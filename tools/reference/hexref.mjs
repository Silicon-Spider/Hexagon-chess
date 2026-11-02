// tools/reference/hexref.mjs
//
// INDEPENDENT REFERENCE IMPLEMENTATION of the hexagonal-chess move rules
// (Gliński's and McCooey's variants), written only from docs/SPEC.md
// (§1 geometry, §2 rules, §5.1 FEN). Its sole purpose is to be a TEST ORACLE that
// cross-checks the Rust/WebAssembly engine, so it deliberately favours clarity over
// speed:
//   * positions are immutable: every move copies the 91-cell board;
//   * a move is legal iff, after playing it on that copy, the mover's king (if it has
//     one) is not attacked. No pin tables, no incremental state, no make/unmake.
//
// Zero dependencies. Node built-ins are used only by the command-line interface.
//
// Position object (plain data, never mutated by this module):
//   { variant: 'glinski' | 'mccooey',
//     board:   Int8Array(91), canonical cell order (§1), codes of §3
//              (0 empty, +1..+6 white P N B R Q K, -1..-6 black),
//     turn:    'w' | 'b',
//     ep:      cell index passed over by the previous move's pawn double step, or -1,
//     halfmove, fullmove }
//
// Moves are coordinate strings: from + to + optional lowercase promotion letter,
// e.g. 'e4e5', 'b1b3', 'e4d5', 'f10f11q'. No separators.

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

// ===========================================================================
// §1  Board geometry
// ===========================================================================

const FILE_LETTERS = 'abcdefghikl'; // 11 files, there is no 'j'
const FILE_OFFSET = [0, 6, 13, 21, 30, 40, 51, 61, 70, 78, 85];
const NUM_CELLS = 91;

function fileHeight(fi) { return 11 - Math.abs(fi - 5); } // a:6 b:7 ... f:11 ... l:6

const cellQ = new Int8Array(NUM_CELLS);
const cellR = new Int8Array(NUM_CELLS);
const cellFile = new Int8Array(NUM_CELLS); // 0..10
const cellRank = new Int8Array(NUM_CELLS); // 1..11
const cellNames = new Array(NUM_CELLS);
const cellByName = new Map();
const cellByQR = new Int16Array(11 * 11).fill(-1); // index (q+5)*11 + (r+5)

for (let fi = 0; fi < 11; fi++) {
  const q = fi - 5;
  for (let rank = 1; rank <= fileHeight(fi); rank++) {
    const r = 6 - rank - Math.max(q, 0);
    const index = FILE_OFFSET[fi] + rank - 1;
    const s = -q - r;
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > 5) throw new Error('geometry bug: cell off board');
    if (cellNames[index] !== undefined) throw new Error('geometry bug: duplicate index');
    cellQ[index] = q;
    cellR[index] = r;
    cellFile[index] = fi;
    cellRank[index] = rank;
    cellNames[index] = FILE_LETTERS[fi] + rank;
    cellByName.set(cellNames[index], index);
    cellByQR[(q + 5) * 11 + (r + 5)] = index;
  }
}
{ // every axial (q, r) with max(|q|,|r|,|s|) <= 5 must be one of the 91 cells, and vice versa
  let valid = 0;
  for (let q = -5; q <= 5; q++) {
    for (let r = -5; r <= 5; r++) {
      const onBoard = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 5;
      if (onBoard) valid++;
      if (onBoard !== (cellByQR[(q + 5) * 11 + (r + 5)] !== -1)) throw new Error('geometry bug: (q,r) table');
    }
  }
  if (valid !== NUM_CELLS || cellByName.size !== NUM_CELLS) throw new Error('geometry bug: cell count');
}

/** Cell index at axial (q, r), or -1 if off the board. */
function cellAt(q, r) {
  if (q < -5 || q > 5 || r < -5 || r > 5) return -1;
  return cellByQR[(q + 5) * 11 + (r + 5)];
}

/** The cell reached from `cell` by the axial delta d = [dq, dr], or -1 if off the board. */
function step(cell, d) { return cellAt(cellQ[cell] + d[0], cellR[cell] + d[1]); }

/** Cell index of a FEN rank / file pair (file index 0..10). */
function cellOf(fi, rank) { return FILE_OFFSET[fi] + rank - 1; }

/** File indices (left to right) that contain the given rank (1..11). */
function filesOnRank(rank) {
  const files = [];
  for (let fi = 0; fi < 11; fi++) if (rank <= fileHeight(fi)) files.push(fi);
  return files;
}

// §1.1 directions, axial deltas [dq, dr]; "north" = towards Black = up the file.
const DIR = {
  // orthogonal (edge-adjacent): rook directions
  N: [0, -1], S: [0, 1], NE: [1, -1], SE: [1, 0], NW: [-1, 0], SW: [-1, 1],
  // diagonal (through a vertex): bishop directions
  E: [2, -1], W: [-2, 1], NNE: [1, -2], NNW: [-1, -1], SSE: [1, 1], SSW: [-1, 2],
};
const ORTHOGONAL = [DIR.N, DIR.S, DIR.NE, DIR.SE, DIR.NW, DIR.SW];
const DIAGONAL = [DIR.E, DIR.W, DIR.NNE, DIR.NNW, DIR.SSE, DIR.SSW];
const KING_STEPS = [...ORTHOGONAL, ...DIAGONAL];
// Knight: the 12 cells whose cube offset is a permutation of (3,-1,-2) or (-3,1,2).
const KNIGHT_JUMPS = [
  [3, -1], [3, -2], [-1, 3], [-1, -2], [-2, 3], [-2, -1],
  [-3, 1], [-3, 2], [1, -3], [1, 2], [2, -3], [2, 1],
];

// ===========================================================================
// §3  Pieces and colours
// ===========================================================================

const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 1, BLACK = -1; // a piece code's sign is its colour

const PIECE_BY_LETTER = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6, p: -1, n: -2, b: -3, r: -4, q: -5, k: -6 };
const TYPE_LETTERS = ' PNBRQK';
const PROMO_LETTER = { [KNIGHT]: 'n', [BISHOP]: 'b', [ROOK]: 'r', [QUEEN]: 'q' };
const PROMOTION_CHOICES = [QUEEN, ROOK, BISHOP, KNIGHT];

function pieceLetter(code) {
  const letter = TYPE_LETTERS[Math.abs(code)];
  return code > 0 ? letter : letter.toLowerCase();
}
function colorOfTurn(turn) { return turn === 'w' ? WHITE : BLACK; }
/** A pawn's forward direction: White moves N (up the file), Black moves S. */
function forward(color) { return color === WHITE ? DIR.N : DIR.S; }

/** §2.1: White promotes on cells with r == -5 || q+r == -5, Black on r == 5 || q+r == 5. */
function isPromotionCell(cell, color) {
  const q = cellQ[cell], r = cellR[cell];
  return color === WHITE ? (r === -5 || q + r === -5) : (r === 5 || q + r === 5);
}

// ===========================================================================
// §2.2 / §2.3  Variants
// ===========================================================================

function cellSet(names) {
  return new Set(names.map((name) => {
    const index = cellByName.get(name);
    if (index === undefined) throw new Error(`bad cell name in variant table: ${name}`);
    return index;
  }));
}

const VARIANTS = {
  glinski: {
    id: 'glinski',
    name: 'Gliński',
    startFen: 'b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1',
    // pawns capture "orthogonally forward at 60 degrees to the vertical"
    whitePawnCaptures: [DIR.NW, DIR.NE],
    blackPawnCaptures: [DIR.SW, DIR.SE],
    // double step allowed from EVERY pawn starting cell of that colour
    whiteDoubleStep: cellSet(['b1', 'c2', 'd3', 'e4', 'f5', 'g4', 'h3', 'i2', 'k1']),
    blackDoubleStep: cellSet(['b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7', 'i7', 'k7']),
  },
  mccooey: {
    id: 'mccooey',
    name: 'McCooey',
    startFen: 'b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1',
    // pawns capture diagonally forward (bishop-wise single step, never blocked)
    whitePawnCaptures: [DIR.NNW, DIR.NNE],
    blackPawnCaptures: [DIR.SSW, DIR.SSE],
    // the centre f-pawn may NOT double step
    whiteDoubleStep: cellSet(['c1', 'd2', 'e3', 'g3', 'h2', 'i1']),
    blackDoubleStep: cellSet(['c8', 'd8', 'e8', 'g8', 'h8', 'i8']),
  },
};

function pawnCaptureDirs(v, color) { return color === WHITE ? v.whitePawnCaptures : v.blackPawnCaptures; }
function doubleStepCells(v, color) { return color === WHITE ? v.whiteDoubleStep : v.blackDoubleStep; }

/** Accepts 'glinski' | 'mccooey' (any case, 'gliński' too) or the engine's numeric ids 0 | 1. */
function variantDef(variant) {
  let key = variant;
  if (typeof variant === 'number') key = ['glinski', 'mccooey'][variant];
  else if (typeof variant === 'string') key = variant.toLowerCase().replace('ń', 'n');
  const v = typeof key === 'string' && Object.prototype.hasOwnProperty.call(VARIANTS, key) ? VARIANTS[key] : undefined;
  if (!v) throw new Error(`unknown variant ${JSON.stringify(variant)} (expected 'glinski' or 'mccooey')`);
  return v;
}

export const VARIANT_IDS = ['glinski', 'mccooey'];
export const START_FEN = Object.freeze({ glinski: VARIANTS.glinski.startFen, mccooey: VARIANTS.mccooey.startFen });

// ===========================================================================
// Attack detection
// ===========================================================================

function findKing(board, color) {
  for (let i = 0; i < NUM_CELLS; i++) if (board[i] === KING * color) return i;
  return -1;
}

/**
 * All cells holding a piece of colour `by` that attacks cell `target` (whatever stands on
 * `target`). One code path, used both for legality and for counting checkers.
 */
function attackersOf(board, v, target, by) {
  const found = [];
  // Rooks / queens along the 6 orthogonal lines, kings one step away on them.
  for (const d of ORTHOGONAL) {
    let c = step(target, d);
    for (let distance = 1; c !== -1; distance++) {
      const p = board[c];
      if (p !== 0) {
        if (Math.sign(p) === by) {
          const t = Math.abs(p);
          if (t === ROOK || t === QUEEN || (t === KING && distance === 1)) found.push(c);
        }
        break; // the first piece on the line blocks everything behind it
      }
      c = step(c, d);
    }
  }
  // Bishops / queens along the 6 diagonal lines, kings one diagonal step away.
  for (const d of DIAGONAL) {
    let c = step(target, d);
    for (let distance = 1; c !== -1; distance++) {
      const p = board[c];
      if (p !== 0) {
        if (Math.sign(p) === by) {
          const t = Math.abs(p);
          if (t === BISHOP || t === QUEEN || (t === KING && distance === 1)) found.push(c);
        }
        break;
      }
      c = step(c, d);
    }
  }
  // Knights jump.
  for (const d of KNIGHT_JUMPS) {
    const c = step(target, d);
    if (c !== -1 && board[c] === KNIGHT * by) found.push(c);
  }
  // A pawn of colour `by` standing on X attacks X + d for each of its capture directions d,
  // so `target` is attacked by such a pawn standing on target - d.
  for (const d of pawnCaptureDirs(v, by)) {
    const c = cellAt(cellQ[target] - d[0], cellR[target] - d[1]);
    if (c !== -1 && board[c] === PAWN * by) found.push(c);
  }
  return found;
}

/** Is the king of `color` attacked? (A side without a king is never in check.) */
function kingAttacked(board, v, color) {
  const k = findKing(board, color);
  return k !== -1 && attackersOf(board, v, k, -color).length > 0;
}

// ===========================================================================
// Move generation
// ===========================================================================

// Internal move record. `piece` / `captured` / `promo` are type codes (§3: 1..6, 0 = none).
function newMove(from, to, piece, captured, promo, isEp, isDouble) {
  return { from, to, piece, captured, promo, ep: isEp, double: isDouble, next: null };
}

function moveString(m) {
  return cellNames[m.from] + cellNames[m.to] + (m.promo ? PROMO_LETTER[m.promo] : '');
}

/** A pawn move to `to`; reaching the last cell of the file means 4 moves (mandatory promotion). */
function addPawnMove(moves, from, to, captured, isEp, isDouble, us) {
  if (isPromotionCell(to, us)) {
    for (const promo of PROMOTION_CHOICES) moves.push(newMove(from, to, PAWN, captured, promo, isEp, isDouble));
  } else {
    moves.push(newMove(from, to, PAWN, captured, 0, isEp, isDouble));
  }
}

function addPawnMoves(moves, pos, v, from, us) {
  const board = pos.board;
  const fwd = forward(us);
  // Advance one cell straight forward onto an empty cell; from a double-step cell, two
  // cells if both are empty.
  const one = step(from, fwd);
  if (one !== -1 && board[one] === 0) {
    addPawnMove(moves, from, one, 0, false, false, us);
    if (doubleStepCells(v, us).has(from)) {
      const two = step(one, fwd);
      if (two !== -1 && board[two] === 0) addPawnMove(moves, from, two, 0, false, true, us);
    }
  }
  // Captures: one cell in either capture direction onto an enemy piece, or onto the
  // en-passant cell (the double-stepped enemy pawn stands one cell beyond it, in the
  // enemy's forward direction, and is removed).
  for (const d of pawnCaptureDirs(v, us)) {
    const to = step(from, d);
    if (to === -1) continue;
    const target = board[to];
    if (target !== 0) {
      if (Math.sign(target) === -us) addPawnMove(moves, from, to, Math.abs(target), false, false, us);
    } else if (to === pos.ep) {
      const victim = step(to, forward(-us));
      if (victim !== -1 && board[victim] === PAWN * -us) addPawnMove(moves, from, to, PAWN, true, false, us);
    }
  }
}

/** Knight jumps and king steps: one hop to an empty or enemy-occupied cell. */
function addLeaps(moves, board, from, piece, offsets, us) {
  for (const d of offsets) {
    const to = step(from, d);
    if (to === -1) continue;
    const target = board[to];
    if (target === 0) moves.push(newMove(from, to, piece, 0, 0, false, false));
    else if (Math.sign(target) === -us) moves.push(newMove(from, to, piece, Math.abs(target), 0, false, false));
  }
}

/** Rook / bishop / queen rays: slide until the edge, an own piece (stop) or an enemy piece (capture, stop). */
function addSlides(moves, board, from, piece, dirs, us) {
  for (const d of dirs) {
    for (let to = step(from, d); to !== -1; to = step(to, d)) {
      const target = board[to];
      if (target === 0) {
        moves.push(newMove(from, to, piece, 0, 0, false, false));
      } else {
        if (Math.sign(target) === -us) moves.push(newMove(from, to, piece, Math.abs(target), 0, false, false));
        break;
      }
    }
  }
}

/** Every move obeying the piece-movement rules, ignoring whether it leaves the own king attacked. */
function pseudoLegalMoves(pos) {
  const v = VARIANTS[pos.variant];
  const board = pos.board;
  const us = colorOfTurn(pos.turn);
  const moves = [];
  for (let from = 0; from < NUM_CELLS; from++) {
    const p = board[from];
    if (p === 0 || Math.sign(p) !== us) continue;
    switch (Math.abs(p)) {
      case PAWN: addPawnMoves(moves, pos, v, from, us); break;
      case KNIGHT: addLeaps(moves, board, from, KNIGHT, KNIGHT_JUMPS, us); break;
      case BISHOP: addSlides(moves, board, from, BISHOP, DIAGONAL, us); break;
      case ROOK: addSlides(moves, board, from, ROOK, ORTHOGONAL, us); break;
      case QUEEN: addSlides(moves, board, from, QUEEN, KING_STEPS, us); break; // 6 orthogonal + 6 diagonal rays
      case KING: addLeaps(moves, board, from, KING, KING_STEPS, us); break;
      default: throw new Error(`corrupt board code ${p}`);
    }
  }
  return moves;
}

/** Plays a (pseudo-legal) move on a COPY of the position and returns the new position. */
function applyMove(pos, m) {
  const us = colorOfTurn(pos.turn);
  const board = pos.board.slice();
  board[m.from] = 0;
  board[m.to] = (m.promo ? m.promo : m.piece) * us;
  if (m.ep) board[step(m.to, forward(-us))] = 0; // remove the pawn that double-stepped
  return {
    variant: pos.variant,
    board,
    turn: us === WHITE ? 'b' : 'w',
    ep: m.double ? step(m.from, forward(us)) : -1, // the cell passed over
    halfmove: m.piece === PAWN || m.captured !== 0 ? 0 : pos.halfmove + 1,
    fullmove: us === BLACK ? pos.fullmove + 1 : pos.fullmove,
  };
}

/** Legal moves (internal records, each with `.next` = the resulting position). */
function legalMoveList(pos) {
  const v = VARIANTS[pos.variant];
  const us = colorOfTurn(pos.turn);
  const legal = [];
  for (const m of pseudoLegalMoves(pos)) {
    const next = applyMove(pos, m);
    if (!kingAttacked(next.board, v, us)) {
      m.next = next;
      legal.push(m);
    }
  }
  return legal;
}

// ===========================================================================
// §5.1  FEN
// ===========================================================================

function parseBoard(text) {
  const rows = text.split('/');
  if (rows.length !== 11) throw new Error(`FEN board must have 11 ranks separated by '/', got ${rows.length}`);
  const board = new Int8Array(NUM_CELLS);
  for (let i = 0; i < 11; i++) {
    const rank = 11 - i; // rank 11 first, rank 1 last
    const files = filesOnRank(rank);
    const row = rows[i];
    let k = 0; // cells of this rank accounted for so far
    let j = 0;
    while (j < row.length) {
      const ch = row[j];
      if (ch >= '0' && ch <= '9') {
        let digits = '';
        while (j < row.length && row[j] >= '0' && row[j] <= '9') digits += row[j++];
        if (digits[0] === '0') throw new Error(`FEN rank ${rank}: bad empty-cell count "${digits}"`);
        k += Number(digits);
        if (k > files.length) throw new Error(`FEN rank ${rank}: more than ${files.length} cells`);
      } else {
        const code = Object.prototype.hasOwnProperty.call(PIECE_BY_LETTER, ch) ? PIECE_BY_LETTER[ch] : undefined;
        if (code === undefined) throw new Error(`FEN rank ${rank}: invalid character "${ch}"`);
        if (k >= files.length) throw new Error(`FEN rank ${rank}: more than ${files.length} cells`);
        board[cellOf(files[k], rank)] = code;
        k++;
        j++;
      }
    }
    if (k !== files.length) throw new Error(`FEN rank ${rank}: describes ${k} cells, expected ${files.length}`);
  }
  return board;
}

function parseCounter(text, name, min) {
  if (!/^\d+$/.test(text)) throw new Error(`FEN ${name} "${text}" is not a non-negative integer`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`FEN ${name} "${text}" out of range`);
  return n;
}

/**
 * §5.1 ep consistency: the ep cell is kept only if it is empty, the cell behind it (where the
 * double step started) is empty, and a pawn of the side that just moved stands on
 * ep + forward(that side). A missing (off-board) neighbour cell makes it inconsistent.
 */
function epConsistent(board, ep, turn) {
  const mover = -colorOfTurn(turn); // the side that made the previous move
  const behind = step(ep, forward(-mover));
  const landed = step(ep, forward(mover));
  return board[ep] === 0
    && behind !== -1 && board[behind] === 0
    && landed !== -1 && board[landed] === PAWN * mover;
}

/** Problems that make a position unacceptable for the engine's hc_load_fen (§7). */
function setupProblems(pos) {
  const v = VARIANTS[pos.variant];
  const problems = [];
  for (const color of [WHITE, BLACK]) {
    const name = color === WHITE ? 'white' : 'black';
    let kings = 0;
    for (let i = 0; i < NUM_CELLS; i++) {
      if (pos.board[i] === KING * color) kings++;
      if (pos.board[i] === PAWN * color && isPromotionCell(i, color)) problems.push(`${name} pawn on its promotion cell ${cellNames[i]}`);
    }
    if (kings !== 1) problems.push(`${name} has ${kings} kings`);
  }
  if (kingAttacked(pos.board, v, -colorOfTurn(pos.turn))) problems.push('the side not to move is in check');
  return problems;
}

/**
 * Parses a FEN (§5.1) for the given variant. Throws on malformed input: not 2..5 fields,
 * not 11 ranks, a rank not accounting for exactly its cell count, an unknown piece letter,
 * an empty-cell count of 0 or with a leading zero, side not 'w'/'b', an ep field that is
 * neither '-' nor a valid cell name, a non-integer halfmove clock, a fullmove number < 1,
 * or more than one king of a colour (rules undefined). Positions with a missing king are
 * accepted (the hexchess.club fixtures need them). The ep consistency rule is applied
 * (an inconsistent ep cell is silently dropped).
 * opts.strict = true additionally applies the hc_load_fen rules of §7 (exactly one king
 * per side, no pawn on its own promotion cell, side not to move not in check).
 */
export function parseFen(fen, variant, opts = {}) {
  const v = variantDef(variant);
  if (typeof fen !== 'string') throw new Error('FEN must be a string');
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 2 || fields.length > 5) throw new Error(`FEN must have 2 to 5 fields, got ${fields[0] === '' ? 0 : fields.length}`);
  const [boardText, side, epText = '-', halfText = '0', fullText = '1'] = fields;
  const board = parseBoard(boardText);
  if (side !== 'w' && side !== 'b') throw new Error(`FEN side to move must be 'w' or 'b', got "${side}"`);
  let ep = -1;
  if (epText !== '-') {
    const cell = cellByName.get(epText);
    if (cell === undefined) throw new Error(`FEN en-passant field "${epText}" is not a cell name`);
    if (epConsistent(board, cell, side)) ep = cell;
  }
  const halfmove = parseCounter(halfText, 'halfmove clock', 0);
  const fullmove = parseCounter(fullText, 'fullmove number', 1);
  for (const color of [WHITE, BLACK]) {
    let kings = 0;
    for (let i = 0; i < NUM_CELLS; i++) if (board[i] === KING * color) kings++;
    if (kings > 1) throw new Error(`FEN has ${kings} ${color === WHITE ? 'white' : 'black'} kings`);
  }
  const pos = { variant: v.id, board, turn: side, ep, halfmove, fullmove };
  if (opts.strict) {
    const problems = setupProblems(pos);
    if (problems.length) throw new Error(`illegal setup: ${problems.join('; ')}`);
  }
  return pos;
}

/** FEN of a position (§5.1); the ep cell is written whenever the previous move was a double step. */
export function toFen(pos) {
  const rows = [];
  for (let rank = 11; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (const fi of filesOnRank(rank)) {
      const p = pos.board[cellOf(fi, rank)];
      if (p === 0) {
        empty++;
      } else {
        if (empty) row += empty;
        empty = 0;
        row += pieceLetter(p);
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const ep = pos.ep === -1 ? '-' : cellNames[pos.ep];
  return `${rows.join('/')} ${pos.turn} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/** The variant's start position. */
export function startPosition(variant) {
  const v = variantDef(variant);
  return parseFen(v.startFen, v.id);
}

// ===========================================================================
// Public rules API
// ===========================================================================

/** Legal moves as coordinate strings, in generation order (sort before comparing). */
export function legalMoves(pos) {
  return legalMoveList(pos).map(moveString);
}

/**
 * Legal moves with details, for cross-checking the engine's move codes (§4):
 *   { move, from, to, fromIndex, toIndex, piece (1..6), captured (0..6; e.p. -> 1),
 *     promotion (0 or 2..5), capture, enPassant, doubleStep, key }
 * where key = fromIndex | toIndex << 8 | promotion << 16  (= engine move code & 0xFFFFF).
 */
export function legalMovesDetailed(pos) {
  return legalMoveList(pos).map((m) => ({
    move: moveString(m),
    from: cellNames[m.from],
    to: cellNames[m.to],
    fromIndex: m.from,
    toIndex: m.to,
    piece: m.piece,
    captured: m.captured,
    promotion: m.promo,
    capture: m.captured !== 0,
    enPassant: m.ep,
    doubleStep: m.double,
    key: m.from | (m.to << 8) | (m.promo << 16),
  }));
}

/** Normalises 'e4-e5', 'E4xD5', 'f10-f11=Q', 'e7e8+' etc. to the canonical 'e4e5' form. */
function normalizeMoveText(text) {
  return String(text).trim().toLowerCase().replace(/[-x=+#!?\s]/g, '');
}

/** Returns the NEW position after a legal move; throws if the move is not legal. */
export function makeMove(pos, moveStr) {
  const wanted = normalizeMoveText(moveStr);
  for (const m of legalMoveList(pos)) if (moveString(m) === wanted) return m.next;
  throw new Error(`illegal move "${moveStr}" in ${toFen(pos)} [${pos.variant}]`);
}

/** Plays a sequence of moves (array or space-separated string). */
export function playMoves(pos, moves) {
  const list = Array.isArray(moves) ? moves : String(moves).trim().split(/\s+/).filter(Boolean);
  return list.reduce((p, mv) => makeMove(p, mv), pos);
}

/** Is the side to move in check? */
export function inCheck(pos) {
  return kingAttacked(pos.board, VARIANTS[pos.variant], colorOfTurn(pos.turn));
}

/** Names of the cells holding pieces that give check to the side to move (2 = double check). */
export function checkers(pos) {
  const us = colorOfTurn(pos.turn);
  const k = findKing(pos.board, us);
  if (k === -1) return [];
  return attackersOf(pos.board, VARIANTS[pos.variant], k, -us).map((c) => cellNames[c]);
}

/** 'ongoing' | 'checkmate' | 'stalemate' (draw rules are NOT applied here). */
export function status(pos) {
  if (legalMoveList(pos).length > 0) return 'ongoing';
  return inCheck(pos) ? 'checkmate' : 'stalemate';
}

function countLeaves(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoveList(pos);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) total += countLeaves(m.next, depth - 1);
  return total;
}

/** Number of leaf nodes of the legal move tree of the given depth (integer >= 0). */
export function perft(pos, depth) {
  if (!Number.isInteger(depth) || depth < 0) throw new Error('perft needs an integer depth >= 0');
  return countLeaves(pos, depth);
}

/** { move: perft(after move, depth - 1) } with keys in sorted move order; depth >= 1. */
export function divide(pos, depth) {
  if (!Number.isInteger(depth) || depth < 1) throw new Error('divide needs an integer depth >= 1');
  const moves = legalMoveList(pos).map((m) => [moveString(m), m.next]);
  moves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const result = {};
  for (const [str, next] of moves) result[str] = countLeaves(next, depth - 1);
  return result;
}

/** The 91 signed piece codes of §3 in canonical cell order (compare with hc_board_ptr). */
export function boardArray(pos) { return Int8Array.from(pos.board); }

/** Cell name -> canonical index (§1), or -1. */
export function cellIndex(name) { const i = cellByName.get(name); return i === undefined ? -1 : i; }
/** Canonical index -> cell name. */
export function cellName(index) { return cellNames[index]; }
/** Canonical index or name -> axial { q, r, s }. */
export function cellAxial(cell) {
  const i = typeof cell === 'string' ? cellIndex(cell) : cell;
  if (!(i >= 0 && i < NUM_CELLS)) throw new Error(`no such cell ${cell}`);
  return { q: cellQ[i], r: cellR[i], s: -cellQ[i] - cellR[i] };
}

/** Number of king steps between two cells (precomputed by breadth-first search). */
const KING_DIST = (() => {
  const dist = new Uint8Array(NUM_CELLS * NUM_CELLS).fill(255);
  for (let a = 0; a < NUM_CELLS; a++) {
    dist[a * NUM_CELLS + a] = 0;
    const queue = [a];
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      for (const d of KING_STEPS) {
        const n = step(c, d);
        if (n !== -1 && dist[a * NUM_CELLS + n] === 255) {
          dist[a * NUM_CELLS + n] = dist[a * NUM_CELLS + c] + 1;
          queue.push(n);
        }
      }
    }
  }
  return dist;
})();
function kingDistance(a, b) { return KING_DIST[a * NUM_CELLS + b]; }

/** §2.1 insufficient material: K v K, K+N v K, K+B v K. */
function insufficientMaterial(board) {
  const others = [];
  for (let i = 0; i < NUM_CELLS; i++) if (board[i] !== 0 && Math.abs(board[i]) !== KING) others.push(Math.abs(board[i]));
  return others.length === 0 || (others.length === 1 && (others[0] === KNIGHT || others[0] === BISHOP));
}

// ===========================================================================
// Seeded random positions (for cross-checking)
// ===========================================================================

/** Deterministic PRNG: FNV-1a hash of the seed text, then mulberry32. */
function makeRng(seedText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 0x01000193);
  let a = h | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function pickWeighted(items, weights, rng) {
  let total = 0;
  for (const w of weights) total += w;
  let x = rng() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

function pieceCount(board) {
  let n = 0;
  for (let i = 0; i < NUM_CELLS; i++) if (board[i] !== 0) n++;
  return n;
}

/** Forward steps a pawn of `color` on `cell` still needs to reach its promotion cell. */
function stepsToPromotion(cell, color) {
  return color === WHITE ? fileHeight(cellFile[cell]) - cellRank[cell] : cellRank[cell] - 1;
}

/** Number of pieces giving check to the side to move (0 if it has no king). */
function checkerCount(pos) {
  const us = colorOfTurn(pos.turn);
  const k = findKing(pos.board, us);
  return k === -1 ? 0 : attackersOf(pos.board, VARIANTS[pos.variant], k, -us).length;
}

/** Does the side to move (after a double step) have a pawn whose capture direction reaches the ep cell? */
function epCapturePossible(pos) {
  if (pos.ep === -1) return false;
  const v = VARIANTS[pos.variant];
  const us = colorOfTurn(pos.turn);
  return pawnCaptureDirs(v, us).some((d) => {
    const c = cellAt(cellQ[pos.ep] - d[0], cellR[pos.ep] - d[1]);
    return c !== -1 && pos.board[c] === PAWN * us;
  });
}

/** Move-selection styles of the random playouts; each one skews towards a kind of position. */
const STYLES = ['uniform', 'captures', 'pawns', 'checks', 'kings', 'ep', 'endgame'];

function moveWeights(style, pos, legal) {
  const us = colorOfTurn(pos.turn);
  const ownKing = findKing(pos.board, us);
  const enemyKing = findKing(pos.board, -us);
  const kingApproach = (m) => m.piece === KING && enemyKing !== -1
    && kingDistance(m.to, enemyKing) < kingDistance(ownKing, enemyKing);
  const pawnPush = (m) => (m.piece === PAWN ? 40 / (1 + stepsToPromotion(m.to, us)) : 0);
  const sparse = pieceCount(pos.board) <= 12;
  return legal.map((m) => {
    switch (style) {
      case 'captures':
        return m.promo ? 30 : m.captured ? 25 : 1;
      case 'pawns':
        if (m.promo) return m.captured ? 80 : 50;
        if (m.piece === PAWN) return 4 + pawnPush(m) + (m.captured ? 10 : 0);
        return m.captured ? 3 : 1;
      case 'checks': {
        const n = checkerCount(m.next);
        return n >= 2 ? 500 : n === 1 ? 25 : m.captured ? 3 : 1;
      }
      case 'kings':
        if (kingApproach(m)) return 30;
        return m.captured ? 8 : 1;
      case 'ep':
        if (m.double) return epCapturePossible(m.next) ? 300 : 12;
        if (m.ep) return 3;
        return m.piece === PAWN ? 4 : 1;
      case 'endgame':
        if (!sparse) return m.promo ? 30 : m.captured ? 30 : 1;
        if (kingApproach(m)) return 25;
        if (m.promo) return 20;
        return m.piece === PAWN ? 3 + pawnPush(m) : m.captured ? 10 : 1;
      default: // 'uniform'
        return 1;
    }
  });
}

/** Tags describing what a position exercises (used to build a skewed, diverse sample). */
function positionTags(pos, legal) {
  const pseudo = pseudoLegalMoves(pos);
  const nCheckers = checkerCount(pos);
  const tags = [];
  if (nCheckers >= 1) tags.push('check');
  if (nCheckers >= 2) tags.push('doubleCheck');
  if (legal.length === 0) tags.push(nCheckers ? 'checkmate' : 'stalemate');
  if (pos.ep !== -1) {
    tags.push('afterDoubleStep');
    if (legal.some((m) => m.ep)) tags.push('ep');
    else if (pseudo.some((m) => m.ep)) tags.push('epIllegal'); // e.p. pseudo-legal but exposes the king
  }
  if (legal.some((m) => m.promo)) tags.push('promo');
  if (legal.some((m) => m.promo && m.captured)) tags.push('promoCapture');
  if (nCheckers === 0) {
    const nonKing = (list) => list.filter((m) => m.piece !== KING).length;
    if (nonKing(legal) < nonKing(pseudo)) tags.push('pin');
  }
  if (pieceCount(pos.board) <= 8) tags.push('sparse');
  const wk = findKing(pos.board, WHITE), bk = findKing(pos.board, BLACK);
  if (wk !== -1 && bk !== -1 && kingDistance(wk, bk) <= 2) tags.push('kingsNear');
  return tags;
}

/** Fractions of the requested count reserved for each tag (the rest is a general random mix). */
const DEFAULT_MIX = {
  doubleCheck: 0.05, epIllegal: 0.01, checkmate: 0.02, stalemate: 0.01, promoCapture: 0.06,
  kingsNear: 0.08, ep: 0.12, promo: 0.06, sparse: 0.12, check: 0.10, pin: 0.05,
};
// Tags filled first (rarest first), and the ones the playout loop insists on finding.
const TAG_ORDER = ['doubleCheck', 'epIllegal', 'stalemate', 'checkmate', 'promoCapture', 'kingsNear', 'ep', 'promo', 'sparse', 'check', 'pin'];
const REQUIRED_TAGS = ['doubleCheck', 'promoCapture', 'kingsNear', 'ep', 'promo', 'sparse', 'check'];

/**
 * Like randomPositions but returns [{ fen, tags }]. Every position is reached from the
 * variant's start position by a seeded random playout of legal moves (so it is a legal,
 * hc_load_fen-acceptable position). Deterministic for a given (variant, count, seed, opts);
 * `seed` may be any number or string. No two results share board + side + ep.
 * Tags: check, doubleCheck, checkmate, stalemate, afterDoubleStep, ep (legal e.p. capture),
 * epIllegal (e.p. pseudo-legal only), promo, promoCapture, pin (not in check, some non-king
 * move illegal), sparse (<= 8 pieces), kingsNear (kings 2 king-steps apart, the minimum).
 * opts: { maxPlies = 200 (longest playout), maxPlayouts (default 60 + count/2),
 *         mix: { tag: fraction of count, ... } overriding DEFAULT_MIX }.
 */
export function randomPositionsTagged(variant, count, seed, opts = {}) {
  const v = variantDef(variant);
  if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
  if (count === 0) return [];
  const rng = makeRng(`hexref:${v.id}:${seed}`);
  const maxPlies = opts.maxPlies ?? 200;
  if (!Number.isInteger(maxPlies) || maxPlies < 1) throw new Error('opts.maxPlies must be a positive integer');
  const minPlies = Math.min(8, maxPlies);
  const mix = { ...DEFAULT_MIX, ...(opts.mix || {}) };
  const quota = {};
  for (const tag of TAG_ORDER) quota[tag] = Math.round((mix[tag] || 0) * count);
  const minPlayouts = 2 * STYLES.length;
  const maxPlayouts = opts.maxPlayouts ?? 60 + Math.ceil(count / 2);
  const hardLimit = maxPlayouts + 10 * count; // only used if the pool is still smaller than `count`

  const pool = new Map(); // board+side+ep -> { fen, tags, playout }
  const tagCount = {};
  const start = startPosition(v.id);
  const enough = (playouts) => playouts >= minPlayouts && pool.size >= 2 * count
    && REQUIRED_TAGS.every((t) => (tagCount[t] || 0) >= 2 * quota[t]);
  const record = (pos, legal, playout) => {
    const fen = toFen(pos);
    const key = fen.split(' ').slice(0, 3).join(' '); // counters ignored for duplicate detection
    if (pool.has(key)) return;
    const tags = positionTags(pos, legal);
    pool.set(key, { fen, tags, playout });
    for (const t of tags) tagCount[t] = (tagCount[t] || 0) + 1;
  };

  let playouts = 0;
  while (!(enough(playouts) || (playouts >= maxPlayouts && pool.size >= count))) {
    if (playouts >= hardLimit) throw new Error(`randomPositions: could only find ${pool.size} distinct positions`);
    const style = STYLES[playouts % STYLES.length];
    const length = minPlies + Math.floor(rng() * (maxPlies - minPlies + 1)); // plies of this playout
    let pos = start;
    for (let ply = 0; ; ply++) {
      const legal = legalMoveList(pos);
      record(pos, legal, playouts);
      // stop at game end, dead draws, long quiet stretches (keeps clear of the 50-move rule)
      if (ply >= length || legal.length === 0 || insufficientMaterial(pos.board) || pos.halfmove >= 80) break;
      // Rare positions one ply ahead are recorded even if the playout does not go there:
      // double checks (style 'checks') and double steps that allow an e.p. capture ('ep').
      for (const m of legal) {
        const rare = style === 'checks' ? checkerCount(m.next) >= 2 : style === 'ep' && m.double && epCapturePossible(m.next);
        if (rare) record(m.next, legalMoveList(m.next), playouts);
      }
      const thisStyle = rng() < 0.12 ? 'uniform' : style;
      pos = pickWeighted(legal, moveWeights(thisStyle, pos, legal), rng).next;
    }
    playouts++;
  }

  // Selection: fill each tag's quota (rarest tags first), spreading picks over playouts,
  // then fill the rest from the whole pool, then shuffle.
  const entries = [...pool.values()];
  const chosen = new Set();
  const result = [];
  const take = (candidates, want) => {
    let taken = 0;
    for (const perPlayoutCap of [1, 3, Infinity]) {
      const used = new Map();
      for (const e of candidates) {
        if (taken >= want) return taken;
        if (chosen.has(e)) continue;
        const n = used.get(e.playout) || 0;
        if (n >= perPlayoutCap) continue;
        used.set(e.playout, n + 1);
        chosen.add(e);
        result.push(e);
        taken++;
      }
    }
    return taken;
  };
  for (const tag of TAG_ORDER) {
    if (!quota[tag]) continue;
    take(shuffleInPlace(entries.filter((e) => e.tags.includes(tag)), rng), Math.min(quota[tag], count - result.length));
  }
  take(shuffleInPlace(entries.slice(), rng), count - result.length);
  shuffleInPlace(result, rng);
  return result.map((e) => ({ fen: e.fen, tags: e.tags.slice() }));
}

/** Array of `count` distinct FEN strings from seeded random playouts (see randomPositionsTagged). */
export function randomPositions(variant, count, seed, opts = {}) {
  return randomPositionsTagged(variant, count, seed, opts).map((e) => e.fen);
}

// ===========================================================================
// Command-line interface
// ===========================================================================

const USAGE = `usage:
  node tools/reference/hexref.mjs perft  <variant> <depth> [fen]
  node tools/reference/hexref.mjs divide <variant> <depth> [fen]
  node tools/reference/hexref.mjs random <variant> <count> <seed>
  node tools/reference/hexref.mjs moves  <variant> <fen>
variants: glinski | mccooey   (FEN: quote it, or pass its fields as separate arguments)`;

function cliPosition(variant, fenArgs) {
  return fenArgs.length ? parseFen(fenArgs.join(' '), variant) : startPosition(variant);
}

function cliDepth(text) {
  if (!/^\d+$/.test(text || '')) throw new Error(`bad depth "${text}"`);
  return Number(text);
}

function runCli(args) {
  const [command, variant, ...rest] = args;
  switch (command) {
    case 'perft': {
      const depth = cliDepth(rest[0]);
      const pos = cliPosition(variant, rest.slice(1));
      const t0 = performance.now();
      const n = perft(pos, depth);
      const ms = performance.now() - t0;
      console.log(String(n));
      console.error(`perft(${depth}) ${pos.variant}: ${n} leaf nodes in ${(ms / 1000).toFixed(2)} s (${Math.round(n / Math.max(ms, 1))} k/s)`);
      return 0;
    }
    case 'divide': {
      const depth = cliDepth(rest[0]);
      const pos = cliPosition(variant, rest.slice(1));
      const t0 = performance.now();
      const d = divide(pos, depth);
      let total = 0;
      for (const [mv, n] of Object.entries(d)) { console.log(`${mv} ${n}`); total += n; }
      console.log(`total ${total}`);
      console.error(`divide(${depth}) ${pos.variant}: ${Object.keys(d).length} moves, ${total} leaf nodes in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
      return 0;
    }
    case 'random': {
      const count = cliDepth(rest[0]);
      if (rest[1] === undefined) throw new Error('missing seed');
      for (const fen of randomPositions(variant, count, rest[1])) console.log(fen);
      return 0;
    }
    case 'moves': {
      if (!rest.length) throw new Error('missing FEN');
      const pos = cliPosition(variant, rest);
      const moves = legalMoves(pos).sort();
      console.log(moves.join(' '));
      console.error(`${moves.length} legal moves; status ${status(pos)}${inCheck(pos) ? ' (in check)' : ''}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

function isMainModule() {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = resolvePath(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
