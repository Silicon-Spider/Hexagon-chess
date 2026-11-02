// tools/difftest.mjs — differential testing of the ENGINE (web/hexchess.wasm driven through
// the real frontend wrapper web/js/engine.js) against the independent reference
// implementation tools/reference/hexref.mjs (written only from docs/SPEC.md §1, §2, §5.1).
//
//   [A] start positions: perft 1..4, both variants (plus SPEC §2.4 published values)
//   [B] hexref.randomPositions (several seeds, both variants): exact legal-move sets as
//       full 32-bit move codes (§4: from/to/promo + flags + piece + captured), FEN, board,
//       side, kings, check, status (§6), hc_ep_cell, the FEN after EVERY legal move,
//       perft(2) everywhere and perft(3) on a subset
//   [C] lockstep random games from the start positions (engine Game with history vs
//       reference + an independent status oracle incl. threefold / fifty-move /
//       insufficient material), biased towards captures, repetitions and quiet shuffles
//   [D] synthetic random piece placements (dense, sparse, e.p. fields, high clocks): the
//       engine's hc_load_fen must accept exactly the FENs the reference accepts in strict
//       (§7) mode; accepted ones are compared as in [B]
// On a perft mismatch the difference is localised with divide down to a single position.
//
// Zero dependencies.  usage: node tools/difftest.mjs [--quick | --full] [--seed <text>] [--verbose]
// --quick (default) runs a subset in well under a minute; --full is the thorough run.
// Exit code 0 when engine and reference agree everywhere, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ref from './reference/hexref.mjs';
import { loadEngine, decodeMove, STATUS } from '../web/js/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MODE = argv.includes('--full') ? 'full' : 'quick';
const VERBOSE = argv.includes('--verbose');
const SEED = argv.includes('--seed') ? String(argv[argv.indexOf('--seed') + 1]) : 'hexchess';

const CONFIG = {
  quick: {
    perftDepth: 4, seeds: 2, perSeed: 60, perft3Every: 15,
    walks: 10, walkPlies: 160, synthetic: 120, synthPerft3Every: 12,
  },
  full: {
    perftDepth: 4, seeds: 5, perSeed: 100, perft3Every: 3,
    walks: 40, walkPlies: 400, synthetic: 700, synthPerft3Every: 4,
  },
}[MODE];

const VARIANTS = ['glinski', 'mccooey'];
const NAMES = ['Gliński', 'McCooey'];
// SPEC §2.4 start-position perft (see the McCooey d4 erratum there).
const SPEC_PERFT = [[51, 2586, 137858, 7282418], [31, 947, 33307, 1157852]];
// Pawn capture directions [colour] per variant (SPEC §2.2 / §2.3), for the hc_ep_cell oracle.
const CAPTURE_DIRS = {
  glinski: [[[-1, 0], [1, -1]], [[-1, 1], [1, 0]]],
  mccooey: [[[-1, -1], [1, -2]], [[-1, 2], [1, 1]]],
};
const FORWARD = [[0, -1], [0, 1]];
const LETTERS = ' PNBRQK';

// ---------------------------------------------------------------------------------------
// Geometry from the REFERENCE (independent of web/js/geometry.js).

const AXIAL = [];
const BY_AXIAL = new Map();
for (let i = 0; i < 91; i++) {
  const a = ref.cellAxial(i);
  AXIAL.push(a);
  BY_AXIAL.set(`${a.q},${a.r}`, i);
}
const cellAt = (q, r) => (BY_AXIAL.has(`${q},${r}`) ? BY_AXIAL.get(`${q},${r}`) : -1);
const step = (i, [dq, dr]) => cellAt(AXIAL[i].q + dq, AXIAL[i].r + dr);
const isPromotionCell = (i, color) => {
  const { q, r } = AXIAL[i];
  return color === 0 ? r === -5 || q + r === -5 : r === 5 || q + r === 5;
};

// ---------------------------------------------------------------------------------------
// Oracles built on the reference

const turnIndex = (pos) => (pos.turn === 'w' ? 0 : 1);

/** The engine's full u32 move code (§4) expected for a reference move. */
function expectedCode(d) {
  const flags = (d.capture ? 1 : 0) | (d.enPassant ? 2 : 0) | (d.doubleStep ? 4 : 0) | (d.promotion ? 8 : 0);
  return (d.key | (flags << 20) | (d.piece << 24) | (d.captured << 28)) >>> 0;
}

/** §7 hc_ep_cell: the e.p. cell if an e.p. capture is pseudo-legal, else -1. */
function expectedEpCell(pos) {
  if (pos.ep < 0) return -1;
  const us = turnIndex(pos);
  const pawn = us === 0 ? 1 : -1;
  for (const [dq, dr] of CAPTURE_DIRS[pos.variant][us]) {
    const from = cellAt(AXIAL[pos.ep].q - dq, AXIAL[pos.ep].r - dr);
    if (from >= 0 && pos.board[from] === pawn) return pos.ep;
  }
  return -1;
}

/** §2.1 classical insufficient material: K v K, K+N v K, K+B v K. */
function insufficient(board) {
  const others = [];
  for (const p of board) if (p !== 0 && Math.abs(p) !== 6) others.push(Math.abs(p));
  return others.length === 0 || (others.length === 1 && (others[0] === 2 || others[0] === 3));
}

/** Repetition key (§6: board, side, e.p. availability). */
function repKey(pos) {
  return `${Array.from(pos.board).join(',')}|${pos.turn}|${expectedEpCell(pos)}`;
}

/** §6 status with precedence: no legal moves > insufficient > fifty-move > threefold. */
function expectedStatus(pos, nLegal, inCheck, repetitions = 1) {
  if (nLegal === 0) return inCheck ? STATUS.CHECKMATE : STATUS.STALEMATE;
  if (insufficient(pos.board)) return STATUS.DRAW_INSUFFICIENT;
  if (pos.halfmove >= 100) return STATUS.DRAW_FIFTY_MOVE;
  if (repetitions >= 3) return STATUS.DRAW_THREEFOLD;
  return STATUS.ONGOING;
}

// ---------------------------------------------------------------------------------------
// Bookkeeping

const stats = { positions: 0, moves: 0, children: 0, perftNodes: 0n, perftRuns: 0, loads: 0, rejectsAgreed: 0 };
const mismatches = [];
function mismatch(section, what, detail) {
  mismatches.push({ section, what, detail });
  if (mismatches.length <= 25) {
    console.log(`  MISMATCH [${section}] ${what}`);
    if (detail) for (const line of String(detail).split('\n')) console.log(`      ${line}`);
  }
}

/** Runs fn(); an exception (from either side) is recorded as a mismatch, not a crash. */
function guard(section, label, fn) {
  try {
    return fn();
  } catch (e) {
    const text = e && e.stack ? e.stack.split(/\r?\n/).slice(0, 4).join(' / ') : String(e);
    mismatch(section, `exception while checking ${label}`, text);
    return false;
  }
}

function makeRng(seedText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 0x01000193);
  let a = h | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Engine side

const engine = await loadEngine({ bytes: fs.readFileSync(path.join(ROOT, 'web', 'hexchess.wasm')) });

function engineDivide(g, depth) {
  const out = new Map();
  for (const m of g.legalMoves()) {
    // The Game refuses moves once a draw rule has ended it (perft itself ignores draws);
    // report such a move as -1 instead of undoing someone else's move.
    if (!g.makeMove(m.code)) { out.set(m.uci, -1n); continue; }
    out.set(m.uci, depth > 1 ? g.perft(depth - 1) : 1n);
    g.undo();
  }
  return out;
}

/**
 * Narrow a perft disagreement down to one position whose legal-move sets differ.
 * `g` holds `pos` (the engine side may refuse moves in a drawn position, so perft-only
 * positions are reloaded from FEN with the clock reset).
 */
function localise(g, pos, depth, trail = []) {
  const ed = engineDivide(g, depth);
  const rd = ref.divide(pos, depth);
  const eKeys = [...ed.keys()].sort();
  const rKeys = Object.keys(rd).sort();
  if (!sameArray(eKeys, rKeys)) {
    return `after [${trail.join(' ')}] in ${ref.toFen(pos)}:\n` +
      `engine-only moves [${eKeys.filter((k) => !(k in rd)).join(' ')}]\n` +
      `reference-only moves [${rKeys.filter((k) => !ed.has(k)).join(' ')}]`;
  }
  for (const k of rKeys) {
    if (ed.get(k) !== BigInt(rd[k])) {
      const m = g.parseMove(k);
      if (!m || !g.makeMove(m.code)) return `engine cannot play ${k} after [${trail.join(' ')}] in ${ref.toFen(pos)}`;
      const r = localise(g, ref.makeMove(pos, k), depth - 1, [...trail, k]);
      g.undo();
      return `divide(${depth}) differs at ${k}: engine ${ed.get(k)} vs reference ${rd[k]}\n${r}`;
    }
  }
  return `divide(${depth}) agrees move by move (perft totals differed?) at ${ref.toFen(pos)}`;
}

/**
 * Compare everything observable about the position the engine game `g` currently holds
 * with the reference position `pos`. `repetitions` = occurrences of this position in the
 * game so far (lockstep games only). Returns false on the first category that differs.
 */
function compareState(section, label, g, pos, { repetitions = 1, children = true, perft = [] } = {}) {
  stats.positions++;
  const where = `${label} | ${ref.toFen(pos)}`;
  const fenR = ref.toFen(pos);
  const fenE = g.fen();
  if (fenE !== fenR) { mismatch(section, `FEN differs: ${label}`, `engine    ${fenE}\nreference ${fenR}`); return false; }
  if (!sameArray(g.board(), ref.boardArray(pos))) { mismatch(section, `board differs: ${where}`); return false; }
  if (g.turn !== turnIndex(pos)) { mismatch(section, `side to move differs: ${where}`); return false; }
  for (const color of [0, 1]) {
    const k = Array.from(pos.board).indexOf(color === 0 ? 6 : -6);
    if (g.kingCell(color) !== k) { mismatch(section, `king cell (colour ${color}) differs: ${where}`); return false; }
  }
  const inCheckR = ref.inCheck(pos);
  if (g.inCheck !== inCheckR) { mismatch(section, `in-check differs (engine ${g.inCheck}): ${where}`, `checkers per reference: ${ref.checkers(pos)}`); return false; }
  if (g.epCell !== expectedEpCell(pos)) { mismatch(section, `hc_ep_cell ${g.epCell} vs expected ${expectedEpCell(pos)}: ${where}`); return false; }
  if (g.halfmoveClock !== pos.halfmove || g.fullmoveNumber !== pos.fullmove) { mismatch(section, `move counters differ: ${where}`); return false; }

  const detailed = ref.legalMovesDetailed(pos);
  const expected = detailed.map(expectedCode).sort((a, b) => a - b);
  const got = g.legalMoveCodes().sort((a, b) => a - b);
  stats.moves += expected.length;
  if (!sameArray(got, expected)) {
    const gotKeys = new Map(got.map((c) => [c & 0xfffff, c]));
    const expKeys = new Map(expected.map((c) => [c & 0xfffff, c]));
    const engineOnly = [...gotKeys.keys()].filter((k) => !expKeys.has(k)).map((k) => decodeMove(k).uci);
    const refOnly = [...expKeys.keys()].filter((k) => !gotKeys.has(k)).map((k) => decodeMove(k).uci);
    const meta = [...gotKeys.keys()].filter((k) => expKeys.has(k) && gotKeys.get(k) !== expKeys.get(k))
      .map((k) => `${decodeMove(k).uci}: engine 0x${gotKeys.get(k).toString(16)} vs expected 0x${expKeys.get(k).toString(16)}`);
    mismatch(section, `legal moves differ: ${where}`,
      `engine-only [${engineOnly.join(' ')}]\nreference-only [${refOnly.join(' ')}]${meta.length ? `\nmetadata: ${meta.slice(0, 6).join('; ')}` : ''}`);
    return false;
  }
  const wantStatus = expectedStatus(pos, expected.length, inCheckR, repetitions);
  if (g.status !== wantStatus) { mismatch(section, `status ${g.status} vs expected ${wantStatus}: ${where}`); return false; }

  if (children && wantStatus === STATUS.ONGOING) {
    // The FEN after every legal move (make in the engine, compare, undo).
    for (const d of detailed) {
      const code = expectedCode(d);
      if (!g.makeMove(code & 0xfffff)) { mismatch(section, `engine refused legal move ${d.move}: ${where}`); return false; }
      const childE = g.fen();
      const checkE = g.inCheck;
      g.undo();
      const child = ref.makeMove(pos, d.move);
      stats.children++;
      if (childE !== ref.toFen(child)) {
        mismatch(section, `FEN after ${d.move} differs: ${where}`, `engine    ${childE}\nreference ${ref.toFen(child)}`);
        return false;
      }
      if (checkE !== ref.inCheck(child)) { mismatch(section, `in-check after ${d.move} differs: ${where}`); return false; }
    }
    if (g.fen() !== fenR) { mismatch(section, `undo did not restore the position: ${where}`); return false; }
  }
  for (const depth of perft) {
    const e = g.perft(depth);
    const r = BigInt(ref.perft(pos, depth));
    stats.perftNodes += r;
    stats.perftRuns++;
    if (e !== r) {
      // Localise on a copy whose clock cannot stop the engine game from making moves.
      const probe = engine.newGame(VARIANTS.indexOf(pos.variant));
      const fen0 = ref.toFen({ ...pos, halfmove: 0 });
      probe.loadFen(fen0);
      const detail = localise(probe, ref.parseFen(fen0, pos.variant), depth);
      probe.destroy();
      mismatch(section, `perft(${depth}) engine ${e} vs reference ${r}: ${where}`, detail);
      return false;
    }
  }
  return true;
}

// =======================================================================================
// [A] Start positions
// =======================================================================================

function sectionA() {
  console.log(`[A] start positions, perft 1..${CONFIG.perftDepth}`);
  for (let v = 0; v < 2; v++) {
    const g = engine.newGame(v);
    const pos = ref.startPosition(VARIANTS[v]);
    guard('A', `${NAMES[v]} start`, () => compareState('A', `${NAMES[v]} start`, g, pos, { children: true }));
    const row = [];
    for (let d = 1; d <= CONFIG.perftDepth; d++) {
      const t0 = performance.now();
      const e = g.perft(d);
      const t1 = performance.now();
      const r = BigInt(ref.perft(pos, d));
      const t2 = performance.now();
      stats.perftNodes += r;
      stats.perftRuns++;
      row.push(`d${d}=${e}${e === r ? '' : ` (reference ${r})`}`);
      if (VERBOSE) console.log(`      ${NAMES[v]} perft(${d}): engine ${e} in ${(t1 - t0).toFixed(0)} ms, reference ${r} in ${(t2 - t1).toFixed(0)} ms`);
      if (e !== r) mismatch('A', `${NAMES[v]} start perft(${d}): engine ${e} vs reference ${r}`, guard('A', 'localise', () => localise(g, pos, d)));
      const spec = SPEC_PERFT[v][d - 1];
      if (spec !== undefined && BigInt(spec) !== e) mismatch('A', `${NAMES[v]} start perft(${d}): engine ${e} vs SPEC §2.4 ${spec}`);
    }
    console.log(`    ${NAMES[v]}: ${row.join(' ')}`);
    g.destroy();
  }
}

// =======================================================================================
// [B] Reference random positions
// =======================================================================================

function sectionB() {
  console.log(`[B] hexref.randomPositions: ${CONFIG.seeds} seeds × ${CONFIG.perSeed} positions per variant`);
  for (let v = 0; v < 2; v++) {
    const g = engine.newGame(v);
    const tagCount = {};
    let n = 0;
    let p3 = 0;
    const before = { moves: stats.moves, children: stats.children, nodes: stats.perftNodes };
    for (let s = 0; s < CONFIG.seeds; s++) {
      const seed = `${SEED}-${MODE}-${s}`;
      const list = ref.randomPositionsTagged(VARIANTS[v], CONFIG.perSeed, seed);
      for (const { fen, tags } of list) {
        for (const t of tags) tagCount[t] = (tagCount[t] || 0) + 1;
        const label = `${NAMES[v]} seed ${seed} #${n} [${tags.join(',')}]`;
        n++;
        const pos = guard('B', `reference strict parse of its own ${fen}`, () => ref.parseFen(fen, VARIANTS[v], { strict: true }));
        if (!pos) continue;
        stats.loads++;
        if (!g.loadFen(fen)) {
          mismatch('B', `engine rejected ${fen} (${NAMES[v]})`, engine.readString(engine.x.hc_last_error ? engine.x.hc_last_error() : 0));
          continue;
        }
        const perft = (n - 1) % CONFIG.perft3Every === 0 ? [2, 3] : [2];
        if (perft.includes(3)) p3++;
        guard('B', label, () => compareState('B', label, g, pos, { perft }));
      }
    }
    const tags = Object.entries(tagCount).sort().map(([t, k]) => `${t} ${k}`).join(', ');
    console.log(`    ${NAMES[v]}: ${n} positions (${tags}); ${stats.moves - before.moves} moves, ${stats.children - before.children} child FENs, perft(2) ×${n}, perft(3) ×${p3}, ${stats.perftNodes - before.nodes} perft nodes`);
    g.destroy();
  }
}

// =======================================================================================
// [C] Lockstep random games (engine Game history semantics)
// =======================================================================================

const STYLES = ['uniform', 'captures', 'shuffle', 'quiet', 'kings'];

function chooseMove(style, rng, detailed, history, ply) {
  switch (style) {
    case 'captures': {
      const good = detailed.filter((d) => d.capture || d.promotion);
      return good.length && rng() < 0.8 ? pick(rng, good) : pick(rng, detailed);
    }
    case 'shuffle': { // undo our own previous move when possible → repetitions
      const mine = history[ply - 2];
      if (ply > 12 && mine && rng() < 0.85) {
        const back = detailed.find((d) => d.from === mine.to && d.to === mine.from && !d.promotion);
        if (back) return back;
      }
      return pick(rng, detailed);
    }
    case 'quiet': { // no pawn moves or captures after a while → fifty-move rule
      const quiet = detailed.filter((d) => d.piece !== 1 && !d.capture);
      return ply > 20 && quiet.length && rng() < 0.97 ? pick(rng, quiet) : pick(rng, detailed);
    }
    case 'kings': {
      const k = detailed.filter((d) => d.piece === 6);
      return k.length && rng() < 0.5 ? pick(rng, k) : pick(rng, detailed);
    }
    default:
      return pick(rng, detailed);
  }
}

function sectionC() {
  console.log(`[C] lockstep random games: ${CONFIG.walks} per variant, up to ${CONFIG.walkPlies} plies`);
  for (let v = 0; v < 2; v++) {
    const rng = makeRng(`${SEED}-${MODE}-walk-${v}`);
    const g = engine.newGame(v);
    const endings = {};
    let plies = 0;
    for (let w = 0; w < CONFIG.walks; w++) guard('C', `${NAMES[v]} game ${w}`, () => {
      const style = STYLES[w % STYLES.length];
      g.reset(v);
      let pos = ref.startPosition(VARIANTS[v]);
      const keys = new Map([[repKey(pos), 1]]);
      const fens = [ref.toFen(pos)];
      const history = [];
      let ok = true;
      let ending = 'ply limit';
      for (let ply = 0; ply <= CONFIG.walkPlies; ply++) {
        const reps = keys.get(repKey(pos));
        ok = compareState('C', `${NAMES[v]} game ${w} (${style}) ply ${ply}`, g, pos, { repetitions: reps, children: ply % 8 === 0 });
        if (!ok) break;
        const detailed = ref.legalMovesDetailed(pos);
        const st = expectedStatus(pos, detailed.length, ref.inCheck(pos), reps);
        if (st !== STATUS.ONGOING) {
          ending = ['', 'checkmate', 'stalemate', 'threefold', 'fifty-move', 'insufficient'][st];
          if (detailed.length && g.makeMove(expectedCode(detailed[0]) & 0xfffff)) {
            mismatch('C', `engine accepted a move after the game ended (${ending}): ${ref.toFen(pos)}`);
            ok = false;
          }
          break;
        }
        if (ply === CONFIG.walkPlies) break;
        const d = chooseMove(style, rng, detailed, history, ply);
        if (!g.makeMove(expectedCode(d) & 0xfffff)) { mismatch('C', `engine refused ${d.move} in ${ref.toFen(pos)}`); ok = false; break; }
        if (g.historyMove(ply) !== expectedCode(d)) { mismatch('C', `history code of ${d.move} differs`); ok = false; break; }
        history.push(d);
        pos = ref.makeMove(pos, d.move);
        const key = repKey(pos);
        keys.set(key, (keys.get(key) || 0) + 1);
        fens.push(ref.toFen(pos));
        plies++;
      }
      endings[ending] = (endings[ending] || 0) + 1;
      if (!ok) return;
      // Unwind the whole game through undo.
      for (let k = fens.length - 1; k > 0; k--) {
        if (g.fen() !== fens[k] || !g.undo()) { mismatch('C', `undo chain broken at ply ${k} of ${NAMES[v]} game ${w}`); break; }
      }
      if (g.fen() !== fens[0] || g.ply !== 0) mismatch('C', `${NAMES[v]} game ${w}: undo did not return to the start`);
    });
    console.log(`    ${NAMES[v]}: ${CONFIG.walks} games, ${plies} plies; endings ${Object.entries(endings).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    g.destroy();
  }
}

// =======================================================================================
// [D] Synthetic placements (hc_load_fen acceptance + rules on odd positions)
// =======================================================================================

function syntheticFen(rng, v) {
  const board = new Int8Array(91);
  const empty = () => { for (;;) { const i = Math.floor(rng() * 91); if (board[i] === 0) return i; } };
  const wk = empty();
  board[wk] = 6;
  board[empty()] = -6;
  const dense = rng();
  const n = dense < 0.35 ? 1 + Math.floor(rng() * 5) : dense < 0.8 ? 4 + Math.floor(rng() * 14) : 16 + Math.floor(rng() * 20);
  for (let k = 0; k < n; k++) {
    const x = rng();
    const type = x < 0.45 ? 1 : x < 0.6 ? 2 : x < 0.73 ? 3 : x < 0.86 ? 4 : 5;
    const color = rng() < 0.5 ? 0 : 1;
    let cell = empty();
    // Mostly keep pawns off their own promotion cell (a few stay, to test rejection).
    for (let t = 0; t < 4 && type === 1 && isPromotionCell(cell, color) && rng() < 0.95; t++) cell = empty();
    board[cell] = (color === 0 ? 1 : -1) * type;
  }
  const side = rng() < 0.5 ? 'w' : 'b';
  let ep = '-';
  const r = rng();
  if (r < 0.35) {
    // Plant a pawn of the side that just moved with an empty e.p. cell and origin behind it.
    const mover = side === 'w' ? 1 : 0;
    for (let t = 0; t < 30; t++) {
      const x = Math.floor(rng() * 91);
      const epCell = step(x, FORWARD[1 - mover]);
      const origin = epCell >= 0 ? step(epCell, FORWARD[1 - mover]) : -1;
      if (board[x] !== 0 && Math.abs(board[x]) === 6) continue;
      if (epCell < 0 || origin < 0 || board[epCell] !== 0 || board[origin] !== 0 || isPromotionCell(x, mover)) continue;
      board[x] = mover === 0 ? 1 : -1;
      ep = ref.cellName(epCell);
      // §5.1 consistency: sometimes break exactly one condition (the e.p. cell must then
      // be dropped): origin occupied, e.p. cell occupied, or no pawn of the mover on x.
      const breakIt = rng();
      const filler = () => (rng() < 0.5 ? 1 : -1) * (2 + Math.floor(rng() * 4));
      if (breakIt < 0.15) board[origin] = filler();
      else if (breakIt < 0.27) board[epCell] = filler();
      else if (breakIt < 0.37) board[x] = rng() < 0.5 ? -board[x] : board[x] * 2;
      if (breakIt < 0.37) break;
      // Often add a capturing pawn of the side to move next to the e.p. cell.
      if (rng() < 0.7) {
        const us = 1 - mover;
        const [dq, dr] = pick(rng, CAPTURE_DIRS[VARIANTS[v]][us]);
        const from = cellAt(AXIAL[epCell].q - dq, AXIAL[epCell].r - dr);
        if (from >= 0 && board[from] === 0 && !isPromotionCell(from, us)) board[from] = us === 0 ? 1 : -1;
      }
      break;
    }
  } else if (r < 0.45) {
    ep = ref.cellName(Math.floor(rng() * 91)); // usually inconsistent → silently dropped
  }
  const half = rng() < 0.85 ? Math.floor(rng() * 100) : 90 + Math.floor(rng() * 40);
  const full = 1 + Math.floor(rng() * 150);
  return ref.toFen({ variant: VARIANTS[v], board, turn: side, ep: -1, halfmove: half, fullmove: full })
    .replace(/ - (\d+) (\d+)$/, ` ${ep} $1 $2`);
}

function sectionD() {
  console.log(`[D] synthetic placements: ${CONFIG.synthetic} accepted positions per variant`);
  for (let v = 0; v < 2; v++) {
    const rng = makeRng(`${SEED}-${MODE}-synthetic-${v}`);
    const g = engine.newGame(v);
    let accepted = 0;
    let rejected = 0;
    let attempts = 0;
    let p3 = 0;
    let epKept = 0;
    let checks = 0;
    const reasons = {};
    while (accepted < CONFIG.synthetic && attempts < CONFIG.synthetic * 20) {
      attempts++;
      const fen = syntheticFen(rng, v);
      let pos = null;
      let refError = '';
      try { pos = ref.parseFen(fen, VARIANTS[v], { strict: true }); } catch (e) { refError = e.message; }
      const engOk = g.loadFen(fen);
      stats.loads++;
      if (engOk !== (pos !== null)) {
        mismatch('D', `hc_load_fen ${engOk ? 'accepted' : 'rejected'} what the reference ${pos ? 'accepts' : 'rejects'}: ${fen} (${NAMES[v]})`, refError);
        continue;
      }
      if (!pos) {
        rejected++;
        stats.rejectsAgreed++;
        const why = refError.replace(/^illegal setup: /, '').replace(/ [a-l]\d+/g, '').replace(/\d+ kings/, 'n kings');
        for (const part of why.split('; ')) reasons[part] = (reasons[part] || 0) + 1;
        continue;
      }
      if (pos.ep >= 0) epKept++;
      const label = `${NAMES[v]} synthetic #${accepted}`;
      accepted++;
      guard('D', label, () => {
        if (ref.inCheck(pos)) checks++;
        const nodes2 = ref.perft(pos, 2);
        const perft = [2];
        if ((accepted - 1) % CONFIG.synthPerft3Every === 0 && nodes2 <= 8000) { perft.push(3); p3++; }
        // A loaded draw (clock >= 100) stops Game.make_move; children are then compared
        // on a copy with the clock reset.
        const drawn = pos.halfmove >= 100 && !insufficient(pos.board);
        if (!compareState('D', label, g, pos, { perft, children: !drawn }) || !drawn) return;
        const probePos = { ...pos, halfmove: 0 };
        g.loadFen(ref.toFen(probePos));
        compareState('D', `${label} (clock reset)`, g, probePos, {});
      });
    }
    const why = Object.entries(reasons).map(([k, n]) => `${k} ×${n}`).join('; ');
    console.log(`    ${NAMES[v]}: ${accepted} accepted (${checks} in check, ${epKept} with a kept e.p. cell; perft(3) ×${p3}), ${rejected} rejected by both [${why}]`);
    g.destroy();
  }
}

// ---------------------------------------------------------------------------------------

const t0 = performance.now();
console.log(`difftest --${MODE}: engine web/hexchess.wasm (via web/js/engine.js) vs tools/reference/hexref.mjs, seed "${SEED}"`);
for (const [name, fn] of [['A', sectionA], ['B', sectionB], ['C', sectionC], ['D', sectionD]]) {
  const s0 = performance.now();
  fn();
  console.log(`    (${name}: ${((performance.now() - s0) / 1000).toFixed(1)} s)`);
}
console.log(`\nTOTAL: ${stats.positions} positions compared, ${stats.moves} legal moves (full move codes), ` +
  `${stats.children} child FENs, ${stats.perftRuns} perft runs / ${stats.perftNodes} perft leaf nodes, ` +
  `${stats.loads} FEN loads (${stats.rejectsAgreed} rejected by both)`);
console.log(`mismatches: ${mismatches.length}   (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(mismatches.length ? 1 : 0);
