# Hexagon chess (WebAssembly)

Hexagonal chess on the 91-cell board, in two variants: **Gliński's** (1936/1949, the
most widely played) and **McCooey's** (1978). The rules engine and the computer opponent
are written in Rust with no dependencies and compiled to WebAssembly. The browser UI is
plain HTML, CSS, JavaScript and SVG.

- Play against the computer (8 strength levels, as White, Black or a random side), play
  two-player hot-seat, or watch a computer-vs-computer demo.
- Supports drag-and-drop or click-to-move, legal-move hints, an in-board promotion picker,
  undo and redo, a clickable move list, flip board, and copy or load a position as FEN.
  You can also export the game, view a "How to play" guide for each variant, and use the
  app on a phone.
- The computer thinks in a Web Worker, so the page stays responsive.
- Choose from four board themes plus light/dark mode, and optional synthesised sounds.
  The current game and your settings survive a reload.
- `dist/hexchess.html` is a single self-contained file (≈ 440 KB) that runs straight from
  disk with no server.

## Quick start

Requirements:
- Rust stable with the wasm target: `rustup target add wasm32-unknown-unknown`.
- Node 18 or newer (Node 22+ for `npm run e2e`).
- Chrome, Chromium or Edge, only for the end-to-end tests.

There are no npm packages to install.

```sh
npm run build    # cargo → web/hexchess.wasm, then the single-file dist/hexchess.html
```

Then either:
- open **`dist/hexchess.html`** in a browser (double-click works), or
- run `npm run serve` and visit <http://localhost:8080/>. This is the development version
  in `web/`, served with the right MIME type for `.wasm`. `npm start` builds and serves in
  one step.

Opening `web/index.html` directly from disk does not work, because browsers block ES
modules on `file://`. The page says so and points you to the two options above.

### Keyboard

| Key | Action |
|---|---|
| ← / → | step back / forward through the game |
| Home / End | go to the start / end |
| F | flip the board |
| N | new game |
| U | undo |
| H or ? | how to play |
| S | settings |
| Esc | cancel selection, close dialog |
| Q / R / B / N | choose a piece when the promotion picker is open |

## The rules in brief

The board has 91 hexagonal cells in three shades. Files run **a–l (there is no j)**. Ranks
run 1–11 and bend into chevrons. Each side has a king, a queen, two knights, two rooks and
**three bishops** (one per cell shade). Gliński's game has 9 pawns per side; McCooey's has 7.

- **Rook:** any distance through the 6 cell edges.
- **Bishop:** any distance through the 6 cell corners. It stays on one shade.
- **Queen:** both of the above, so 12 directions.
- **King:** one step in any of those 12 directions.
- **Knight:** 12 targets: two steps orthogonally, then one step at 60°, jumping.
- **Castling:** none.

| | Gliński | McCooey |
|---|---|---|
| Pawn move | one cell straight forward | one cell straight forward |
| Pawn capture | one cell to the forward-left or forward-right edge-neighbour (60° from straight ahead) | one cell forward-diagonally (bishop-wise) |
| Double step | from **any** of its side's pawn start cells, even one it reached by capturing | from its own start cell; the centre (f-file) pawn may not |
| En passant | yes | yes |
| Promotion | mandatory, to Q, R, B or N, on the far end of the pawn's file | the same |
| Stalemate | the side giving stalemate scores **¾**, the stalemated side **¼** | draw (½–½) |

The app applies these draw rules automatically:
- threefold repetition (same position, side to move and en-passant possibility);
- the fifty-move rule (100 plies with no capture or pawn move);
- insufficient material.

**Convention:** only K v K, K+N v K and K+B v K count as insufficient material. All other
endings play on, and the fifty-move rule ends them eventually. Checkmate and stalemate take
precedence over the draw rules, so a mate delivered on the 100th ply still wins.

The app's "How to play" dialog explains all of this with diagrams.

**Notation:** standard algebraic notation with the hex file letters, for example `Nhf8`,
`exd5` or `f11=Q#`. FEN strings use the [hexchess.club](https://hexchess.club) format, so
positions can be exchanged with it. The ranks go from 11 down to 1, with the cells of each
rank listed left to right. The Gliński start position is:

```
b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1
```

McCooey's own publications letter the files a–k *with* j and without l. This app always
uses Gliński's letters.

## Computer opponent

The AI is a classical alpha-beta engine in `engine/src/search.rs` and `eval.rs`.
- **Search:**
  - iterative deepening and principal-variation search with aspiration windows;
  - a 16 MiB transposition table;
  - quiescence search with static exchange evaluation (SEE);
  - move ordering: hash move, MVV-LVA, killers, counter-moves and history;
  - pruning and reductions: null move, reverse futility, futility, late moves, and
    late-move reductions;
  - check extensions;
  - mate-distance pruning.
- **Draws inside the search:** repetition, fifty-move and insufficient material.
- **Evaluation:** a tapered middlegame/endgame evaluation covering material, centralisation,
  mobility, pawn structure and passed pawns (with a passed-pawn mask per variant), king
  safety, and mop-up.
- **Stalemate:** in Gliński's game a forced stalemate is worth +5 pawns to the side that
  gives it, because it is a ¾ result.

In WebAssembly it searches about 1.2–1.5 M nodes per second, which reaches depth 12 or
more within a second.

| Level | Name | Search budget |
|---:|---|---|
| 1 | Novice | depth 1, large random noise |
| 2 | Beginner | depth 2, noise |
| 3 | Casual | depth 3, a little noise |
| 4 | Club | depth 4 |
| 5 | Strong | depth 6 |
| 6 | Expert | depth 9 |
| 7 | Master | 5 s per move |
| 8 | Grandmaster | 9 s per move |

Levels 3–6 also have a safety time cap (0.4–2.5 s). Timed searches stop starting new
iterations after half their budget, so a move at level 7 or 8 usually takes 50–100 % of
the listed time.

## Project layout

```
engine/              Rust crate hexchess_engine (cdylib + rlib, zero dependencies)
  src/geometry.rs    cells, directions, attack tables (all computed at compile time)
  src/variant.rs     Gliński / McCooey definitions (start FEN, pawn rules, stalemate rule)
  src/position.rs    u128 bitboards + mailbox, make/unmake, Zobrist hashing, FEN
  src/movegen.rs     legal move generation (pins and check evasion, no make/test)
  src/notation.rs    SAN output and SAN/coordinate move parsing
  src/game.rs        game history, repetition, status (mate/stalemate/draws)
  src/eval.rs        evaluation
  src/search.rs      the AI
  src/lib.rs         the hc_* WebAssembly ABI (hand-written, no wasm-bindgen)
  tests/             perft, rules, FEN, SAN, make/undo, McCooey's published games, ABI, AI
web/                 the app (ES modules, no framework); hexchess.wasm is a build output
  js/engine.js       JS wrapper around the wasm ABI (also usable from Node)
  js/ai-worker.js    the Web Worker that runs the search
  js/main.js         app controller (also exposes window.__hexchess for tests)
  js/board-view.js   SVG board, highlights, animation, pointer input, promotion picker
  js/pieces.js       the piece artwork (original SVG set)
dist/hexchess.html   single-file build (CSS, JS, worker and base64 wasm inlined)
tools/               build, dev server and test scripts (no npm dependencies)
  reference/         an independent JavaScript implementation of the rules, used as a test oracle
docs/SPEC.md         the design contract: geometry, rules, FEN/SAN, ABI, UI and AI requirements
```

The wasm module's only import is `env.now_ms` (the clock for the AI's time limit). The
JavaScript side talks to it through 36 `hc_*` functions:
- game handles, FEN in and out, legal moves as packed `u32` codes, make and undo;
- SAN in and out, status, perft, evaluation and search.

`docs/SPEC.md` §7 lists every function.

## Testing

```sh
npm test         # ~40 s: everything below except the browser tests
npm run e2e      # ~2 min: the real app in headless Chrome (dev server and dist/ build)
node tools/difftest.mjs --full   # ~90 s: a larger engine-vs-reference comparison
```

`npm test` runs:
1. **`cargo test --release`**:
   - perft;
   - pawn rules, en passant and promotion in both variants;
   - FEN validation;
   - SAN disambiguation and parsing;
   - check, mate, stalemate and draw rules;
   - make/undo round trips with hash checks over ~30,000 random plies;
   - replays of McCooey's six published sample games (every SAN matches the source);
   - the ABI;
   - AI tests: mates in 1 and 2, stalemate avoidance, draw scoring, time limits,
     determinism.
2. **The wasm build**, then **`tools/wasm-tests.mjs`**. These are ~600,000 checks of the
   real `.wasm` through `web/js/engine.js`:
   - the frontend's geometry against the engine on every cell;
   - random-game round trips;
   - status fixtures;
   - the AI levels;
   - the worker protocol;
   - memory growth.
3. **`tools/reference/hexref.test.mjs`**, the self-tests of the independent reference
   implementation.
4. **`tools/difftest.mjs --quick`**, which compares the engine and the reference on
   thousands of positions:
   - exact legal-move sets, FENs after every move, status and perft;
   - lockstep random games;
   - synthetic positions, including which FENs each one accepts.

Perft from the start position:

| Variant | d1 | d2 | d3 | d4 | d5 |
|---|---:|---:|---:|---:|---:|
| Gliński | 51 | 2,586 | 137,858 | 7,282,418 | 401,622,759 |
| McCooey | 31 | 947 | 33,307 | 1,157,852 | 45,293,892 |

The Gliński d1–d3 and McCooey d1–d3 figures match published values.

For McCooey d4, the only published figure is 1,157,856. It was computed before its
author fixed a "phantom en passant" bug. Re-creating that bug in our reference reproduces
1,157,856 exactly; see the erratum in `docs/SPEC.md` §2.4.

## Sources

- **Rules:**
  - Wikipedia, *Hexagonal chess*;
  - McCooey's own rules page and sample games on chessvariants.com;
  - the Zillions *HexChess.zrf* rules file;
  - the hexchess.club FEN conventions and test positions.
- **Artwork:** the piece set is original, drawn for this project.
