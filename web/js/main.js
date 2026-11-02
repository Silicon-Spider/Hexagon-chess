// main.js — application controller: owns the game, drives the board, panel, dialogs and
// the computer player (docs/SPEC.md §8, §9). Also exposes window.__hexchess for tests.
import { loadEngine, decodeMove, STATUS, WHITE, BLACK } from './engine.js';
import { BoardView } from './board-view.js';
import { AiClient, LEVEL_NAMES, clampLevel } from './ai-client.js';
import { injectPieceSymbols } from './pieces.js';
import { Panel } from './panel.js';
import { setupNewGameDialog, setupSettingsDialog, setupHelpDialog, setupGameOverDialog, setupPositionDialog, BOARD_THEMES } from './dialogs.js';
import { loadJSON, saveJSON } from './storage.js';
import { SoundFx } from './sound.js';
import { $, toast, anyDialogOpen } from './dom.js';
import { variantInfo } from './rules.js';
import { cellIndex, cellName } from './geometry.js';

const AI_MIN_DELAY_MS = 350;
const DEMO_MIN_DELAY_MS = 650;
const PIECE_VALUE = [0, 1, 3, 3, 5, 9, 0];
const MODES = ['hvc', 'hvh', 'cvc'];

const DEFAULT_SETTINGS = { theme: 'walnut', ui: 'auto', coords: true, legal: true, anim: true, sound: false, evalBar: true };
const DEFAULT_CONFIG = { variant: 0, mode: 'hvc', side: 'white', humanColor: WHITE, level: 3, autoFlip: false };

const S = {
  engine: null,
  game: null,
  ai: null,
  board: null,
  panel: null,
  sound: new SoundFx(),
  dlg: {},
  variants: [],
  settings: { ...DEFAULT_SETTINGS },
  config: { ...DEFAULT_CONFIG },
  flipped: false,
  redo: [], // stack of { code, san }; the last entry is the next move to redo
  paused: false,
  thinking: false,
  searchToken: 0,
  lastInfo: null,
  ready: false,
  aiNotice: false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------- config

function normalizeVariant(v) {
  const n = Number(v);
  const ids = S.variants.map((x) => x.id);
  if (Number.isInteger(n) && ids.includes(n)) return n;
  if (typeof v === 'string') {
    const key = v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hit = S.variants.find((x) => x.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').startsWith(key.slice(0, 4)));
    if (hit) return hit.id;
  }
  return ids.length ? ids[0] : 0;
}

function normalizeMode(m) {
  const s = String(m || '').toLowerCase();
  if (MODES.includes(s)) return s;
  if (/two|hot|hvh|2p|human|pvp|local/.test(s)) return 'hvh';
  if (/demo|cvc|auto|watch|engine.?vs/.test(s)) return 'cvc';
  return 'hvc';
}

function normalizeSide(c) {
  if (c === 0 || c === 1) return c === 1 ? 'black' : 'white';
  const s = String(c || '').toLowerCase();
  if (s === 'b' || s === 'black' || s === '1') return 'black';
  if (s === 'random' || s === 'r' || s === '?') return 'random';
  return 'white';
}

/** Merge partial options into a full config; 'random' resolves to a colour here. */
function makeConfig(opts, base = S.config) {
  const cfg = { ...base };
  if (opts.variant !== undefined) cfg.variant = normalizeVariant(opts.variant);
  else cfg.variant = normalizeVariant(cfg.variant);
  if (opts.mode !== undefined) cfg.mode = normalizeMode(opts.mode);
  const side = opts.humanColor !== undefined ? normalizeSide(opts.humanColor)
    : opts.side !== undefined ? normalizeSide(opts.side) : null;
  if (side) cfg.side = side;
  if (opts.level !== undefined) cfg.level = clampLevel(opts.level);
  if (opts.autoFlip !== undefined) cfg.autoFlip = !!opts.autoFlip;
  if (side || opts.mode !== undefined || cfg.humanColor === undefined) {
    cfg.humanColor = cfg.side === 'black' ? BLACK : cfg.side === 'random' ? (Math.random() < 0.5 ? WHITE : BLACK) : WHITE;
  }
  return cfg;
}

// --------------------------------------------------------------------------- queries

function variantName(id) {
  const v = S.variants.find((x) => x.id === id);
  return v ? v.name : variantInfo(id).short;
}

function aiToMove() {
  const g = S.game;
  if (!g || g.isGameOver) return false;
  if (S.config.mode === 'cvc') return true;
  return S.config.mode === 'hvc' && g.turn !== S.config.humanColor;
}

function humanToMove() {
  const g = S.game;
  if (!g || g.isGameOver) return false;
  if (S.config.mode === 'hvh') return true;
  return S.config.mode === 'hvc' && g.turn === S.config.humanColor;
}

function canHumanInput() {
  return S.ready && !S.thinking && humanToMove();
}

function startInfo() {
  const parts = S.game.startFen().split(/\s+/);
  return { color: parts[1] === 'b' ? BLACK : WHITE, number: Math.max(1, parseInt(parts[4], 10) || 1) };
}

/** Final result of the current position, or null while the game is on. */
function resultInfo() {
  const g = S.game;
  const st = g.status;
  if (st === STATUS.ONGOING) return null;
  const turn = g.turn;
  const side = turn === WHITE ? 'White' : 'Black';
  const other = turn === WHITE ? 'Black' : 'White';
  const vname = variantName(g.variant);
  switch (st) {
    case STATUS.CHECKMATE:
      return { title: 'Checkmate', text: `Checkmate — ${other} wins`, score: turn === WHITE ? '0–1' : '1–0', winner: 1 - turn, detail: `${other} wins by checkmate.` };
    case STATUS.STALEMATE: {
      const rule = S.engine.stalemateRule(g.variant);
      if (rule === 1) {
        return {
          title: 'Stalemate',
          text: `Stalemate — ${other} scores ¾ (${vname} rule)`,
          score: turn === WHITE ? '¼–¾' : '¾–¼',
          winner: 1 - turn,
          detail: `${side} has no legal move but is not in check. Under ${vname}’s rule the stalemating side scores ¾ and the stalemated side ¼.`,
        };
      }
      if (rule === 2) {
        return { title: 'Stalemate', text: `Stalemate — ${other} wins`, score: turn === WHITE ? '0–1' : '1–0', winner: 1 - turn, detail: `${side} has no legal move; in ${vname} chess that loses.` };
      }
      return { title: 'Stalemate', text: 'Stalemate — draw', score: '½–½', winner: -1, detail: `${side} has no legal move but is not in check. In ${vname} chess stalemate is a draw.` };
    }
    case STATUS.DRAW_THREEFOLD:
      return { title: 'Draw', text: 'Draw by threefold repetition', score: '½–½', winner: -1, detail: 'The same position has occurred three times.' };
    case STATUS.DRAW_FIFTY_MOVE:
      return { title: 'Draw', text: 'Draw — fifty-move rule', score: '½–½', winner: -1, detail: 'Fifty moves by each side without a capture or a pawn move.' };
    case STATUS.DRAW_INSUFFICIENT:
      return { title: 'Draw', text: 'Draw — insufficient material', score: '½–½', winner: -1, detail: 'Neither side has enough material left to checkmate.' };
    default:
      return { title: 'Game over', text: 'Game over', score: '*', winner: -1, detail: '' };
  }
}

function formatScore(info) {
  const whiteCp = info.color === WHITE ? info.score : -info.score;
  const mate = Math.abs(whiteCp) >= 29000;
  let text;
  let share;
  if (mate) {
    const moves = Math.max(1, Math.ceil((30000 - Math.abs(whiteCp)) / 2));
    text = whiteCp > 0 ? `#${moves}` : `#-${moves}`;
    share = whiteCp > 0 ? 1 : 0;
  } else {
    const pawns = whiteCp / 100;
    text = `${pawns > 0 ? '+' : pawns < 0 ? '−' : ''}${Math.abs(pawns).toFixed(2)}`;
    share = 1 / (1 + Math.exp(-whiteCp / 380));
  }
  return { text, whiteShare: Math.min(0.97, Math.max(0.03, share)), lead: whiteCp > 0 ? 'w' : whiteCp < 0 ? 'b' : '' };
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function playerName(color) {
  const mode = S.config.mode;
  const lvl = `Level ${S.config.level} · ${LEVEL_NAMES[S.config.level]}`;
  if (mode === 'hvh') return { name: color === WHITE ? 'White' : 'Black', sub: 'Player' };
  if (mode === 'cvc') return { name: `Computer · ${color === WHITE ? 'White' : 'Black'}`, sub: lvl };
  if (color === S.config.humanColor) return { name: 'You', sub: color === WHITE ? 'White' : 'Black' };
  return { name: 'Computer', sub: lvl };
}

function buildView() {
  const g = S.game;
  const turn = g.turn;
  const board = g.board();
  const ply = g.ply;
  const result = resultInfo();
  const turnName = turn === WHITE ? 'White' : 'Black';
  const view = { turn, thinking: S.thinking, mode: S.config.mode, paused: S.paused };

  if (result) {
    view.statusMain = result.text;
    view.statusSub = `Result ${result.score}`;
    view.tone = 'over';
  } else {
    view.statusMain = `${turnName} to move${g.inCheck ? ' — check!' : ''}`;
    view.tone = g.inCheck ? 'check' : S.thinking ? 'thinking' : 'normal';
    const mode = S.config.mode;
    if (mode === 'hvc') {
      if (turn === S.config.humanColor) view.statusSub = g.inCheck ? 'Your move — get out of check' : 'Your move';
      else view.statusSub = S.thinking ? 'Computer is thinking…' : 'Computer to move';
    } else if (mode === 'cvc') {
      view.statusSub = S.paused ? 'Demo paused' : S.thinking ? 'Computer is thinking…' : 'Computer vs computer';
    } else {
      view.statusSub = S.config.autoFlip ? 'Two players · board turns each move' : 'Two players';
    }
  }

  // Evaluation from the last search (White's point of view), shown while the board is at
  // (or one reply after) the position the computer produced.
  const fresh = S.lastInfo && (ply === S.lastInfo.plyAfter || ply === S.lastInfo.plyAfter + 1);
  if (S.settings.evalBar && fresh && S.config.mode !== 'hvh') {
    view.eval = formatScore(S.lastInfo);
    const i = S.lastInfo;
    const kn = i.ms > 0 ? `${formatCount(Math.round((i.nodes / i.ms) * 1000))} n/s` : '';
    const pv = i.pvSan && i.pvSan.length ? ` · ${i.pvSan.slice(0, 5).join(' ')}` : '';
    view.searchLine = `depth ${i.depth} · ${formatCount(i.nodes)} nodes${kn ? ` · ${kn}` : ''}${pv}`;
  }

  if (S.redo.length) {
    const total = ply + S.redo.length;
    const canResume = !result && ((S.config.mode === 'hvc' && turn !== S.config.humanColor) || S.config.mode === 'cvc');
    let where = 'the start position';
    let san = '';
    if (ply > 0) {
      const si0 = startInfo();
      const color = (si0.color + ply - 1) % 2;
      const number = si0.number + Math.floor((ply - 1 + si0.color) / 2);
      where = `${number}${color === WHITE ? '.' : '…'} `;
      san = g.historySanAt(ply - 1);
    }
    const hint = canResume ? '' : result ? '' : ' — make a move to continue from here';
    // The SAN is passed separately so the panel can set its file letters like the board's.
    const lead = `Reviewing ${ply > 0 ? 'after ' : ''}${where}`;
    const tail = ` (${ply}/${total})${hint}`;
    view.review = { lead, san, tail, text: `${lead}${san}${tail}`, canResume };
  }

  // Players, ordered as on screen.
  const startColor = (turn + ply) % 2;
  const captured = [[], []];
  for (let i = 0; i < ply; i++) {
    const code = g.historyMove(i);
    const cap = (code >>> 28) & 0xf;
    if (cap) captured[(startColor + i) % 2].push(cap);
  }
  let material = 0;
  for (const p of board) material += p > 0 ? PIECE_VALUE[p] : -PIECE_VALUE[-p];
  const playerView = (color) => {
    const n = playerName(color);
    const adv = color === WHITE ? material : -material;
    return {
      side: color,
      name: n.name,
      sub: n.sub,
      toMove: !result && turn === color,
      captured: captured[color],
      adv: adv > 0 ? `+${adv}` : '',
    };
  };
  const bottom = S.flipped ? BLACK : WHITE;
  view.players = [playerView(1 - bottom), playerView(bottom)];

  const si = startInfo();
  view.moves = {
    firstColor: si.color,
    firstNumber: si.number,
    ply,
    sans: g.historySan().concat(S.redo.slice().reverse().map((e) => e.san)),
    emptyText: S.config.mode === 'hvc' && S.config.humanColor !== si.color ? 'The computer moves first.' : 'No moves yet — White begins.',
  };
  if (si.color === BLACK && !ply && !S.redo.length) view.moves.emptyText = 'No moves yet — Black to play.';
  view.canBack = ply > 0;
  view.canForward = S.redo.length > 0;
  view.canUndo = undoCount() > 0;
  view.canRedo = S.redo.length > 0;
  return view;
}

// --------------------------------------------------------------------------- rendering

function lastMoveMarks() {
  const g = S.game;
  const ply = g.ply;
  if (!ply) return null;
  const m = decodeMove(g.historyMove(ply - 1));
  return { from: m.from, to: m.to };
}

/** Redraw board + panel. opts: { move, reverse, dropped, instant } for the board. */
function render(opts = {}) {
  const g = S.game;
  if (!g) return;
  S.board.setVariant(g.variant);
  S.board.setFlipped(S.flipped);
  S.board.setPosition(g.board(), {
    lastMove: lastMoveMarks(),
    checkCell: g.inCheck ? g.kingCell(g.turn) : -1,
    move: opts.move,
    reverse: opts.reverse,
    dropped: opts.dropped,
    instant: opts.instant,
  });
  refreshInteraction();
  const brand = $('#brand-variant');
  if (brand) brand.textContent = variantInfo(g.variant, variantName(g.variant)).title;
  const brandShort = $('#brand-variant-short');
  if (brandShort) brandShort.textContent = variantName(g.variant);
  document.documentElement.dataset.variant = String(g.variant);
}

/** Update what the user may do and the panel, without touching the pieces. */
function refreshInteraction() {
  const g = S.game;
  const interactive = canHumanInput();
  S.board.setMoves(interactive ? g.legalMoves() : [], g.turn, interactive);
  S.panel.render(buildView());
  const app = $('#app');
  if (app) {
    app.dataset.thinking = S.thinking ? 'true' : 'false';
    app.dataset.mode = S.config.mode;
  }
}

// --------------------------------------------------------------------------- persistence

function persist() {
  const g = S.game;
  if (!g) return;
  saveJSON('game.v1', {
    variant: g.variant,
    startFen: g.startFen(),
    moves: g.historyCodes(),
    redo: S.redo.map((e) => e.code),
    redoSan: S.redo.map((e) => e.san),
    mode: S.config.mode,
    side: S.config.side,
    humanColor: S.config.humanColor,
    level: S.config.level,
    autoFlip: S.config.autoFlip,
    flipped: S.flipped,
    paused: S.paused,
  });
}

function persistSettings() {
  saveJSON('settings.v1', S.settings);
}

function restoreGame() {
  const saved = loadJSON('game.v1', null);
  if (!saved || typeof saved !== 'object') return false;
  try {
    const cfg = makeConfig({ variant: saved.variant, mode: saved.mode, level: saved.level, autoFlip: saved.autoFlip }, DEFAULT_CONFIG);
    cfg.side = normalizeSide(saved.side);
    cfg.humanColor = saved.humanColor === BLACK ? BLACK : WHITE;
    const g = S.game;
    if (!g.reset(cfg.variant)) return false;
    if (typeof saved.startFen === 'string' && saved.startFen !== g.startFen() && !g.loadFen(saved.startFen)) {
      g.reset(cfg.variant);
      return false;
    }
    for (const code of Array.isArray(saved.moves) ? saved.moves : []) {
      if (!g.makeMove(Number(code) >>> 0)) break;
    }
    const redo = Array.isArray(saved.redo) ? saved.redo : [];
    const sans = Array.isArray(saved.redoSan) ? saved.redoSan : [];
    S.redo = redo.map((code, i) => ({ code: Number(code) >>> 0, san: String(sans[i] || '?') }));
    S.config = cfg;
    S.flipped = !!saved.flipped;
    S.paused = !!saved.paused;
    return true;
  } catch (e) {
    return false;
  }
}

// --------------------------------------------------------------------------- the computer

function cancelAI() {
  S.searchToken++;
  if (S.thinking) {
    S.thinking = false;
    if (S.ai) S.ai.cancel();
  }
}

function maybeStartAI() {
  if (!S.ready || S.thinking || S.redo.length) return;
  if (!aiToMove()) return;
  if (S.config.mode === 'cvc' && S.paused) return;
  requestAI();
}

function pvToSan(variant, fen, pv) {
  const out = [];
  if (!pv || !pv.length) return out;
  let t = null;
  try {
    t = S.engine.newGame(variant);
    if (!t.loadFen(fen)) return out;
    for (const code of pv.slice(0, 8)) {
      const san = t.san(code);
      if (!san || !t.makeMove(code)) break;
      out.push(san);
    }
  } catch (e) {
    /* informational only */
  } finally {
    if (t) t.destroy();
  }
  return out;
}

async function requestAI() {
  const g = S.game;
  const token = ++S.searchToken;
  const color = g.turn;
  const fenBefore = g.fen();
  const started = performance.now();
  S.thinking = true;
  refreshInteraction();
  const res = await S.ai.search({ variant: g.variant, startFen: g.startFen(), moves: g.historyCodes(), level: S.config.level });
  if (token !== S.searchToken) return;
  const minDelay = S.config.mode === 'cvc' ? DEMO_MIN_DELAY_MS : AI_MIN_DELAY_MS;
  const wait = minDelay - (performance.now() - started);
  if (wait > 0) await sleep(wait);
  if (token !== S.searchToken) return;
  S.thinking = false;
  if (!res || !res.move) {
    if (res && res.error) toast(`The computer could not move: ${res.error}`, 'warn');
    refreshInteraction();
    return;
  }
  if (res.info) S.lastInfo = { ...res.info, color, plyAfter: g.ply + 1, via: res.via, pvSan: pvToSan(g.variant, fenBefore, res.info.pv) };
  if (!applyMove(decodeMove(res.move), { source: 'ai' })) {
    toast('The engine suggested an illegal move — please report this.', 'warn');
    refreshInteraction();
  }
}

// --------------------------------------------------------------------------- moves

function playSoundFor(move) {
  const g = S.game;
  if (g.isGameOver) S.sound.play('end');
  else if (g.inCheck) S.sound.play('check');
  else if (move.isCapture) S.sound.play('capture');
  else S.sound.play('move');
}

/** Hot-seat auto-flip: the side to move sits at the bottom. */
function syncAutoFlip() {
  if (S.config.mode === 'hvh' && S.config.autoFlip) S.flipped = S.game.turn === BLACK;
}

/** Apply a legal move (from the user or the computer). */
function applyMove(move, { dropped = false } = {}) {
  const g = S.game;
  if (!g.makeMove(move.code)) return false;
  S.redo = [];
  const made = decodeMove(g.historyMove(g.ply - 1));
  syncAutoFlip();
  render({ move: made, dropped });
  playSoundFor(made);
  persist();
  if (g.isGameOver) announceGameOver();
  else maybeStartAI();
  return true;
}

function onBoardMove(move, meta) {
  if (!canHumanInput()) return false;
  return applyMove(move, { dropped: !!(meta && meta.dropped) });
}

function announceGameOver() {
  const r = resultInfo();
  if (!r) return;
  S.dlg.over.open({ title: r.title, score: r.score, detail: r.detail, winner: r.winner });
}

// --------------------------------------------------------------------------- history

function undoPly() {
  const g = S.game;
  const n = g.ply;
  if (!n) return null;
  const code = g.historyMove(n - 1);
  const san = g.historySanAt(n - 1);
  if (!g.undo()) return null;
  S.redo.push({ code, san });
  return decodeMove(code);
}

function redoPly() {
  const e = S.redo.pop();
  if (!e) return null;
  if (!S.game.makeMove(e.code)) {
    S.redo = [];
    return null;
  }
  return decodeMove(e.code);
}

/** Undo plies one by one; the board follows each step and only the last one animates. */
function undoSteps(count) {
  let last = null;
  for (let i = 0; i < count; i++) {
    if (last) S.board.setPosition(S.game.board(), { move: last, reverse: true, instant: true });
    const m = undoPly();
    if (!m) break;
    last = m;
  }
  return last;
}

function stepBack() {
  cancelAI();
  if (S.config.mode === 'cvc') S.paused = true;
  const m = undoPly();
  syncAutoFlip();
  render(m ? { move: m, reverse: true } : {});
  persist();
}

function stepForward() {
  cancelAI();
  const m = redoPly();
  syncAutoFlip();
  render(m ? { move: m } : {});
  if (m) playSoundFor(m);
  persist();
  maybeStartAI();
}

function jumpTo(ply) {
  const g = S.game;
  const target = Math.max(0, Math.min(ply, g.ply + S.redo.length));
  if (target === g.ply) return;
  cancelAI();
  if (target < g.ply) {
    if (S.config.mode === 'cvc') S.paused = true;
    const m = undoSteps(g.ply - target);
    syncAutoFlip();
    render(m ? { move: m, reverse: true } : {});
  } else {
    let m = null;
    while (g.ply < target) {
      if (m) S.board.setPosition(g.board(), { move: m, instant: true });
      const next = redoPly();
      if (!next) break;
      m = next;
    }
    syncAutoFlip();
    render(m ? { move: m } : {});
  }
  persist();
  maybeStartAI();
}

function navigate(kind) {
  if (kind === 'prev') stepBack();
  else if (kind === 'next') stepForward();
  else if (kind === 'first') jumpTo(0);
  else if (kind === 'last') jumpTo(S.game.ply + S.redo.length);
}

/** Plies the Undo button takes back (0 = nothing to undo). */
function undoCount() {
  const g = S.game;
  if (!g || !g.ply) return 0;
  if (S.config.mode !== 'hvc') return 1;
  // Back to the most recent earlier position with the human to move.
  let turn = g.turn;
  let count = 0;
  do {
    count++;
    turn = 1 - turn;
  } while (turn !== S.config.humanColor && count < g.ply);
  return turn === S.config.humanColor ? count : 0;
}

/** The Undo button: in "You vs Computer" it takes back to your previous turn. */
function undoMove() {
  const count = undoCount();
  if (!count) return false;
  cancelAI();
  if (S.config.mode === 'cvc') S.paused = true;
  const m = undoSteps(count);
  syncAutoFlip();
  render(m ? { move: m, reverse: true } : {});
  persist();
  return true;
}

/** The Redo button: replays undone moves (in "You vs Computer" up to your next turn). */
function redoMove() {
  if (!S.redo.length) return false;
  cancelAI();
  const g = S.game;
  let m = redoPly();
  if (S.config.mode === 'hvc') {
    while (m && S.redo.length && g.turn !== S.config.humanColor && !g.isGameOver) {
      S.board.setPosition(g.board(), { move: m, instant: true });
      m = redoPly();
    }
  }
  syncAutoFlip();
  render(m ? { move: m } : {});
  persist();
  maybeStartAI();
  return true;
}

/** Discard the redo list and continue the game from the displayed position. */
function playFromHere() {
  cancelAI();
  S.redo = [];
  S.paused = false;
  render();
  persist();
  maybeStartAI();
}

function togglePause() {
  if (S.config.mode !== 'cvc') return;
  if (S.paused) {
    S.paused = false;
    S.redo = [];
    render();
    maybeStartAI();
  } else {
    S.paused = true;
    cancelAI();
    render();
  }
  persist();
}

function flip() {
  S.flipped = !S.flipped;
  render({ instant: true });
  persist();
}

// --------------------------------------------------------------------------- games

function newGame(cfg, fen) {
  cancelAI();
  if (S.dlg.over) S.dlg.over.close();
  const g = S.game;
  if (!g.reset(cfg.variant)) return `Unknown variant ${cfg.variant}`;
  if (fen && !g.loadFen(fen)) {
    g.reset(cfg.variant);
    return 'invalid FEN';
  }
  S.config = cfg;
  S.redo = [];
  S.lastInfo = null;
  S.paused = false;
  if (cfg.mode === 'hvc') S.flipped = cfg.humanColor === BLACK;
  else if (cfg.mode === 'hvh') S.flipped = cfg.autoFlip ? g.turn === BLACK : false;
  else S.flipped = false;
  render({ instant: true });
  persist();
  maybeStartAI();
  return null;
}

function loadFenFromDialog(fen, variant) {
  const v = normalizeVariant(variant);
  const probe = S.engine.newGame(v);
  const ok = probe.loadFen(fen);
  probe.destroy();
  if (!ok) {
    return `Not a valid ${variantName(v)} position. A FEN needs 11 ranks (from rank 11 down to 1) with the right number of cells, one king per side, no pawns on their promotion cells, and the side that is not to move must not be in check.`;
  }
  const err = newGame(makeConfig({ variant: v }), fen);
  return err ? `Could not load the position (${err}).` : null;
}

/** PGN-style ASCII result: 1-0, 0-1, 1/2-1/2, 3/4-1/4 … */
function asciiScore(score) {
  return score.replace(/½/g, '1/2').replace(/¾/g, '3/4').replace(/¼/g, '1/4').replace(/–/g, '-');
}

function exportText() {
  const g = S.game;
  const r = resultInfo();
  const si = startInfo();
  const sans = g.historySan();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const lines = [
    '[Event "Hexchess game"]',
    `[Date "${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}"]`,
    `[Variant "${variantName(g.variant)}"]`,
    `[White "${playerName(WHITE).name}"]`,
    `[Black "${playerName(BLACK).name}"]`,
    `[StartFEN "${g.startFen()}"]`,
    `[Result "${r ? asciiScore(r.score) : '*'}"]`,
  ];
  if (r) lines.push(`[Termination "${r.text}"]`);
  const parts = [];
  sans.forEach((san, i) => {
    const color = (si.color + i) % 2;
    const number = si.number + Math.floor((i + si.color) / 2);
    if (color === WHITE) parts.push(`${number}. ${san}`);
    else parts.push(i === 0 ? `${number}... ${san}` : san);
  });
  parts.push(r ? asciiScore(r.score) : '*');
  const words = parts.join(' ').split(' ');
  const wrapped = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + w.length + 1 > 78) {
      wrapped.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) wrapped.push(line);
  return `${lines.join('\n')}\n\n${wrapped.join('\n')}\n`;
}

// --------------------------------------------------------------------------- settings

function applySettings() {
  const s = S.settings;
  const root = document.documentElement;
  if (!BOARD_THEMES.some((t) => t.id === s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  root.dataset.board = s.theme;
  if (s.ui === 'light' || s.ui === 'dark') root.dataset.ui = s.ui;
  else delete root.dataset.ui;
  S.board.setOptions({ coords: !!s.coords, legal: !!s.legal, animate: !!s.anim });
  S.sound.setEnabled(!!s.sound);
  if (S.game) S.panel.render(buildView());
}

// --------------------------------------------------------------------------- dialogs

function openNewGame() {
  if (!S.ready) return;
  S.dlg.newGame.open(S.config, S.variants);
}

function openHelp() {
  if (!S.variants.length) return;
  S.dlg.help.open(S.game ? S.game.variant : 0);
}

function openSettings() {
  S.dlg.settings.open(S.settings);
}

function openPosition() {
  if (!S.ready) return;
  S.dlg.position.open({ fen: S.game.fen(), exportText: exportText(), variants: S.variants, variant: S.game.variant });
}

// --------------------------------------------------------------------------- keyboard

function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const tag = t && t.tagName ? t.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  if (!S.ready) return;
  if (S.board.promotionOpen) {
    if (S.board.handleKey(e.key)) e.preventDefault();
    return;
  }
  if (anyDialogOpen()) return;
  switch (e.key) {
    case 'ArrowLeft': stepBack(); break;
    case 'ArrowRight': stepForward(); break;
    case 'Home': jumpTo(0); break;
    case 'End': navigate('last'); break;
    case 'f': case 'F': flip(); break;
    case 'n': case 'N': openNewGame(); break;
    case 'u': case 'U': undoMove(); break;
    case 'h': case 'H': case '?': openHelp(); break;
    case 's': case 'S': openSettings(); break;
    case 'Escape': S.board.clearSelection(); break;
    default: return;
  }
  e.preventDefault();
}

// --------------------------------------------------------------------------- startup

function showFatal(err) {
  const app = $('#app');
  if (app) app.dataset.state = 'error';
  const panel = $('#fatal');
  if (panel) panel.hidden = false;
  const detail = $('#fatal-detail');
  if (detail) {
    const proto = typeof location !== 'undefined' ? location.protocol : '';
    detail.textContent = `${err && err.message ? err.message : String(err)}${proto === 'file:' ? '\n(The page was opened from file://, where browsers refuse to fetch hexchess.wasm.)' : ''}`;
  }
  const status = $('#status-main');
  if (status) status.textContent = 'Engine unavailable';
}

function testState() {
  const g = S.game;
  if (!g) return { ready: false };
  const r = resultInfo();
  return {
    ready: S.ready,
    variant: g.variant,
    variantName: variantName(g.variant),
    fen: g.fen(),
    startFen: g.startFen(),
    turn: g.turn,
    status: g.status,
    inCheck: g.inCheck,
    history: g.historySan(),
    ply: g.ply,
    redo: S.redo.length,
    mode: S.config.mode,
    humanColor: S.config.humanColor,
    level: S.config.level,
    thinking: S.thinking,
    gameOver: g.isGameOver,
    resultText: r ? r.text : '',
    score: r ? r.score : '*',
    flipped: S.flipped,
    paused: S.paused,
    selected: S.board.selectedCell >= 0 ? cellName(S.board.selectedCell) : null,
    promotionOpen: S.board.promotionOpen,
    aiMode: S.ai ? S.ai.mode : 'none',
    // The computer's last search: where it ran ('worker' | 'main') and its search info.
    lastSearch: S.lastInfo
      ? { via: S.lastInfo.via || null, depth: S.lastInfo.depth, score: S.lastInfo.score, nodes: S.lastInfo.nodes, ms: S.lastInfo.ms, pv: S.lastInfo.pvSan || [] }
      : null,
    settings: { ...S.settings },
  };
}

function installTestHook(ready) {
  globalThis.__hexchess = {
    ready,
    state: testState,
    clickCell(name) {
      const i = cellIndex(String(name));
      if (i < 0 || !S.ready) return false;
      S.board.clickCell(i);
      return true;
    },
    newGame(opts = {}) {
      if (!S.ready) return null;
      newGame(makeConfig(opts || {}));
      return testState();
    },
    playMove(text) {
      if (!S.ready || !canHumanInput()) return false;
      const m = S.game.parseMove(String(text));
      if (!m) return false;
      return onBoardMove(m, { dropped: false });
    },
    undo() {
      return S.ready ? undoMove() : false;
    },
    redo() {
      return S.ready ? redoMove() : false;
    },
    setLevel(n) {
      S.config.level = clampLevel(n);
      persist();
      if (S.ready) refreshInteraction();
      return S.config.level;
    },
    flip() {
      if (S.ready) flip();
      return S.flipped;
    },
    jumpTo(ply) {
      if (S.ready) jumpTo(Number(ply));
      return testState();
    },
    loadFen(fen, variant) {
      if (!S.ready) return 'not ready';
      return loadFenFromDialog(String(fen), variant === undefined ? S.game.variant : variant);
    },
    exportText: () => (S.ready ? exportText() : ''),
  };
}

async function boot() {
  injectPieceSymbols(document);
  S.settings = { ...DEFAULT_SETTINGS, ...loadJSON('settings.v1', {}) };
  S.board = new BoardView($('#board'), {
    onMove: onBoardMove,
    onGesture: () => {
      if (S.settings.sound) S.sound.setEnabled(true);
    },
  });
  S.panel = new Panel({
    onJump: (ply) => jumpTo(ply),
    onNav: navigate,
    onFlip: flip,
    onUndo: undoMove,
    onRedo: redoMove,
    onPause: togglePause,
    onPosition: openPosition,
    onResume: playFromHere,
  });
  applySettings();

  S.dlg.newGame = setupNewGameDialog({ onStart: (cfg) => newGame(makeConfig(cfg)) });
  S.dlg.settings = setupSettingsDialog({
    onChange: (s) => {
      S.settings = { ...S.settings, ...s };
      applySettings();
      persistSettings();
    },
  });
  S.dlg.help = setupHelpDialog({ getVariants: () => S.variants });
  S.dlg.over = setupGameOverDialog({ onNew: openNewGame, onReview: () => refreshInteraction() });
  S.dlg.position = setupPositionDialog({ onLoad: loadFenFromDialog });

  $('#btn-new').addEventListener('click', openNewGame);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-settings').addEventListener('click', openSettings);
  const retry = $('#fatal-retry');
  if (retry) retry.addEventListener('click', () => location.reload());
  document.addEventListener('keydown', onKey);

  S.engine = await loadEngine();
  S.variants = S.engine.variants().map((v) => {
    const t = S.engine.newGame(v.id);
    const startFen = t.startFen();
    t.destroy();
    return { ...v, startFen };
  });
  S.game = S.engine.newGame(0);
  if (!restoreGame()) {
    S.config = makeConfig({}, DEFAULT_CONFIG);
    S.game.reset(S.config.variant);
    S.flipped = S.config.mode === 'hvc' && S.config.humanColor === BLACK;
  }
  S.ai = new AiClient(S.engine, {
    onModeChange: (mode, err) => {
      if (mode === 'main' && !S.aiNotice) {
        S.aiNotice = true;
        toast('Background thinking is unavailable here, so the page may pause while the computer thinks.', 'warn');
        if (err) console.warn('[hexchess] AI worker unavailable:', err);
      }
    },
  });
  await S.ai.start();
  S.ready = true;
  const app = $('#app');
  if (app) app.dataset.state = 'ready';
  render({ instant: true });
  maybeStartAI();
}

function start() {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  installTestHook(ready);
  boot().then(
    () => resolveReady(true),
    (err) => {
      console.error('[hexchess] startup failed:', err);
      showFatal(err);
      rejectReady(err);
    },
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
