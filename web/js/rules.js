// rules.js — variant descriptions and the "How to play" content (docs/SPEC.md §2, §9.4),
// with small board diagrams drawn from the geometry tables.
import { cellIndex, stepCell, emptyBoardTargets, parseFenBoard } from './geometry.js';
import { miniBoardSvg } from './board-view.js';
import { escapeHtml } from './dom.js';

export const VARIANT_INFO = {
  0: {
    short: 'Gliński',
    title: 'Gliński’s hexagonal chess',
    year: '1949',
    blurb: 'The classic of the hex world. Pawns capture at 60°, may double-step from any pawn starting cell, and stalemate scores ¾ for the attacker.',
  },
  1: {
    short: 'McCooey',
    title: 'McCooey’s hexagonal chess',
    year: '1978',
    blurb: 'A light-centred board and a compact setup. Pawns capture diagonally through cell corners, and stalemate is a draw.',
  },
};

export function variantInfo(id, engineName) {
  return VARIANT_INFO[id] || {
    short: engineName || `Variant ${id}`,
    title: engineName || `Variant ${id}`,
    year: '',
    blurb: 'Hexagonal chess on the 91-cell board.',
  };
}

const PAWN_RULES = {
  0: {
    doubleCells: 'b1 c2 d3 e4 f5 g4 h3 i2 k1',
    blackDoubleCells: 'b7 c7 d7 e7 f7 g7 h7 i7 k7',
    capture: [[-1, 0], [1, -1]],
    pawnCell: 'e4',
    text: [
      'Moves one cell straight forward onto an empty cell.',
      'May advance <b>two cells</b> (both empty) when it stands on <b>any</b> pawn starting cell of its colour — White: b1 c2 d3 e4 f5 g4 h3 i2 k1. A pawn that reached another pawn’s starting cell by capturing may still double-step.',
      'Captures one cell forward <b>at 60° to the file</b>, through a cell edge: for White to the upper-left or upper-right neighbour (never straight ahead).',
    ],
  },
  1: {
    doubleCells: 'c1 d2 e3 g3 h2 i1',
    blackDoubleCells: 'c8 d8 e8 g8 h8 i8',
    capture: [[-1, -1], [1, -2]],
    pawnCell: 'e3',
    text: [
      'Moves one cell straight forward onto an empty cell.',
      'May advance <b>two cells</b> (both empty) from its own starting cell — White: c1 d2 e3 g3 h2 i1. The centre f-pawn may <b>not</b> double-step.',
      'Captures <b>diagonally forward</b>, through a cell corner, to the forward-left or forward-right diagonal cell. Such a capture can never be blocked.',
    ],
  },
};

// The file letter l, styled like the board coordinates (in the UI font it reads as a capital I).
const L = '<span class="file-l">l</span>';

const PIECE_TEXT = [
  { type: 6, name: 'King', text: 'One step in any of the <b>12</b> directions: to the 6 edge-neighbours or the 6 corner-neighbours. There is no castling, and kings can never stand side by side.' },
  { type: 5, name: 'Queen', text: 'Slides any distance in all 12 directions — a rook and a bishop combined.' },
  { type: 4, name: 'Rook', text: 'Slides any distance straight through cell <b>edges</b>, in 6 directions.' },
  { type: 3, name: 'Bishop', text: 'Slides any distance diagonally through cell <b>corners</b>, in 6 directions. A bishop never changes colour, so each side has three — one per colour.' },
  { type: 2, name: 'Knight', text: 'Jumps to one of 12 cells: two cells straight, then one cell at 60°. Nothing can block it.' },
];

function diagram(variant, pieces, marks) {
  return `<figure class="rule-fig">${miniBoardSvg({ variant, pieces, marks, size: 9 })}</figure>`;
}

function pieceDiagram(variant, type) {
  const at = cellIndex('f6');
  const marks = new Map();
  for (const t of emptyBoardTargets(at, type)) marks.set(t, 'move');
  marks.set(at, 'from');
  return diagram(variant, [{ cell: at, color: 0, type }], marks);
}

function pawnDiagram(variant) {
  const rules = PAWN_RULES[variant] || PAWN_RULES[0];
  const at = cellIndex(rules.pawnCell);
  const marks = new Map([[at, 'from']]);
  const pieces = [{ cell: at, color: 0, type: 1 }];
  const one = stepCell(at, 0, -1);
  const two = stepCell(one, 0, -1);
  marks.set(one, 'move');
  marks.set(two, 'double');
  for (const [dq, dr] of rules.capture) {
    const c = stepCell(at, dq, dr);
    if (c >= 0) {
      marks.set(c, 'capture');
      pieces.push({ cell: c, color: 1, type: 2 });
    }
  }
  return diagram(variant, pieces, marks);
}

function setupDiagram(variant, startFen) {
  const board = startFen ? parseFenBoard(startFen) : null;
  if (!board) return '';
  const pieces = [];
  board.forEach((p, cell) => {
    if (p) pieces.push({ cell, color: p > 0 ? 0 : 1, type: Math.abs(p) });
  });
  return diagram(variant, pieces, new Map());
}

/**
 * HTML of the rules for one variant.
 * opts: { variant, name, startFen, stalemateRule (0 draw, 1 ¾–¼, 2 win) }
 */
export function rulesHtml({ variant, name, startFen, stalemateRule }) {
  const info = variantInfo(variant, name);
  const pawn = PAWN_RULES[variant] || PAWN_RULES[0];
  const shading = variant === 1
    ? 'McCooey boards have a <b>light</b> centre cell (f6).'
    : 'On Gliński’s board the centre cell (f6) is <b>mid-tone</b>; f1 is light and f11 dark.';
  const stalemate = stalemateRule === 1
    ? 'Stalemate is <b>not a draw</b>: the player who delivers it scores <b>¾</b> and the stalemated player <b>¼</b>.'
    : stalemateRule === 2
      ? 'Stalemate is a <b>win</b> for the player who delivers it.'
      : 'Stalemate is a <b>draw</b> (½–½).';

  const pieceCards = PIECE_TEXT.map((p) => `
    <article class="rule-card">
      ${pieceDiagram(variant, p.type)}
      <div><h4>${p.name}</h4><p>${p.text}</p></div>
    </article>`).join('');

  return `
  <section class="rules" data-variant="${variant}">
    <p class="rules-lede">${escapeHtml(info.title)}${info.year ? ` <span class="muted">· ${escapeHtml(info.year)}</span>` : ''} — ${escapeHtml(info.blurb)}</p>

    <div class="rule-card wide">
      ${setupDiagram(variant, startFen)}
      <div>
        <h3>The board</h3>
        <p>91 hexagonal cells in three colours; no two neighbouring cells share a colour. ${shading}</p>
        <p><b>Files</b> run straight up the board and are lettered <b>a–${L}</b> (there is no j). <b>Ranks</b> bend like chevrons: rank 1 runs from a1 down to f1 and back up to ${L}1. White starts at the bottom and moves first.</p>
        <p>The aim is the same as in ordinary chess: <b>checkmate</b> the enemy king. A move may never leave your own king attacked.</p>
      </div>
    </div>

    <h3>How the pieces move</h3>
    <div class="rule-grid">${pieceCards}
      <article class="rule-card">
        ${pawnDiagram(variant)}
        <div>
          <h4>Pawn</h4>
          <ul>${pawn.text.map((t) => `<li>${t}</li>`).join('')}</ul>
        </div>
      </article>
    </div>
    <p class="legend"><span class="lg lg-move"></span> move <span class="lg lg-double"></span> double step <span class="lg lg-capture"></span> capture</p>

    <h3>Special pawn rules</h3>
    <ul>
      <li><b>En passant.</b> If an enemy pawn has just made a double step past a cell your pawn could capture on, your pawn may capture it there, as if it had moved only one cell — on the very next move only.</li>
      <li><b>Promotion.</b> A pawn reaching the last cell of its file — for White a6 b7 c8 d9 e10 f11 g10 h9 i8 k7 ${L}6, for Black the first rank a1…${L}1 — must become a queen, rook, bishop or knight. Pick it from the picker that appears on the board (queen first; Esc cancels).</li>
      <li>Black’s double-step cells are ${escapeHtml(pawn.blackDoubleCells)}.</li>
    </ul>

    <h3>End of the game</h3>
    <ul>
      <li><b>Checkmate</b> wins.</li>
      <li>${stalemate}</li>
      <li><b>Draws</b> happen automatically by threefold repetition, by the fifty-move rule (50 moves by each side with no capture or pawn move) and with insufficient material: king against king, king and knight against king, king and bishop against king.</li>
      <li class="muted">On the hex board even those last endings contain cooperative mates${stalemateRule === 1 ? ' — and, with ¾-point stalemates, cooperative stalemates —' : ''} but none can be forced, so like most chess software this game scores them as draws.</li>
    </ul>

    <h3>Notation &amp; controls</h3>
    <ul>
      <li>Moves are written in algebraic notation: <code>Nf3</code>, <code>exd5</code>, <code>f11=Q+</code>, <code>Qxf9#</code>. Coordinate input like <code>e4e5</code> or <code>f10-f11=Q</code> works too.</li>
      <li>Click a piece and then a highlighted cell, or drag the piece. Dots mark quiet moves, rings mark captures.</li>
    </ul>
    <table class="keys">
      <tbody>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Step back / forward through the moves</td></tr>
        <tr><td><kbd>Home</kbd> <kbd>End</kbd></td><td>Jump to the start / the latest move</td></tr>
        <tr><td><kbd>F</kbd></td><td>Flip the board</td></tr>
        <tr><td><kbd>N</kbd></td><td>New game</td></tr>
        <tr><td><kbd>U</kbd></td><td>Undo (take back your last move)</td></tr>
        <tr><td><kbd>H</kbd> <kbd>S</kbd></td><td>How to play / settings</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close a dialog, cancel a selection or a promotion</td></tr>
      </tbody>
    </table>
  </section>`;
}
