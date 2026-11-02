// tools/reference/hexref.test.mjs — tests of the independent reference implementation.
// Plain Node script: `node tools/reference/hexref.test.mjs`; exits non-zero on any failure.
//
// Expected values come from docs/SPEC.md (§1, §2.4, §5.1) or are derived BY HAND from the
// §1.1 direction tables (derivations in comments). Positions are written with fenOf(),
// which builds FEN text independently of hexref's own toFen().

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  START_FEN, parseFen, toFen, legalMoves, legalMovesDetailed, makeMove, playMoves, inCheck,
  checkers, status, perft, divide, randomPositions, randomPositionsTagged, startPosition,
  boardArray, cellIndex, cellName, cellAxial,
} from './hexref.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0;
const failed = [];
function test(name, fn) {
  const t0 = performance.now();
  try {
    fn();
    passed++;
    console.log(`ok   ${name}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    failed.push(name);
    console.log(`FAIL ${name}\n     ${String(err && err.stack || err).split('\n').join('\n     ')}`);
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function sameSet(actual, expected, what) {
  const a = [...actual].sort(), e = [...expected].sort();
  if (a.length !== e.length || a.some((x, i) => x !== e[i])) {
    throw new Error(`${what}:\n  expected [${e.join(' ')}]\n  got      [${a.join(' ')}]\n  missing  [${e.filter((x) => !a.includes(x)).join(' ')}]  extra [${a.filter((x) => !e.includes(x)).join(' ')}]`);
  }
}
function throws(fn, what) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(`expected an exception: ${what}`);
}

// ---------------------------------------------------------------------------
// helpers (written independently of hexref internals)
// ---------------------------------------------------------------------------
const FILES = 'abcdefghikl';
const fileHeight = (fi) => 11 - Math.abs(fi - 5);

/** FEN from a { cell: pieceLetter } map, ranks 11..1, files a..l (§5.1). */
function fenOf(pieces, side = 'w', rest = '- 0 1') {
  for (const cell of Object.keys(pieces)) {
    const fi = FILES.indexOf(cell[0]);
    const rank = Number(cell.slice(1));
    if (fi < 0 || !(rank >= 1 && rank <= fileHeight(fi))) throw new Error(`test bug: no cell ${cell}`);
  }
  const rows = [];
  for (let rank = 11; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (let fi = 0; fi < 11; fi++) {
      if (rank > fileHeight(fi)) continue;
      const p = pieces[FILES[fi] + rank];
      if (p) { if (empty) row += empty; empty = 0; row += p; } else empty++;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${side} ${rest}`;
}
/** Position from a piece map; strict = also a legal setup per §7 (one king each, side not to move not in check). */
function pos(variant, pieces, side = 'w', rest = '- 0 1') { return parseFen(fenOf(pieces, side, rest), variant, { strict: true }); }
const movesFrom = (p, cell) => legalMoves(p).filter((m) => m.startsWith(cell) && /^\d/.test(m.slice(cell.length)) === false);
const targets = (p, cell) => movesFrom(p, cell).map((m) => m.slice(cell.length));
const fenField = (fen, i) => fen.split(' ')[i];
/** Are two cells one king step apart (6 orthogonal + 6 diagonal neighbours)? Uses cube coordinates. */
function kingAdjacent(a, b) {
  const A = cellAxial(a), B = cellAxial(b);
  const d = [Math.abs(A.q - B.q), Math.abs(A.r - B.r), Math.abs(A.s - B.s)].sort((x, y) => x - y).join('');
  return d === '011' || d === '112';
}

// ===========================================================================
// §1 geometry
// ===========================================================================
test('geometry: 91 cells, canonical indices and axial examples of §1', () => {
  let n = 0;
  for (let fi = 0; fi < 11; fi++) for (let rank = 1; rank <= fileHeight(fi); rank++) { eq(cellName(cellIndex(FILES[fi] + rank)), FILES[fi] + rank, 'name round trip'); n++; }
  eq(n, 91, 'cell count');
  eq(cellIndex('j1'), -1, 'there is no j file');
  eq(cellIndex('a7'), -1, 'file a has 6 cells');
  const idx = { a1: 0, a6: 5, b1: 6, f1: 40, f6: 45, f11: 50, g1: 51, l1: 85, l6: 90 };
  for (const [c, i] of Object.entries(idx)) eq(cellIndex(c), i, `index of ${c}`);
  const ax = { f1: [0, 5], f6: [0, 0], f11: [0, -5], a1: [-5, 5], a6: [-5, 0], l1: [5, 0], l6: [5, -5] };
  for (const [c, [q, r]] of Object.entries(ax)) { const a = cellAxial(c); eq(`${a.q},${a.r}`, `${q},${r}`, `axial of ${c}`); }
});

test('§1.1 direction table: a lone king on e4 reaches exactly the 12 example cells', () => {
  // Orthogonal examples from e4: N e5, S e3, NE f5, SE f4, NW d4, SW d3;
  // diagonal examples: E g4, W c3, NNE f6, NNW d5, SSE f3, SSW d2. Black king far away on k7.
  const p = pos('glinski', { e4: 'K', k7: 'k' });
  sameSet(targets(p, 'e4'), ['e5', 'e3', 'f5', 'f4', 'd4', 'd3', 'g4', 'c3', 'f6', 'd5', 'f3', 'd2'], 'king moves from e4');
});

// ===========================================================================
// Lone pieces, counts derived by hand from §1.1
// ===========================================================================
// f6 is the centre (0,0); the board is every cell within hex distance 5 of it.
// White king b1 = (-4,5) and black king k7 = (4,-5): neither lies on a line through f6 —
// the orthogonal lines through (0,0) have q=0, r=0 or s=0, the diagonal lines q=r, q=s or
// r=s — and neither is a knight jump from f6, so nothing blocks, pins or checks.
const FAR_KINGS = { b1: 'K', k7: 'k' };

test('lone rook on f6: 30 moves (6 orthogonal rays x 5 cells to the edge)', () => {
  // N f7..f11, S f5..f1, NE g6 h6 i6 k6 l6, SW e5 d4 c3 b2 a1, SE g5 h4 i3 k2 l1, NW e6 d6 c6 b6 a6
  const p = pos('glinski', { f6: 'R', ...FAR_KINGS });
  sameSet(targets(p, 'f6'), ['f7', 'f8', 'f9', 'f10', 'f11', 'f5', 'f4', 'f3', 'f2', 'f1',
    'g6', 'h6', 'i6', 'k6', 'l6', 'e5', 'd4', 'c3', 'b2', 'a1', 'g5', 'h4', 'i3', 'k2', 'l1',
    'e6', 'd6', 'c6', 'b6', 'a6'], 'rook targets');
  // The white king on b1 adds its own 7 moves: b2 c2 c1 a1 d2 c3 a2
  // (S, SW, W, SSE, SSW lead off the board from b1); the rook's a1/b2/c3 overlap is fine.
  sameSet(targets(p, 'b1'), ['b2', 'c2', 'c1', 'a1', 'd2', 'c3', 'a2'], 'king targets from b1');
  eq(legalMoves(p).length, 37, 'total');
});

test('lone bishop on f6: 12 moves (6 diagonal rays x 2 cells: a diagonal step is hex distance 2)', () => {
  // E h5 k4, W d5 b4, NNE g7 h8, NNW e7 d8, SSE g4 h2, SSW e4 d2
  const p = pos('glinski', { f6: 'B', ...FAR_KINGS });
  sameSet(targets(p, 'f6'), ['h5', 'k4', 'd5', 'b4', 'g7', 'h8', 'e7', 'd8', 'g4', 'h2', 'e4', 'd2'], 'bishop targets');
});

test('lone knight on f6: 12 moves (all 12 jumps are within distance 3 of the centre)', () => {
  // (3,-1) i4, (3,-2) i5, (-1,3) e3, (-1,-2) e8, (-2,3) d3, (-2,-1) d7,
  // (-3,1) c5, (-3,2) c4, (1,-3) g8, (1,2) g3, (2,-3) h7, (2,1) h3
  const p = pos('glinski', { f6: 'N', ...FAR_KINGS });
  sameSet(targets(p, 'f6'), ['i4', 'i5', 'e3', 'e8', 'd3', 'd7', 'c5', 'c4', 'g8', 'g3', 'h7', 'h3'], 'knight targets');
});

test('lone queen on f6: 42 moves (30 rook + 12 bishop)', () => {
  const p = pos('mccooey', { f6: 'Q', ...FAR_KINGS });
  eq(movesFrom(p, 'f6').length, 42, 'queen moves');
});

test('lone king on f6: 12 moves (6 orthogonal + 6 diagonal neighbours)', () => {
  const p = pos('glinski', { f6: 'K', k7: 'k' });
  sameSet(targets(p, 'f6'), ['f7', 'f5', 'g6', 'g5', 'e6', 'e5', 'h5', 'd5', 'g7', 'e7', 'g4', 'e4'], 'king targets');
});

test('pieces in the a1 corner: rook 20, bishop 10, knight 4, king 5', () => {
  // a1 = (-5,5). Kings: white h1 = (2,3), black k7 = (4,-5) — neither on a line from a1
  // (deltas (7,-2) and (9,-10) are not multiples of any direction) nor a knight jump away.
  // Rook: N a2..a6 (5), NE b2 c3 d4 e5 f6 g6 h6 i6 k6 l6 (10), SE b1 c1 d1 e1 f1 (5); S, NW, SW off-board.
  // Bishop: E c2 e3 g3 i2 l1 (5), NNE b3 c5 d7 e9 f11 (5); the other 4 diagonals leave the board.
  // Knight: only (3,-1) d2, (3,-2) d3, (1,-3) b4, (2,-3) c4 stay on the board.
  // King: N a2, NE b2, SE b1, E c2, NNE b3.
  const kings = { h1: 'K', k7: 'k' };
  eq(movesFrom(pos('glinski', { a1: 'R', ...kings }), 'a1').length, 20, 'rook on a1');
  sameSet(targets(pos('glinski', { a1: 'B', ...kings }), 'a1'), ['c2', 'e3', 'g3', 'i2', 'l1', 'b3', 'c5', 'd7', 'e9', 'f11'], 'bishop on a1');
  sameSet(targets(pos('glinski', { a1: 'N', ...kings }), 'a1'), ['d2', 'd3', 'b4', 'c4'], 'knight on a1');
  sameSet(targets(pos('glinski', { a1: 'K', k7: 'k' }), 'a1'), ['a2', 'b2', 'b1', 'c2', 'b3'], 'king on a1');
});

test('kings never become adjacent: Kf6 vs Kf8 leaves the white king 7 of its 12 steps', () => {
  // f8 = (0,-2). Of f6's neighbours, f7 g7 e7 (orthogonal to f8) and g6 e6 (diagonal to f8) are
  // attacked by the black king; f5 g5 e5 h5 d5 g4 e4 are at distance >= 3 from f8.
  const p = pos('glinski', { f6: 'K', f8: 'k' });
  sameSet(targets(p, 'f6'), ['f5', 'g5', 'e5', 'h5', 'd5', 'g4', 'e4'], 'king targets');
});

test('sliders are blocked by the first piece; captures only of enemy pieces', () => {
  // Rook f6 with a white pawn f8 (blocks: only f7 to the north) and a black knight on d6
  // (captured, nothing beyond): NW ray = e6, d6 only.
  const p = pos('glinski', { f6: 'R', f8: 'P', d6: 'n', ...FAR_KINGS });
  const t = targets(p, 'f6');
  ok(t.includes('f7') && !t.includes('f8') && !t.includes('f9'), 'north ray stops before own pawn');
  ok(t.includes('e6') && t.includes('d6') && !t.includes('c6'), 'NW ray captures d6 and stops');
  eq(t.length, 30 - 4 - 3, 'rook moves');
  // A diagonal step is NOT blocked by the two cells it passes between: bishop f6 -> h5 passes
  // between g6 and g5; fill both with white pawns, h5 must still be reachable.
  const q = pos('glinski', { f6: 'B', g6: 'P', g5: 'P', ...FAR_KINGS });
  ok(targets(q, 'f6').includes('h5') && targets(q, 'f6').includes('k4'), 'diagonal not blocked by the side cells');
});

// ===========================================================================
// §2.4 perft
// ===========================================================================
function breakdown(p) {
  const by = {};
  for (const m of legalMovesDetailed(p)) {
    const k = ' PNBRQK'[m.piece] + (m.doubleStep ? '2' : '');
    by[k] = (by[k] || 0) + 1;
  }
  return by;
}

test('Gliński perft d1=51 (17 pawn = 9 single + 8 double, 8 N, 12 B, 6 Q, 2 K, 6 R), d2=2586, d3=137858', () => {
  const s = startPosition('glinski');
  const b = breakdown(s);
  eq(b.P, 9, 'single pawn steps'); eq(b.P2, 8, 'double steps'); eq(b.N, 8, 'knight'); eq(b.B, 12, 'bishop');
  eq(b.Q, 6, 'queen'); eq(b.K, 2, 'king'); eq(b.R, 6, 'rook');
  ok(!legalMoves(s).includes('f5f7'), 'f5-f7 blocked by f7 at the start');
  eq(perft(s, 1), 51, 'd1'); eq(perft(s, 2), 2586, 'd2'); eq(perft(s, 3), 137858, 'd3');
});

test('McCooey perft d1=31 (13 pawn = 7 single + 6 double, 10 N, 8 B), d2=947, d3=33307', () => {
  const s = startPosition('mccooey');
  const b = breakdown(s);
  eq(b.P, 7, 'single'); eq(b.P2, 6, 'double'); eq(b.N, 10, 'knight'); eq(b.B, 8, 'bishop');
  eq(Object.keys(b).length, 4, 'no other piece can move');
  ok(legalMoves(s).includes('f4f5') && !legalMoves(s).includes('f4f6'), 'the McCooey f-pawn may not double step');
  eq(perft(s, 1), 31, 'd1'); eq(perft(s, 2), 947, 'd2'); eq(perft(s, 3), 33307, 'd3');
});

// McCooey d4 = 1,157,852 (SPEC §2.4). Two further throwaway implementations (one with
// "king can be captured" legality, one using only geometric predicates on cube coordinates)
// agree. The one published figure, 1,157,856, predates its author's fix of a "phantom en
// passant" bug (see the SPEC §2.4 erratum); d4 is the first depth at which BLACK pawn
// captures occur in McCooey, so d1-d3 never exercise Black's capture directions.
test('McCooey perft d4 = 1157852 (SPEC §2.4)', () => {
  eq(perft(startPosition('mccooey'), 4), 1157852, 'McCooey d4');
});

test('divide sums to perft and lists sorted moves', () => {
  const s = startPosition('glinski');
  const d = divide(s, 2);
  const keys = Object.keys(d);
  eq(keys.length, 51, 'root moves');
  eq(keys.join(' '), [...keys].sort().join(' '), 'sorted keys');
  eq(Object.values(d).reduce((a, b) => a + b, 0), 2586, 'sum');
  eq(perft(s, 0), 1, 'perft depth 0');
  throws(() => perft(s, 1.5), 'non-integer depth');
  throws(() => perft(s, -1), 'negative depth');
  throws(() => divide(s, 0), 'divide depth 0');
});

// ===========================================================================
// Pawn capture directions (§2.2 / §2.3), both colours — hand-derived
// ===========================================================================
test('pawn capture directions per variant and colour (and the cells a pawn may NOT capture)', () => {
  // Enemy knights stand on both capture targets AND on the two cells of the other kind
  // (diagonal for Gliński, orthogonal for McCooey). Kings: white l1, black a1 (far away).
  const cases = [
    // Gliński White e4 (-1,2): N e5, double e6; NW (-1,0) d4, NE (+1,-1) f5; not NNW d5 / NNE f6
    ['glinski', 'w', 'e4', 'P', ['d4', 'f5', 'd5', 'f6'], ['e5', 'e6', 'd4', 'f5']],
    // Gliński Black e7 (-1,-1): S e6, double e5; SW (-1,+1) d6, SE (+1,0) f7; not SSW d5 / SSE f6
    ['glinski', 'b', 'e7', 'p', ['d6', 'f7', 'd5', 'f6'], ['e6', 'e5', 'd6', 'f7']],
    // McCooey White e3 (-1,3): N e4, double e5; NNW (-1,-1) d4, NNE (+1,-2) f5; not NW d3 / NE f4
    ['mccooey', 'w', 'e3', 'P', ['d4', 'f5', 'd3', 'f4'], ['e4', 'e5', 'd4', 'f5']],
    // McCooey Black e8 (-1,-2): S e7, double e6; SSW (-1,+2) d6, SSE (+1,+1) f7; not SW d7 / SE f8
    ['mccooey', 'b', 'e8', 'p', ['d6', 'f7', 'd7', 'f8'], ['e7', 'e6', 'd6', 'f7']],
  ];
  for (const [variant, side, from, pawn, enemies, expected] of cases) {
    const knight = side === 'w' ? 'n' : 'N';
    const pieces = { [from]: pawn, l1: 'K', a1: 'k' };
    for (const c of enemies) pieces[c] = knight;
    sameSet(targets(pos(variant, pieces, side), from), expected, `${variant} ${side} pawn on ${from}`);
  }
});

// ===========================================================================
// §2.4 pawn examples (Wikipedia)
// ===========================================================================
test('Gliński: after e4xf5 the f5 pawn may double-step to f7', () => {
  let p = pos('glinski', { e4: 'P', f5: 'p', g1: 'K', g10: 'k' });
  ok(legalMoves(p).includes('e4e6'), 'e4 is a double-step cell');
  p = makeMove(p, 'e4f5'); // capture NE: e4 (-1,2) + (1,-1) = f5 (0,1)
  p = makeMove(p, 'g10g9');
  const t = targets(p, 'f5');
  ok(t.includes('f6') && t.includes('f7'), `f5 pawn: single and double step (got ${t})`);
});

test('Gliński: Black c7-c5 may be answered by b5xc6 e.p. (only immediately)', () => {
  const p0 = pos('glinski', { b5: 'P', c7: 'p', g1: 'K', g10: 'k' }, 'b');
  const p1 = makeMove(p0, 'c7c5');
  eq(toFen(p1).split(' ').slice(1).join(' '), 'w c6 0 2', 'FEN tail after the double step');
  const ep = legalMovesDetailed(p1).find((m) => m.move === 'b5c6');
  ok(ep && ep.enPassant && ep.capture && ep.captured === 1, 'b5c6 is an en-passant capture');
  const p2 = makeMove(p1, 'b5c6');
  const b = boardArray(p2);
  eq(b[cellIndex('c6')], 1, 'white pawn on c6'); eq(b[cellIndex('c5')], 0, 'c5 emptied'); eq(b[cellIndex('b5')], 0, 'b5 emptied');
  eq(fenField(toFen(p2), 2), '-', 'no ep after the capture');
  const later = playMoves(p1, 'g1g2 g10g9');
  ok(!legalMoves(later).includes('b5c6'), 'e.p. expires after one move');
});

test('Gliński: Black captures e.p. too (e4-e6 answered by d5xe5)', () => {
  const p1 = makeMove(pos('glinski', { e4: 'P', d5: 'p', g1: 'K', g10: 'k' }), 'e4e6');
  eq(fenField(toFen(p1), 2), 'e5', 'ep cell');
  const p2 = makeMove(p1, 'd5e5'); // black captures SE: d5 (-2,1) + (1,0) = e5
  const b = boardArray(p2);
  eq(b[cellIndex('e5')], -1, 'black pawn on e5'); eq(b[cellIndex('e6')], 0, 'e6 emptied');
});

test('McCooey: Black e8-e6 may be answered by d5xe7 e.p.', () => {
  const p1 = makeMove(pos('mccooey', { d5: 'P', e8: 'p', g1: 'K', g10: 'k' }, 'b'), 'e8e6');
  ok(legalMovesDetailed(p1).some((m) => m.move === 'd5e7' && m.enPassant), 'd5e7 e.p. (NNE: (-2,1)+(1,-2) = e7)');
  const b = boardArray(makeMove(p1, 'd5e7'));
  eq(b[cellIndex('e7')], 1, 'white pawn on e7'); eq(b[cellIndex('e6')], 0, 'e6 emptied');
});

test('e.p. that would expose the own king is illegal; e.p. that removes a checking pawn is legal', () => {
  // Black rook a5, white pawn b5, white king e5: after c7-c5 the line a5-b5-c5-d5-e5 (SE) is
  // blocked by b5 and c5; b5xc6 e.p. would empty both.
  const pinned = makeMove(pos('glinski', { e5: 'K', b5: 'P', a5: 'r', c7: 'p', g10: 'k' }, 'b'), 'c7c5');
  ok(!legalMoves(pinned).includes('b5c6'), 'e.p. exposing the king must be illegal');
  ok(legalMoves(pinned).includes('b5b6') && legalMoves(pinned).includes('b5a5'), 'other b5 moves stay legal');
  // Control: same without the rook -> e.p. legal.
  ok(legalMoves(makeMove(pos('glinski', { e5: 'K', b5: 'P', c7: 'p', g10: 'k' }, 'b'), 'c7c5')).includes('b5c6'), 'control');
  // c7-c5 gives check to a king on d5 (black pawn on c5 captures SE onto d5); e.p. removes the checker.
  const checked = makeMove(pos('glinski', { d5: 'K', b5: 'P', c7: 'p', g10: 'k' }, 'b'), 'c7c5');
  ok(inCheck(checked), 'king on d5 is in check from c5');
  ok(legalMoves(checked).includes('b5c6'), 'e.p. capture of the checking pawn is legal');
});

// ===========================================================================
// Promotion
// ===========================================================================
test('promotion cells: every file, both colours, both variants (4 choices each)', () => {
  const whiteLast = ['a6', 'b7', 'c8', 'd9', 'e10', 'f11', 'g10', 'h9', 'i8', 'k7', 'l6'];
  for (const variant of ['glinski', 'mccooey']) {
    for (let fi = 0; fi < 11; fi++) {
      const f = FILES[fi];
      // kings on c4 / i5 never stand in a pawn's way and are never attacked by it
      const w = pos(variant, { [f + (fileHeight(fi) - 1)]: 'P', c4: 'K', i5: 'k' }, 'w');
      const wm = movesFrom(w, f + (fileHeight(fi) - 1));
      sameSet(wm.map((m) => m.slice(-1)), ['q', 'r', 'b', 'n'], `${variant} white ${f} promotion choices`);
      eq(wm[0].slice(0, -1).slice((f + (fileHeight(fi) - 1)).length), whiteLast[fi], `${variant} white promotion cell of file ${f}`);
      const b = pos(variant, { [f + 2]: 'p', c4: 'K', i5: 'k' }, 'b');
      sameSet(movesFrom(b, f + 2), ['q', 'r', 'b', 'n'].map((x) => `${f}2${f}1${x}`), `${variant} black ${f} promotion`);
    }
  }
});

test('Gliński promotion by advance and by capture: f10 -> f11, e10, g10 (12 moves)', () => {
  // f10 (0,-4): N f11, NW (-1,0) e10, NE (+1,-1) g10 — all three are promotion cells.
  const p = pos('glinski', { f10: 'P', e10: 'n', g10: 'r', b1: 'K', k1: 'k' });
  sameSet(movesFrom(p, 'f10'), ['f10f11q', 'f10f11r', 'f10f11b', 'f10f11n', 'f10e10q', 'f10e10r', 'f10e10b', 'f10e10n',
    'f10g10q', 'f10g10r', 'f10g10b', 'f10g10n'], 'promotions');
  const after = makeMove(p, 'f10g10n');
  eq(boardArray(after)[cellIndex('g10')], 2, 'under-promotion to a white knight');
  eq(fenField(toFen(after), 3), '0', 'halfmove reset');
});

test('McCooey promotion by capture: e9 -> e10 (advance) and f11 (NNE capture), not d10', () => {
  // e9 (-1,-3): N e10; NNE (+1,-2) f11; NNW (-1,-1) = (-2,-4) is off the board.
  const p = pos('mccooey', { e9: 'P', f11: 'b', b1: 'K', k1: 'k' });
  sameSet(movesFrom(p, 'e9'), ['e9e10q', 'e9e10r', 'e9e10b', 'e9e10n', 'e9f11q', 'e9f11r', 'e9f11b', 'e9f11n'], 'promotions');
  // McCooey pawns never capture orthogonally; f10 is not a capture target of e9 even with a piece on it.
  ok(!targets(pos('mccooey', { e9: 'P', f10: 'n', b1: 'K', k1: 'k' }), 'e9').some((t) => t.startsWith('f10')), 'no orthogonal capture');
});

// ===========================================================================
// §2.4 fool's mate and hexchess.club status fixtures
// ===========================================================================
test("Gliński fool's mate: 1.Qc3 Qc6 2.b2 b6 3.Bb1 e6 4.Qxf9# reproduces the hexchess.club FEN", () => {
  const p = playMoves(startPosition('glinski'), 'e1c3 e10c6 b1b2 b7b6 f3b1 e7e6 c3f9');
  eq(toFen(p), 'b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4', 'final FEN');
  eq(status(p), 'checkmate', 'status');
  eq(legalMoves(p).length, 0, 'no legal moves');
});

test('hexchess.club fixtures (Gliński): check / mate / stalemate', () => {
  const cases = [
    ['K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1', true, 'ongoing'],
    ['K/3/5/3q3/2q6/11/11/11/11/11/11 w - 0 1', true, 'ongoing'],
    ['K/3/2q2/3q3/9/11/11/11/11/11/11 w - 1 2', true, 'checkmate'],
    ['k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1', false, 'ongoing'],
    ['k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1', false, 'stalemate'],
  ];
  for (const [fen, check, st] of cases) {
    const p = parseFen(fen, 'glinski');
    eq(inCheck(p), check, `inCheck ${fen}`);
    eq(status(p), st, `status ${fen}`);
    eq(toFen(p), fen, `round trip ${fen}`);
  }
});

test('checkers(): single and double check', () => {
  // White king f1 = (0,5): black rook f5 checks along the f-file (f2..f4 empty) and the black
  // knight e3 = (-1,3) checks by the jump (1,2) -> (0,5).
  const p = pos('glinski', { f1: 'K', f5: 'r', e3: 'n', k7: 'k' });
  sameSet(checkers(p), ['f5', 'e3'], 'double check');
  // In double check only king moves can be legal.
  ok(legalMovesDetailed(p).every((m) => m.piece === 6), 'only king moves');
});

// ===========================================================================
// §5.1 FEN
// ===========================================================================
test('FEN round trips: start positions, optional fields, positions after moves', () => {
  for (const v of ['glinski', 'mccooey']) {
    eq(toFen(parseFen(START_FEN[v], v)), START_FEN[v], `${v} start`);
    eq(toFen(startPosition(v)), START_FEN[v], `${v} startPosition`);
  }
  eq(START_FEN.glinski, 'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', 'Gliński start per §2.2');
  eq(START_FEN.mccooey, 'b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1', 'McCooey start per §2.3');
  eq(toFen(parseFen('1/3/5/7/9/11/11/11/11/11/11 w', 'glinski')), '1/3/5/7/9/11/11/11/11/11/11 w - 0 1', 'defaults - 0 1');
  eq(toFen(parseFen('  1/3/5/7/9/11/11/11/11/11/11   b   -  7 ', 'glinski')), '1/3/5/7/9/11/11/11/11/11/11 b - 7 1', 'whitespace, partial');
  // counters: knight move +1, black move increments fullmove, pawn move resets
  const s = startPosition('glinski');
  const a = makeMove(s, 'd1f4');
  eq(toFen(a).split(' ').slice(1).join(' '), 'b - 1 1', 'after a knight move');
  const b = makeMove(a, 'h9i6'); // knight (2,-5) + (1,2) = (3,-3) = i6
  eq(toFen(b).split(' ').slice(1).join(' '), 'w - 2 2', 'after a black knight move');
  const c = makeMove(b, 'e4e5');
  eq(toFen(c).split(' ').slice(1).join(' '), 'b - 0 2', 'after a pawn single step');
  const d = makeMove(c, 'c7c5');
  eq(toFen(d).split(' ').slice(1).join(' '), 'w c6 0 3', 'after a black double step (ep written even without a capturer)');
  eq(toFen(parseFen(toFen(d), 'glinski')), toFen(d), 'ep survives a round trip');
});

test('FEN ep consistency rule: inconsistent ep cells are silently dropped', () => {
  const base = { b5: 'P', c5: 'p', g1: 'K', g10: 'k' }; // as after c7-c5
  eq(fenField(toFen(parseFen(fenOf(base, 'w', 'c6 0 2'), 'glinski')), 2), 'c6', 'consistent ep kept');
  eq(fenField(toFen(parseFen(fenOf(base, 'w', 'b6 0 2'), 'glinski')), 2), '-', 'no black pawn on b5 -> dropped');
  eq(fenField(toFen(parseFen(fenOf({ ...base, c7: 'n' }, 'w', 'c6 0 2'), 'glinski')), 2), '-', 'cell behind occupied -> dropped');
  eq(fenField(toFen(parseFen(fenOf({ ...base, c6: 'n' }, 'w', 'c6 0 2'), 'glinski')), 2), '-', 'ep cell occupied -> dropped');
  eq(fenField(toFen(parseFen(fenOf(base, 'b', 'c6 0 2'), 'glinski')), 2), '-', 'wrong side to move -> dropped');
  eq(fenField(toFen(parseFen(fenOf({ e6: 'P', g1: 'K', g10: 'k' }, 'b', 'e5 0 1'), 'glinski')), 2), 'e5', 'white double step kept');
  ok(!legalMoves(parseFen(fenOf(base, 'w', 'b6 0 2'), 'glinski')).includes('b5c6'), 'dropped ep gives no capture');
});

test('malformed FEN input throws', () => {
  const good = START_FEN.glinski;
  const bad = [
    '', '   ',
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2 w - 0 1', // 10 ranks
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1/1 w - 0 1', // 12 ranks
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP w - 0 1', // rank 1 has 10 cells
    'b/qbk/n1b1n/r5r/ppppppppp/12/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // 12 empties
    'b/qbk/n1b1n/r5r/pppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // rank 7 has 10
    'bb/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // rank 11 has 2
    'b/qbk/n1b1n/r5r/ppppppppp/11/5X5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // bad letter
    'b/qbk/n1b1n/r5r/ppppppppp/011/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // leading zero
    'b/qbk/n1b1n/r5r/ppppppppp/0/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1', // zero
    'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1', // no side
    good.replace(' w ', ' x '), good.replace(' w ', ' W '),
    good.replace(' - ', ' j5 '), good.replace(' - ', ' a7 '), good.replace(' - ', ' f12 '), good.replace(' - ', ' f0 '), good.replace(' - ', ' e '),
    good.replace(' 0 1', ' -1 1'), good.replace(' 0 1', ' x 1'), good.replace(' 0 1', ' 0 0'), good.replace(' 0 1', ' 0 1.5'),
    `${good} extra`,
    '1/3/5/7/9/11/11/11/11/11/KK9 w - 0 1', // two white kings
  ];
  for (const fen of bad) throws(() => parseFen(fen, 'glinski'), JSON.stringify(fen));
  throws(() => parseFen(good, 'chess'), 'unknown variant');
  eq(parseFen(good, 0).variant, 'glinski', 'numeric variant id 0');
  eq(parseFen(good, 'Gliński').variant, 'glinski', 'accented name');
  // strict mode = the hc_load_fen acceptance rules of §7
  throws(() => parseFen('K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1', 'glinski', { strict: true }), 'strict: missing black king');
  throws(() => parseFen(fenOf({ f11: 'P', g1: 'K', g10: 'k' }), 'glinski', { strict: true }), 'strict: white pawn on its promotion cell');
  throws(() => parseFen(fenOf({ f1: 'K', f5: 'r', g10: 'k' }, 'b'), 'glinski', { strict: true }), 'strict: side not to move in check');
  parseFen(fenOf({ f1: 'K', f5: 'r', g10: 'k' }, 'w'), 'glinski', { strict: true }); // side to move in check is fine
  parseFen('K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1', 'glinski'); // non-strict accepts the fixture
});

// ===========================================================================
// API behaviour
// ===========================================================================
test('makeMove: immutable, accepts separators, rejects illegal moves', () => {
  const s = startPosition('glinski');
  const before = toFen(s);
  const boardBefore = boardArray(s);
  const a = makeMove(s, 'e4-e5');
  eq(toFen(s), before, 'input position unchanged');
  ok(boardArray(s).every((x, i) => x === boardBefore[i]), 'input board unchanged');
  eq(toFen(makeMove(s, 'e4e5')), toFen(a), "'e4-e5' == 'e4e5'");
  throws(() => makeMove(s, 'e4e7'), 'illegal move');
  throws(() => makeMove(s, 'g1h1'), 'king onto its own knight');
  throws(() => makeMove(s, 'g1g3'), 'king two cells');
  const p = pos('glinski', { f10: 'P', b1: 'K', k1: 'k' });
  throws(() => makeMove(p, 'f10f11'), 'promotion letter required');
  eq(toFen(makeMove(p, 'f10-f11=Q')), toFen(makeMove(p, 'f10f11q')), 'f10-f11=Q');
});

test('legalMovesDetailed: flags and engine key (from | to<<8 | promo<<16)', () => {
  const s = startPosition('glinski');
  const d = legalMovesDetailed(s).find((m) => m.move === 'e4e6');
  ok(d.doubleStep && !d.capture && !d.enPassant && d.promotion === 0 && d.piece === 1, 'double step flags');
  eq(d.key, cellIndex('e4') | (cellIndex('e6') << 8), 'key');
  const p = pos('glinski', { f10: 'P', g10: 'r', b1: 'K', k1: 'k' });
  const pr = legalMovesDetailed(p).find((m) => m.move === 'f10g10n');
  ok(pr.capture && pr.captured === 4 && pr.promotion === 2, 'promotion capture details');
  eq(pr.key, cellIndex('f10') | (cellIndex('g10') << 8) | (2 << 16), 'promotion key');
  const b = boardArray(s);
  eq(b.length, 91, 'board length');
  eq(b[cellIndex('g1')], 6, 'white king'); eq(b[cellIndex('g10')], -6, 'black king'); eq(b[cellIndex('f6')], 0, 'empty centre');
});

// ===========================================================================
// randomPositions
// ===========================================================================
test('randomPositions: deterministic, distinct, legal, round-tripping, correctly tagged, all categories', () => {
  for (const v of ['glinski', 'mccooey']) {
    const tagged = randomPositionsTagged(v, 300, 12345);
    eq(tagged.length, 300, `${v} count`);
    const fens = randomPositions(v, 300, 12345);
    eq(JSON.stringify(fens), JSON.stringify(tagged.map((e) => e.fen)), `${v} deterministic`);
    const other = randomPositions(v, 300, 54321);
    ok(other.filter((f) => !fens.includes(f)).length > 250, `${v} another seed gives other positions`);
    const keys = new Set(fens.map((f) => f.split(' ').slice(0, 3).join(' ')));
    eq(keys.size, 300, `${v} distinct (board + side + ep)`);
    const seen = new Set();
    for (const { fen, tags } of tagged) {
      const p = parseFen(fen, v, { strict: true }); // legal setup: one king each, side not to move not in check
      eq(toFen(p), fen, 'round trip');
      const moves = legalMovesDetailed(p);
      const has = (t) => tags.includes(t);
      eq(has('check'), inCheck(p), `check tag ${fen}`);
      eq(has('doubleCheck'), checkers(p).length >= 2, `doubleCheck tag ${fen}`);
      eq(has('promo'), moves.some((m) => m.promotion), `promo tag ${fen}`);
      eq(has('promoCapture'), moves.some((m) => m.promotion && m.capture), `promoCapture tag ${fen}`);
      eq(has('ep'), moves.some((m) => m.enPassant), `ep tag ${fen}`);
      if (has('ep') || has('epIllegal')) ok(fenField(fen, 2) !== '-', 'ep tags need an ep field');
      eq(has('sparse'), boardArray(p).filter((x) => x !== 0).length <= 8, `sparse tag ${fen}`);
      const b = boardArray(p);
      const wk = cellName(b.indexOf(6)), bk = cellName(b.indexOf(-6));
      const near = [...Array(91).keys()].some((c) => kingAdjacent(cellName(c), wk) && kingAdjacent(cellName(c), bk));
      eq(has('kingsNear'), near, `kingsNear tag ${fen}`);
      ok(!kingAdjacent(wk, bk), 'kings never adjacent');
      const st = status(p);
      eq(has('checkmate'), st === 'checkmate', `checkmate tag ${fen}`);
      eq(has('stalemate'), st === 'stalemate', `stalemate tag ${fen}`);
      for (const t of tags) seen.add(t);
    }
    for (const t of ['ep', 'promo', 'promoCapture', 'check', 'doubleCheck', 'sparse', 'kingsNear', 'pin']) ok(seen.has(t), `${v}: no '${t}' position in the sample`);
    console.log(`     ${v}: tags seen ${[...seen].sort().join(' ')}`);
  }
  // options: short playouts stay near the opening (every position within maxPlies plies)
  const short = randomPositions('mccooey', 40, 'opening', { maxPlies: 3 });
  eq(new Set(short).size, 40, 'distinct short-playout positions');
  ok(short.every((f) => Number(fenField(f, 4)) <= 2 + 1), 'fullmove <= 3 after at most 3 plies');
  eq(randomPositions('glinski', 0, 1).length, 0, 'count 0');
  throws(() => randomPositions('glinski', 5, 1, { maxPlies: 0 }), 'bad maxPlies');
});

// ===========================================================================
// CLI
// ===========================================================================
test('CLI: perft, divide, moves, random', () => {
  const cli = (...args) => execFileSync(process.execPath, [join(HERE, 'hexref.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  eq(cli('perft', 'mccooey', '2').trim(), '947', 'perft');
  eq(cli('perft', 'glinski', '1', 'k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1').trim(), '0', 'perft from a FEN (stalemate)');
  const div = cli('divide', 'glinski', '1').trim().split('\n');
  eq(div[div.length - 1], 'total 51', 'divide total');
  eq(cli('moves', 'glinski', '1/3/5/7/9/11/11/11/11/11/11', 'w', '-', '0', '1').trim(), '', 'no pieces, no moves');
  eq(cli('moves', 'mccooey', START_FEN.mccooey).trim().split(' ').length, 31, 'moves from FEN');
  const r = cli('random', 'glinski', '5', '7').trim().split('\n');
  eq(r.length, 5, 'random count');
  r.forEach((fen) => parseFen(fen, 'glinski', { strict: true }));
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(`failed: ${failed.join(' | ')}`);
  process.exitCode = 1;
}
