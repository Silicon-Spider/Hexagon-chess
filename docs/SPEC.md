# Hexagonal Chess (WebAssembly) — Technical Specification

This document is the single source of truth shared by the Rust engine (compiled to
WebAssembly) and the browser frontend. If code and this spec disagree, the spec wins
unless the spec is shown to be wrong about the rules of the game.

---------------------------------------------------------------------------------------

## 0. Repository layout

```
Hexagon chess/
  package.json            npm scripts (no npm dependencies at all)
  README.md
  docs/SPEC.md            this file
  engine/                 Rust crate `hexchess_engine` (cdylib + rlib, ZERO crate dependencies)
    Cargo.toml
    src/lib.rs            module wiring + the C-ABI wasm exports (thin layer, `hc_*` functions)
    src/geometry.rs       cells, coordinates, direction tables, precomputed rays/jumps
    src/variant.rs        variant definitions (setup FEN, pawn start cells, stalemate rule …)
    src/position.rs       Position, make/unmake, Zobrist hashing, FEN I/O
    src/movegen.rs        move generation, attack detection, legality
    src/notation.rs       SAN output, move parsing (SAN + coordinate form)
    src/game.rs           Game = position + history (undo, repetition, status)
    src/eval.rs           static evaluation
    src/search.rs         AI search
    tests/*.rs            integration tests (rules, perft, FEN, SAN, search sanity)
  web/                    static site (served as-is)
    index.html
    style.css
    js/*.js               ES modules (see §8 conventions)
    js/ai-worker.js       classic (non-module) self-contained Web Worker
    hexchess.wasm         build output copied here by tools/build.mjs
  tools/
    build.mjs             cargo build → copy wasm → bundle dist/hexchess.html
    serve.mjs             zero-dependency static dev server (correct application/wasm MIME)
    test.mjs              runs `cargo test --release` then the Node wasm tests
    wasm-tests.mjs        Node tests that load web/hexchess.wasm through web/js/engine.js
  dist/hexchess.html      single-file build (inline CSS/JS/worker + base64 wasm); works from file://
```

Toolchain facts (verified on this machine): rustc 1.99 stable, default host toolchain
`x86_64-pc-windows-gnu`, target `wasm32-unknown-unknown` installed, Node 24, Python 3.14.
No wasm-bindgen / wasm-pack / wasm-opt / emscripten. Use Rust **edition 2021**.

**IMPORTANT wasm-linking gotcha (verified):** with this Rust version, an undeclared
`extern "C"` import makes rust-lld fail with `undefined symbol`. JS imports MUST be
declared like this, and given a native stand-in so `cargo test` links:

```rust
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" { fn now_ms() -> f64; }          // JS supplies env.now_ms = () => performance.now()

#[cfg(not(target_arch = "wasm32"))]
fn now_ms_native() -> f64 { /* std::time::Instant based */ }
```

The ONLY import the wasm module may have is `env.now_ms: () -> f64`.

Release profile: `opt-level = 3, lto = true, codegen-units = 1, panic = "abort"`.

---------------------------------------------------------------------------------------

## 1. Board geometry (91 cells, flat-topped hexagons)

* Files, left→right from White's view: `a b c d e f g h i k l` (there is **no j**).
  File index `fi` = 0..10, axial column `q = fi - 5` (−5..+5).
* Cells per file: `11 - |q|` → a:6 b:7 c:8 d:9 e:10 f:11 g:10 h:9 i:8 k:7 l:6 (total 91).
* Ranks: within each file, rank 1 is the bottom cell (White's side), increasing upward.
  Ranks are chevron (V) shaped across the board.
* Axial coordinates (q, r) with cube `s = -q - r`; valid iff `max(|q|,|r|,|s|) <= 5`:
  `r = 6 - rank - max(q, 0)`  ⇔  `rank = 6 - r - max(q, 0)`.
  Examples: f1=(0,5) f6=(0,0) f11=(0,−5) a1=(−5,5) a6=(−5,0) l1=(5,0) l6=(5,−5).
* **Cell index (canonical, used everywhere: ABI, board array, move encoding):** cells are
  ordered by file a→l, then rank ascending. `index = FILE_OFFSET[fi] + rank - 1` with
  `FILE_OFFSET = [0, 6, 13, 21, 30, 40, 51, 61, 70, 78, 85]`.
  a1=0, a6=5, b1=6, f1=40, f6=45 (centre), f11=50, g1=51, l1=85, l6=90.
* Screen layout (White at bottom, unflipped), hex "size" = centre-to-corner radius:
  `x = 1.5 * size * q`, `y = sqrt(3) * size * (r + q/2)` (y grows downward).
  Flat-topped corner k (k=0..5) is at angle 60°·k from the centre.
  Flipped board = rotate 180° (negate x and y).
* Cell colour class (3 colours, no two edge-neighbours equal, bishops never change class):
  `colorClass = ((q - r) mod 3 + 3) mod 3`. Class 0 contains f6; f1 is class 1 (=(0−5) mod 3);
  f11 is class 2. Which shade (light/medium/dark) each class gets is specified in §2.

### 1.1 Directions (axial deltas (dq, dr); "north" = toward Black = up the file)

Orthogonal (edge-adjacent) — rook directions:

| name | (dq, dr) | example from e4 |
|------|----------|-----------------|
| N    | ( 0, −1) | e5 |
| S    | ( 0, +1) | e3 |
| NE   | (+1, −1) | f5 |
| SE   | (+1,  0) | f4 |
| NW   | (−1,  0) | d4 |
| SW   | (−1, +1) | d3 |

Diagonal (through a vertex) — bishop directions. A diagonal step is NOT blocked by the two
cells it passes between; only pieces standing on the diagonal line's cells block.

| name | (dq, dr) | example from e4 |
|------|----------|-----------------|
| E    | (+2, −1) | g4 |
| W    | (−2, +1) | c3 |
| NNE  | (+1, −2) | f6 |
| NNW  | (−1, −1) | d5 |
| SSE  | (+1, +1) | f3 |
| SSW  | (−1, +2) | d2 |

Knight: the 12 cells whose cube offset is a permutation of (3,−1,−2) or (−3,1,2):
`(3,−1) (3,−2) (−1,3) (−1,−2) (−2,3) (−2,−1) (−3,1) (−3,2) (1,−3) (1,2) (2,−3) (2,1)`
(i.e. two orthogonal steps in one direction then one orthogonal step at 60°; it jumps).

King: one step in any of the 12 directions (6 orthogonal + 6 diagonal).
Queen: slides in all 12 directions. Rook: slides in the 6 orthogonal directions.
Bishop: slides in the 6 diagonal directions.

---------------------------------------------------------------------------------------

## 2. Rules

Sources: Wikipedia "Hexagonal chess" (Gliński & McCooey sections); Dave McCooey's own
rules page (chessvariants.com/hexagonal.dir/hexchess2.html); Jens Markmann's Zillions
`HexChess.zrf` (both setups + double-step zones); hexchess.club (`scottbedard/hexchess`,
MIT) FEN format and fixtures. The perft numbers in §2.4 were reproduced from this spec by
an independent throwaway implementation before any engine code was written.

### 2.1 Common rules (both variants)
* Pieces move as in §1.1. White moves first. **No castling.** No "two-square" rule other
  than the pawn double step below.
* Check / checkmate as in orthodox chess; a move may never leave the mover's own king
  attacked (so kings can never stand on adjacent cells).
* **Pawn advance:** one cell straight forward (White: N, Black: S) onto an empty cell.
* **Pawn double step:** a pawn standing on one of its side's *double-step cells*
  (variant-specific list, §2.2/§2.3) may instead move two cells straight forward if BOTH
  cells are empty. The cell passed over becomes the *en-passant target*.
* **Pawn capture:** one cell in either of the two variant-specific capture directions,
  onto a cell holding an enemy piece. (Pawns never capture straight ahead.)
* **En passant:** if the opponent's immediately preceding move was a pawn double step
  that passed over cell X, then any pawn whose capture directions reach X may move to X,
  removing the double-stepped pawn (which stands on `X + forward(opponent)`). Only on the
  immediately following move.
* **Promotion (mandatory):** a pawn that reaches the last cell of its file — White:
  `a6 b7 c8 d9 e10 f11 g10 h9 i8 k7 l6`; Black: `a1 b1 c1 d1 e1 f1 g1 h1 i1 k1 l1` —
  by advancing or capturing, is replaced by a Queen, Rook, Bishop or Knight of the
  player's choice, regardless of material already on the board. (In axial terms White
  promotes on cells with `r == -5 || q + r == -5`; Black on `r == 5 || q + r == 5`.)
* **Draws** (this implementation; automatic, no claim needed):
  threefold repetition; fifty-move rule (100 plies without capture or pawn move);
  insufficient material = the classical list K v K, K+N v K, K+B v K. (Note: on the hex
  board helpmates — and, under Gliński scoring, cooperative stalemates — exist even in
  these endings, but none can be forced; we follow the classical convention used by
  chess software, and document it in the README / How-to-play.)
* Checkmate / stalemate take precedence over the draw rules (a mate delivered on the
  100th quiet ply is a win).

### 2.2 Gliński's hexagonal chess (variant 0, default) — "Gliński"
* Start (FEN §5.1): `b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1`
  White: K g1, Q e1, R c1 i1, N d1 h1, B f1 f2 f3, P b1 c2 d3 e4 f5 g4 h3 i2 k1.
  Black: K g10, Q e10, R c8 i8, N d9 h9, B f9 f10 f11, P b7 c7 d7 e7 f7 g7 h7 i7 k7.
* Pawn captures "orthogonally forward at 60° to the vertical":
  White **NW (−1,0) and NE (+1,−1)**; Black **SW (−1,+1) and SE (+1,0)**.
* Double-step cells = **every** pawn starting cell of that colour (Wikipedia: "If it stands
  on its starting cell or on the starting cell of any other pawn of its colour"):
  White `b1 c2 d3 e4 f5 g4 h3 i2 k1`; Black `b7 c7 d7 e7 f7 g7 h7 i7 k7`.
  E.g. after e4xf5 that pawn may later play f5–f7. (At the start f5–f7 is blocked by f7.)
* **Stalemate is not a draw:** the stalemating player scores ¾, the stalemated player ¼
  (`hc_variant_stalemate_rule` = 1).
* Cell shading (Wikipedia diagram): colour class 0 (f6, centre) **mid-tone**, class 1
  (f1) **light**, class 2 (f11) **dark**. Each side's three bishops start one per class.

### 2.3 McCooey's hexagonal chess (variant 1) — "McCooey"
* Start: `b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1`
  White: K g1, Q e1, R d1 h1, N e2 g2, B f1 f2 f3, P c1 d2 e3 f4 g3 h2 i1.
  Black: K g10, Q e10, R d9 h9, N e9 g9, B f9 f10 f11, P c8 d8 e8 f8 g8 h8 i8.
  (Black mirrors White across the horizontal axis — confirmed by the Zillions ZRF.)
* Pawn captures **diagonally forward** (bishop-wise, never blocked):
  White **NNW (−1,−1) and NNE (+1,−2)**; Black **SSW (−1,+2) and SSE (+1,+1)**.
* Double-step cells: White `c1 d2 e3 g3 h2 i1`; Black `c8 d8 e8 g8 h8 i8`
  (the centre f-pawn may NOT double step).
* **Stalemate is a draw** (½–½) (`hc_variant_stalemate_rule` = 0).
* Cell shading: McCooey's boards have a light centre: class 0 **light**, class 1 **mid**,
  class 2 **dark**.
* McCooey's own published notation letters the files a–k *including j* (his j = our k,
  his k = our l); we always use the Gliński letters a–l without j.

### 2.4 Validation data (must be reproduced by the engine's tests)
* Gliński perft from the start: d1 = **51**, d2 = **2,586**, d3 = **137,858**
  (published, cross-verified by two independent implementations, and reproduced from
  this spec). d1 breakdown: 17 pawn (9 single + 8 double), 8 knight, 12 bishop, 6 queen,
  2 king, 6 rook.
* McCooey perft from the start: d1 = **31**, d2 = **947**, d3 = **33,307**,
  d4 = **1,157,852**, d5 = **45,293,892** (d1–d3 published; all reproduced from this spec by
  the engine, tools/reference/hexref.mjs and two further throwaway implementations).
  d1 breakdown: 13 pawn (7 single + 6 double), 10 knight, 8 bishop.
  *Erratum:* the only published d4 figure, 1,157,856 (a "computed once" self-perft in
  github.com/talvola/abstract_games, engine_games McCooey package), predates that package's
  own documented fix (2026-07-27) of a "phantom en passant" bug: a pawn capture whose axial r
  changed by 2 armed an e.p. right. Re-creating that bug in a copy of hexref.mjs gives exactly
  1,157,856; d4 is the first depth where Black pawn captures occur, so it is the first to
  expose it.
* Gliński d4 = **7,282,418** and d5 = **401,622,759** (not published; engine and reference
  agree; d4 also matched by a third implementation).
* Gliński examples (Wikipedia): after `e4xf5` the f5 pawn may double-step to f7 when f6, f7
  are empty; Black `c7-c5` may be answered by `b5xc6` e.p. McCooey: Black `e8-e6` may be
  answered by `d5xe7` e.p.
* Gliński "fool's mate": `1. Qe1-c3 Qe10-c6 2. b1-b2 b7-b6 3. Bf3-b1 e7-e6 4. Qc3xf9#`
  (after 4.Qxf9 the position is checkmate; final FEN as in hexchess.club fixtures:
  `b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4`).
* hexchess.club status fixtures (Gliński). The first three have no black king, so the strict
  `hc_load_fen` (§7) rejects them as written; tests load them with the relaxed Rust parser
  or add a black king on a1 (which changes none of the expected results):
  `K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1` → check, not mate;
  `K/3/5/3q3/2q6/11/11/11/11/11/11 w - 0 1` → check, not mate;
  `K/3/2q2/3q3/9/11/11/11/11/11/11 w - 1 2` → checkmate;
  `k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1` → not stalemate;
  `k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1` → stalemate.

---------------------------------------------------------------------------------------

## 3. Piece codes, board array, colours

* Piece type codes: `1 Pawn, 2 Knight, 3 Bishop, 4 Rook, 5 Queen, 6 King`.
* Board array (exported, 91 signed bytes, canonical cell order): `0` empty,
  `+code` white piece, `-code` black piece.
* Colour codes: `0 = White, 1 = Black`. White moves first.

## 4. Move encoding (u32)

```
bits  0..7   from cell index (0..90)
bits  8..15  to cell index
bits 16..19  promotion piece type (0 none, else 2..5)
bits 20..23  flags: 1 = capture, 2 = en passant, 4 = pawn double step, 8 = promotion
bits 24..27  moving piece type (1..6)          (informational)
bits 28..31  captured piece type (0 or 1..6)   (informational; en passant → 1)
```
`0` is never a valid move and means "no move". When JS submits a move for execution, only
from/to/promo (bits 0..19 minus flags, i.e. `mv & 0xFFFFF` with flags ignored) are matched
against the generated legal moves.

## 5. Text formats

### 5.1 FEN (hexchess.club-compatible)
`<board> <side> <ep> <halfmove> <fullmove>` — identical to the format used by
hexchess.club / `scottbedard/hexchess`, so positions can be exchanged with it.

* `<board>`: 11 rank strings from **rank 11 down to rank 1**, separated by `/`. Rank n
  lists its cells left→right (file a→l): ranks 1–6 have all 11 files `a..l`; rank 7 has
  `b..k` (9 cells); rank 8 `c..i` (7); rank 9 `d..h` (5); rank 10 `e..g` (3); rank 11 `f`
  (1). Pieces `PNBRQK` (white) / `pnbrqk` (black); runs of empty cells are decimal
  numbers, possibly two digits (`10`, `11`). Each rank string must account for exactly its
  cell count. Empty board: `1/3/5/7/9/11/11/11/11/11/11 w - 0 1`.
* `<side>`: `w` or `b`.
* `<ep>`: the cell passed over by a pawn double step on the previous move (e.g. `f6`), or `-`.
  Output: written whenever the previous move was a double step (hexchess.club convention).
  Input: an invalid cell name is an error; a valid cell is kept only if consistent (it is
  empty, the cell behind it is empty, and a pawn of the side that just moved stands on
  `ep + forward(that side)`), otherwise silently ignored.
  The Zobrist hash / repetition key includes the ep cell only when an en-passant capture
  is pseudo-legally available, so FEN output and repetition semantics don't interfere.
* `<halfmove>`: plies since last capture or pawn move. `<fullmove>`: starts at 1, increments
  after Black moves. The last three fields are optional on input (default `- 0 1`).
* Start positions: §2.2 (Gliński) and §2.3 (McCooey).

### 5.2 SAN (move list display)
* Piece letter `K Q R B N` (none for pawns), disambiguation, `x` for captures, destination
  cell, `=Q|R|B|N` for promotions, then `+` for check or `#` for checkmate.
* Disambiguation (non-pawn): if another piece of the same type and colour can also legally
  move to the destination, add the origin file letter if that is unique, else the origin
  rank number if unique, else the full origin cell (e.g. `Rc1`, `R3`, `Qe1`).
* Pawn moves: `f6`; pawn captures (incl. en passant): origin file letter + `x` + dest,
  e.g. `exd5`; promotion `f11=Q`, `gxf11=N+`.
* Coordinate form (accepted by the parser, also used in tests/console): `e4e5`, `e4-e5`,
  `e4xd5`, `f10f11q` / `f10-f11=Q`.

## 6. Game status codes
```
0 ONGOING
1 CHECKMATE                 side to move is checkmated (other side wins)
2 STALEMATE                 side to move has no legal move and is not in check (scoring per variant)
3 DRAW_THREEFOLD            same position (board, side, castling n/a, ep-availability) 3 times
4 DRAW_FIFTY_MOVE           halfmove clock >= 100
5 DRAW_INSUFFICIENT         K v K, K+N v K, K+B v K
```
Precedence: no legal moves (1/2) > insufficient material > fifty-move > threefold.
Draws are automatic (no claim needed).

---------------------------------------------------------------------------------------

## 7. Engine wasm ABI  (all `#[no_mangle] pub extern "C"`, prefix `hc_`)

All pointers are byte offsets into the exported `memory`. `G` = `*mut Game` (a u32 handle
obtained from `hc_new`; multiple games may coexist). Strings are written by the engine
into ONE shared output buffer (≥ 8 KiB) whose address is `hc_str_ptr()`; functions that
produce a string return its byte length (UTF-8/ASCII, no NUL). JS must copy it out
immediately. **JS must re-create typed-array views after every call** because the wasm
memory may grow (which detaches old views).

```
hc_abi_version() -> u32                    // = 1
hc_alloc(len: u32) -> *mut u8              // scratch for JS→wasm strings
hc_free(ptr: *mut u8, len: u32)
hc_str_ptr() -> *const u8

hc_variant_count() -> u32
hc_variant_name(v: u32) -> u32             // string len ("Gliński", "McCooey", …) 
hc_variant_stalemate_rule(v: u32) -> u32   // 0 = draw, 1 = stalemating side scores 3/4 vs 1/4, 2 = stalemating side wins

hc_new(variant: u32) -> G                  // 0 (null) if variant invalid
hc_destroy(g: G)
hc_reset(g: G, variant: u32) -> i32        // new game at the variant's start position; 1 ok / 0 bad variant
hc_variant(g: G) -> u32
hc_load_fen(g: G, ptr: *const u8, len: u32) -> i32
        // 1 ok (history cleared, this becomes the start position) / 0 error (game unchanged).
        // Reject: bad syntax, wrong cell counts, not exactly one king per side,
        // pawns on own promotion cells, side NOT to move in check.
hc_fen(g: G) -> u32                        // current position FEN (string)
hc_start_fen(g: G) -> u32                  // FEN of the game's start position (string)

hc_board_ptr(g: G) -> *const i8            // 91 bytes, see §3
hc_turn(g: G) -> u32                       // 0 white / 1 black
hc_status(g: G) -> u32                     // §6
hc_in_check(g: G) -> u32                   // 1 if side to move is in check
hc_king_cell(g: G, color: u32) -> i32      // -1 if none
hc_ep_cell(g: G) -> i32                    // ep target if an ep capture is pseudo-legal, else -1
hc_halfmove_clock(g: G) -> u32
hc_fullmove_number(g: G) -> u32

hc_gen_moves(g: G) -> u32                  // generate LEGAL moves into the game's buffer; returns count
hc_moves_ptr(g: G) -> *const u32           // the buffer (valid until next call that mutates g)
hc_make_move(g: G, mv: u32) -> i32         // 1 made / 0 not legal (game unchanged); matches from,to,promo
hc_undo(g: G) -> i32                       // 1 undone / 0 nothing to undo
hc_move_san(g: G, mv: u32) -> u32          // SAN of a legal move in the current position; 0 if illegal
hc_parse_move(g: G, ptr, len) -> u32       // SAN or coordinate text → legal move code, 0 if none/ambiguous

hc_history_len(g: G) -> u32                // moves made since the start position
hc_history_move(g: G, i: u32) -> u32       // i-th move code (0 if out of range)
hc_history_san(g: G, i: u32) -> u32        // SAN of i-th move as it was played (string)

hc_perft(g: G, depth: u32) -> u64          // JS receives a BigInt
hc_eval(g: G) -> i32                       // static eval, centipawns, from WHITE's point of view
hc_search(g: G, max_depth: u32, time_ms: u32, noise_cp: u32, seed: u32) -> u32
        // best legal move (0 iff no legal moves or game over). Must leave g exactly as it was.
        // max_depth 0 = unlimited (time-bounded); time_ms 0 = unlimited (depth-bounded).
        // Never return 0 when legal moves exist, even if time runs out during depth 1.
        // noise_cp > 0 → deliberately weaker play: root moves are scored with a full window
        // and a deterministic pseudo-random offset in [-noise_cp, +noise_cp] (seeded by seed).
hc_search_info_ptr() -> *const i32
        // [0] depth completed, [1] score cp (side-to-move POV; mate scores = ±(30000 − plies)),
        // [2] nodes low 32 bits, [3] nodes high 32 bits, [4] elapsed ms, [5] pv length (≤ 32),
        // [6..6+pvlen] pv move codes (as i32)
```

---------------------------------------------------------------------------------------

## 8. Frontend (web/)

### 8.1 Module conventions (needed by the single-file bundler)
* Every file in `web/js/` except `ai-worker.js` is an ES module.
* Imports only in the form `import { a, b } from './file.js';` at the top of the file
  (relative, same directory, named imports only, one statement per line, no aliases).
* Exports only as `export function f…`, `export class C…`, `export const X …`
  (no default exports, no `export { … }` lists, no re-exports).
* Top-level names need not be globally unique (the bundler wraps each module in its own
  function scope).
* No top-level `await`, no `import.meta`, no dynamic `import()` (the bundle is a classic
  script). `main.js` starts the app with
  `if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();`
* `index.html` must reference the stylesheet exactly as `<link rel="stylesheet" href="style.css">`
  and the app exactly as `<script type="module" src="js/main.js"></script>`, and contain
  `</body>` (tools/build.mjs rewrites these for the single-file build).
* `engine.js` must not touch `window`/`document` at import time (it is also imported by
  the Node tests).
* `ai-worker.js` is a classic worker with no imports; it receives the compiled
  `WebAssembly.Module` from the main thread via `postMessage` (so the worker can also be
  started from a Blob URL in the single-file build).
* Wasm bytes: if `globalThis.__HEXCHESS_WASM_B64__` exists (single-file build) decode it;
  otherwise `fetch('hexchess.wasm')`. Imports object: `{ env: { now_ms: () => performance.now() } }`.
* Worker: if `document.getElementById('ai-worker-src')` exists, start the worker from a
  Blob of its text; else `new Worker('js/ai-worker.js')`. If the worker cannot be created
  or fails, fall back to calling `hc_search` synchronously on the main thread.

### 8.2 Worker protocol
```
main → worker  {type:'init', module: WebAssembly.Module}
worker → main  {type:'ready'} | {type:'error', message}
main → worker  {type:'search', id, variant, startFen, moves:[u32…], maxDepth, timeMs, noise, seed}
worker → main  {type:'result', id, move, info:{depth, score, nodes, ms, pv:[u32…]}}
```
The worker rebuilds the game from `variant` + `startFen` + `moves` (so repetition history
is correct) and searches. The main thread ignores results whose `id` is stale (user undid /
started a new game meanwhile); to cancel a long search it may `terminate()` the worker and
create a new one.

---------------------------------------------------------------------------------------

## 9. UI requirements

General: polished, original visual design; no external resources at runtime (no CDNs,
no web fonts — system font stack) so it works offline and from the single-file build.
Light and dark themes via `prefers-color-scheme` using CSS custom properties defined on
`:root`. Must work at phone width (≥ 360 px) without horizontal scrolling.

### 9.1 Board (SVG)
* Flat-topped hexes laid out per §1; White at the bottom unless flipped.
* Three-shade cell colouring per §1/§2 with at least 3 selectable board themes
  (e.g. "Walnut", "Slate", "Jade"); shades must be distinct but harmonious.
* Coordinates (toggleable): file letters below each file's bottom cell (and above the top
  cells), rank numbers at the outer ends of each chevron rank; they must follow flipping.
* Pieces: ORIGINAL SVG designs (do not copy existing piece sets), defined once as
  `<symbol>`s and placed with `<use>`; white pieces light fill + dark outline, black pieces
  dark fill + light outline; clearly distinct silhouettes for K Q R B N P.
* Highlights: selected cell, legal destinations (dot for quiet moves, ring for captures),
  last move (from + to), king in check (red glow), hover feedback on legal targets.
* Animated piece movement (~180 ms ease; disabled when `prefers-reduced-motion`),
  including the captured pawn vanishing on en passant.

### 9.2 Interaction
* Click-to-move AND drag-and-drop (pointer events; works with mouse, touch and pen).
* Clicking an own piece selects it and shows its legal moves; clicking a legal target
  moves; clicking another own piece switches selection; anything else deselects.
* Promotion: when a move has several promotion options, show an in-board picker
  (Q R B N, Q default/first) near the destination; Escape/click-away cancels the move.
* Input is ignored while it is the computer's turn or the game is over.

### 9.3 Game modes and computer strength
* Modes: "You vs Computer" (play White / Black / Random), "Two players" (hot-seat,
  optional auto-flip each turn), "Computer vs Computer" (demo; pausable).
* Computer strength 1–8 mapped to `hc_search` arguments:

| level | maxDepth | timeMs | noise_cp |
|------:|---------:|-------:|---------:|
| 1 | 1 | 0    | 250 |
| 2 | 2 | 0    | 120 |
| 3 | 3 | 400  | 40  |
| 4 | 4 | 700  | 0   |
| 5 | 6 | 1200 | 0   |
| 6 | 9 | 2500 | 0   |
| 7 | 0 | 5000 | 0   |
| 8 | 0 | 9000 | 0   |

  (Levels 5 and 6 were originally time-only; the selective search reaches depth 12+ in
  1 s, so they now cap the depth to give an even progression 1, 2, 3, 4, 6, 9, ~14, ~16.)

* While the computer thinks: show a "thinking…" indicator; keep the UI responsive.
  Apply the computer's move no sooner than ~350 ms after it was requested (feels natural).
* Optional evaluation bar / score readout from the last search info (White's POV).

### 9.4 Panel
* New game (variant select: all engine variants; mode; side; strength), Undo, Redo, Flip.
  Undo in "You vs Computer" takes back to the human's previous turn (usually 2 plies).
  Redo replays undone moves; making a new move discards the redo list.
* Move list in SAN with move numbers, current ply highlighted; clicking a move jumps to
  that ply (implemented via undo/redo); ⏮ ◀ ▶ ⏭ navigation buttons.
* Status line: whose turn, check, and final result, e.g. "Checkmate — White wins",
  "Stalemate — Black scores ¾ (Gliński rule)", "Draw by threefold repetition",
  "Draw — fifty-move rule", "Draw — insufficient material".
* Captured pieces for each side with material difference (+N).
* Game over: modal/banner with the result and "New game" / "Review" buttons.
* FEN: copy current FEN; load FEN (text field + validation message).
  Export game as text (variant, start FEN, SAN move list) to clipboard.
* Settings: board theme, show coordinates, show legal moves, animations, sound
  (tiny WebAudio-synthesised move/capture/check sounds; off by default is fine).
* "How to play" modal explaining the variant's rules (board, every piece's movement,
  pawn rules, promotion, stalemate scoring).
* Keyboard: ←/→ step through history (undo/redo), F flip, N new game, Esc closes dialogs
  / cancels selection.

### 9.5 Robustness
* Persist settings and the current game (variant, startFen, move list, mode, level) in
  `localStorage` (every access wrapped in try/catch; page must work without it) and
  restore on load by replaying moves.
* If the wasm fails to load, show a clear error panel explaining how to run it
  (`npm run serve`, or open `dist/hexchess.html`).
* Never let a stale AI result be applied after undo/new game (request ids).

---------------------------------------------------------------------------------------

## 10. AI requirements (engine/src/search.rs, eval.rs)

* Negamax alpha-beta (PVS) with iterative deepening, transposition table (Zobrist, lazily
  allocated, ~8–16 MB), quiescence search (captures + promotions, stand-pat), move ordering
  (TT move, MVV-LVA captures, promotions, 2 killers/ply, history heuristic), check
  extension, null-move pruning (not in check, side has non-pawn material, depth ≥ 3),
  late-move reductions for quiet late moves (re-search on fail-high).
* Draw detection inside search: repetition against game history + search path (twofold
  in-search counts as draw), fifty-move rule, insufficient material.
* Terminal scores: mate = ±(30000 − ply). Stalemate for the side to move:
  draw rule → 0; ¾-rule (Gliński) → −STALEMATE_VALUE for the stalemated side with
  STALEMATE_VALUE = 500 (≈ "clearly winning but not as good as mate").
* Time: check `now_ms()` every 1024 nodes; abort and return the best move of the last
  completed iteration (or the best so far in the current iteration if it searched the
  previous best first). Depth 1 always completes.
* Evaluation (centipawns, tapered middlegame/endgame by non-pawn material):
  material P=100 N=300 B=300 R=500 Q=900 (adjust only with justification); centralisation
  (hex distance to f6) for N/B/Q and for K in the endgame; pawn advancement toward the
  promotion cell (grows sharply near promotion), passed-pawn bonus; king shelter in the
  middlegame; light mobility term; small tempo bonus.
* Must never mutate the visible game: on return the Game is bit-identical to before.
* Performance target in wasm: ≥ 300k nodes/s; depth ≥ 4 within ~1 s from the opening.
