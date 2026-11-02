// pieces.js - the original SVG piece set of Hexagonal Chess (docs/SPEC.md section 9.1).
//
// Six Staunton-inspired designs (pawn, knight, bishop, rook, queen, king) drawn from scratch
// for this project on a 100 x 100 grid (common baseline y = 88, centred on x = 50). They are
// expanded into twelve <symbol>s, ids 'hc-piece-wP' ... 'hc-piece-bK', that are placed with
// <use href="#hc-piece-wK"/>.
//
// Every colour comes from a CSS custom property, so a board theme can restyle the pieces
// straight through <use> (custom properties inherit into the shadow tree):
//   --hc-piece-w-fill   --hc-piece-w-stroke   --hc-piece-w-accent    white pieces
//   --hc-piece-b-fill   --hc-piece-b-stroke   --hc-piece-b-accent    black pieces
//   --hc-piece-b-rim    (optional; defaults to --hc-piece-b-fill)
// fill = body, stroke = outline and the lines between the parts of a piece,
// accent = interior detail (mane, eye, nostril, mouth ...). White: light fill, dark outline.
// Black: dark fill, light outline and light details so it stays legible on dark cells, plus
// a thin dark rim just outside the light outline so it keeps its full silhouette on light
// cells (set --hc-piece-b-rim: transparent to drop the rim).

const TYPE_LETTERS = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
const COLOR_LETTERS = ['w', 'b'];

const DEFAULT_COLORS = {
  w: { fill: '#fbf6ec', stroke: '#2a2521', accent: '#2a2521' },
  b: { fill: '#2b2622', stroke: '#ddd2c0', accent: '#ddd2c0' },
};

const OUTLINE_WIDTH = 3.2;
const ACCENT_WIDTH = 2.5;
const RIM_WIDTH = { w: 0, b: 1.2 }; // extra rim outside the outline, in viewBox units

// Piece artwork, 100 x 100 grid, drawn back to front.
// {B} = body shape (fill + outline), {A} = accent line, {D} = accent dot.
const DESIGNS = {
  P: [ // pawn
    '<circle {B} cx="50" cy="40.5" r="12.5"/>', // head
    '<path {B} d="M50 58L56 58C56 65.8 58.1 72.63 63 77.5L50 77.5L37 77.5C41.9 72.63 44 65.8 44 58L50 58Z"/>', // stem
    '<rect {B} x="37" y="52.5" width="26" height="6" rx="3"/>', // collar
    '<path {B} d="M50 76L65.8 76L68 78.2L68 83L50 83L32 83L32 78.2L34.2 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L70.3 81.5L73.8 84.75L70.3 88L50 88L29.7 88L26.2 84.75L29.7 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
  N: [ // knight
    '<path {B} d="M46.64 12.7C44.24 15.1 42.8 18.46 42.8 21.82C39.92 23.74 37.52 25.66 35.6 28.06C31.28 32.86 25.52 38.62 21.2 43.42C17.84 46.78 15.44 49.18 15.44 52.54C15.44 56.38 17.84 59.26 21.2 60.7C22.64 61.37 23.6 61.66 25.04 61.66C30.8 61.18 37.04 58.3 42.8 54.94C45.68 53.21 48.56 52.83 50.48 53.98C50.48 58.3 44.72 63.1 40.88 67.42C38 70.78 37.04 74.14 38 77.5L38.1 77.5L71.7 77.5L72.08 77.5C75.44 66.46 76.4 53.02 73.04 41.5C70.16 32.86 65.36 25.66 58.64 20.86C57.68 17.98 56.24 15.58 53.84 13.66C52.88 15.58 51.92 17.02 50.96 17.98C50 16.06 48.56 14.14 46.64 12.7Z"/>', // head and arched neck
    '<path {A} d="M16.02 55.52Q19.09 56.67 22.16 55.9"/>', // mouth
    '<path {A} d="M57.2 25.66C62.96 29.98 67.28 37.18 69.2 46.3C70.64 53.02 70.64 59.74 69.68 65.5"/>', // mane
    '<path {A} d="M50.48 53.5C54.32 49.18 55.28 41.98 51.92 36.22"/>', // cheek
    '<path {A} d="M19.28 48.7C20.72 47.26 22.64 47.74 23.12 49.66"/>', // nostril
    '<ellipse {D} cx="38" cy="31.9" rx="2.8" ry="1.9" transform="rotate(-42 38 31.9)"/>', // eye
    '<path {B} d="M50 76L68.8 76L71 78.2L71 83L50 83L29 83L29 78.2L31.2 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L73.3 81.5L76.8 84.75L73.3 88L50 88L26.7 88L23.2 84.75L26.7 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
  B: [ // bishop
    '<path {B} d="M50 21C53.29 23.12 56.58 25.78 59.14 28.9L51 41.5L61.85 32.89C63.19 35.39 64 38.11 64 41C64 47.5 60.5 51.5 57.5 54.5L50 54.5L42.5 54.5C39.5 51.5 36 47.5 36 41C36 32.5 43 25.5 50 21Z"/>', // mitre with slanted slit
    '<path {B} d="M50 57.5L55.5 57.5C55.5 65.5 57.9 72.5 63.5 77.5L50 77.5L36.5 77.5C42.1 72.5 44.5 65.5 44.5 57.5L50 57.5Z"/>', // stem
    '<rect {B} x="37.5" y="52.5" width="25" height="5.5" rx="2.75"/>', // collar
    '<circle {B} cx="50" cy="17.5" r="4.6"/>', // finial
    '<path {B} d="M50 76L67.3 76L69.5 78.2L69.5 83L50 83L30.5 83L30.5 78.2L32.7 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L71.8 81.5L75.3 84.75L71.8 88L50 88L28.2 88L24.7 84.75L28.2 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
  R: [ // rook
    '<path {B} d="M50 21L54.6 21L54.6 28L60.4 28L60.4 21L69 21L69 28.5C69 33.5 66 37 64.5 40.5L50 40.5L35.5 40.5C34 37 31 33.5 31 28.5L31 21L39.6 21L39.6 28L45.4 28L45.4 21L50 21Z"/>', // battlement: three merlons, two crenels
    '<path {B} d="M50 39.5L63.5 39.5C62.5 52 63 66 67.03 77.5L50 77.5L32.97 77.5C37 66 37.5 52 36.5 39.5L50 39.5Z"/>', // tower
    '<rect {B} x="33" y="38" width="34" height="6" rx="2.6"/>', // ring
    '<path {B} d="M50 76L69.3 76L71.5 78.2L71.5 83L50 83L28.5 83L28.5 78.2L30.7 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L73.8 81.5L77.3 84.75L73.8 88L50 88L26.2 88L22.7 84.75L26.2 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
  Q: [ // queen
    '<path {B} d="M50 17Q51.5 26 55 31Q57 25.5 60 20Q61.5 27 64.5 31.5Q66.5 28 70 25C69 30 67 33 66 35L50 35L34 35C33 33 31 30 30 25Q33.5 28 35.5 31.5Q38.5 27 40 20Q43 25.5 45 31Q48.5 26 50 17Z"/>', // coronet: five points
    '<circle {B} cx="50" cy="15.5" r="4.2"/>', // ball
    '<circle {B} cx="60" cy="19" r="3.6"/>', // ball
    '<circle {B} cx="40" cy="19" r="3.6"/>', // ball
    '<circle {B} cx="70" cy="24" r="3.4"/>', // ball
    '<circle {B} cx="30" cy="24" r="3.4"/>', // ball
    '<path {B} d="M50 35L65 35C61.5 39.5 58 43 57.5 48L50 48L42.5 48C42 43 38.5 39.5 35 35L50 35Z"/>', // chalice
    '<rect {B} x="32" y="30.5" width="36" height="5.5" rx="2.75"/>', // band
    '<path {B} d="M50 50L57 50C57 61 59.7 70.63 66 77.5L50 77.5L34 77.5C40.3 70.63 43 61 43 50L50 50Z"/>', // stem
    '<rect {B} x="37" y="44.5" width="26" height="6" rx="3"/>', // collar
    '<path {B} d="M50 76L70.3 76L72.5 78.2L72.5 83L50 83L27.5 83L27.5 78.2L29.7 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L74.8 81.5L78.3 84.75L74.8 88L50 88L25.2 88L21.7 84.75L25.2 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
  K: [ // king
    '<path {B} d="M47.6 21L47.9 14.6L42 15.4L42 9L47.9 9.8L47.3 4.4L52.7 4.4L52.1 9.8L58 9L58 15.4L52.1 14.6L52.4 21Z"/>', // cross, slightly flared
    '<path {B} d="M50 17.5C59.5 17.5 65.5 22 65.5 28.5L50 28.5L34.5 28.5C34.5 22 40.5 17.5 50 17.5Z"/>', // dome
    '<path {B} d="M50 29L67.5 29C63 34.5 58 40 58 47.5L50 47.5L42 47.5C42 40 37 34.5 32.5 29L50 29Z"/>', // chalice
    '<rect {B} x="31" y="26.5" width="38" height="6" rx="3"/>', // rim
    '<path {B} d="M50 50L57 50C57 61 59.7 70.63 66 77.5L50 77.5L34 77.5C40.3 70.63 43 61 43 50L50 50Z"/>', // stem
    '<rect {B} x="37" y="44.5" width="26" height="6" rx="3"/>', // collar
    '<path {B} d="M50 76L70.3 76L72.5 78.2L72.5 83L50 83L27.5 83L27.5 78.2L29.7 76L50 76Z"/>', // plinth tier
    '<path {B} d="M50 81.5L74.8 81.5L78.3 84.75L74.8 88L50 88L25.2 88L21.7 84.75L25.2 81.5L50 81.5Z"/>', // plinth slab
  ].join(''),
};

function buildSymbols() {
  let out = '';
  for (const c of COLOR_LETTERS) {
    const v = (name) => 'var(--hc-piece-' + c + '-' + name + ',' + DEFAULT_COLORS[c][name] + ')';
    const tokens = {
      '{B}': 'style="fill:' + v('fill') + ';stroke:' + v('stroke') + '"',
      '{A}': 'style="fill:none;stroke:' + v('accent') + ';stroke-width:' + ACCENT_WIDTH + '"',
      '{D}': 'style="fill:' + v('accent') + ';stroke:none"',
    };
    const rimColor = 'var(--hc-piece-' + c + '-rim,' + v('fill') + ')';
    const rimStyle = 'style="fill:' + rimColor + ';stroke:' + rimColor + ';stroke-width:' +
      (OUTLINE_WIDTH + 2 * RIM_WIDTH[c]) + '"';
    for (let t = 1; t <= 6; t++) {
      const letter = TYPE_LETTERS[t];
      const design = DESIGNS[letter];
      // Rim underlay: the body shapes again, stroked wider in the rim colour, without details.
      const rim = RIM_WIDTH[c] > 0
        ? design.replace(/<[^>]*\{[AD]\}[^>]*>/g, '').replace(/\{B\}/g, rimStyle)
        : '';
      const body = design.replace(/\{[BAD]\}/g, (m) => tokens[m]);
      out += '<symbol id="hc-piece-' + c + letter + '" viewBox="0 0 100 100">' +
        '<g stroke-width="' + OUTLINE_WIDTH + '" stroke-linejoin="round" stroke-linecap="round">' +
        rim + body + '</g></symbol>';
    }
  }
  return out;
}

// One string with the 12 <symbol> elements (white P N B R Q K, then black P N B R Q K).
export const PIECE_SYMBOLS_SVG = buildSymbols();

// Id of the hidden <svg> that injectPieceSymbols() adds to the document.
export const PIECE_DEFS_ELEMENT_ID = 'hc-piece-defs';

// color: 0 = white, 1 = black ('w' / 'b' also accepted);
// type: 1..6 = P N B R Q K (the letters 'P' ... 'K' also accepted).
// Returns e.g. 'hc-piece-wK', or null for anything else.
export function pieceSymbolId(color, type) {
  let c = null;
  if (color === 0 || color === 'w') c = 'w';
  else if (color === 1 || color === 'b') c = 'b';
  let t = null;
  if (typeof type === 'number' && Number.isInteger(type) && type >= 1 && type <= 6) t = TYPE_LETTERS[type];
  else if (typeof type === 'string' && type.length === 1 && 'PNBRQK'.includes(type.toUpperCase())) t = type.toUpperCase();
  return c && t ? 'hc-piece-' + c + t : null;
}

// Inserts the symbol definitions once into doc.body (doc defaults to globalThis.document).
// Calling it again is a no-op. Returns the hidden <svg> element (or null without a document).
export function injectPieceSymbols(doc) {
  const d = doc || globalThis.document;
  if (!d) return null;
  const existing = d.getElementById(PIECE_DEFS_ELEMENT_ID);
  if (existing) return existing;
  const supplied = d.getElementById('hc-piece-wP'); // symbols already put in the page some other way
  if (supplied) return supplied.ownerSVGElement || supplied.parentNode;
  const markup = '<svg id="' + PIECE_DEFS_ELEMENT_ID + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"' +
    ' width="0" height="0" style="position:absolute;overflow:hidden"><defs>' + PIECE_SYMBOLS_SVG + '</defs></svg>';
  const host = d.body || d.documentElement;
  host.insertAdjacentHTML('afterbegin', markup);
  return d.getElementById(PIECE_DEFS_ELEMENT_ID);
}

// Markup of a standalone piece icon (needs injectPieceSymbols() to have run), e.g.
// pieceSvg(1, 6, 32) -> '<svg class="hc-piece" width="32" height="32" viewBox="0 0 100 100"
// aria-hidden="true"><use href="#hc-piece-bK"/></svg>'. size: number (px) or CSS length
// string; defaults to '1em'. Returns '' for an invalid color/type.
export function pieceSvg(color, type, size) {
  const id = pieceSymbolId(color, type);
  if (!id) return '';
  let s = '1em';
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0) s = String(size);
  else if (typeof size === 'string' && /^\d+(\.\d+)?(px|em|rem|%|vw|vh|vmin|vmax)?$/.test(size.trim())) s = size.trim();
  return '<svg class="hc-piece" width="' + s + '" height="' + s + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<use href="#' + id + '"/></svg>';
}
