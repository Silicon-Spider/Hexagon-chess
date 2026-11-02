// engine.js — JavaScript wrapper around the hexchess WebAssembly C ABI (docs/SPEC.md §7).
//
// Node-safe: nothing here touches window/document, so the Node tests import it directly.
//
//   const engine = await loadEngine();              // browser: fetch('hexchess.wasm') or the
//                                                    // single-file build's embedded base64
//   const engine = await loadEngine({ bytes });      // Node: pass the .wasm bytes
//   const game = engine.newGame(0);                  // 0 = Gliński, 1 = McCooey
//   game.legalMoves().length                         // 51
//   game.makeMove(game.parseMove('f5f6')); game.undo();
//
// Typed-array views on the wasm memory are re-created after every call (memory may grow).
import { cellName } from './geometry.js';

export const ABI_VERSION = 1;
export const WHITE = 0;
export const BLACK = 1;
export const NUM_CELLS = 91;

export const STATUS = Object.freeze({
  ONGOING: 0,
  CHECKMATE: 1,
  STALEMATE: 2,
  DRAW_THREEFOLD: 3,
  DRAW_FIFTY_MOVE: 4,
  DRAW_INSUFFICIENT: 5,
});

export const PIECE = Object.freeze({ PAWN: 1, KNIGHT: 2, BISHOP: 3, ROOK: 4, QUEEN: 5, KING: 6 });
export const PIECE_LETTERS = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
export const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
export const MOVE_FLAGS = Object.freeze({ CAPTURE: 1, EN_PASSANT: 2, DOUBLE_STEP: 4, PROMOTION: 8 });

/** Stalemate rules returned by hc_variant_stalemate_rule. */
export const STALEMATE_RULE = Object.freeze({ DRAW: 0, THREE_QUARTERS: 1, WIN: 2 });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Build a move code from its parts (flags are not needed to submit a move). */
export function encodeMove(from, to, promo = 0) {
  return ((from & 0xff) | ((to & 0xff) << 8) | ((promo & 0xf) << 16)) >>> 0;
}

/** Decode a u32 move code (§4) into a plain object. */
export function decodeMove(code) {
  const c = code >>> 0;
  const from = c & 0xff;
  const to = (c >>> 8) & 0xff;
  const promo = (c >>> 16) & 0xf;
  const flags = (c >>> 20) & 0xf;
  const fromName = cellName(from);
  const toName = cellName(to);
  return {
    code: c,
    key: c & 0xfffff,
    from,
    to,
    promo,
    flags,
    piece: (c >>> 24) & 0xf,
    captured: (c >>> 28) & 0xf,
    isCapture: (flags & 1) !== 0,
    isEnPassant: (flags & 2) !== 0,
    isDoubleStep: (flags & 4) !== 0,
    isPromotion: (flags & 8) !== 0,
    fromName,
    toName,
    uci: fromName + toName + (promo ? PIECE_LETTERS[promo].toLowerCase() : ''),
  };
}

/** The part of a move code the engine matches when a move is submitted. */
export function moveKey(move) {
  const code = typeof move === 'number' ? move : move.code;
  return (code >>> 0) & 0xfffff;
}

export function wasmImports() {
  return { env: { now_ms: () => performance.now() } };
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(globalThis.Buffer.from(b64, 'base64'));
}

/**
 * Obtain the wasm bytes: the single-file build's embedded base64 when present,
 * otherwise fetch(url) (default 'hexchess.wasm', relative to the page).
 */
export async function fetchWasmBytes(url = 'hexchess.wasm') {
  const b64 = globalThis.__HEXCHESS_WASM_B64__;
  if (typeof b64 === 'string' && b64.length > 0) return base64ToBytes(b64);
  if (typeof fetch !== 'function') throw new Error('fetch() is not available to load ' + url);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`could not fetch ${url} (${e && e.message ? e.message : e})`);
  }
  if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load and instantiate the engine.
 * opts.module — an already compiled WebAssembly.Module, or
 * opts.bytes  — the .wasm bytes (ArrayBuffer / typed array), or
 * opts.url    — where to fetch it from (default 'hexchess.wasm').
 * Resolves to an Engine; rejects with a descriptive Error.
 */
export async function loadEngine(opts = {}) {
  let module = opts.module || null;
  if (!module) {
    const bytes = opts.bytes || (await fetchWasmBytes(opts.url));
    module = await WebAssembly.compile(bytes);
  }
  const instance = await WebAssembly.instantiate(module, wasmImports());
  return new Engine(module, instance);
}

/** One instantiated engine (one wasm instance). Games created from it share its memory. */
export class Engine {
  constructor(module, instance) {
    this.module = module;
    this.instance = instance;
    this.x = instance.exports;
    const missing = ['memory', 'hc_abi_version', 'hc_new', 'hc_gen_moves', 'hc_make_move', 'hc_search']
      .filter((name) => !(name in this.x));
    if (missing.length) throw new Error('wasm module is missing exports: ' + missing.join(', '));
    this.abiVersion = this.x.hc_abi_version() >>> 0;
    if (this.abiVersion !== ABI_VERSION) {
      throw new Error(`engine ABI version ${this.abiVersion}, expected ${ABI_VERSION}`);
    }
  }

  /** Copy the engine's shared output string (len bytes) out of wasm memory. */
  readString(len) {
    const n = len >>> 0;
    if (n === 0) return '';
    const ptr = this.x.hc_str_ptr() >>> 0;
    return textDecoder.decode(new Uint8Array(this.x.memory.buffer, ptr, n).slice());
  }

  /** Run fn(ptr, len) with `text` copied into wasm scratch memory, then free it. */
  withString(text, fn) {
    const bytes = textEncoder.encode(String(text));
    const size = Math.max(bytes.length, 1);
    const ptr = this.x.hc_alloc(size) >>> 0;
    if (!ptr) throw new Error('hc_alloc failed');
    try {
      new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
      return fn(ptr, bytes.length);
    } finally {
      this.x.hc_free(ptr, size);
    }
  }

  variantCount() {
    return this.x.hc_variant_count() >>> 0;
  }

  variantName(v) {
    return this.readString(this.x.hc_variant_name(v));
  }

  stalemateRule(v) {
    return this.x.hc_variant_stalemate_rule(v) >>> 0;
  }

  /** [{ id, name, stalemateRule }] for every variant the engine knows. */
  variants() {
    const out = [];
    for (let v = 0; v < this.variantCount(); v++) {
      out.push({ id: v, name: this.variantName(v), stalemateRule: this.stalemateRule(v) });
    }
    return out;
  }

  newGame(variant = 0) {
    return new HexGame(this, variant);
  }

  /** Last search's info block (§7 hc_search_info_ptr). */
  searchInfo() {
    const ptr = this.x.hc_search_info_ptr() >>> 0;
    const a = new Int32Array(this.x.memory.buffer, ptr, 38);
    const pvLen = Math.max(0, Math.min(32, a[5]));
    const pv = [];
    for (let i = 0; i < pvLen; i++) pv.push(a[6 + i] >>> 0);
    return {
      depth: a[0],
      score: a[1],
      nodes: (a[2] >>> 0) + (a[3] >>> 0) * 4294967296,
      ms: a[4],
      pv,
    };
  }
}

/** A game handle (§7 `G`): position + history inside the engine. */
export class HexGame {
  constructor(engine, variant = 0) {
    this.engine = engine;
    this.x = engine.x;
    this.ptr = this.x.hc_new(variant) >>> 0;
    if (!this.ptr) throw new Error(`invalid variant ${variant}`);
  }

  _live() {
    if (!this.ptr) throw new Error('game has been destroyed');
    return this.ptr;
  }

  destroy() {
    if (this.ptr) this.x.hc_destroy(this.ptr);
    this.ptr = 0;
  }

  get variant() {
    return this.x.hc_variant(this._live()) >>> 0;
  }

  get variantName() {
    return this.engine.variantName(this.variant);
  }

  get stalemateRule() {
    return this.engine.stalemateRule(this.variant);
  }

  /** New game at a variant's start position (default: the current variant). */
  reset(variant = this.variant) {
    return this.x.hc_reset(this._live(), variant) === 1;
  }

  /** Load a FEN; on success history is cleared and it becomes the start position. */
  loadFen(fen) {
    const g = this._live();
    return this.engine.withString(String(fen).trim(), (p, n) => this.x.hc_load_fen(g, p, n)) === 1;
  }

  fen() {
    return this.engine.readString(this.x.hc_fen(this._live()));
  }

  startFen() {
    return this.engine.readString(this.x.hc_start_fen(this._live()));
  }

  /** Copy of the 91-byte board (§3): 0 empty, +type white, -type black. */
  board() {
    const ptr = this.x.hc_board_ptr(this._live()) >>> 0;
    return new Int8Array(this.x.memory.buffer, ptr, NUM_CELLS).slice();
  }

  get turn() {
    return this.x.hc_turn(this._live()) >>> 0;
  }

  get status() {
    return this.x.hc_status(this._live()) >>> 0;
  }

  get inCheck() {
    return this.x.hc_in_check(this._live()) === 1;
  }

  get isGameOver() {
    return this.status !== STATUS.ONGOING;
  }

  kingCell(color) {
    return this.x.hc_king_cell(this._live(), color) | 0;
  }

  get epCell() {
    return this.x.hc_ep_cell(this._live()) | 0;
  }

  get halfmoveClock() {
    return this.x.hc_halfmove_clock(this._live()) >>> 0;
  }

  get fullmoveNumber() {
    return this.x.hc_fullmove_number(this._live()) >>> 0;
  }

  /** Legal move codes (u32) of the side to move. */
  legalMoveCodes() {
    const g = this._live();
    const n = this.x.hc_gen_moves(g) >>> 0;
    if (n === 0) return [];
    const ptr = this.x.hc_moves_ptr(g) >>> 0;
    return Array.from(new Uint32Array(this.x.memory.buffer, ptr, n));
  }

  /** Legal moves of the side to move, decoded (see decodeMove). */
  legalMoves() {
    return this.legalMoveCodes().map(decodeMove);
  }

  /** Normalise a move argument (code, decoded move, or SAN/coordinate text) to a code. */
  _code(move) {
    if (typeof move === 'number') return move >>> 0;
    if (typeof move === 'string') {
      const m = this.parseMove(move);
      return m ? m.code : 0;
    }
    if (move && typeof move.code === 'number') return move.code >>> 0;
    return 0;
  }

  /** Play a legal move (code, decoded move or text). Returns false if it is not legal. */
  makeMove(move) {
    const code = this._code(move);
    if (!code) return false;
    return this.x.hc_make_move(this._live(), code) === 1;
  }

  undo() {
    return this.x.hc_undo(this._live()) === 1;
  }

  /** SAN of a legal move in the current position, or null. */
  san(move) {
    const code = this._code(move);
    if (!code) return null;
    const len = this.x.hc_move_san(this._live(), code) >>> 0;
    return len ? this.engine.readString(len) : null;
  }

  /** Parse SAN or coordinate text ("e4e5", "f10-f11=Q", "Qxf9") to a legal move, or null. */
  parseMove(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const g = this._live();
    const code = this.engine.withString(text.trim(), (p, n) => this.x.hc_parse_move(g, p, n)) >>> 0;
    return code ? decodeMove(code) : null;
  }

  /** Number of moves made since the start position. */
  get ply() {
    return this.x.hc_history_len(this._live()) >>> 0;
  }

  /** Code of the i-th move since the start position (0 if out of range). */
  historyMove(i) {
    return this.x.hc_history_move(this._live(), i >>> 0) >>> 0;
  }

  /** SAN of the i-th move as it was played ('' if out of range). */
  historySanAt(i) {
    return this.engine.readString(this.x.hc_history_san(this._live(), i >>> 0));
  }

  historyCodes() {
    const g = this._live();
    const n = this.x.hc_history_len(g) >>> 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.x.hc_history_move(g, i) >>> 0);
    return out;
  }

  historySan() {
    const g = this._live();
    const n = this.x.hc_history_len(g) >>> 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.engine.readString(this.x.hc_history_san(g, i)));
    return out;
  }

  /** [{ code, san, move }] for every move since the start position. */
  history() {
    const sans = this.historySan();
    return this.historyCodes().map((code, i) => ({ code, san: sans[i], move: decodeMove(code) }));
  }

  /** Leaf count of the legal move tree (BigInt). */
  perft(depth) {
    return BigInt.asUintN(64, BigInt(this.x.hc_perft(this._live(), depth)));
  }

  /** Static evaluation in centipawns from White's point of view. */
  eval() {
    return this.x.hc_eval(this._live()) | 0;
  }

  evaluate() {
    return this.eval();
  }

  /**
   * Search synchronously (blocks the calling thread). Returns
   * { code, move (decoded or null), info: { depth, score (side-to-move POV), nodes, ms, pv } }.
   */
  search({ maxDepth = 0, timeMs = 0, noise = 0, seed = 0 } = {}) {
    const code = this.x.hc_search(this._live(), maxDepth >>> 0, timeMs >>> 0, noise >>> 0, seed >>> 0) >>> 0;
    return { code, move: code ? decodeMove(code) : null, info: this.engine.searchInfo() };
  }

  /** Rebuild this game from a start FEN (or the variant start) plus a move list. */
  replay(variant, startFen, moves) {
    if (!this.reset(variant)) return false;
    if (startFen && startFen !== this.startFen() && !this.loadFen(startFen)) return false;
    for (const m of moves || []) {
      if (!this.makeMove(m)) return false;
    }
    return true;
  }
}
