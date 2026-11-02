// tools/wasm-tests.mjs — end-to-end tests of the REAL engine (web/hexchess.wasm) driven
// through the REAL frontend wrapper (web/js/engine.js), plus the frontend's geometry table
// (web/js/geometry.js), AI level table / client (web/js/ai-client.js) and AI worker
// (web/js/ai-worker.js). Contract: docs/SPEC.md §1–§7, §8.2, §9.3.
//
// Zero dependencies.  usage: node tools/wasm-tests.mjs [--filter <text>] [--verbose]
// Exit code 0 when every check passes, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  ABI_VERSION, STATUS, PIECE, PIECE_LETTERS, MOVE_FLAGS, NUM_CELLS,
  loadEngine, decodeMove, encodeMove,
} from '../web/js/engine.js';
import {
  CELLS, FILES, FILE_OFFSET, DIRS_ORTHO, DIRS_DIAG, KNIGHT_JUMPS,
  cellIndex, cellName, stepCell, hexDistance, emptyBoardTargets, parseFenBoard,
  shadeOfClass, cellFromPoint, SQRT3,
} from '../web/js/geometry.js';
import { LEVELS, AiClient } from '../web/js/ai-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM_PATH = path.join(ROOT, 'web', 'hexchess.wasm');
const argv = process.argv.slice(2);
const FILTER = argv.includes('--filter') ? argv[argv.indexOf('--filter') + 1] || '' : '';
const VERBOSE = argv.includes('--verbose');

// ---------------------------------------------------------------------------------------
// SPEC data (docs/SPEC.md) — the expectations, written independently of the engine.

const SPEC = {
  names: ['Gliński', 'McCooey'],
  stalemateRule: [1, 0],
  startFen: [
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1',
    'b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1',
  ],
  perft: [[51n, 2586n, 137858n], [31n, 947n, 33307n]],
  // §2.4 depth-1 breakdown by moving piece, plus the number of double steps.
  breakdown: [
    { P: 17, N: 8, B: 12, R: 6, Q: 6, K: 2, double: 8 },
    { P: 13, N: 10, B: 8, R: 0, Q: 0, K: 0, double: 6 },
  ],
  doubleStep: [
    ['b1 c2 d3 e4 f5 g4 h3 i2 k1', 'b7 c7 d7 e7 f7 g7 h7 i7 k7'],
    ['c1 d2 e3 g3 h2 i1', 'c8 d8 e8 g8 h8 i8'],
  ],
  // Pawn capture directions [variant][colour] as axial deltas (§2.2, §2.3).
  captureDirs: [
    [[[-1, 0], [1, -1]], [[-1, 1], [1, 0]]],
    [[[-1, -1], [1, -2]], [[-1, 2], [1, 1]]],
  ],
  // §9.3 strength table: [maxDepth, timeMs, noise].
  levels: [null, [1, 0, 250], [2, 0, 120], [3, 400, 40], [4, 700, 0], [6, 1200, 0], [9, 2500, 0], [0, 5000, 0], [0, 9000, 0]],
  // §7 exports and their parameter counts.
  exports: {
    hc_abi_version: 0, hc_alloc: 1, hc_free: 2, hc_str_ptr: 0,
    hc_variant_count: 0, hc_variant_name: 1, hc_variant_stalemate_rule: 1,
    hc_new: 1, hc_destroy: 1, hc_reset: 2, hc_variant: 1, hc_load_fen: 3, hc_fen: 1, hc_start_fen: 1,
    hc_board_ptr: 1, hc_turn: 1, hc_status: 1, hc_in_check: 1, hc_king_cell: 2, hc_ep_cell: 1,
    hc_halfmove_clock: 1, hc_fullmove_number: 1,
    hc_gen_moves: 1, hc_moves_ptr: 1, hc_make_move: 2, hc_undo: 1, hc_move_san: 2, hc_parse_move: 3,
    hc_history_len: 1, hc_history_move: 2, hc_history_san: 2,
    hc_perft: 2, hc_eval: 1, hc_search: 5, hc_search_info_ptr: 0,
  },
};

const MATE = 30000;
const LETTER_TYPE = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };

// ---------------------------------------------------------------------------------------
// Tiny test harness: checks record failures and keep going; a test fails if any check did.

class Checker {
  constructor() { this.count = 0; this.failures = []; this.suppressed = 0; }
  fail(msg) {
    if (this.failures.length < 20) this.failures.push(typeof msg === 'function' ? msg() : String(msg));
    else this.suppressed++;
  }
  ok(cond, msg) { this.count++; if (!cond) this.fail(msg); return !!cond; }
  eq(actual, expected, msg) {
    this.count++;
    if (actual === expected) return true;
    this.fail(() => `${typeof msg === 'function' ? msg() : msg}: got ${fmt(actual)}, expected ${fmt(expected)}`);
    return false;
  }
  same(actual, expected, msg) { // arrays / typed arrays / plain JSON-able values
    this.count++;
    if (deepEqual(actual, expected)) return true;
    this.fail(() => `${typeof msg === 'function' ? msg() : msg}: got ${fmt(actual)}, expected ${fmt(expected)}`);
    return false;
  }
}

function fmt(v) {
  if (typeof v === 'bigint') return `${v}n`;
  if (ArrayBuffer.isView(v)) v = Array.from(v);
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function deepEqual(a, b) {
  if (ArrayBuffer.isView(a)) a = Array.from(a);
  if (ArrayBuffer.isView(b)) b = Array.from(b);
  return JSON.stringify(a, (k, x) => (typeof x === 'bigint' ? `${x}n` : x))
    === JSON.stringify(b, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------------------
// Helpers

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

const CELLS_BY_RANK = [];
for (let rank = 1; rank <= 11; rank++) {
  CELLS_BY_RANK[rank] = CELLS.filter((c) => c.rank === rank).sort((a, b) => a.fileIndex - b.fileIndex);
}

/** FEN (§5.1) of a 91-cell board, written from the FRONTEND's cell table. */
function fenFromBoard(board, side = 'w', ep = '-', half = 0, full = 1) {
  const rows = [];
  for (let rank = 11; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (const c of CELLS_BY_RANK[rank]) {
      const p = board[c.index];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const ch = PIECE_LETTERS[Math.abs(p)];
      row += p > 0 ? ch : ch.toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${side} ${ep} ${half} ${full}`;
}

/** FEN from { cellName: 'K' | 'q' | … }. */
function fenFrom(pieces, side = 'w', ep = '-', half = 0, full = 1) {
  const board = new Int8Array(NUM_CELLS);
  for (const [name, ch] of Object.entries(pieces)) {
    const i = cellIndex(name);
    if (i < 0) throw new Error(`bad cell ${name}`);
    const t = LETTER_TYPE[ch.toUpperCase()];
    board[i] = ch === ch.toUpperCase() ? t : -t;
  }
  return fenFromBoard(board, side, ep, half, full);
}

const isKingStep = (a, b) => emptyBoardTargets(a, PIECE.KING).includes(b);

/** Two king cells outside `exclude`, at hex distance >= 3 from each other (never adjacent). */
function pickKings(exclude) {
  for (let wk = 0; wk < NUM_CELLS; wk++) {
    if (exclude.has(wk)) continue;
    for (let bk = NUM_CELLS - 1; bk >= 0; bk--) {
      if (bk === wk || exclude.has(bk) || hexDistance(wk, bk) < 3) continue;
      return [wk, bk];
    }
  }
  return null;
}

function snapshot(g) {
  return JSON.stringify({
    variant: g.variant, fen: g.fen(), start: g.startFen(), ply: g.ply, codes: g.historyCodes(),
    sans: g.historySan(), board: Array.from(g.board()), status: g.status, ep: g.epCell,
    check: g.inCheck, half: g.halfmoveClock, full: g.fullmoveNumber, moves: g.legalMoveCodes(),
  });
}

const F = '[abcdefghikl]';
const R = '(?:1[01]|[1-9])';
const SAN_RE = new RegExp(`^(?:[KQRBN](?:${F}${R}|${F}|${R})?x?${F}${R}|${F}(?:x${F}${R}|${R})(?:=[QRBN])?)[+#]?$`);

function dashedForm(m) {
  return `${m.fromName}${m.isCapture ? 'x' : '-'}${m.toName}${m.promo ? '=' + PIECE_LETTERS[m.promo] : ''}`;
}

function sorted(list) { return [...list].sort((a, b) => a - b); }

// ---------------------------------------------------------------------------------------
// Engine instance shared by most tests (a few tests make their own to control memory).

const WASM_BYTES = fs.readFileSync(WASM_PATH);
const engine = await loadEngine({ bytes: WASM_BYTES });

// =======================================================================================
// 1. ABI surface
// =======================================================================================

test('ABI: imports, exports + arities, version, variants, BigInt perft, null handles', (c) => {
  const imports = WebAssembly.Module.imports(engine.module);
  c.same(imports, [{ module: 'env', name: 'now_ms', kind: 'function' }], 'the only import is env.now_ms');
  const x = engine.x;
  c.ok(x.memory instanceof WebAssembly.Memory, 'memory is exported');
  for (const [name, arity] of Object.entries(SPEC.exports)) {
    if (c.ok(typeof x[name] === 'function', `export ${name} exists`)) c.eq(x[name].length, arity, `${name} parameter count`);
  }
  c.eq(Object.keys(SPEC.exports).length, 35, 'SPEC §7 lists 35 functions');
  c.eq(engine.abiVersion, ABI_VERSION, 'Engine.abiVersion');
  c.eq(x.hc_abi_version(), 1, 'hc_abi_version()');
  c.eq(engine.variantCount(), 2, 'variant count');
  for (let v = 0; v < 2; v++) {
    c.eq(engine.variantName(v), SPEC.names[v], `variant ${v} name`);
    c.eq(engine.stalemateRule(v), SPEC.stalemateRule[v], `variant ${v} stalemate rule`);
  }
  c.same(engine.variants().map((v) => v.name), SPEC.names, 'Engine.variants()');
  c.eq(x.hc_new(2), 0, 'hc_new(bad variant) returns null');
  let threw = false;
  try { engine.newGame(7); } catch (e) { threw = true; }
  c.ok(threw, 'newGame(bad variant) throws');
  const g = engine.newGame(0);
  c.eq(typeof g.perft(1), 'bigint', 'perft returns a BigInt');
  c.eq(g.perft(0), 1n, 'perft(0) = 1');
  c.eq(typeof x.hc_perft(g.ptr, 1), 'bigint', 'raw hc_perft returns a BigInt (i64)');
  c.eq(g.reset(9), false, 'reset(bad variant) fails');
  c.eq(g.fen(), SPEC.startFen[0], 'reset(bad variant) leaves the game unchanged');
  g.destroy();
  threw = false;
  try { g.fen(); } catch (e) { threw = true; }
  c.ok(threw, 'a destroyed HexGame throws instead of touching freed memory');
  // Every handle-taking export must tolerate a null handle (no wasm trap).
  const nullCalls = {
    hc_destroy: [0], hc_reset: [0, 0], hc_variant: [0], hc_load_fen: [0, 0, 0], hc_fen: [0],
    hc_start_fen: [0], hc_board_ptr: [0], hc_turn: [0], hc_status: [0], hc_in_check: [0],
    hc_king_cell: [0, 0], hc_ep_cell: [0], hc_halfmove_clock: [0], hc_fullmove_number: [0],
    hc_gen_moves: [0], hc_moves_ptr: [0], hc_make_move: [0, 0x1234], hc_undo: [0], hc_move_san: [0, 0x1234],
    hc_parse_move: [0, 0, 0], hc_history_len: [0], hc_history_move: [0, 0], hc_history_san: [0, 0],
    hc_perft: [0, 2], hc_eval: [0], hc_search: [0, 1, 0, 0, 0],
  };
  for (const [name, args] of Object.entries(nullCalls)) {
    try { x[name](...args); c.ok(true); } catch (e) { c.fail(`${name}(null handle) trapped: ${e.message}`); }
  }
  c.eq(x.hc_king_cell(0, 0), -1, 'hc_king_cell(null) = -1');
  c.eq(x.hc_ep_cell(0), -1, 'hc_ep_cell(null) = -1');
});

// =======================================================================================
// 2. Start positions
// =======================================================================================

test('start positions: FEN, board, state, move counts + breakdown, perft 1..3 (BigInt)', (c) => {
  for (let v = 0; v < 2; v++) {
    const g = engine.newGame(v);
    const tag = SPEC.names[v];
    c.eq(g.variant, v, `${tag} variant`);
    c.eq(g.variantName, SPEC.names[v], `${tag} variantName`);
    c.eq(g.fen(), SPEC.startFen[v], `${tag} start FEN`);
    c.eq(g.startFen(), SPEC.startFen[v], `${tag} startFen()`);
    c.same(g.board(), parseFenBoard(SPEC.startFen[v]), `${tag} board = frontend parse of the start FEN`);
    c.eq(g.turn, 0, `${tag} White moves first`);
    c.eq(g.status, STATUS.ONGOING, `${tag} status`);
    c.eq(g.inCheck, false, `${tag} not in check`);
    c.eq(g.epCell, -1, `${tag} no e.p.`);
    c.eq(g.halfmoveClock, 0, `${tag} halfmove`);
    c.eq(g.fullmoveNumber, 1, `${tag} fullmove`);
    c.eq(g.ply, 0, `${tag} ply`);
    c.eq(g.kingCell(0), cellIndex('g1'), `${tag} white king on g1`);
    c.eq(g.kingCell(1), cellIndex('g10'), `${tag} black king on g10`);
    const moves = g.legalMoves();
    c.eq(moves.length, Number(SPEC.perft[v][0]), `${tag} legal move count`);
    const count = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0, double: 0 };
    for (const m of moves) {
      count[PIECE_LETTERS[m.piece]]++;
      if (m.isDoubleStep) count.double++;
      c.ok(!m.isCapture && !m.isPromotion && !m.isEnPassant, `${tag} ${m.uci} has no capture/promo/ep flags`);
      c.ok(g.board()[m.from] === m.piece, `${tag} ${m.uci} moving-piece field matches the board`);
    }
    c.same(count, SPEC.breakdown[v], `${tag} d1 breakdown (SPEC §2.4)`);
    c.eq(new Set(moves.map((m) => m.key)).size, moves.length, `${tag} move keys are unique`);
    for (let d = 1; d <= 3; d++) c.eq(g.perft(d), SPEC.perft[v][d - 1], `${tag} perft(${d})`);
    c.eq(g.fen(), SPEC.startFen[v], `${tag} perft leaves the game unchanged`);
    g.destroy();
  }
  // reset() switches variants in place.
  const g = engine.newGame(0);
  g.makeMove('f5f6');
  c.ok(g.reset(1), 'reset(1)');
  c.eq(g.variant, 1, 'reset(1) → McCooey');
  c.eq(g.fen(), SPEC.startFen[1], 'reset(1) → McCooey start');
  c.eq(g.ply, 0, 'reset clears history');
  g.destroy();
});

test('hc_eval is from White\'s point of view (SPEC §7)', (c) => {
  const g = engine.newGame(0);
  const noBlackQ = [
    'b/1bk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1',
    'b/1bk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2',
  ];
  const noWhiteQ = [
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRN1BKNRP1',
    'b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PR1BKRP2',
  ];
  for (let v = 0; v < 2; v++) {
    g.reset(v);
    const e0 = g.eval();
    c.ok(Number.isInteger(e0) && Math.abs(e0) < 100, `${SPEC.names[v]} start eval is small (${e0})`);
    for (const side of ['w', 'b']) {
      c.ok(g.loadFen(`${noBlackQ[v]} ${side} - 0 1`), 'load (black queen missing)');
      c.ok(g.eval() > 500, `${SPEC.names[v]} ${side} to move, Black a queen down: eval ${g.eval()} > +500`);
      c.ok(g.loadFen(`${noWhiteQ[v]} ${side} - 0 1`), 'load (white queen missing)');
      c.ok(g.eval() < -500, `${SPEC.names[v]} ${side} to move, White a queen down: eval ${g.eval()} < -500`);
    }
  }
  g.destroy();
});

// =======================================================================================
// 3. Geometry: frontend cell table (web/js/geometry.js) vs SPEC §1 and vs the engine
// =======================================================================================

test('geometry: frontend cell table matches SPEC §1 (indices, axial, classes, shading, directions)', (c) => {
  c.eq(CELLS.length, 91, '91 cells');
  c.eq(FILES, 'abcdefghikl', 'files (no j)');
  c.same(FILE_OFFSET, [0, 6, 13, 21, 30, 40, 51, 61, 70, 78, 85], 'FILE_OFFSET');
  const idx = { a1: 0, a6: 5, b1: 6, f1: 40, f6: 45, f11: 50, g1: 51, l1: 85, l6: 90 };
  for (const [n, i] of Object.entries(idx)) c.eq(cellIndex(n), i, `index of ${n}`);
  const axial = { f1: [0, 5], f6: [0, 0], f11: [0, -5], a1: [-5, 5], a6: [-5, 0], l1: [5, 0], l6: [5, -5] };
  for (const [n, [q, r]] of Object.entries(axial)) c.same([CELLS[cellIndex(n)].q, CELLS[cellIndex(n)].r], [q, r], `axial of ${n}`);
  for (const cell of CELLS) {
    const fi = FILES.indexOf(cell.name[0]);
    const rank = Number(cell.name.slice(1));
    c.eq(cell.index, FILE_OFFSET[fi] + rank - 1, `index formula for ${cell.name}`);
    c.eq(cell.q, fi - 5, `q of ${cell.name}`);
    c.eq(cell.r, 6 - rank - Math.max(cell.q, 0), `r of ${cell.name}`);
    c.eq(cell.colorClass, (((cell.q - cell.r) % 3) + 3) % 3, `colour class of ${cell.name}`);
    c.eq(cellName(cell.index), cell.name, `cellName(${cell.index})`);
    c.eq(cellFromPoint(cell.x, cell.y), cell.index, `cellFromPoint(centre of ${cell.name})`);
    c.ok(Math.abs(cell.x - 1.5 * cell.q) < 1e-9 && Math.abs(cell.y - SQRT3 * (cell.r + cell.q / 2)) < 1e-9, `screen centre of ${cell.name}`);
  }
  const perFile = FILES.split('').map((f) => CELLS.filter((x) => x.file === f).length);
  c.same(perFile, [6, 7, 8, 9, 10, 11, 10, 9, 8, 7, 6], 'cells per file');
  const classCount = [0, 0, 0];
  for (const cell of CELLS) classCount[cell.colorClass]++;
  c.same(classCount, [31, 30, 30], 'colour class sizes');
  c.same(['f6', 'f1', 'f11'].map((n) => CELLS[cellIndex(n)].colorClass), [0, 1, 2], 'classes of f6/f1/f11');
  c.same([0, 1, 2].map((k) => shadeOfClass(0, k)), ['mid', 'light', 'dark'], 'Gliński shading (§2.2)');
  c.same([0, 1, 2].map((k) => shadeOfClass(1, k)), ['light', 'mid', 'dark'], 'McCooey shading (§2.3)');
  // §1.1 direction table (examples from e4); frontend order N S NE SE NW SW / E W NNE NNW SSE SSW.
  const e4 = cellIndex('e4');
  c.same(DIRS_ORTHO.map(([dq, dr]) => cellName(stepCell(e4, dq, dr))), ['e5', 'e3', 'f5', 'f4', 'd4', 'd3'], 'orthogonal steps from e4');
  c.same(DIRS_DIAG.map(([dq, dr]) => cellName(stepCell(e4, dq, dr))), ['g4', 'c3', 'f6', 'd5', 'f3', 'd2'], 'diagonal steps from e4');
  c.eq(KNIGHT_JUMPS.length, 12, '12 knight jumps');
  for (const [dq, dr] of KNIGHT_JUMPS) {
    const cube = [dq, dr, -dq - dr].map(Math.abs).sort((a, b) => a - b);
    c.same(cube, [1, 2, 3], `knight jump (${dq},${dr}) is a permutation of (3,-1,-2)`);
  }
  // Promotion flags (§2.1): last cell of each file for each side.
  c.same(CELLS.filter((x) => x.whitePromo).map((x) => x.name), 'a6 b7 c8 d9 e10 f11 g10 h9 i8 k7 l6'.split(' '), 'White promotion cells');
  c.same(CELLS.filter((x) => x.blackPromo).map((x) => x.name), 'a1 b1 c1 d1 e1 f1 g1 h1 i1 k1 l1'.split(' '), 'Black promotion cells');
});

test('geometry: engine vs frontend on all 91 cells × N B R Q K (FEN placement, moves, SAN names, classes, layout)', (c) => {
  const g = engine.newGame(0);
  let positions = 0;
  let moveCount = 0;
  for (const type of [PIECE.KNIGHT, PIECE.BISHOP, PIECE.ROOK, PIECE.QUEEN, PIECE.KING]) {
    const letter = PIECE_LETTERS[type];
    for (let i = 0; i < NUM_CELLS; i++) {
      const expected = new Set(emptyBoardTargets(i, type));
      const board = new Int8Array(NUM_CELLS);
      let wk;
      let bk;
      if (type === PIECE.KING) {
        wk = i;
        bk = 0;
        for (let j = 0; j < NUM_CELLS; j++) if (hexDistance(i, j) > hexDistance(i, bk)) bk = j;
        board[wk] = 6;
      } else {
        [wk, bk] = pickKings(new Set([...expected, i]));
        board[i] = type;
        board[wk] = 6;
      }
      board[bk] = -6;
      const fen = fenFromBoard(board, 'w');
      const where = `${letter}${cellName(i)} (K${cellName(wk)} k${cellName(bk)})`;
      positions++;
      if (!c.ok(g.loadFen(fen), `engine accepts ${where}: ${fen}`)) continue;
      c.eq(g.fen(), fen, `engine FEN of ${where} (rank/file order)`);
      c.same(g.board(), board, `engine board of ${where}`);
      c.same(parseFenBoard(g.fen()), g.board(), `frontend parse of engine FEN, ${where}`);
      c.eq(g.kingCell(0), wk, `white king cell, ${where}`);
      c.eq(g.kingCell(1), bk, `black king cell, ${where}`);
      const moves = g.legalMoves().filter((m) => m.from === i);
      const got = new Set(moves.map((m) => m.to));
      const missing = [...expected].filter((t) => !got.has(t)).map(cellName);
      const extra = [...got].filter((t) => !expected.has(t)).map(cellName);
      c.ok(missing.length === 0 && extra.length === 0 && moves.length === expected.size,
        () => `${where}: engine moves differ from frontend geometry; missing [${missing}] extra [${extra}]`);
      for (const m of moves) {
        moveCount++;
        c.eq(m.piece, type, `${where} → ${m.toName}: moving piece`);
        const san = g.san(m.code);
        const bare = (san || '').replace(/[+#]$/, '');
        c.ok(bare === letter + m.toName, () => `${where}: SAN ${san} names destination ${m.toName} (frontend name of index ${m.to})`);
        const parsed = g.parseMove(m.fromName + m.toName);
        c.ok(parsed && parsed.code === m.code, () => `${where}: engine parses frontend names ${m.fromName}${m.toName}`);
        const dx = CELLS[m.to].x - CELLS[i].x;
        const dy = CELLS[m.to].y - CELLS[i].y;
        const dist = Math.hypot(dx, dy);
        if (type === PIECE.BISHOP) {
          c.eq(CELLS[m.to].colorClass, CELLS[i].colorClass, `bishop ${cellName(i)}→${m.toName} keeps its colour class`);
        }
        if (type === PIECE.ROOK && hexDistance(i, m.to) === 1) {
          c.ok(CELLS[m.to].colorClass !== CELLS[i].colorClass, `edge neighbours ${cellName(i)}/${m.toName} differ in colour class`);
          c.ok(Math.abs(dist - SQRT3) < 1e-9, `edge neighbours ${cellName(i)}/${m.toName} are √3 apart on screen`);
        }
        if (type === PIECE.KING) {
          const orth = hexDistance(i, m.to) === 1;
          c.ok(Math.abs(dist - (orth ? SQRT3 : 3)) < 1e-9, `king step ${cellName(i)}→${m.toName} screen distance`);
        }
        if (type === PIECE.KNIGHT) c.ok(Math.abs(dist - Math.sqrt(21)) < 1e-9, `knight jump ${cellName(i)}→${m.toName} screen distance`);
      }
    }
  }
  c.eq(positions, 455, 'positions tested');
  if (VERBOSE) console.log(`     ${positions} positions, ${moveCount} engine moves compared`);
  g.destroy();
});

test('geometry: pawn forward direction, double-step cells, promotion cells (all cells, both variants, both colours)', (c) => {
  const g = engine.newGame(0);
  let tested = 0;
  for (let v = 0; v < 2; v++) {
    for (let color = 0; color < 2; color++) {
      const dbl = new Set(SPEC.doubleStep[v][color].split(' ').map(cellIndex));
      const fwd = color === 0 ? [0, -1] : [0, 1];
      for (let i = 0; i < NUM_CELLS; i++) {
        const own = color === 0 ? CELLS[i].whitePromo : CELLS[i].blackPromo;
        if (own) continue;
        g.reset(v);
        const near = new Set();
        for (let j = 0; j < NUM_CELLS; j++) if (hexDistance(i, j) <= 2) near.add(j);
        const [wk, bk] = pickKings(near);
        const board = new Int8Array(NUM_CELLS);
        board[i] = color === 0 ? 1 : -1;
        board[wk] = 6;
        board[bk] = -6;
        const fen = fenFromBoard(board, color === 0 ? 'w' : 'b');
        const where = `${SPEC.names[v]} ${color ? 'black' : 'white'} pawn ${cellName(i)}`;
        tested++;
        if (!c.ok(g.loadFen(fen), `load ${where}: ${fen}`)) continue;
        c.eq(g.variant, v, 'loadFen keeps the variant');
        const one = stepCell(i, fwd[0], fwd[1]);
        const expected = [];
        const promoCell = one >= 0 && (color === 0 ? CELLS[one].whitePromo : CELLS[one].blackPromo);
        if (one >= 0) {
          if (promoCell) for (const p of [2, 3, 4, 5]) expected.push(`${cellName(i)}${cellName(one)}${PIECE_LETTERS[p].toLowerCase()}`);
          else expected.push(`${cellName(i)}${cellName(one)}`);
          if (dbl.has(i)) expected.push(`${cellName(i)}${cellName(stepCell(one, fwd[0], fwd[1]))}`);
        }
        const moves = g.legalMoves().filter((m) => m.from === i);
        c.same(moves.map((m) => m.uci).sort(), expected.sort(), `${where}: moves`);
        for (const m of moves) {
          c.eq(m.piece, PIECE.PAWN, `${where} piece field`);
          c.eq(m.isPromotion, promoCell, `${where} ${m.uci} promotion flag`);
          c.eq(m.isDoubleStep, m.to !== one, `${where} ${m.uci} double-step flag`);
          // Screen orientation: White's pawns go up the screen, Black's down; same file.
          c.ok(CELLS[m.to].x === CELLS[i].x && (color === 0 ? CELLS[m.to].y < CELLS[i].y : CELLS[m.to].y > CELLS[i].y),
            `${where} ${m.uci} moves ${color ? 'down' : 'up'} its file on screen`);
          if (m.isDoubleStep) {
            c.ok(g.makeMove(m.code), `${where} make ${m.uci}`);
            c.eq(g.fen().split(' ')[2], cellName(one), `${where} FEN e.p. field after ${m.uci}`);
            g.undo();
          }
        }
      }
    }
  }
  c.eq(tested, 2 * 2 * 80, 'pawn placements tested');
  g.destroy();
});

test('geometry: pawn capture directions per variant/colour (SPEC §2.2/§2.3) and start-bishop colour classes', (c) => {
  const g = engine.newGame(0);
  const f6 = cellIndex('f6');
  const ring = [...DIRS_ORTHO, ...DIRS_DIAG].map(([dq, dr]) => stepCell(f6, dq, dr));
  for (let v = 0; v < 2; v++) {
    for (let color = 0; color < 2; color++) {
      const board = new Int8Array(NUM_CELLS);
      const s = color === 0 ? 1 : -1;
      board[f6] = s;
      for (const n of ring) board[n] = -s; // enemy pawns on all 12 neighbouring cells
      board[cellIndex('a1')] = 6;
      board[cellIndex('l6')] = -6;
      g.reset(v);
      const where = `${SPEC.names[v]} ${color ? 'black' : 'white'} pawn f6`;
      if (!c.ok(g.loadFen(fenFromBoard(board, color ? 'b' : 'w')), `load ${where}`)) continue;
      const got = g.legalMoves().filter((m) => m.from === f6).map((m) => m.toName).sort();
      const want = SPEC.captureDirs[v][color].map(([dq, dr]) => cellName(stepCell(f6, dq, dr))).sort();
      c.same(got, want, `${where} captures exactly in the SPEC directions`);
    }
  }
  for (let v = 0; v < 2; v++) {
    g.reset(v);
    const b = g.board();
    for (const s of [1, -1]) {
      const classes = [];
      for (let i = 0; i < NUM_CELLS; i++) if (b[i] === 3 * s) classes.push(CELLS[i].colorClass);
      c.same(classes.sort(), [0, 1, 2], `${SPEC.names[v]} ${s > 0 ? 'White' : 'Black'} bishops stand on 3 colour classes`);
    }
  }
  g.destroy();
});

// =======================================================================================
// 4. Rules examples (SPEC §2.4) through the wrapper
// =======================================================================================

test('rules: SPEC §2.4 pawn examples (e4xf5 then f5-f7, b5xc6 e.p., McCooey d5xe7 e.p.), promotion', (c) => {
  const g = engine.newGame(0);
  // Gliński: after e4xf5 the pawn may double-step f5-f7.
  c.ok(g.loadFen(fenFrom({ g1: 'K', g10: 'k', e4: 'P', f5: 'n' })), 'load e4xf5 position');
  c.ok(g.makeMove('exf5'), 'exf5');
  const kingMove = g.legalMoves().find((m) => m.piece === PIECE.KING && !['f6', 'f7'].includes(m.toName));
  c.ok(g.makeMove(kingMove.code), 'a black king move');
  const ds = g.parseMove('f5f7');
  c.ok(ds && ds.isDoubleStep, 'f5-f7 is a legal double step after e4xf5');
  c.ok(g.makeMove(ds.code), 'play f5-f7');
  c.eq(g.fen().split(' ')[2], 'f6', 'e.p. field f6 after f5-f7');
  c.eq(g.historySanAt(2), 'f7', 'SAN f7');

  // Gliński: c7-c5 b5xc6 e.p.
  c.ok(g.loadFen(fenFrom({ g1: 'K', g10: 'k', b5: 'P', c7: 'p' }, 'b')), 'load c7-c5 position');
  c.ok(g.makeMove('c7c5'), 'c7-c5');
  c.eq(g.epCell, cellIndex('c6'), 'hc_ep_cell = c6');
  const ep = g.legalMoves().find((m) => m.uci === 'b5c6');
  c.ok(ep && ep.isEnPassant && ep.isCapture && ep.captured === PIECE.PAWN, 'b5xc6 is en passant (capture flag, captured pawn)');
  const before = g.board();
  c.eq(g.san(ep), 'bxc6', 'SAN of the e.p. capture');
  c.ok(g.makeMove(ep), 'play b5xc6 e.p.');
  const after = g.board();
  c.ok(after[cellIndex('c5')] === 0 && after[cellIndex('c6')] === 1 && after[cellIndex('b5')] === 0, 'e.p. removes the c5 pawn');
  c.ok(g.undo(), 'undo e.p.');
  c.same(g.board(), before, 'undo restores the e.p. victim');
  // e.p. only immediately: after another pair of moves it is gone.
  g.makeMove(g.legalMoves().find((m) => m.piece === PIECE.KING).code);
  g.makeMove(g.legalMoves().find((m) => m.piece === PIECE.KING).code);
  c.ok(!g.legalMoves().some((m) => m.isEnPassant), 'e.p. expires after one ply');

  // McCooey: e8-e6 d5xe7 e.p.
  g.reset(1);
  c.ok(g.loadFen(fenFrom({ g1: 'K', g10: 'k', d5: 'P', e8: 'p' }, 'b')), 'load McCooey e8-e6 position');
  c.ok(g.makeMove('e8e6'), 'e8-e6');
  const ep2 = g.parseMove('d5e7');
  c.ok(ep2 && ep2.isEnPassant, 'd5xe7 e.p. in McCooey');
  c.ok(g.makeMove(ep2), 'play d5xe7');
  c.eq(g.board()[cellIndex('e6')], 0, 'McCooey e.p. removes e6');

  // Start-position double-step rules.
  g.reset(1);
  c.eq(g.parseMove('f4f6'), null, 'McCooey f-pawn may not double step');
  c.ok(g.parseMove('f4f5') !== null, 'McCooey f4-f5');
  c.ok(g.parseMove('e3e5') !== null, 'McCooey e3-e5 double step');
  g.reset(0);
  c.eq(g.parseMove('f5f7'), null, 'Gliński f5-f7 blocked by f7 at the start');

  // Promotion (Gliński White f10-f11, both forms; no default piece).
  c.ok(g.loadFen(fenFrom({ b1: 'K', l1: 'k', f10: 'P' })), 'load promotion position');
  const promos = g.legalMoves().filter((m) => m.from === cellIndex('f10'));
  c.same(promos.map((m) => m.promo).sort(), [2, 3, 4, 5], 'four promotion choices');
  c.ok(promos.every((m) => m.isPromotion && m.toName === 'f11'), 'promotion flags');
  c.eq(g.parseMove('f10f11'), null, 'f10f11 without a piece is ambiguous');
  c.eq(g.parseMove('f11'), null, 'f11 without a piece is ambiguous');
  c.eq(g.parseMove('f10f11q')?.promo, 5, 'f10f11q');
  c.eq(g.parseMove('f10-f11=N')?.promo, 2, 'f10-f11=N');
  c.eq(g.parseMove('f11=R')?.promo, 4, 'f11=R');
  c.eq(g.makeMove(encodeMove(cellIndex('f10'), cellIndex('f11'), 0)), false, 'no default queen');
  c.ok(g.makeMove(encodeMove(cellIndex('f10'), cellIndex('f11'), 5)), 'promote to queen');
  c.eq(g.board()[cellIndex('f11')], 5, 'queen on f11');
  c.ok(/^f11=Q[+#]?$/.test(g.historySanAt(0)), `SAN ${g.historySanAt(0)}`);
  g.undo();
  c.ok(g.makeMove('f10f11n') && g.board()[cellIndex('f11')] === 2, 'under-promotion to a knight');
  // Black promotes on rank 1.
  c.ok(g.loadFen(fenFrom({ a6: 'K', l6: 'k', f2: 'p' }, 'b')), 'load black promotion position');
  c.same(g.legalMoves().filter((m) => m.from === cellIndex('f2')).map((m) => m.uci).sort(), ['f2f1b', 'f2f1n', 'f2f1q', 'f2f1r'], 'Black promotes on f1');
  // McCooey e9: four pushes + four capture-promotions.
  g.reset(1);
  c.ok(g.loadFen(fenFrom({ g1: 'K', l6: 'k', e9: 'P', f11: 'r' })), 'load McCooey e9 position');
  const e9 = g.legalMoves().filter((m) => m.from === cellIndex('e9'));
  c.eq(e9.length, 8, 'McCooey e9: 4 promotions on e10 + 4 capture-promotions on f11');
  const capPromo = g.parseMove('exf11=N');
  c.ok(capPromo && capPromo.isCapture && capPromo.isPromotion && capPromo.captured === PIECE.ROOK, 'exf11=N flags');
  c.ok(g.makeMove(capPromo) && g.board()[cellIndex('f11')] === 2, 'exf11=N played');
  g.destroy();
});

// =======================================================================================
// 5. make / undo / history / SAN round trips
// =======================================================================================

test('make/undo/history/SAN round trips over random games (both variants)', (c) => {
  const rng = makeRng(20261102);
  let plies = 0;
  let movesChecked = 0;
  let games = 0;
  for (let v = 0; v < 2; v++) {
    for (let n = 0; n < 4; n++) {
      games++;
      const g = engine.newGame(v);
      const fens = [g.fen()];
      const codes = [];
      for (let ply = 0; ply < 130; ply++) {
        const legal = g.legalMoves();
        const st = g.status;
        if (legal.length === 0) {
          c.ok(st === STATUS.CHECKMATE || st === STATUS.STALEMATE, `no legal moves ⇒ mate/stalemate (status ${st})`);
          c.eq(st === STATUS.CHECKMATE, g.inCheck, 'checkmate iff in check');
          break;
        }
        if (st !== STATUS.ONGOING) break; // automatic draw
        c.eq(new Set(legal.map((m) => m.key)).size, legal.length, 'legal move keys unique');
        const board = g.board();
        const turnSign = g.turn === 0 ? 1 : -1;
        for (const m of legal) {
          movesChecked++;
          c.ok(board[m.from] === turnSign * m.piece, () => `${m.uci}: moving piece ${m.piece} is on ${m.fromName}`);
          const capturedOnBoard = m.isEnPassant ? PIECE.PAWN : Math.abs(board[m.to]);
          c.ok(m.captured === capturedOnBoard && m.isCapture === (capturedOnBoard !== 0), () => `${m.uci}: captured field`);
          const san = g.san(m.code);
          if (!c.ok(typeof san === 'string' && SAN_RE.test(san), () => `SAN "${san}" of ${m.uci} is well formed`)) continue;
          c.ok(m.piece === PIECE.PAWN ? san[0] === m.fromName[0] : san[0] === PIECE_LETTERS[m.piece], () => `SAN ${san} leads with the right letter`);
          c.ok(san.includes('x') === m.isCapture, () => `SAN ${san}: 'x' iff capture`);
          c.ok(san.includes('=') === m.isPromotion, () => `SAN ${san}: '=' iff promotion`);
          for (const text of [san, san.replace(/[+#]$/, ''), m.uci, dashedForm(m)]) {
            const p = g.parseMove(text);
            c.ok(p !== null && p.code === m.code, () => `parseMove("${text}") → ${p && p.uci}, expected ${m.uci}`);
          }
        }
        // Illegal codes are refused without changing anything.
        for (let k = 0; k < 3; k++) {
          const bad = encodeMove(Math.floor(rng() * 91), Math.floor(rng() * 91), 0);
          if (legal.some((m) => m.key === bad)) continue;
          c.eq(g.makeMove(bad), false, `illegal ${decodeMove(bad).uci} refused`);
        }
        c.eq(g.fen(), fens[fens.length - 1], 'refused moves leave the game unchanged');
        const m = pick(rng, legal);
        const san = g.san(m.code);
        // Half the time submit only from/to/promo (flags and info bits stripped, §4).
        c.ok(g.makeMove(rng() < 0.5 ? m.key : m.code), `make ${m.uci}`);
        plies++;
        codes.push(m.code);
        c.eq(g.ply, ply + 1, 'ply after make');
        c.eq(g.historyMove(ply), m.code, 'hc_history_move = the generated move code');
        c.eq(g.historySanAt(ply), san, 'hc_history_san = SAN as played');
        c.eq(g.inCheck, /[+#]$/.test(san), () => `check flag vs SAN suffix (${san})`);
        c.eq(g.status === STATUS.CHECKMATE, san.endsWith('#'), () => `'#' iff checkmate (${san})`);
        c.eq(g.turn, (ply + 1) % 2, 'side to move alternates');
        const fen = g.fen();
        c.same(parseFenBoard(fen), g.board(), 'frontend parse of FEN = board');
        fens.push(fen);
      }
      c.same(g.historyCodes(), codes, 'historyCodes()');
      c.same(g.history().map((h) => h.code), codes, 'history()');
      // FEN round trip into a second game: same position, same legal moves.
      const g2 = engine.newGame(v);
      c.ok(g2.loadFen(g.fen()), 'reload current FEN');
      c.eq(g2.fen(), g.fen(), 'FEN round trip');
      c.same(sorted(g2.legalMoveCodes()), sorted(g.legalMoveCodes()), 'same legal moves after FEN round trip');
      // replay() reproduces the game.
      c.ok(g2.replay(v, '', codes), 'replay(variant, "", codes)');
      c.eq(g2.fen(), g.fen(), 'replayed FEN');
      c.same(g2.historySan(), g.historySan(), 'replayed SAN list');
      g2.destroy();
      // Undo everything, checking each FEN on the way back.
      for (let k = fens.length - 1; k > 0; k--) {
        c.eq(g.fen(), fens[k], `FEN before undo #${k}`);
        c.ok(g.undo(), `undo #${k}`);
      }
      c.eq(g.fen(), fens[0], 'back at the start');
      c.eq(g.ply, 0, 'history empty');
      c.eq(g.undo(), false, 'undo with no history fails');
      g.destroy();
    }
  }
  if (VERBOSE) console.log(`     ${games} games, ${plies} plies, ${movesChecked} legal moves round-tripped`);
  c.ok(plies > 300, `enough plies played (${plies})`);
});

// =======================================================================================
// 6. Game status (SPEC §2.4 fixtures, fool's mate, §6 draws and precedence)
// =======================================================================================

test('status: SPEC §2.4 hexchess.club fixtures', (c) => {
  const g = engine.newGame(0);
  // The first three fixtures have no black king, which §7 says hc_load_fen must reject;
  // they are checked with a black king added on a1 (far from the action).
  const fixtures = [
    ['K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1', true, STATUS.ONGOING, 'check, not mate'],
    ['K/3/5/3q3/2q6/11/11/11/11/11/11 w - 0 1', true, STATUS.ONGOING, 'check, not mate'],
    ['K/3/2q2/3q3/9/11/11/11/11/11/11 w - 1 2', true, STATUS.CHECKMATE, 'checkmate'],
    ['k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1', false, STATUS.ONGOING, 'not stalemate'],
    ['k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1', false, STATUS.STALEMATE, 'stalemate'],
  ];
  for (const [fen, check, status, what] of fixtures) {
    let load = fen;
    if (!fen.includes('k')) {
      c.eq(g.loadFen(fen), false, `fixture without a black king is rejected (§7): ${fen}`);
      load = fen.replace(/\/11 ([wb]) /, '/k10 $1 ');
    }
    if (!c.ok(g.loadFen(load), `load ${load}`)) continue;
    c.eq(g.inCheck, check, `${what}: in check`);
    c.eq(g.status, status, `${what}: status`);
    c.eq(g.legalMoveCodes().length === 0, status !== STATUS.ONGOING, `${what}: has legal moves`);
  }
  g.destroy();
});

test('status: Gliński fool\'s mate (SPEC §2.4), SAN + coordinate input, game over', (c) => {
  // SPEC §2.4 prints rank 3 of the final FEN as "3P1B1P3", but 3.Bf3-b1 has just moved that
  // bishop away, so the correct rank is "3P3P3" (SPEC typo; everything else matches).
  const FINAL = 'b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4';
  const sans = ['Qc3', 'Qc6', 'b2', 'b6', 'Bb1', 'e6', 'Qxf9#'];
  const coords = ['e1-c3', 'e10-c6', 'b1-b2', 'b7-b6', 'f3-b1', 'e7-e6', 'c3xf9'];
  for (const [label, list] of [['SAN', sans], ['coordinates', coords]]) {
    const g = engine.newGame(0);
    for (const text of list) c.ok(g.makeMove(text), `${label}: ${text}`);
    c.eq(g.status, STATUS.CHECKMATE, `${label}: checkmate`);
    c.eq(g.inCheck, true, `${label}: in check`);
    c.eq(g.fen(), FINAL, `${label}: final FEN`);
    c.same(g.historySan(), sans, `${label}: SAN history`);
    c.eq(g.legalMoveCodes().length, 0, `${label}: no legal moves`);
    const res = g.search({ maxDepth: 2 });
    c.eq(res.code, 0, `${label}: search returns 0 when the game is over`);
    c.same(res.info, { depth: 0, score: 0, nodes: 0, ms: 0, pv: [] }, `${label}: zeroed search info`);
    c.ok(g.undo(), 'undo the mate');
    c.eq(g.status, STATUS.ONGOING, 'ongoing again');
    const mate = g.search({ maxDepth: 2 });
    c.eq(g.san(mate.code), 'Qxf9#', 'search finds Qxf9#');
    c.eq(mate.info.score, MATE - 1, 'mate-in-1 score = 30000 - 1');
    g.destroy();
  }
});

/** Four knight moves (side to move, other side, then both back) that restore the position. */
function findShuffle(g) {
  let cycle = null;
  for (const a of g.legalMoves().filter((m) => m.piece === PIECE.KNIGHT)) {
    g.makeMove(a.code);
    for (const b of g.legalMoves().filter((m) => m.piece === PIECE.KNIGHT)) {
      g.makeMove(b.code);
      const ar = g.parseMove(a.toName + a.fromName);
      if (ar) {
        g.makeMove(ar.code);
        const br = g.parseMove(b.toName + b.fromName);
        g.undo();
        if (br && !cycle) cycle = [a.uci, b.uci, ar.uci, br.uci];
      }
      g.undo();
      if (cycle) break;
    }
    g.undo();
    if (cycle) break;
  }
  return cycle;
}

test('status: threefold with e.p. availability in the repetition key (SPEC §5.1/§6)', (c) => {
  // (1) A raw e.p. field that no pawn can use does not make a position different:
  //     1.c2-c4 (FEN e.p. c3, not capturable) then two knight shuffles → 3rd occurrence.
  const g = engine.newGame(0);
  c.ok(g.makeMove('c2c4'), 'c2-c4');
  c.eq(g.fen().split(' ')[2], 'c3', 'FEN shows the raw e.p. cell');
  c.eq(g.epCell, -1, 'but no e.p. capture is available');
  const cycle = findShuffle(g);
  if (c.ok(cycle, 'knight shuffle after c2-c4')) {
    [...cycle, ...cycle].forEach((mv, k) => {
      c.ok(g.makeMove(mv), `shuffle ${mv}`);
      c.eq(g.status, k === 7 ? STATUS.DRAW_THREEFOLD : STATUS.ONGOING, `status after shuffle ply ${k + 1} (unusable e.p. field ignored)`);
    });
  }
  // (2) A usable e.p. capture makes the position distinct: after c7-c5 with a white pawn on
  //     b5, the position P0 (White to move, b5xc6 e.p. possible) differs from the same
  //     board later. Shuffling W,B,W,B twice returns to that board at plies 4 and 8, which
  //     must NOT be a threefold (an engine keying on the board alone would stop at ply 8);
  //     the first true triple is the position after White's first shuffle move (plies 1, 5, 9).
  c.ok(g.loadFen(fenFrom({ g1: 'K', g10: 'k', b5: 'P', c7: 'p', d1: 'N', d9: 'n' }, 'b')), 'load e.p. repetition position');
  c.ok(g.makeMove('c7c5'), 'c7-c5');
  c.eq(g.epCell, cellIndex('c6'), 'b5xc6 e.p. available');
  const cycle2 = findShuffle(g);
  if (c.ok(cycle2, 'knight shuffle with e.p. pending')) {
    const seq = [...cycle2, ...cycle2, cycle2[0]];
    seq.forEach((mv, k) => {
      c.ok(g.makeMove(mv), `shuffle ${mv}`);
      c.eq(g.status, k === 8 ? STATUS.DRAW_THREEFOLD : STATUS.ONGOING, `status after shuffle ply ${k + 1} (usable e.p. counts)`);
    });
  }
  g.destroy();
});

test('status: threefold, fifty-move (and mate on the 100th ply), insufficient material, precedence', (c) => {
  // Threefold: find a knight shuffle for each side and repeat it (§6, automatic draw).
  for (let v = 0; v < 2; v++) {
    const g = engine.newGame(v);
    const cycle = findShuffle(g);
    if (!c.ok(cycle, `${SPEC.names[v]}: found a knight shuffle`)) continue;
    const seq = [...cycle, ...cycle];
    seq.forEach((mv, k) => {
      c.ok(g.makeMove(mv), `${SPEC.names[v]} shuffle ${mv}`);
      c.eq(g.status, k === 7 ? STATUS.DRAW_THREEFOLD : STATUS.ONGOING, `${SPEC.names[v]} status after ply ${k + 1}`);
    });
    c.eq(g.makeMove(cycle[0]), false, 'no moves after an automatic draw');
    c.ok(g.undo(), 'undo the repeating move');
    c.eq(g.status, STATUS.ONGOING, 'undo leaves the draw');
    g.destroy();
  }
  const g = engine.newGame(0);
  // Fifty-move rule: clock 99 + a quiet move = draw; a pawn move resets; a mate on the
  // 100th ply is a win (§2.1 precedence).
  c.ok(g.loadFen(fenFrom({ f1: 'K', c6: 'Q', f11: 'k', a2: 'P' }, 'w', '-', 99, 80)), 'load clock-99 position');
  const quiet = g.legalMoves().find((m) => m.piece === PIECE.KING);
  c.ok(g.makeMove(quiet.code), `quiet ${quiet.uci}`);
  c.eq(g.halfmoveClock, 100, 'clock 100');
  c.eq(g.status, STATUS.DRAW_FIFTY_MOVE, 'fifty-move draw');
  g.undo();
  c.ok(g.makeMove('a2a3'), 'pawn move');
  c.eq(g.halfmoveClock, 0, 'pawn move resets the clock');
  c.eq(g.status, STATUS.ONGOING, 'no draw after a pawn move');
  g.undo();
  c.ok(g.makeMove('Qf9'), 'Qc6-f9');
  c.eq(g.halfmoveClock, 100, 'the mating move is the 100th quiet ply');
  c.eq(g.status, STATUS.CHECKMATE, 'checkmate beats the fifty-move rule');
  c.eq(g.historySanAt(0), 'Qf9#', 'SAN Qf9#');
  c.ok(g.loadFen(fenFrom({ f1: 'K', c6: 'Q', f11: 'k' }, 'w', '-', 100, 80)), 'load clock-100 position');
  c.eq(g.status, STATUS.DRAW_FIFTY_MOVE, 'a loaded clock of 100 is already a draw');
  // Insufficient material: exactly the classical list K v K, K+N v K, K+B v K (§2.1).
  const material = [
    [{}, STATUS.DRAW_INSUFFICIENT, 'K v K'],
    [{ a1: 'N' }, STATUS.DRAW_INSUFFICIENT, 'K+N v K'],
    [{ a1: 'b' }, STATUS.DRAW_INSUFFICIENT, 'K v K+B'],
    [{ a1: 'R' }, STATUS.ONGOING, 'K+R v K'],
    [{ a2: 'P' }, STATUS.ONGOING, 'K+P v K'],
    [{ a2: 'Q' }, STATUS.ONGOING, 'K+Q v K'],
    [{ a1: 'N', l6: 'n' }, STATUS.ONGOING, 'K+N v K+N'],
    [{ a2: 'B', l5: 'b' }, STATUS.ONGOING, 'K+B v K+B'],
    [{ a1: 'N', a2: 'N' }, STATUS.ONGOING, 'K+N+N v K'],
  ];
  for (const [extra, status, what] of material) {
    for (let v = 0; v < 2; v++) {
      g.reset(v);
      c.ok(g.loadFen(fenFrom({ f1: 'K', f11: 'k', ...extra })), `load ${what}`);
      c.eq(g.status, status, `${SPEC.names[v]} ${what}`);
    }
  }
  // Precedence: stalemate / checkmate beat insufficient material and the fifty-move rule.
  for (let v = 0; v < 2; v++) {
    g.reset(v);
    c.ok(g.loadFen(fenFrom({ f9: 'K', f11: 'k' }, 'b', '-', 150, 90)), 'load bare-king stalemate');
    c.eq(g.status, STATUS.STALEMATE, `${SPEC.names[v]}: K f9 v k f11 (Black to move) is stalemate, not a material draw`);
    c.ok(g.loadFen(fenFrom({ f9: 'K', h7: 'B', f11: 'k' }, 'b')), 'load K+B mate');
    c.eq(g.status, STATUS.CHECKMATE, `${SPEC.names[v]}: K+B v K checkmate beats insufficient material`);
    c.eq(g.engine.stalemateRule(v), SPEC.stalemateRule[v], 'stalemate scoring rule');
  }
  g.destroy();
});

// =======================================================================================
// 7. hc_load_fen error handling
// =======================================================================================

test('loadFen: malformed / illegal FENs are rejected and leave the game unchanged', (c) => {
  const START = SPEC.startFen[0];
  const board = START.split(' ')[0];
  const ranks = board.split('/');
  const withRank = (k, text) => ranks.map((r, i) => (i === k ? text : r)).join('/');
  const bad = [
    ['empty', ''],
    ['whitespace', '   '],
    ['garbage', 'hello world'],
    ['board only (side missing)', board],
    ['10 ranks', ranks.slice(1).join('/') + ' w - 0 1'],
    ['12 ranks', '1/' + board + ' w - 0 1'],
    ['rank with too many cells', withRank(5, '12') + ' w - 0 1'],
    ['rank with too few cells', withRank(5, '10') + ' w - 0 1'],
    ['rank 11 with 2 cells', withRank(0, '2') + ' w - 0 1'],
    ['empty rank string', withRank(5, '') + ' w - 0 1'],
    ['bad piece letter', withRank(5, '5x5') + ' w - 0 1'],
    ['zero count', withRank(5, '0P10') + ' w - 0 1'],
    ['bad side', board + ' x - 0 1'],
    ['e.p. on a j file', board + ' w j5 0 1'],
    ['e.p. off the board', board + ' w a7 0 1'],
    ['e.p. garbage', board + ' w e44 0 1'],
    ['halfmove not a number', board + ' w - x 1'],
    ['halfmove negative', board + ' w - -1 1'],
    ['fullmove 0 (starts at 1)', board + ' w - 0 0'],
    ['fullmove not a number', board + ' w - 0 one'],
    ['six fields', board + ' w - 0 1 extra'],
    ['no white king', fenFrom({ f11: 'k', a1: 'Q' })],
    ['no black king', fenFrom({ f1: 'K', a1: 'q' })],
    ['two white kings', fenFrom({ f1: 'K', a1: 'K', f11: 'k' })],
    ['two black kings', fenFrom({ f1: 'K', l6: 'k', f11: 'k' })],
    ['white pawn on f11', fenFrom({ f1: 'K', a6: 'k', f11: 'P' })],
    ['white pawn on l6', fenFrom({ f1: 'K', a6: 'k', l6: 'P' })],
    ['black pawn on f1', fenFrom({ a1: 'K', f11: 'k', f1: 'p' })],
    ['black pawn on a1', fenFrom({ l1: 'K', f11: 'k', a1: 'p' })],
    ['side not to move in check', fenFrom({ f1: 'K', f11: 'k', f5: 'R' }, 'w')],
    ['adjacent kings', fenFrom({ f5: 'K', f6: 'k' })],
    ['adjacent kings (diagonal)', fenFrom({ e4: 'K', f6: 'k' })],
    ['non-ASCII', 'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w – 0 1'],
    ['Gliński in a board field', 'Gliński w - 0 1'],
    ['NUL byte', board + ' w\u0000 - 0 1'],
    ['100 KB of junk', 'x'.repeat(100 * 1024)],
    ['a FEN repeated', `${START} ${START}`],
  ];
  const g = engine.newGame(0);
  g.makeMove('f5f6');
  g.makeMove('e7e6');
  const before = snapshot(g);
  const lastError = typeof engine.x.hc_last_error === 'function';
  for (const [what, fen] of bad) {
    c.eq(g.loadFen(fen), false, `reject ${what}`);
    c.eq(snapshot(g), before, `game unchanged after rejecting ${what}`);
    if (lastError) c.ok(engine.readString(engine.x.hc_last_error()).length > 0, `hc_last_error explains ${what}`);
  }
  // Valid inputs.
  c.ok(g.loadFen(board + ' w'), 'board + side only');
  c.eq(g.fen(), START, 'missing fields default to "- 0 1"');
  c.eq(g.ply, 0, 'history cleared');
  c.ok(g.loadFen(`  ${START}  `), 'surrounding whitespace is fine');
  const afterDouble = (() => { const t = engine.newGame(0); t.makeMove('c2c4'); const f = t.fen(); t.destroy(); return f; })();
  c.eq(afterDouble.split(' ')[2], 'c3', 'FEN writes the e.p. cell after any double step (§5.1)');
  c.ok(g.loadFen(afterDouble), 'load a FEN with a consistent e.p. cell');
  c.eq(g.fen(), afterDouble, 'consistent e.p. cell kept');
  c.eq(g.startFen(), afterDouble, 'loaded FEN becomes the start FEN');
  c.eq(g.epCell, -1, 'hc_ep_cell = -1 when no e.p. capture is possible');
  c.ok(g.loadFen(afterDouble.replace(' c3 ', ' d3 ')), 'a valid but inconsistent e.p. cell is not an error');
  c.eq(g.fen().split(' ')[2], '-', 'inconsistent e.p. cell silently dropped');
  if (lastError) c.eq(engine.x.hc_last_error(), 0, 'hc_last_error empty after a success');
  g.destroy();
});

// =======================================================================================
// 8. Search at the SPEC §9.3 strength levels 1–4
// =======================================================================================

test('search: §9.3 level table; levels 1–4 return a legal move in time and leave the game unchanged', (c) => {
  c.same(LEVELS.map((l) => (l ? [l.maxDepth, l.timeMs, l.noise] : null)), SPEC.levels, 'ai-client LEVELS = SPEC §9.3 table');
  const rng = makeRng(99);
  const positions = [];
  for (let v = 0; v < 2; v++) {
    positions.push({ label: `${SPEC.names[v]} start`, variant: v, moves: [] });
    const g = engine.newGame(v);
    for (let k = 0; k < 24 && g.status === STATUS.ONGOING; k++) g.makeMove(pick(rng, g.legalMoveCodes()));
    positions.push({ label: `${SPEC.names[v]} after 24 random plies`, variant: v, moves: g.historyCodes() });
    g.destroy();
  }
  const foolsPre = engine.newGame(0);
  ['Qc3', 'Qc6', 'b2', 'b6', 'Bb1', 'e6'].forEach((s) => foolsPre.makeMove(s));
  positions.push({ label: 'mate in 1 (Qxf9#)', variant: 0, moves: foolsPre.historyCodes(), mateSan: 'Qxf9#' });
  foolsPre.destroy();
  for (let level = 1; level <= 4; level++) {
    const { maxDepth, timeMs, noise } = LEVELS[level];
    for (const [k, p] of positions.entries()) {
      const g = engine.newGame(p.variant);
      p.moves.forEach((m) => g.makeMove(m));
      const before = snapshot(g);
      const legal = g.legalMoveCodes();
      const t0 = performance.now();
      const res = g.search({ maxDepth, timeMs, noise, seed: level * 100 + k });
      const ms = performance.now() - t0;
      const where = `level ${level} on ${p.label}`;
      c.ok(res.code !== 0 && legal.includes(res.code), () => `${where}: returns a legal move (got ${res.code})`);
      c.eq(snapshot(g), before, `${where}: game unchanged`);
      const budget = (timeMs || 0) + 1500;
      c.ok(ms < budget, () => `${where}: took ${ms.toFixed(0)} ms (budget ${budget} ms)`);
      c.ok(res.info.depth >= 1 && (maxDepth === 0 || res.info.depth <= maxDepth), () => `${where}: depth ${res.info.depth}`);
      c.ok(res.info.nodes > 0, `${where}: nodes counted`);
      c.ok(Math.abs(res.info.score) <= MATE, `${where}: score in range`);
      c.ok(res.info.pv.length >= 1 && res.info.pv[0] === res.code, `${where}: PV starts with the move`);
      const replay = engine.newGame(p.variant);
      p.moves.forEach((m) => replay.makeMove(m));
      c.ok(res.info.pv.every((m) => replay.makeMove(m)), `${where}: PV is a legal sequence`);
      replay.destroy();
      if (p.mateSan) {
        c.eq(g.san(res.code), p.mateSan, `${where}: finds the mate`);
        c.eq(res.info.score, MATE - 1, `${where}: mate score (un-noised)`);
      }
      if (VERBOSE) console.log(`     ${where}: ${g.san(res.code)} depth ${res.info.depth} score ${res.info.score} ${res.info.nodes} nodes ${ms.toFixed(0)} ms`);
      g.destroy();
    }
  }
  // Depth-bounded searches with noise are deterministic per seed (§7).
  const g = engine.newGame(1);
  const a = g.search({ maxDepth: 2, noise: 120, seed: 5 });
  const b = g.search({ maxDepth: 2, noise: 120, seed: 5 });
  c.eq(a.code, b.code, 'same seed → same move');
  g.destroy();
});

// =======================================================================================
// 9. AI worker protocol (§8.2) and the AiClient, run in Node
// =======================================================================================

/** Runs web/js/ai-worker.js in a VM context; messages are delivered asynchronously. */
class SimWorker {
  constructor(url) {
    const src = fs.readFileSync(path.join(ROOT, 'web', url), 'utf8');
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    const self = {
      postMessage: (data) => setTimeout(() => { if (!this.terminated && this.onmessage) this.onmessage({ data }); }, 0),
    };
    this.self = self;
    vm.runInContext(src, vm.createContext({ self, TextEncoder, WebAssembly, performance }), { filename: url });
    SimWorker.created++;
  }
  postMessage(data) {
    if (this.terminated) return;
    setTimeout(() => { if (!this.terminated) this.self.onmessage({ data }); }, 0);
  }
  terminate() { this.terminated = true; SimWorker.terminated++; }
}
SimWorker.created = 0;
SimWorker.terminated = 0;

test('AI worker protocol (§8.2): init → ready, search → result rebuilt from startFen + moves, errors', async (c) => {
  const w = new SimWorker('js/ai-worker.js');
  const inbox = [];
  w.onmessage = (e) => inbox.push(e.data);
  const next = async () => {
    for (let k = 0; k < 2000 && inbox.length === 0; k++) await new Promise((r) => setTimeout(r, 1));
    return inbox.shift();
  };
  w.postMessage({ type: 'search', id: 1, variant: 0, startFen: '', moves: [], maxDepth: 1, timeMs: 0, noise: 0, seed: 0 });
  const early = await next();
  c.ok(early && early.type === 'error' && early.id === 1, 'search before init → error');
  w.postMessage({ type: 'init', module: engine.module });
  c.eq((await next())?.type, 'ready', 'ready after init');
  const rng = makeRng(7);
  for (let v = 0; v < 2; v++) {
    const g = engine.newGame(v);
    for (let k = 0; k < 10; k++) g.makeMove(pick(rng, g.legalMoveCodes()));
    for (const startFen of ['', g.startFen()]) {
      w.postMessage({ type: 'search', id: 10 + v, variant: v, startFen, moves: g.historyCodes(), maxDepth: 3, timeMs: 0, noise: 0, seed: 3 });
      const r = await next();
      c.ok(r && r.type === 'result' && r.id === 10 + v, `${SPEC.names[v]}: result with the request id`);
      c.ok(g.legalMoveCodes().includes(r.move), `${SPEC.names[v]}: worker move is legal in the real game`);
      const local = g.search({ maxDepth: 3, timeMs: 0, noise: 0, seed: 3 });
      c.eq(r.move, local.code, `${SPEC.names[v]}: worker (rebuilt game) and main thread agree at fixed depth`);
      c.ok(r.info && r.info.depth === 3 && r.info.pv[0] === r.move, `${SPEC.names[v]}: info block`);
    }
    // A FEN start position + moves.
    const g2 = engine.newGame(v);
    g2.loadFen(g.fen());
    g2.makeMove(pick(rng, g2.legalMoveCodes()));
    w.postMessage({ type: 'search', id: 20, variant: v, startFen: g2.startFen(), moves: g2.historyCodes(), maxDepth: 2, timeMs: 0, noise: 0, seed: 1 });
    const r2 = await next();
    c.ok(r2?.type === 'result' && g2.legalMoveCodes().includes(r2.move), `${SPEC.names[v]}: search from a FEN start + moves`);
    g.destroy();
    g2.destroy();
  }
  w.postMessage({ type: 'search', id: 30, variant: 0, startFen: '', moves: [0x1234], maxDepth: 1, timeMs: 0, noise: 0, seed: 0 });
  const e1 = await next();
  c.ok(e1?.type === 'error' && e1.id === 30, 'illegal move list → error with id');
  w.postMessage({ type: 'search', id: 31, variant: 5, startFen: '', moves: [], maxDepth: 1, timeMs: 0, noise: 0, seed: 0 });
  const e2 = await next();
  c.ok(e2?.type === 'error' && e2.id === 31, 'bad variant → error with id');
  w.postMessage({ type: 'search', id: 32, variant: 0, startFen: 'nonsense', moves: [], maxDepth: 1, timeMs: 0, noise: 0, seed: 0 });
  const e3 = await next();
  c.ok(e3?.type === 'error' && e3.id === 32, 'bad start FEN → error with id');
  const mated = engine.newGame(0);
  ['Qc3', 'Qc6', 'b2', 'b6', 'Bb1', 'e6', 'Qxf9#'].forEach((s) => mated.makeMove(s));
  w.postMessage({ type: 'search', id: 33, variant: 0, startFen: '', moves: mated.historyCodes(), maxDepth: 2, timeMs: 0, noise: 0, seed: 0 });
  const r3 = await next();
  c.ok(r3?.type === 'result' && r3.move === 0, 'finished game → result with move 0');
  mated.destroy();
  w.terminate();
});

test('AiClient: worker mode (simulated Worker) and main-thread fallback in Node; stale requests resolve to null', async (c) => {
  // Worker mode through a simulated Worker global.
  const hadWorker = 'Worker' in globalThis;
  globalThis.Worker = SimWorker;
  try {
    const ai = new AiClient(engine);
    await ai.start();
    c.eq(ai.mode, 'worker', 'AiClient uses the worker when one can be created');
    const g = engine.newGame(1);
    g.makeMove('e3e5');
    const r = await ai.search({ variant: 1, startFen: g.startFen(), moves: g.historyCodes(), level: 2, seed: 9 });
    c.ok(r && r.via === 'worker' && g.legalMoveCodes().includes(r.move), 'worker search result is legal');
    // Supersede: the first request resolves to null, the second one answers.
    const p1 = ai.search({ variant: 1, startFen: '', moves: g.historyCodes(), level: 1, seed: 1 });
    const p2 = ai.search({ variant: 1, startFen: '', moves: g.historyCodes(), level: 1, seed: 2 });
    c.eq(await p1, null, 'superseded request → null');
    const r2 = await p2;
    c.ok(r2 && g.legalMoveCodes().includes(r2.move), 'latest request answered');
    const before = SimWorker.terminated;
    const p3 = ai.search({ variant: 1, startFen: '', moves: g.historyCodes(), level: 3, seed: 3 });
    ai.cancel();
    c.eq(await p3, null, 'cancelled request → null');
    c.ok(SimWorker.terminated > before, 'cancel terminates the busy worker');
    const r4 = await ai.search({ variant: 1, startFen: '', moves: g.historyCodes(), level: 1, seed: 4 });
    c.ok(r4 && g.legalMoveCodes().includes(r4.move), 'a restarted worker answers');
    ai.dispose();
    g.destroy();
  } finally {
    if (!hadWorker) delete globalThis.Worker;
  }
  // No Worker in Node → main-thread fallback.
  const ai = new AiClient(engine);
  await ai.start();
  c.eq(ai.mode, 'main', 'falls back to the main thread without Worker');
  const r = await ai.search({ variant: 0, startFen: '', moves: [], level: 1 });
  c.ok(r && r.via === 'main' && r.move !== 0, 'main-thread search result');
  const g = engine.newGame(0);
  c.ok(g.legalMoveCodes().includes(r.move), 'main-thread move is legal');
  g.destroy();
  ai.dispose();
});

// =======================================================================================
// 10. Heavy use, memory growth, detached views
// =======================================================================================

test('heavy use: hundreds of games, thousands of moves and strings, no leaks or traps', async (c) => {
  const e = await loadEngine({ bytes: WASM_BYTES });
  const mem = () => e.x.memory.buffer.byteLength;
  let totalMoves = 0;
  let totalStrings = 0;
  const round = (seed) => {
    const rng = makeRng(seed);
    const games = [];
    for (let k = 0; k < 200; k++) games.push(e.newGame(k % 2));
    for (let ply = 0; ply < 40; ply++) {
      for (const g of games) {
        if (g.status !== STATUS.ONGOING) continue;
        const codes = g.legalMoveCodes();
        const code = pick(rng, codes);
        const san = g.san(code);
        totalStrings++;
        if (!g.makeMove(code)) c.fail(`make ${decodeMove(code).uci} failed`);
        if (g.historySanAt(g.ply - 1) !== san) c.fail('history SAN mismatch under load');
        totalMoves++;
        if (ply % 10 === 9) { g.fen(); g.startFen(); g.historySan(); totalStrings += 2 + g.ply; }
      }
    }
    // Every game is reproducible from its move list in a fresh handle.
    const fens = games.map((g) => g.fen());
    const check = e.newGame(0);
    games.forEach((g, k) => {
      if (!check.replay(g.variant, '', g.historyCodes()) || check.fen() !== fens[k]) c.fail(`game ${k} does not replay`);
    });
    check.destroy();
    games.forEach((g) => g.destroy());
  };
  round(1);
  const m1 = mem();
  for (let r = 0; r < 3; r++) round(1);
  c.eq(mem(), m1, 'identical rounds do not grow memory (no leaks)');
  round(2);
  round(3);
  c.ok(mem() <= m1 + 4 * 65536, () => `different rounds stay within 4 pages (${m1} → ${mem()})`);
  // Thousands of short random strings through the alloc/free path.
  const g = e.newGame(0);
  const rng = makeRng(4);
  const alphabet = 'abcdefghijkl0123456789xX-=+#QRBNKP /éń–\u{1F600}';
  const m2 = mem();
  for (let k = 0; k < 20000; k++) {
    let s = '';
    const len = Math.floor(rng() * 24);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rng() * alphabet.length)];
    const p = g.parseMove(s);
    if (p && !g.legalMoveCodes().includes(p.code)) c.fail(`parseMove("${s}") returned an illegal move`);
    if (k % 10 === 0 && g.loadFen(s)) c.fail(`loadFen accepted "${s}"`);
    totalStrings++;
  }
  c.eq(g.fen(), SPEC.startFen[0], 'random strings never changed the game');
  c.ok(mem() <= m2 + 65536, 'string traffic does not grow memory');
  // Huge strings force memory growth; the wrapper must re-create its views.
  for (const size of [64 * 1024, 1 << 20, 4 << 20]) {
    c.eq(g.parseMove('e'.repeat(size)), null, `parseMove of a ${size}-byte string`);
    c.eq(g.loadFen('1/'.repeat(size / 2)), false, `loadFen of a ${size}-byte string`);
    c.eq(g.fen(), SPEC.startFen[0], 'game intact after huge strings');
  }
  // Many simultaneous handles.
  const many = [];
  for (let k = 0; k < 1000; k++) many.push(e.newGame(k % 2));
  many.forEach((h, k) => h.makeMove(pick(rng, h.legalMoveCodes())));
  c.ok(many.every((h) => h.ply === 1), '1000 coexisting games each hold their own move');
  c.ok(new Set(many.map((h) => h.ptr)).size === 1000, 'distinct handles');
  many.forEach((h) => h.destroy());
  g.destroy();
  if (VERBOSE) console.log(`     ${totalMoves} moves, ${totalStrings} strings; memory ${m1} → ${mem()} bytes`);
  c.ok(totalMoves > 30000, `moves played (${totalMoves})`);
});

test('memory growth: typed-array views are re-created after wasm memory grows (no detached-buffer bugs)', async (c) => {
  const e = await loadEngine({ bytes: WASM_BYTES });
  const g = e.newGame(0);
  g.makeMove('f5f6');
  const ref = { fen: g.fen(), board: Array.from(g.board()), moves: g.legalMoveCodes(), san: g.historySan() };
  const old = e.x.memory.buffer;
  e.x.memory.grow(3);
  c.eq(old.byteLength, 0, 'old ArrayBuffer is detached by memory.grow');
  c.eq(g.fen(), ref.fen, 'fen() after grow');
  c.same(g.board(), ref.board, 'board() after grow');
  c.same(g.legalMoveCodes(), ref.moves, 'legalMoveCodes() after grow');
  c.same(g.historySan(), ref.san, 'historySan() after grow');
  c.ok(g.parseMove('e7e6') !== null, 'parseMove() after grow');
  // The first search allocates the transposition table (memory grows by megabytes).
  const beforeSearch = e.x.memory.buffer.byteLength;
  const r = g.search({ maxDepth: 3 });
  const grown = e.x.memory.buffer.byteLength - beforeSearch;
  if (VERBOSE) console.log(`     first search grew memory by ${(grown / 1048576).toFixed(1)} MiB`);
  c.ok(r.code !== 0 && g.legalMoveCodes().includes(r.code), 'search after grow');
  c.ok(r.info.depth === 3 && r.info.pv[0] === r.code, 'searchInfo() read through a fresh view');
  c.eq(g.fen(), ref.fen, 'fen() after the search grew memory');
  c.ok(g.makeMove(r.code) && g.undo(), 'make/undo after growth');
  c.eq(g.perft(1), BigInt(g.legalMoveCodes().length), 'perft after growth');
  g.destroy();
});

// ---------------------------------------------------------------------------------------

const t0 = performance.now();
let failed = 0;
let ran = 0;
let checks = 0;
console.log(`wasm tests: ${path.relative(ROOT, WASM_PATH)} (${WASM_BYTES.length} bytes) via web/js/engine.js`);
for (const t of tests) {
  if (FILTER && !t.name.includes(FILTER)) continue;
  ran++;
  const c = new Checker();
  const start = performance.now();
  try {
    await t.fn(c);
  } catch (e) {
    c.failures.push(`threw: ${e && e.stack ? e.stack : e}`);
  }
  const ms = performance.now() - start;
  checks += c.count;
  const ok = c.failures.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.name}  [${c.count} checks, ${ms.toFixed(0)} ms]`);
  for (const f of c.failures) console.log(`       - ${f}`);
  if (c.suppressed) console.log(`       … ${c.suppressed} more failures`);
}
console.log(`\n${ran - failed}/${ran} tests passed, ${checks} checks, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
