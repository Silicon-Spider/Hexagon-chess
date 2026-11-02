// geometry.js — the 91-cell hexagonal board (docs/SPEC.md §1).
//
// Cells are listed in the engine's canonical order (file a→l, then rank ascending), so
// CELLS[i] describes cell index i of the wasm ABI, the board array and the move encoding.
// Screen coordinates are given for a hex of "size" (centre-to-corner radius) 1, White at
// the bottom; multiply by the rendering size and negate both axes for a flipped board.

export const FILES = 'abcdefghikl';
export const FILE_OFFSET = [0, 6, 13, 21, 30, 40, 51, 61, 70, 78, 85];
export const NUM_CELLS = 91;
export const SQRT3 = Math.sqrt(3);

// Axial deltas (dq, dr). "North" is toward Black.
export const DIRS_ORTHO = [[0, -1], [0, 1], [1, -1], [1, 0], [-1, 0], [-1, 1]]; // N S NE SE NW SW
export const DIRS_DIAG = [[2, -1], [-2, 1], [1, -2], [-1, -1], [1, 1], [-1, 2]]; // E W NNE NNW SSE SSW
export const KNIGHT_JUMPS = [
  [3, -1], [3, -2], [-1, 3], [-1, -2], [-2, 3], [-2, -1],
  [-3, 1], [-3, 2], [1, -3], [1, 2], [2, -3], [2, 1],
];

function buildCells() {
  const cells = [];
  for (let fi = 0; fi < 11; fi++) {
    const q = fi - 5;
    const count = 11 - Math.abs(q);
    for (let rank = 1; rank <= count; rank++) {
      const r = 6 - rank - Math.max(q, 0);
      cells.push(Object.freeze({
        index: cells.length,
        name: FILES[fi] + rank,
        file: FILES[fi],
        fileIndex: fi,
        rank,
        q,
        r,
        s: -q - r,
        x: 1.5 * q,
        y: SQRT3 * (r + q / 2),
        colorClass: (((q - r) % 3) + 3) % 3,
        // Last cell of the file seen from each side (promotion cells, §2.1).
        whitePromo: r === -5 || q + r === -5,
        blackPromo: r === 5 || q + r === 5,
      }));
    }
  }
  return cells;
}

export const CELLS = Object.freeze(buildCells());

const NAME_TO_INDEX = new Map(CELLS.map((c) => [c.name, c.index]));
const AXIAL_TO_INDEX = new Int16Array(11 * 11).fill(-1);
for (const c of CELLS) AXIAL_TO_INDEX[(c.q + 5) * 11 + (c.r + 5)] = c.index;

export function isValidAxial(q, r) {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 5;
}

/** Index of the cell at axial (q, r), or -1 when off the board. */
export function cellAt(q, r) {
  if (!isValidAxial(q, r)) return -1;
  return AXIAL_TO_INDEX[(q + 5) * 11 + (r + 5)];
}

/** Index of a cell name such as "f6" (case-insensitive), or -1. */
export function cellIndex(name) {
  if (typeof name !== 'string') return -1;
  const i = NAME_TO_INDEX.get(name.trim().toLowerCase());
  return i === undefined ? -1 : i;
}

export function cellName(index) {
  const c = CELLS[index];
  return c ? c.name : '?';
}

/** Neighbour of a cell by an axial delta, or -1 when that leaves the board. */
export function stepCell(index, dq, dr) {
  const c = CELLS[index];
  return c ? cellAt(c.q + dq, c.r + dr) : -1;
}

export function hexDistance(a, b) {
  const A = CELLS[a];
  const B = CELLS[b];
  return (Math.abs(A.q - B.q) + Math.abs(A.r - B.r) + Math.abs(A.s - B.s)) / 2;
}

/** Forward direction of a colour's pawns (0 = White moves north, 1 = Black south). */
export function forwardDelta(color) {
  return color === 0 ? [0, -1] : [0, 1];
}

/**
 * Light / mid / dark shade of a colour class for a variant (§2.2, §2.3).
 * Gliński (0, and the default for unknown variants): class 0 mid, 1 light, 2 dark.
 * McCooey (1): class 0 light, 1 mid, 2 dark.
 */
export function shadeOfClass(variant, colorClass) {
  if (variant === 1) return ['light', 'mid', 'dark'][colorClass];
  return ['mid', 'light', 'dark'][colorClass];
}

/** Corner k (0..5) of a flat-topped hex, at angle 60°·k (y grows downward). */
export function hexCorner(cx, cy, size, k) {
  const a = (Math.PI / 3) * k;
  return [cx + size * Math.cos(a), cy + size * Math.sin(a)];
}

/** SVG "points" string of a flat-topped hex. */
export function hexPoints(cx, cy, size, digits = 2) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const [x, y] = hexCorner(cx, cy, size, k);
    pts.push(`${x.toFixed(digits)},${y.toFixed(digits)}`);
  }
  return pts.join(' ');
}

/** SVG path data ("M…Z") of a flat-topped hex. */
export function hexPath(cx, cy, size, digits = 2) {
  let d = '';
  for (let k = 0; k < 6; k++) {
    const [x, y] = hexCorner(cx, cy, size, k);
    d += `${k ? 'L' : 'M'}${x.toFixed(digits)} ${y.toFixed(digits)}`;
  }
  return d + 'Z';
}

/** Round fractional axial coordinates to the containing hex. */
export function axialRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

/** Cell under a point given in unit-size screen coordinates (unflipped), or -1. */
export function cellFromPoint(x, y) {
  const qf = (2 / 3) * x;
  const rf = -x / 3 + (SQRT3 / 3) * y;
  const [q, r] = axialRound(qf, rf);
  return cellAt(q, r);
}

const FEN_PIECES = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

/**
 * Board field of a FEN (§5.1) → Int8Array(91) in canonical order (+white / -black), or
 * null if malformed. Used for static diagrams; the engine validates real positions.
 */
export function parseFenBoard(fen) {
  const ranks = String(fen).trim().split(/\s+/)[0].split('/');
  if (ranks.length !== 11) return null;
  const board = new Int8Array(NUM_CELLS);
  for (let i = 0; i < 11; i++) {
    const rank = 11 - i;
    const files = [];
    for (let fi = 0; fi < 11; fi++) if (11 - Math.abs(fi - 5) >= rank) files.push(fi);
    const s = ranks[i];
    let pos = 0;
    let j = 0;
    while (j < s.length) {
      const ch = s[j];
      if (ch >= '0' && ch <= '9') {
        let k = j;
        while (k < s.length && s[k] >= '0' && s[k] <= '9') k++;
        pos += parseInt(s.slice(j, k), 10);
        j = k;
        continue;
      }
      const t = FEN_PIECES[ch.toLowerCase()];
      if (!t || pos >= files.length) return null;
      board[FILE_OFFSET[files[pos]] + rank - 1] = ch === ch.toLowerCase() ? -t : t;
      pos++;
      j++;
    }
    if (pos !== files.length) return null;
  }
  return board;
}

/**
 * Cells a piece could reach on an otherwise empty board (used by the rules diagrams;
 * the engine is the authority for real games). type: 2 N, 3 B, 4 R, 5 Q, 6 K.
 */
export function emptyBoardTargets(index, type) {
  const out = [];
  const c = CELLS[index];
  const slide = (dirs) => {
    for (const [dq, dr] of dirs) {
      let q = c.q + dq;
      let r = c.r + dr;
      while (isValidAxial(q, r)) {
        out.push(cellAt(q, r));
        q += dq;
        r += dr;
      }
    }
  };
  const jump = (dirs) => {
    for (const [dq, dr] of dirs) {
      const t = cellAt(c.q + dq, c.r + dr);
      if (t >= 0) out.push(t);
    }
  };
  if (type === 2) jump(KNIGHT_JUMPS);
  else if (type === 3) slide(DIRS_DIAG);
  else if (type === 4) slide(DIRS_ORTHO);
  else if (type === 5) { slide(DIRS_ORTHO); slide(DIRS_DIAG); }
  else if (type === 6) { jump(DIRS_ORTHO); jump(DIRS_DIAG); }
  return out;
}
