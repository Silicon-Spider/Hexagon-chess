// ai-client.js — computer moves via a Web Worker (docs/SPEC.md §8.1, §8.2), with a
// synchronous main-thread fallback when workers are unavailable or fail.
//
//   const ai = new AiClient(engine);  ai.start();
//   const r = await ai.search({ variant, startFen, moves, level });   // or maxDepth/timeMs/noise
//   r === null → the request was cancelled or superseded; otherwise { id, move, info, via }.

/** Strength table of §9.3 (index = level). */
export const LEVELS = [
  null,
  { maxDepth: 1, timeMs: 0, noise: 250 },
  { maxDepth: 2, timeMs: 0, noise: 120 },
  { maxDepth: 3, timeMs: 400, noise: 40 },
  { maxDepth: 4, timeMs: 700, noise: 0 },
  { maxDepth: 6, timeMs: 1200, noise: 0 },
  { maxDepth: 9, timeMs: 2500, noise: 0 },
  { maxDepth: 0, timeMs: 5000, noise: 0 },
  { maxDepth: 0, timeMs: 9000, noise: 0 },
];

export const LEVEL_NAMES = ['', 'Novice', 'Beginner', 'Casual', 'Club', 'Strong', 'Expert', 'Master', 'Grandmaster'];

export function clampLevel(level) {
  const n = Math.round(Number(level));
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 3;
}

export function levelParams(level) {
  return LEVELS[clampLevel(level)];
}

/** Short human description of a level's search budget. */
export function levelDescription(level) {
  const p = levelParams(level);
  const parts = [];
  if (p.maxDepth) parts.push(`depth ${p.maxDepth}`);
  if (p.timeMs) parts.push(p.timeMs >= 1000 ? `${(p.timeMs / 1000).toFixed(p.timeMs % 1000 ? 1 : 0)} s` : `${p.timeMs} ms`);
  if (p.noise) parts.push('relaxed');
  return parts.join(' · ');
}

function randomSeed() {
  return (Math.random() * 0x100000000) >>> 0;
}

function createWorker(url) {
  if (typeof Worker !== 'function') throw new Error('Web Workers are not supported here');
  const srcEl = typeof document !== 'undefined' ? document.getElementById('ai-worker-src') : null;
  if (srcEl) {
    const blob = new Blob([srcEl.textContent], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    worker.__blobUrl = blobUrl;
    return worker;
  }
  return new Worker(url);
}

function releaseWorker(worker) {
  if (!worker) return;
  worker.onmessage = null;
  worker.onerror = null;
  worker.onmessageerror = null;
  try { worker.terminate(); } catch (e) { /* already gone */ }
  if (worker.__blobUrl) {
    try { URL.revokeObjectURL(worker.__blobUrl); } catch (e) { /* ignore */ }
  }
}

export class AiClient {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.workerUrl = opts.workerUrl || 'js/ai-worker.js';
    this.readyTimeoutMs = opts.readyTimeoutMs || 8000;
    this.onModeChange = opts.onModeChange || null;
    this.mode = 'idle'; // 'idle' | 'starting' | 'worker' | 'main'
    this.worker = null;
    this.busy = false;
    this.pending = null;
    this.seq = 0;
    this.lastError = null;
    this.startPromise = null;
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.onModeChange) this.onModeChange(mode, this.lastError);
  }

  /** Start (or restart) the worker. Never rejects: falls back to the main thread. */
  start() {
    if (this.mode === 'main') return Promise.resolve();
    if (this.startPromise && (this.mode === 'starting' || this.mode === 'worker')) return this.startPromise;
    this._setMode('starting');
    this.startPromise = this._spawn().then(
      (worker) => {
        this.worker = worker;
        worker.onmessage = (e) => this._onMessage(e);
        worker.onerror = (e) => this._onCrash(e);
        worker.onmessageerror = (e) => this._onCrash(e);
        this._setMode('worker');
      },
      (err) => this._fallback(err),
    );
    return this.startPromise;
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = createWorker(this.workerUrl);
      } catch (e) {
        reject(e);
        return;
      }
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        if (err) {
          releaseWorker(worker);
          reject(err);
        } else {
          resolve(worker);
        }
      };
      const timer = setTimeout(() => finish(new Error('the AI worker did not start in time')), this.readyTimeoutMs);
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'ready') finish(null);
        else if (m.type === 'error') finish(new Error(m.message || 'worker error'));
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        finish(new Error((e && e.message) || 'the AI worker failed to load'));
      };
      try {
        worker.postMessage({ type: 'init', module: this.engine.module });
      } catch (e) {
        finish(e);
      }
    });
  }

  _fallback(err) {
    this.lastError = err ? String(err.message || err) : null;
    releaseWorker(this.worker);
    this.worker = null;
    this.busy = false;
    this._setMode('main');
    if (this.pending) this._runOnMainThread(this.pending);
  }

  _onCrash(e) {
    if (e && e.preventDefault) e.preventDefault();
    this._fallback(new Error((e && e.message) || 'the AI worker crashed'));
  }

  _onMessage(e) {
    const m = e.data || {};
    const p = this.pending;
    if (m.type === 'result') {
      this.busy = false;
      if (!p || p.id !== m.id) return; // stale
      this.pending = null;
      p.resolve({ id: m.id, move: m.move >>> 0, info: m.info || null, via: 'worker' });
    } else if (m.type === 'error') {
      this.busy = false;
      this.lastError = m.message || 'worker error';
      if (p && (m.id === undefined || m.id === p.id)) this._runOnMainThread(p);
    }
  }

  /**
   * Request a computer move. req: { variant, startFen, moves:[u32], level } or explicit
   * { maxDepth, timeMs, noise, seed }. Only one request is active: a new one supersedes
   * (and resolves to null) the previous one.
   */
  search(req) {
    this.cancel();
    const params = req.level !== undefined ? levelParams(req.level) : {};
    const p = {
      id: ++this.seq,
      req: {
        variant: req.variant >>> 0,
        startFen: req.startFen || '',
        moves: (req.moves || []).map((m) => m >>> 0),
        maxDepth: (req.maxDepth !== undefined ? req.maxDepth : params.maxDepth) >>> 0,
        timeMs: (req.timeMs !== undefined ? req.timeMs : params.timeMs) >>> 0,
        noise: (req.noise !== undefined ? req.noise : params.noise) >>> 0,
        seed: (req.seed !== undefined ? req.seed : randomSeed()) >>> 0,
      },
      resolve: null,
    };
    const promise = new Promise((resolve) => { p.resolve = resolve; });
    this.pending = p;
    this._dispatch(p);
    return promise;
  }

  _dispatch(p) {
    if (this.pending !== p) return;
    if (this.mode === 'idle') this.start();
    if (this.mode === 'starting') {
      this.startPromise.then(() => this._dispatch(p));
      return;
    }
    if (this.mode === 'worker' && this.worker) {
      this.busy = true;
      try {
        this.worker.postMessage({ type: 'search', id: p.id, ...p.req });
      } catch (e) {
        this._fallback(e);
      }
      return;
    }
    this._runOnMainThread(p);
  }

  _runOnMainThread(p) {
    // Deferred so the "thinking" state can paint before the thread blocks.
    setTimeout(() => {
      if (this.pending !== p) return;
      let result;
      try {
        const g = this.engine.newGame(p.req.variant);
        try {
          if (p.req.startFen && !g.loadFen(p.req.startFen)) throw new Error('start FEN rejected');
          for (const mv of p.req.moves) {
            if (!g.makeMove(mv)) throw new Error('illegal move while rebuilding the game');
          }
          const r = g.search(p.req);
          result = { id: p.id, move: r.code, info: r.info, via: 'main' };
        } finally {
          g.destroy();
        }
      } catch (e) {
        result = { id: p.id, move: 0, info: null, via: 'main', error: String(e && e.message ? e.message : e) };
      }
      if (this.pending !== p) return;
      this.pending = null;
      p.resolve(result);
    }, 30);
  }

  /** Cancel the active request (it resolves to null). A busy worker is restarted. */
  cancel() {
    const p = this.pending;
    this.pending = null;
    if (p) p.resolve(null);
    if (this.busy && this.worker) {
      releaseWorker(this.worker);
      this.worker = null;
      this.busy = false;
      this.mode = 'idle';
      this.startPromise = null;
      this.start();
    }
  }

  get isBusy() {
    return this.pending !== null;
  }

  dispose() {
    const p = this.pending;
    this.pending = null;
    if (p) p.resolve(null);
    releaseWorker(this.worker);
    this.worker = null;
    this.busy = false;
    this.mode = 'idle';
  }
}
