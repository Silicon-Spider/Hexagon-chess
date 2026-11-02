// board-view.js — the SVG board: frame, three-shade cells, coordinates, pieces,
// highlights, move animation and pointer input (click-to-move, drag and drop with mouse,
// touch or pen, in-board promotion picker). Game logic lives in the engine; this view
// only displays positions and reports the move the user picked (docs/SPEC.md §9.1, §9.2).
import { CELLS, NUM_CELLS, FILES, FILE_OFFSET, SQRT3, hexPoints, hexPath, shadeOfClass, cellFromPoint, stepCell } from './geometry.js';
import { pieceSymbolId } from './pieces.js';

const NS = 'http://www.w3.org/2000/svg';

export const HEX = 40; // hex radius in SVG user units
const TILE = 0.966; // tile size relative to the hex (the rest is the grout line)
const FRAME_APOTHEM = 9.42; // frame half-width in hex units
const FRAME_CORNER = 1.15; // frame corner rounding, hex units
const PIECE_BOX = 1.5; // piece glyph box, hex units
const LABEL_GAP = 1.27; // label distance from its cell centre, hex units
const LABEL_NUDGE = 0.2; // sideways nudge of labels sharing a notch of the top staircase
const DRAG_THRESHOLD_PX = 5;
const MOVE_MS = 180;
const FADE_MS = 160;

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function fmt(n) {
  return Number(n.toFixed(2));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function reducedMotion() {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    return false;
  }
}

/** Polygon path with quadratic-rounded corners. */
function roundedPath(points, radius) {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const l1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const a = [p1[0] + ((p0[0] - p1[0]) / l1) * radius, p1[1] + ((p0[1] - p1[1]) / l1) * radius];
    const b = [p1[0] + ((p2[0] - p1[0]) / l2) * radius, p1[1] + ((p2[1] - p1[1]) / l2) * radius];
    d += `${i ? 'L' : 'M'}${fmt(a[0])} ${fmt(a[1])}Q${fmt(p1[0])} ${fmt(p1[1])} ${fmt(b[0])} ${fmt(b[1])}`;
  }
  return d + 'Z';
}

/** Frame outline: a pointy-topped hexagon around the whole board (unit coordinates). */
function frameVertices(apothem) {
  const R = apothem / (SQRT3 / 2);
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = (-90 + 60 * k) * (Math.PI / 180);
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return pts;
}

/**
 * Coordinate labels in unflipped unit coordinates: file letters below each file's bottom
 * cell and above its top cell; rank numbers beyond both outer ends of each chevron rank.
 * Where a top letter and a rank number share a notch of the upper staircase, both are
 * nudged apart along their edges.
 */
function labelSpecs() {
  const out = [];
  const hx = SQRT3 / 2;
  for (let fi = 0; fi < 11; fi++) {
    const q = fi - 5;
    const bottom = CELLS[FILE_OFFSET[fi]];
    const top = CELLS[FILE_OFFSET[fi] + 10 - Math.abs(q)];
    out.push({ text: FILES[fi], kind: 'file', x: bottom.x, y: bottom.y + LABEL_GAP });
    const nudge = q < 0 ? -LABEL_NUDGE : q > 0 ? LABEL_NUDGE : 0;
    out.push({ text: FILES[fi], kind: 'file', x: top.x + nudge, y: top.y - LABEL_GAP });
  }
  for (let rank = 1; rank <= 11; rank++) {
    const leftFi = rank <= 6 ? 0 : rank - 6;
    const rightFi = rank <= 6 ? 10 : 16 - rank;
    const left = CELLS[FILE_OFFSET[leftFi] + rank - 1];
    const right = CELLS[FILE_OFFSET[rightFi] + rank - 1];
    const upper = rank >= 7 ? LABEL_NUDGE : 0;
    // Left end: continue the rank line toward the north-west; right end: north-east.
    out.push({
      text: String(rank), kind: 'rank',
      x: left.x - hx * LABEL_GAP + 0.5 * upper,
      y: left.y - 0.5 * LABEL_GAP - hx * upper,
    });
    out.push({
      text: String(rank), kind: 'rank',
      x: right.x + hx * LABEL_GAP - 0.5 * upper,
      y: right.y - 0.5 * LABEL_GAP - hx * upper,
    });
  }
  return out;
}

const LABELS = labelSpecs();

export class BoardView {
  /**
   * svg: the <svg> element to draw into.
   * handlers.onMove(move, meta) → boolean: the user picked a legal move (meta.dropped).
   * handlers.onGesture(): any pointer press (used to unlock audio).
   */
  constructor(svg, handlers = {}) {
    this.svg = svg;
    this.h = handlers;
    this.variant = 0;
    this.flipped = false;
    this.opts = { coords: true, legal: true, animate: true };
    this.board = new Int8Array(NUM_CELLS);
    this.byFrom = new Map();
    this.turnColor = 0;
    this.interactive = false;
    this.selected = -1;
    this.hover = -1;
    this.lastMove = null;
    this.checkCell = -1;
    this.pieceEls = new Array(NUM_CELLS).fill(null);
    this.moving = new Set();
    this.tweens = new Set();
    this.raf = 0;
    this.drag = null;
    this.promo = null;
    this._tick = this._tick.bind(this);
    this._build();
    this._bindInput();
  }

  // ------------------------------------------------------------------ construction

  _build() {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const A = FRAME_APOTHEM * HEX;
    const R = A / (SQRT3 / 2);
    const padX = 0.18 * HEX;
    const padTop = 0.12 * HEX;
    const padBottom = 0.42 * HEX;
    svg.setAttribute('viewBox', `${fmt(-A - padX)} ${fmt(-R - padTop)} ${fmt(2 * (A + padX))} ${fmt(2 * R + padTop + padBottom)}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.classList.add('hc-board');

    const defs = el('defs', null, svg);
    defs.innerHTML = `
      <linearGradient id="hcb-frame" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="stop-frame-hi"/>
        <stop offset="1" class="stop-frame-lo"/>
      </linearGradient>
      <radialGradient id="hcb-frame-sheen" cx="0.32" cy="0.18" r="0.9">
        <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
        <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="hcb-light" gradientUnits="userSpaceOnUse" cx="${fmt(-2.6 * HEX)}" cy="${fmt(-4.2 * HEX)}" r="${fmt(13.5 * HEX)}">
        <stop offset="0" stop-color="#fff" stop-opacity="0.20"/>
        <stop offset="0.45" stop-color="#fff" stop-opacity="0.04"/>
        <stop offset="0.8" stop-color="#000" stop-opacity="0.06"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.16"/>
      </radialGradient>
      <radialGradient id="hcb-check" r="0.5">
        <stop offset="0" class="stop-check" stop-opacity="0.95"/>
        <stop offset="0.45" class="stop-check" stop-opacity="0.6"/>
        <stop offset="1" class="stop-check" stop-opacity="0"/>
      </radialGradient>
      <filter id="hcb-piece-shadow" x="-30%" y="-30%" width="160%" height="170%">
        <feDropShadow dx="0" dy="${fmt(0.06 * HEX)}" stdDeviation="${fmt(0.05 * HEX)}" flood-color="#000" flood-opacity="0.38"/>
      </filter>
      <filter id="hcb-lift-shadow" x="-40%" y="-40%" width="180%" height="190%">
        <feDropShadow dx="0" dy="${fmt(0.22 * HEX)}" stdDeviation="${fmt(0.14 * HEX)}" flood-color="#000" flood-opacity="0.35"/>
      </filter>`;

    const layer = (cls) => el('g', { class: cls }, svg);
    this.gShadow = layer('frame-shadow');
    this.gFrame = layer('frame');
    this.gCoords = layer('coords');
    this.gBase = layer('base');
    this.gCells = layer('cells');
    this.gBevel = layer('bevel');
    this.gLight = layer('light');
    this.gMarks = layer('marks');
    this.gHints = layer('hints');
    this.gPieces = layer('pieces');
    this.gPieces.setAttribute('filter', 'url(#hcb-piece-shadow)');
    this.gFx = layer('fx');
    this.gDrag = layer('drag');
    this.gDrag.setAttribute('filter', 'url(#hcb-lift-shadow)');
    this.gPromo = layer('promo');

    // Frame: static, independent of flipping (it is symmetric).
    const frame = frameVertices(FRAME_APOTHEM).map(([x, y]) => [x * HEX, y * HEX]);
    const framePath = roundedPath(frame, FRAME_CORNER * HEX);
    for (let i = 4; i >= 1; i--) {
      el('path', {
        d: framePath,
        class: 'frame-shadow-layer',
        transform: `translate(0 ${fmt(i * 0.07 * HEX)}) scale(${fmt(1 + i * 0.006)})`,
        opacity: fmt(0.05 + (4 - i) * 0.03),
      }, this.gShadow);
    }
    el('path', { d: framePath, class: 'frame-body', fill: 'url(#hcb-frame)' }, this.gFrame);
    el('path', { d: framePath, class: 'frame-sheen', fill: 'url(#hcb-frame-sheen)' }, this.gFrame);
    const inner = frameVertices(FRAME_APOTHEM - 0.16).map(([x, y]) => [x * HEX, y * HEX]);
    el('path', { d: roundedPath(inner, (FRAME_CORNER - 0.12) * HEX), class: 'frame-rim' }, this.gFrame);
    // A fine inlay line just inside the frame edge, clear of the coordinate labels.
    const inlay = frameVertices(FRAME_APOTHEM - 0.27).map(([x, y]) => [x * HEX, y * HEX]);
    el('path', { d: roundedPath(inlay, (FRAME_CORNER - 0.24) * HEX), class: 'frame-inlay' }, this.gFrame);
    this.framePath = framePath;

    // Persistent highlight shapes.
    const tilePts = hexPoints(0, 0, HEX * TILE);
    this.mLastFrom = el('polygon', { points: tilePts, class: 'mark mark-last' }, this.gMarks);
    this.mLastTo = el('polygon', { points: tilePts, class: 'mark mark-last mark-last-to' }, this.gMarks);
    this.mCheck = el('circle', { r: fmt(HEX * 1.05), class: 'mark-check', fill: 'url(#hcb-check)' }, this.gMarks);
    this.mSelected = el('polygon', { points: tilePts, class: 'mark mark-selected' }, this.gMarks);
    this.mHover = el('polygon', { points: hexPoints(0, 0, HEX * (TILE - 0.06)), class: 'mark mark-hover' }, this.gMarks);
    for (const m of [this.mLastFrom, this.mLastTo, this.mCheck, this.mSelected, this.mHover]) m.style.display = 'none';

    this._layoutCells();
  }

  _pos(index) {
    const c = CELLS[index];
    const k = this.flipped ? -HEX : HEX;
    return [c.x * k, c.y * k];
  }

  /** (Re)draw everything that depends on orientation or variant shading. */
  _layoutCells() {
    for (const g of [this.gCoords, this.gBase, this.gCells, this.gBevel, this.gLight]) {
      while (g.firstChild) g.removeChild(g.firstChild);
    }
    let base = '';
    let union = '';
    let hi = '';
    let lo = '';
    const t = HEX * TILE;
    const b = t * 0.93;
    for (const c of CELLS) {
      const [x, y] = this._pos(c.index);
      base += hexPath(x, y, HEX * 1.035);
      union += hexPath(x, y, t);
      const shade = shadeOfClass(this.variant, c.colorClass);
      el('polygon', {
        points: hexPoints(x, y, t),
        class: `cell ${shade}`,
        'data-cell': c.name,
      }, this.gCells);
      // Bevel: lit upper edges, shaded lower edges (corner k at 60°·k, y down).
      const corner = (k) => {
        const a = (Math.PI / 3) * k;
        return `${fmt(x + b * Math.cos(a))} ${fmt(y + b * Math.sin(a))}`;
      };
      hi += `M${corner(3)}L${corner(4)}L${corner(5)}L${corner(0)}`;
      lo += `M${corner(0)}L${corner(1)}L${corner(2)}L${corner(3)}`;
    }
    el('path', { d: base, class: 'board-bed' }, this.gBase);
    el('path', { d: hi, class: 'bevel-hi' }, this.gBevel);
    el('path', { d: lo, class: 'bevel-lo' }, this.gBevel);
    el('path', { d: union, class: 'board-light', fill: 'url(#hcb-light)' }, this.gLight);

    const sign = this.flipped ? -1 : 1;
    for (const L of LABELS) {
      const tx = el('text', {
        x: fmt(L.x * HEX * sign),
        y: fmt(L.y * HEX * sign),
        dy: '0.36em',
        class: `coord coord-${L.kind}`,
        'text-anchor': 'middle',
      }, this.gCoords);
      tx.textContent = L.text;
    }
    this.gCoords.style.display = this.opts.coords ? '' : 'none';

    for (let i = 0; i < NUM_CELLS; i++) {
      const p = this.pieceEls[i];
      if (p && !this.moving.has(p)) this._place(p, i);
    }
    this._renderMarks();
  }

  // ------------------------------------------------------------------ public API

  setVariant(variant) {
    const v = variant >>> 0;
    if (v === this.variant) return;
    this.variant = v;
    this._layoutCells();
  }

  setFlipped(flipped) {
    const f = !!flipped;
    if (f === this.flipped) return;
    this._finishTweens();
    this._cancelDrag();
    this.cancelPromotion();
    this.flipped = f;
    this._layoutCells();
  }

  setOptions(opts) {
    Object.assign(this.opts, opts);
    this.gCoords.style.display = this.opts.coords ? '' : 'none';
    this._renderMarks();
  }

  /**
   * Show a position. opts:
   *   lastMove {from,to} | null, checkCell (-1 none),
   *   move (decoded) + reverse/dropped: animate that move forward (or backward for undo),
   *   instant: no animation.
   */
  setPosition(board, opts = {}) {
    this._finishTweens();
    this._cancelDrag();
    this.cancelPromotion();
    const old = this.board;
    this.board = Int8Array.from(board);
    this.lastMove = opts.lastMove || null;
    this.checkCell = opts.checkCell === undefined ? -1 : opts.checkCell;
    if (!opts.keepSelection) {
      this.selected = -1;
      this.hover = -1;
    }
    const anim = this.opts.animate && !opts.instant && !reducedMotion();
    if (opts.move) {
      if (opts.reverse) this._animateReverse(opts.move, anim);
      else this._animateForward(opts.move, old, anim, !!opts.dropped);
    }
    this._reconcile();
    this._renderMarks();
  }

  /** Legal moves of the side to move, and whether the user may move now. */
  setMoves(moves, turnColor, interactive) {
    this.byFrom = new Map();
    for (const m of moves || []) {
      let list = this.byFrom.get(m.from);
      if (!list) this.byFrom.set(m.from, (list = []));
      list.push(m);
    }
    this.turnColor = turnColor;
    this.interactive = !!interactive;
    if (this.selected >= 0 && (!this.interactive || !this._isOwn(this.selected))) {
      this.selected = -1;
      this.hover = -1;
    }
    if (!this.interactive) {
      this._cancelDrag();
      this.cancelPromotion();
    }
    this._renderMarks();
  }

  clearSelection() {
    if (this.selected < 0 && this.hover < 0) return;
    this.selected = -1;
    this.hover = -1;
    this._renderMarks();
  }

  get promotionOpen() {
    return !!this.promo;
  }

  get selectedCell() {
    return this.selected;
  }

  /** Simulated click on a cell, through the same logic as a pointer click. */
  clickCell(index) {
    if (this.promo) {
      const opt = this.promo.cells.find((c) => c.cell === index);
      if (opt) this._choosePromotion(opt.type);
      else this.cancelPromotion();
      return;
    }
    this._press(index, null);
  }

  /** Keyboard while the promotion picker is open. Returns true if handled. */
  handleKey(key) {
    if (!this.promo) return false;
    const k = key.toLowerCase();
    const map = { q: 5, r: 4, b: 3, n: 2, enter: 5 };
    if (k === 'escape') {
      this.cancelPromotion();
      return true;
    }
    if (map[k] && this.promo.options.some((m) => m.promo === map[k])) {
      this._choosePromotion(map[k]);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ pieces

  _symbolHref(code) {
    return '#' + pieceSymbolId(code > 0 ? 0 : 1, Math.abs(code));
  }

  _createPiece(index, code, atStart) {
    const g = el('g', { class: 'piece' });
    const s = PIECE_BOX * HEX;
    const use = el('use', { x: fmt(-s / 2), y: fmt(-s / 2), width: fmt(s), height: fmt(s) }, g);
    g.__use = use;
    this._setCode(g, code);
    this._place(g, index);
    if (atStart) this.gPieces.insertBefore(g, this.gPieces.firstChild);
    else this.gPieces.appendChild(g);
    this.pieceEls[index] = g;
    return g;
  }

  _setCode(g, code) {
    if (g.__code === code) return;
    g.__code = code;
    g.__use.setAttribute('href', this._symbolHref(code));
    g.setAttribute('class', `piece ${code > 0 ? 'white' : 'black'}`);
  }

  _place(g, index) {
    const [x, y] = this._pos(index);
    g.setAttribute('transform', `translate(${fmt(x)} ${fmt(y)})`);
  }

  _reconcile() {
    for (let i = 0; i < NUM_CELLS; i++) {
      const want = this.board[i];
      const g = this.pieceEls[i];
      if (!want) {
        if (g) {
          g.remove();
          this.pieceEls[i] = null;
        }
        continue;
      }
      if (!g) {
        this._createPiece(i, want);
        continue;
      }
      if (this.moving.has(g)) continue;
      this._setCode(g, want);
      this._place(g, i);
    }
  }

  _victimCell(move, moverIsWhite) {
    if (move.isEnPassant) return stepCell(move.to, 0, moverIsWhite ? 1 : -1);
    return move.isCapture ? move.to : -1;
  }

  _animateForward(m, old, anim, dropped) {
    const g = this.pieceEls[m.from];
    if (!g || !old[m.from]) return;
    const victim = this._victimCell(m, old[m.from] > 0);
    const v = victim >= 0 ? this.pieceEls[victim] : null;
    if (v && v !== g) {
      this.pieceEls[victim] = null;
      if (anim) this._fadeOut(v);
      else v.remove();
    }
    this.pieceEls[m.from] = null;
    this.pieceEls[m.to] = g;
    this.gPieces.appendChild(g);
    if (anim && !dropped) this._slide(g, m.from, m.to);
  }

  _animateReverse(m, anim) {
    const g = this.pieceEls[m.to];
    const now = this.board[m.from];
    if (!g || !now) return;
    this.pieceEls[m.to] = null;
    this.pieceEls[m.from] = g;
    this._setCode(g, now);
    this.gPieces.appendChild(g);
    if (anim) this._slide(g, m.to, m.from);
    const victim = this._victimCell(m, now > 0);
    if (victim >= 0 && this.board[victim] && !this.pieceEls[victim]) {
      const v = this._createPiece(victim, this.board[victim], true);
      if (anim) this._fadeIn(v);
    }
  }

  _slide(g, from, to) {
    const [x0, y0] = this._pos(from);
    const [x1, y1] = this._pos(to);
    this.moving.add(g);
    this._tween(MOVE_MS, (k) => {
      g.setAttribute('transform', `translate(${fmt(x0 + (x1 - x0) * k)} ${fmt(y0 + (y1 - y0) * k)})`);
    }, () => {
      this.moving.delete(g);
      if (this.pieceEls[to] === g) {
        this._setCode(g, this.board[to]);
        this._place(g, to);
      }
    });
  }

  _fadeOut(g) {
    this.gFx.appendChild(g);
    this._tween(FADE_MS, (k) => { g.style.opacity = String(1 - k); }, () => g.remove());
  }

  _fadeIn(g) {
    g.style.opacity = '0';
    this._tween(FADE_MS, (k) => { g.style.opacity = String(k); }, () => { g.style.opacity = ''; });
  }

  _tween(duration, step, done) {
    const t = { start: performance.now(), duration, step, done, finished: false };
    this.tweens.add(t);
    step(0);
    if (!this.raf) this.raf = requestAnimationFrame(this._tick);
    return t;
  }

  _tick(now) {
    this.raf = 0;
    for (const t of Array.from(this.tweens)) {
      const k = Math.min(1, Math.max(0, (now - t.start) / t.duration));
      if (k >= 1) this._endTween(t);
      else t.step(easeOutCubic(k));
    }
    if (this.tweens.size) this.raf = requestAnimationFrame(this._tick);
  }

  _endTween(t) {
    if (t.finished) return;
    t.finished = true;
    this.tweens.delete(t);
    t.step(1);
    if (t.done) t.done();
  }

  _finishTweens() {
    for (const t of Array.from(this.tweens)) this._endTween(t);
  }

  // ------------------------------------------------------------------ highlights

  _placeMark(node, index) {
    if (index === undefined || index === null || index < 0) {
      node.style.display = 'none';
      return;
    }
    const [x, y] = this._pos(index);
    node.setAttribute('transform', `translate(${fmt(x)} ${fmt(y)})`);
    node.style.display = '';
  }

  _renderMarks() {
    const lm = this.lastMove;
    this._placeMark(this.mLastFrom, lm ? lm.from : -1);
    this._placeMark(this.mLastTo, lm ? lm.to : -1);
    this._placeMark(this.mCheck, this.checkCell);
    this._placeMark(this.mSelected, this.selected);
    this._placeMark(this.mHover, this.hover);
    const gh = this.gHints;
    while (gh.firstChild) gh.removeChild(gh.firstChild);
    if (this.selected >= 0 && this.opts.legal) {
      const seen = new Set();
      for (const m of this.byFrom.get(this.selected) || []) {
        if (seen.has(m.to)) continue;
        seen.add(m.to);
        const [x, y] = this._pos(m.to);
        if (m.isCapture) {
          el('circle', { cx: fmt(x), cy: fmt(y), r: fmt(HEX * 0.7), class: 'hint hint-capture' }, gh);
        } else {
          el('circle', { cx: fmt(x), cy: fmt(y), r: fmt(HEX * 0.19), class: 'hint hint-move' }, gh);
        }
      }
    }
  }

  _setHover(cell) {
    if (cell === this.hover) return;
    this.hover = cell;
    this._placeMark(this.mHover, cell);
  }

  // ------------------------------------------------------------------ input

  _isOwn(cell) {
    const p = this.board[cell];
    return p !== 0 && (p > 0 ? 0 : 1) === this.turnColor;
  }

  _targetsOf(from) {
    const set = new Set();
    for (const m of this.byFrom.get(from) || []) set.add(m.to);
    return set;
  }

  _userPoint(e) {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  _cellAtEvent(e) {
    const p = this._userPoint(e);
    const k = this.flipped ? -HEX : HEX;
    return cellFromPoint(p.x / k, p.y / k);
  }

  _bindInput() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this._onDown(e));
    svg.addEventListener('pointermove', (e) => this._onMove(e));
    svg.addEventListener('pointerup', (e) => this._onUp(e));
    svg.addEventListener('pointercancel', () => this._cancelDrag(true));
    svg.addEventListener('lostpointercapture', (e) => {
      if (this.drag && this.drag.pointerId === e.pointerId) this._cancelDrag(true);
    });
    svg.addEventListener('pointerleave', (e) => {
      if (!this.drag && e.pointerType === 'mouse') {
        this._setHover(-1);
        svg.style.cursor = '';
      }
    });
    svg.addEventListener('contextmenu', (e) => {
      if (this.drag) e.preventDefault();
    });
  }

  _onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.h.onGesture) this.h.onGesture();
    if (this.drag) return;
    if (this.promo) {
      e.preventDefault();
      const node = e.target && e.target.closest ? e.target.closest('[data-promo]') : null;
      if (node) this._choosePromotion(Number(node.getAttribute('data-promo')));
      else this.cancelPromotion();
      return;
    }
    this._press(this._cellAtEvent(e), e);
  }

  _press(cell, e) {
    if (cell < 0 || !this.interactive) {
      this.clearSelection();
      return;
    }
    if (this.selected >= 0 && this.selected !== cell && this._targetsOf(this.selected).has(cell)) {
      this._attempt(this.selected, cell, null);
      return;
    }
    if (this._isOwn(cell)) {
      const wasSelected = this.selected === cell;
      if (!e) {
        if (wasSelected) this.clearSelection();
        else this._select(cell);
        return;
      }
      this._select(cell);
      this.drag = { cell, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, wasSelected, el: null };
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* synthetic events */
      }
      e.preventDefault();
      return;
    }
    this.clearSelection();
  }

  _select(cell) {
    this.selected = cell;
    this.hover = -1;
    this._renderMarks();
  }

  _onMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) {
      if (e.pointerType === 'mouse' && !this.promo) this._mouseHover(this._cellAtEvent(e));
      return;
    }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD_PX) return;
      if (!this._lift(d)) return;
    }
    const p = this._userPoint(e);
    d.el.setAttribute('transform', `translate(${fmt(p.x)} ${fmt(p.y)}) scale(1.12)`);
    const cell = this._cellAtEvent(e);
    this._setHover(cell !== d.cell && this._targetsOf(d.cell).has(cell) ? cell : -1);
  }

  _mouseHover(cell) {
    let cursor = '';
    let hover = -1;
    if (this.interactive && cell >= 0) {
      if (this._isOwn(cell)) cursor = 'grab';
      else if (this.selected >= 0 && this._targetsOf(this.selected).has(cell)) {
        cursor = 'pointer';
        hover = cell;
      }
    }
    this.svg.style.cursor = cursor;
    this._setHover(hover);
  }

  _lift(d) {
    const g = this.pieceEls[d.cell];
    if (!g) {
      this.drag = null;
      return false;
    }
    this._finishTweens();
    d.moved = true;
    d.el = g;
    this.gDrag.appendChild(g);
    g.classList.add('dragging');
    this.svg.classList.add('is-dragging');
    return true;
  }

  _onUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    this.svg.classList.remove('is-dragging');
    if (!d.moved) {
      if (d.wasSelected) this.clearSelection();
      return;
    }
    const cell = this._cellAtEvent(e);
    this._setHover(-1);
    if (cell >= 0 && cell !== d.cell && this._targetsOf(d.cell).has(cell)) {
      this._settleDragged(d.el, cell);
      this._attempt(d.cell, cell, d.el);
    } else {
      this._returnDragged(d, true);
    }
  }

  /** Put a dragged piece down at a cell (its pieceEls slot is unchanged). */
  _settleDragged(g, cell) {
    g.classList.remove('dragging');
    this.gPieces.appendChild(g);
    this._place(g, cell);
  }

  _returnDragged(d, animate) {
    const g = d.el;
    if (!g) return;
    g.classList.remove('dragging');
    this.gPieces.appendChild(g);
    if (animate && this.opts.animate && !reducedMotion()) {
      const t = (g.getAttribute('transform') || '').match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/);
      const [x1, y1] = this._pos(d.cell);
      if (t) {
        const x0 = Number(t[1]);
        const y0 = Number(t[2]);
        this.moving.add(g);
        this._tween(MOVE_MS, (k) => {
          g.setAttribute('transform', `translate(${fmt(x0 + (x1 - x0) * k)} ${fmt(y0 + (y1 - y0) * k)})`);
        }, () => {
          this.moving.delete(g);
          if (this.pieceEls[d.cell] === g) this._place(g, d.cell);
        });
        return;
      }
    }
    this._place(g, d.cell);
  }

  _cancelDrag(animate) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.svg.classList.remove('is-dragging');
    this._setHover(-1);
    if (d.moved) this._returnDragged(d, !!animate);
  }

  _attempt(from, to, draggedEl) {
    const options = (this.byFrom.get(from) || []).filter((m) => m.to === to);
    if (!options.length) {
      if (draggedEl) this._reconcile();
      return;
    }
    if (options.length > 1 && options.some((m) => m.promo)) {
      this._openPromotion(from, to, options, draggedEl);
      return;
    }
    this._commit(options[0], draggedEl);
  }

  _commit(move, draggedEl) {
    this.selected = -1;
    this.hover = -1;
    this._renderMarks();
    const ok = this.h.onMove ? this.h.onMove(move, { dropped: !!draggedEl }) : false;
    if (!ok) this._reconcile(); // rejected: put everything back where the position says
  }

  // ------------------------------------------------------------------ promotion picker

  _openPromotion(from, to, options, draggedEl) {
    const color = this.board[from] > 0 ? 0 : 1;
    const back = color === 0 ? 1 : -1; // toward the promoting side's home along the file
    const types = [5, 4, 3, 2].filter((t) => options.some((m) => m.promo === t));
    const cells = [];
    let cell = to;
    for (const type of types) {
      if (cell < 0) break;
      cells.push({ cell, type });
      cell = stepCell(cell, 0, back);
    }
    this.promo = { from, to, options, draggedEl, cells };
    const gp = this.gPromo;
    while (gp.firstChild) gp.removeChild(gp.firstChild);
    const vb = this.svg.viewBox.baseVal;
    el('rect', { x: vb.x, y: vb.y, width: vb.width, height: vb.height, class: 'promo-catch' }, gp);
    el('path', { d: this.framePath, class: 'promo-scrim' }, gp);
    const s = PIECE_BOX * HEX * 0.92;
    cells.forEach(({ cell: c, type }, i) => {
      const [x, y] = this._pos(c);
      const opt = el('g', {
        class: 'promo-option',
        'data-promo': String(type),
        transform: `translate(${fmt(x)} ${fmt(y)})`,
        role: 'button',
        'aria-label': ['', '', 'Knight', 'Bishop', 'Rook', 'Queen'][type],
      }, gp);
      opt.style.setProperty('--i', String(i));
      const inner = el('g', { class: 'promo-inner' }, opt);
      el('circle', { r: fmt(HEX * 0.84), class: 'promo-disc' }, inner);
      el('use', {
        href: '#' + pieceSymbolId(color, type),
        x: fmt(-s / 2), y: fmt(-s / 2), width: fmt(s), height: fmt(s),
      }, inner);
    });
    this.svg.classList.add('promo-open');
    // A press anywhere outside the board also cancels the picker ("click-away").
    if (!this._awayHandler) {
      this._awayHandler = (e) => {
        if (this.promo && !this.svg.contains(e.target)) this.cancelPromotion();
      };
    }
    document.addEventListener('pointerdown', this._awayHandler, true);
  }

  _closePromotion() {
    this.promo = null;
    const gp = this.gPromo;
    while (gp.firstChild) gp.removeChild(gp.firstChild);
    this.svg.classList.remove('promo-open');
    if (this._awayHandler) document.removeEventListener('pointerdown', this._awayHandler, true);
  }

  _choosePromotion(type) {
    const p = this.promo;
    if (!p) return;
    const move = p.options.find((m) => m.promo === type) || p.options[0];
    this._closePromotion();
    this._commit(move, p.draggedEl);
  }

  cancelPromotion() {
    const p = this.promo;
    if (!p) return;
    this._closePromotion();
    if (p.draggedEl) this._returnDragged({ el: p.draggedEl, cell: p.from }, true);
    this.selected = -1;
    this._renderMarks();
  }
}

/**
 * A small static board drawing (for the rules dialog): shaded cells, optional pieces and
 * marked cells. marks: Map(cellIndex → 'move' | 'capture' | 'target' | 'from').
 */
export function miniBoardSvg({ variant = 0, pieces = [], marks = new Map(), size = 9 } = {}) {
  const pad = 1.0;
  const w = (8.5 + pad) * size;
  const h = (9.53 + pad * 0.6) * size;
  let out = `<svg class="mini-board" viewBox="${fmt(-w)} ${fmt(-h)} ${fmt(2 * w)} ${fmt(2 * h)}" role="img" aria-hidden="true">`;
  for (const c of CELLS) {
    const shade = shadeOfClass(variant, c.colorClass);
    out += `<polygon class="cell ${shade}" points="${hexPoints(c.x * size, c.y * size, size * 0.94, 1)}"/>`;
  }
  for (const [cell, kind] of marks) {
    const c = CELLS[cell];
    out += `<polygon class="mini-mark ${kind}" points="${hexPoints(c.x * size, c.y * size, size * 0.94, 1)}"/>`;
  }
  const s = size * 1.62;
  for (const { cell, color, type } of pieces) {
    const c = CELLS[cell];
    out += `<use href="#${pieceSymbolId(color, type)}" x="${fmt(c.x * size - s / 2)}" y="${fmt(c.y * size - s / 2)}" width="${fmt(s)}" height="${fmt(s)}"/>`;
  }
  return out + '</svg>';
}
