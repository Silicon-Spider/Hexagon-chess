// tools/e2e.mjs — end-to-end test of the Hexchess web app in a real browser.
//
// Zero dependencies: Node >= 22 (built-in fetch and WebSocket) plus an installed Chrome,
// Chromium or Edge, driven headless over the Chrome DevTools Protocol.
//
//   npm run e2e                serve web/ on a free port and test it, then test dist/hexchess.html
//   node tools/e2e.mjs --url http://localhost:8130/      test an already running dev server
//
// Options
//   --url <url>             dev-site URL to test instead of starting tools/serve.mjs
//   --only served|single    run one suite: the dev site (http) or the single-file build (file://)
//   --shots <dir>           write screenshots there (default: a new folder in the OS temp dir)
//   --no-shots              take no screenshots
//   --tmp <dir>             parent folder of the throw-away Chrome profile (default: OS temp dir)
//   --chrome <path>         browser executable (default: $CHROME_PATH, then the usual install paths)
//   --verbose               also print the browser console
//
// Each suite checks: the page loads with no console errors or uncaught exceptions (page and
// AI worker); the wasm engine and window.__hexchess come up; 91 cells and 36 (Gliński) / 32
// (McCooey) pieces, each drawn on the cell the engine has it on; shading and coordinate labels
// (also flipped); two-player play through the test hook with double steps, en passant and a
// promotion through the in-board picker using real clicks (Escape, click-away, mouse and
// keyboard choice); undo / redo / arrow keys / move-list clicks; reload persistence; the fool's
// mate with its game-over dialog; the computer at levels 1, 4 and 7 answering legally and in
// time from a Web Worker (a Blob worker in the single-file build) while the page keeps
// responding; cancelled searches never landing; the demo pausing; mouse click-to-move and
// drag-and-drop; touch taps and drags; no horizontal scrolling at 360 and 390 px, also with
// every dialog open; the four board themes; light and dark. Screenshots are saved for a human
// look. Every move the page shows is replayed through a separate copy of the engine in Node.
// Exit code 0 = every check passed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngine } from '../web/js/engine.js';
import { cellIndex, cellName, parseFenBoard } from '../web/js/geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const option = (name, fallback = null) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : fallback;
};
const flag = (name) => ARGS.includes(`--${name}`);
const VERBOSE = flag('verbose');
const ONLY = option('only');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------- reporting

const results = [];
let scope = '';

function section(name) {
  scope = name;
  console.log(`\n[${name}]`);
}

function check(name, ok, detail) {
  const pass = !!ok;
  results.push({ scope, name, pass, detail: pass ? '' : String(detail ?? '') });
  const extra = !pass && detail !== undefined && detail !== '' ? `  — ${detail}` : '';
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${extra}`);
  return pass;
}

let shotDir = null;
const shotFiles = [];

// ------------------------------------------------------------------------------- browser

function findBrowser() {
  const explicit = option('chrome') || process.env.CHROME_PATH;
  if (explicit) return explicit;
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Start a headless browser with a private profile; resolves once its DevTools port is open. */
async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('no Chrome / Chromium / Edge found: pass --chrome <path> or set CHROME_PATH');
  const tmpBase = path.resolve(option('tmp', os.tmpdir()));
  fs.mkdirSync(tmpBase, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tmpBase, 'hexchess-e2e-profile-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-extensions', '--disable-component-update', '--disable-sync', '--mute-audio', '--password-store=basic',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // Port 0: the browser picks a free (unique) port and writes it to <profile>/DevToolsActivePort.
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });
  let wsUrl = null;
  for (let i = 0; i < 300 && !wsUrl; i++) {
    if (exited) throw new Error(`${exe} exited during start-up`);
    try {
      const [port, wsPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      /* not written yet */
    }
    if (!wsUrl) await sleep(50);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('the browser did not open a DevTools port');
  }
  return { exe, proc, profile, wsUrl, exited: () => exited };
}

async function closeBrowser(browser, cdp) {
  if (!browser) return;
  if (cdp) {
    try { await cdp.send('Browser.close', {}, null, 3000); } catch { /* already closing */ }
    cdp.close();
  }
  // Headless Chrome can need several seconds to exit after Browser.close; killing it early
  // orphans its helper processes, which keep the profile folder locked.
  for (let i = 0; i < 200 && !browser.exited(); i++) await sleep(100);
  if (!browser.exited()) {
    browser.proc.kill();
    await sleep(1000);
  }
  for (let i = 0; i < 40; i++) {
    try {
      fs.rmSync(browser.profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250); // Windows keeps files locked for a moment after the process exits
    }
  }
  console.warn(`e2e: could not remove the temporary browser profile ${browser.profile}`);
}

/** Chrome DevTools Protocol over one browser-level WebSocket, with flattened sessions. */
class Cdp {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`cannot connect to ${this.url}`)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: DevTools connection closed`));
      }
      this.pending.clear();
    });
  }

  _onMessage(ev) {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result || {});
      return;
    }
    for (const fn of [...this.handlers]) fn(msg.method, msg.params || {}, msg.sessionId || null);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 30000) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const KEYS = {
  Escape: { code: 'Escape', keyCode: 27 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

/** One browser tab: console capture, worker tracking, evaluation, input and screenshots. */
class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sid = sessionId;
    this.console = [];
    this.workers = [];
    cdp.on((method, params, sid) => this._event(method, params, sid));
  }

  static async attach(cdp) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    let target = targetInfos.find((t) => t.type === 'page');
    if (!target) target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    // Dedicated workers (the AI) attach as child sessions: their console is captured too.
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await page.send('Page.bringToFront').catch(() => {});
    return page;
  }

  send(method, params = {}, timeoutMs) {
    return this.cdp.send(method, params, this.sid, timeoutMs);
  }

  _event(method, p, sid) {
    const own = sid === this.sid;
    const worker = own ? null : this.workers.find((w) => w.sessionId === sid);
    if (!own && !worker) return;
    const where = worker ? '[worker] ' : '';
    if (method === 'Runtime.consoleAPICalled') {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type))
        .join(' ');
      const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : 'info';
      this.console.push({ level, text: where + text });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      this.console.push({ level: 'error', text: `${where}uncaught ${d.exception && d.exception.description ? d.exception.description : d.text}` });
    } else if (method === 'Log.entryAdded') {
      const e = p.entry || {};
      if (e.level === 'error' || e.level === 'warning') this.console.push({ level: e.level, text: `${where}${e.text}${e.url ? ` (${e.url})` : ''}` });
    } else if (method === 'Target.attachedToTarget' && own) {
      const info = p.targetInfo || {};
      this.workers.push({ sessionId: p.sessionId, url: info.url || '', type: info.type, detached: false });
      this.cdp.send('Runtime.enable', {}, p.sessionId).catch(() => {});
    } else if (method === 'Target.detachedFromTarget' && own) {
      const w = this.workers.find((x) => x.sessionId === p.sessionId);
      if (w) w.detached = true;
    }
  }

  errors() {
    return this.console.filter((c) => c.level === 'error');
  }

  warnings() {
    return this.console.filter((c) => c.level === 'warning');
  }

  waitEvent(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.cdp.on((m, params, sid) => {
        if (m === method && sid === this.sid) {
          clearTimeout(timer);
          off();
          resolve(params);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
    });
  }

  async goto(url) {
    this.workers = [];
    const loaded = this.waitEvent('Page.loadEventFired');
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
    await loaded;
  }

  async reload() {
    this.workers = [];
    const loaded = this.waitEvent('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  async eval(expression, timeoutMs = 30000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception && d.exception.description ? d.exception.description : d.text}`);
    }
    return r.result ? r.result.value : undefined;
  }

  state() {
    return this.eval('window.__hexchess.state()');
  }

  hook(name, ...args) {
    return this.eval(`window.__hexchess.${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
  }

  async viewport(width, height, { mobile = false, scale = 1 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    await sleep(120);
  }

  async scheme(dark) {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await sleep(80);
  }

  /** Centre of the first element matching selector, in viewport CSS pixels (scrolled into view). */
  center(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
  }

  async cell(name) {
    const c = await this.center(`#board .cells [data-cell="${name}"]`);
    if (!c) throw new Error(`no board cell ${name}`);
    return c;
  }

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async clickSelector(selector) {
    const c = await this.center(selector);
    if (!c) throw new Error(`nothing matches ${selector}`);
    await this.click(c.x, c.y);
  }

  async clickCell(name) {
    const c = await this.cell(name);
    await this.click(c.x, c.y);
  }

  async drag(a, b, { steps = 10, midway } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
      if (midway && i === Math.ceil(steps / 2)) await midway();
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async tap(p) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await sleep(30);
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async touchDrag(a, b, steps = 10) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      await sleep(16);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async key(key) {
    const k = KEYS[key] || { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Save a PNG (viewport, a clip, or the full page) to the screenshot folder. */
  async shot(name, { clip = null, full = false } = {}) {
    if (!shotDir) return null;
    const params = { format: 'png' };
    if (clip) params.clip = { scale: 1, ...clip };
    if (full) {
      const m = await this.send('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const r = await this.send('Page.captureScreenshot', params, 60000);
    const file = path.join(shotDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    shotFiles.push(file);
    return file;
  }
}

// ------------------------------------------------------------------------------- dev server

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(port)], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { proc, url };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error('tools/serve.mjs did not start');
}

// ------------------------------------------------------------------------------- engine (Node)

let engine = null;

/** null if the page's game (start FEN + SAN history) replays legally to its FEN, else why not. */
function replayProblem(st) {
  const g = engine.newGame(st.variant);
  try {
    if (st.startFen !== g.startFen() && !g.loadFen(st.startFen)) return `start FEN rejected: ${st.startFen}`;
    for (let i = 0; i < st.history.length; i++) {
      const san = st.history[i];
      const m = g.parseMove(san);
      if (!m) return `ply ${i + 1} "${san}" is not a legal move`;
      const again = g.san(m);
      if (again !== san) return `ply ${i + 1}: page shows "${san}", engine writes "${again}"`;
      g.makeMove(m);
    }
    return g.fen() === st.fen ? null : `replayed FEN ${g.fen()} differs from the page's ${st.fen}`;
  } finally {
    g.destroy();
  }
}

function legalMovesOf(st) {
  const g = engine.newGame(st.variant);
  try {
    if (!g.loadFen(st.fen)) throw new Error(`engine rejects ${st.fen}`);
    return g.legalMoves();
  } finally {
    g.destroy();
  }
}

function legalTargets(st, from) {
  const i = cellIndex(from);
  return [...new Set(legalMovesOf(st).filter((m) => m.from === i).map((m) => m.toName))];
}

const pieceHref = (code) => `#hc-piece-${code > 0 ? 'w' : 'b'}${'PNBRQK'[Math.abs(code) - 1]}`;

// ------------------------------------------------------------------------------- page probes

const BOARD_DOM_JS = `(() => {
  const svg = document.getElementById('board');
  const centre = (poly) => {
    const pts = poly.getAttribute('points').trim().split(/\\s+/).map((p) => p.split(',').map(Number));
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  };
  const cells = [...svg.querySelectorAll('.cells polygon.cell')].map((p) => ({ name: p.dataset.cell, c: centre(p) }));
  const read = (g) => {
    const m = (g.getAttribute('transform') || '').match(/translate\\(([-\\d.e]+)[ ,]+([-\\d.e]+)\\)/);
    const x = m ? Number(m[1]) : NaN;
    const y = m ? Number(m[2]) : NaN;
    let best = null;
    let dist = Infinity;
    for (const c of cells) {
      const d = Math.hypot(c.c[0] - x, c.c[1] - y);
      if (d < dist) { dist = d; best = c.name; }
    }
    const use = g.querySelector('use');
    const href = use ? use.getAttribute('href') || use.getAttribute('xlink:href') || '' : '';
    const box = use ? use.getBoundingClientRect() : null;
    return {
      cell: best, dist, href,
      symbol: !!(href && document.getElementById(href.slice(1))),
      visible: !!box && box.width > 2 && box.height > 2,
      opacity: getComputedStyle(g).opacity,
    };
  };
  return {
    cells: cells.length,
    names: new Set(cells.map((c) => c.name)).size,
    pieces: [...svg.querySelectorAll('.pieces > g.piece')].map(read),
    fx: svg.querySelectorAll('.fx g.piece').length,
    drag: svg.querySelectorAll('.drag g.piece').length,
  };
})()`;

const LABELS_JS = `(() => {
  const svg = document.getElementById('board');
  const layer = svg.querySelector('.coords');
  const shown = getComputedStyle(layer).display !== 'none';
  const sr = svg.getBoundingClientRect();
  const labels = [...layer.querySelectorAll('text')].map((t) => {
    const r = t.getBoundingClientRect();
    // Ink box: the text box without most of the font's ascent/descent padding.
    const ink = { l: r.left + r.width * 0.08, r: r.right - r.width * 0.08, t: r.top + r.height * 0.22, b: r.bottom - r.height * 0.18 };
    const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
      .map(([fx, fy]) => [ink.l + fx * (ink.r - ink.l), ink.t + fy * (ink.b - ink.t)]);
    const onCell = pts.some(([x, y]) => document.elementsFromPoint(x, y).some((e) => e.matches && e.matches('#board polygon.cell')));
    return { text: t.textContent, ...ink, onCell, size: r.height };
  });
  return { shown, svg: { l: sr.left, t: sr.top, r: sr.right, b: sr.bottom }, labels };
})()`;

const OVERFLOW_JS = `(() => {
  const vw = document.documentElement.clientWidth;
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || (cs.position === 'fixed' && cs.opacity === '0')) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) offenders.push(describe(el) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    // Content cut off inside an open dialog.
    const dlg = el.closest('dialog[open]');
    if (dlg && dlg !== el) {
      const d = dlg.getBoundingClientRect();
      if (r.right > d.right + 0.5 || r.left < d.left - 0.5) offenders.push(describe(el) + ' cut off by ' + describe(dlg));
    }
  }
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, clientWidth: vw, offenders: [...new Set(offenders)].slice(0, 8) };
})()`;

// Every visible button keeps its contents inside its padding (no label squeezed to the edge
// or cut off).
const BUTTONS_JS = `(() => {
  const bad = [];
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (b.closest('dialog') && !b.closest('dialog[open]')) continue;
    const cs = getComputedStyle(b);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const range = document.createRange();
    range.selectNodeContents(b);
    const c = range.getBoundingClientRect();
    if (c.width < 1) continue;
    const inset = Math.min(c.left - r.left, r.right - c.right);
    const need = Math.min(6, parseFloat(cs.paddingLeft) || 0);
    if (inset < need - 0.5) bad.push((b.id ? '#' + b.id : '.' + [...b.classList].join('.')) + ' "' + b.textContent.trim().slice(0, 24) + '" ' + inset.toFixed(1) + ' px from its edge');
  }
  return bad;
})()`;

const PROBE_START_JS = `(() => {
  const p = window.__e2eProbe = { max: 0, last: performance.now(), stop: false, n: 0 };
  const tick = () => {
    const now = performance.now();
    p.max = Math.max(p.max, now - p.last);
    p.last = now;
    p.n++;
    if (!p.stop) setTimeout(tick, 10);
  };
  setTimeout(tick, 10);
  return true;
})()`;

const PROBE_STOP_JS = `(() => { const p = window.__e2eProbe; p.stop = true; return { max: Math.round(p.max), ticks: p.n }; })()`;

async function waitReady(page, timeoutMs = 20000) {
  return page.eval(`(async () => {
    const t0 = performance.now();
    while (!window.__hexchess) {
      if (performance.now() - t0 > ${timeoutMs}) return 'window.__hexchess never appeared';
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      const ok = await Promise.race([
        window.__hexchess.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after ${timeoutMs} ms')), ${timeoutMs})),
      ]);
      return ok === true ? 'ok' : 'ready resolved to ' + ok;
    } catch (e) {
      return 'ready rejected: ' + (e && e.message ? e.message : e);
    }
  })()`, timeoutMs + 5000);
}

async function waitState(page, pred, timeoutMs) {
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < timeoutMs) {
    st = await page.state();
    if (pred(st)) return st;
    await sleep(40);
  }
  return null;
}

async function waitWorker(page, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const live = page.workers.filter((w) => w.type === 'worker' && !w.detached);
    if (live.length) return live[live.length - 1];
    await sleep(40);
  }
  return null;
}

/** The board drawing must match the engine's position exactly (after animations settle). */
async function checkBoard(page, label, settleMs = 420) {
  if (settleMs) await sleep(settleMs);
  const st = await page.state();
  const dom = await page.eval(BOARD_DOM_JS);
  const want = parseFenBoard(st.fen);
  const problems = [];
  if (!want) problems.push(`unparsable FEN ${st.fen}`);
  if (dom.cells !== 91 || dom.names !== 91) problems.push(`${dom.cells} cells / ${dom.names} names`);
  const drawn = new Map();
  for (const p of dom.pieces) {
    if (!(p.dist < 0.5)) problems.push(`${p.href} is ${p.dist.toFixed(1)} units off the centre of ${p.cell}`);
    if (!p.symbol) problems.push(`no <symbol> for ${p.href}`);
    if (!p.visible) problems.push(`${p.href} on ${p.cell} renders empty`);
    if (p.opacity !== '1') problems.push(`${p.href} on ${p.cell} has opacity ${p.opacity}`);
    if (drawn.has(p.cell)) problems.push(`two pieces on ${p.cell}`);
    drawn.set(p.cell, p.href);
  }
  for (let i = 0; want && i < 91; i++) {
    const name = cellName(i);
    const got = drawn.get(name);
    if (want[i] && got !== pieceHref(want[i])) problems.push(`${name}: want ${pieceHref(want[i])}, drawn ${got || 'nothing'}`);
    if (!want[i] && got) problems.push(`${name}: stray ${got}`);
  }
  if (dom.fx) problems.push(`${dom.fx} piece(s) still in the fade layer`);
  if (dom.drag) problems.push(`${dom.drag} piece(s) left in the drag layer`);
  return check(label, problems.length === 0, problems.slice(0, 5).join('; '));
}

async function checkLabels(page, label) {
  const L = await page.eval(LABELS_JS);
  const problems = [];
  if (!L.shown) problems.push('the coordinate layer is hidden');
  if (L.labels.length !== 44) problems.push(`${L.labels.length} labels instead of 44`);
  for (const a of L.labels) {
    if (a.l < L.svg.l - 1 || a.r > L.svg.r + 1 || a.t < L.svg.t - 1 || a.b > L.svg.b + 1) problems.push(`"${a.text}" sticks out of the board`);
    if (a.onCell) problems.push(`"${a.text}" overlaps a cell`);
  }
  for (let i = 0; i < L.labels.length; i++) {
    for (let j = i + 1; j < L.labels.length; j++) {
      const a = L.labels[i];
      const b = L.labels[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ox > 0.5 && oy > 0.5) problems.push(`"${a.text}" overlaps "${b.text}"`);
    }
  }
  const size = L.labels.length ? Math.min(...L.labels.map((a) => a.size)) : 0;
  return check(`${label} (label height ${size.toFixed(1)} px)`, !problems.length, problems.slice(0, 6).join('; '));
}

async function checkOverflow(page, label) {
  const o = await page.eval(OVERFLOW_JS);
  return check(`${label}: no horizontal scrolling (scrollWidth ${o.scrollWidth} <= ${o.innerWidth})`,
    o.scrollWidth <= o.innerWidth && o.offenders.length === 0, o.offenders.join(', '));
}

async function checkButtons(page, label) {
  const bad = await page.eval(BUTTONS_JS);
  return check(`${label}: every button label fits inside its button`, bad.length === 0, bad.slice(0, 5).join('; '));
}

/** Small deterministic PRNG (mulberry32) for reproducible random games. */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function overDialog(page) {
  return page.eval(`(() => { const d = document.getElementById('dlg-over'); return { open: d.open, title: document.getElementById('over-title').textContent, score: document.getElementById('over-score').textContent, detail: document.getElementById('over-detail').textContent }; })()`);
}

async function closeOverDialog(page) {
  if (await page.eval(`document.getElementById('dlg-over').open`)) {
    await page.clickSelector('#over-review');
    await sleep(250);
  }
}

/** Run one test group; an exception becomes a failed check instead of ending the run. */
async function guarded(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name} finished without an exception`, false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  }
}

// ------------------------------------------------------------------------------- tests

async function testLoad(page, suite, url) {
  section(`${suite}: load`);
  await page.viewport(1400, 900);
  await page.scheme(false);
  await page.goto(url);
  const ready = await waitReady(page);
  if (!check(`${url} loads and window.__hexchess.ready resolves`, ready === 'ok', ready)) return false;
  const st = await page.state();
  const app = await page.eval(`({ state: document.getElementById('app').dataset.state, fatal: !document.getElementById('fatal').hidden })`);
  check('the wasm engine is up (app ready, no error panel)', st.ready === true && app.state === 'ready' && !app.fatal, JSON.stringify(app));
  check('the AI client is in Web Worker mode', st.aiMode === 'worker', st.aiMode);
  const worker = await waitWorker(page);
  const blob = suite === 'single';
  check(`a dedicated worker runs the AI (${blob ? 'Blob URL' : 'js/ai-worker.js'})`,
    worker && (blob ? worker.url.startsWith('blob:') : /\/js\/ai-worker\.js$/.test(worker.url)), worker ? worker.url : 'no worker target');
  const errs = page.errors();
  check('no console errors or uncaught exceptions while loading', errs.length === 0, errs.map((e) => e.text).join(' | '));
  await checkButtons(page, 'desktop 1400×900');
  return true;
}

async function testBoard(page, suite) {
  section(`${suite}: board`);
  for (const [variant, name, count] of [[0, 'Gliński', 36], [1, 'McCooey', 32]]) {
    const st = await page.hook('newGame', { variant, mode: 'hvh' });
    check(`new ${name} two-player game through the test hook`, st && st.variant === variant && st.mode === 'hvh' && st.ply === 0,
      st && `${st.variant}/${st.mode}/${st.ply}`);
    await sleep(100);
    const dom = await page.eval(BOARD_DOM_JS);
    check(`${name}: 91 cells`, dom.cells === 91 && dom.names === 91, `${dom.cells} cells, ${dom.names} distinct names`);
    check(`${name}: ${count} pieces`, dom.pieces.length === count, dom.pieces.length);
    await checkBoard(page, `${name}: each piece drawn centred on the engine's cell`, 0);
    const classes = await page.eval(`['f6', 'f1', 'f11'].map((n) => document.querySelector('#board .cells [data-cell="' + n + '"]').getAttribute('class'))`);
    const want = variant === 0 ? ['mid', 'light', 'dark'] : ['light', 'mid', 'dark'];
    check(`${name}: shading f6 ${want[0]}, f1 ${want[1]}, f11 ${want[2]}`,
      classes.every((c, i) => c.split(/\s+/).includes(want[i])), classes.join(' / '));
    if (variant === 1) await page.shot(`${suite}-desktop-mccooey-start`);
  }
  await checkLabels(page, 'coordinates: 44 labels inside the frame, clear of the cells and of each other');
  const flipped = await page.hook('flip');
  check('flip() turns the board', flipped === true);
  const ys = await page.eval(`['f1', 'f11', 'a1', 'l1'].map((n) => { const r = document.querySelector('#board .cells [data-cell="' + n + '"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })`);
  check('flipped: f1 at the top, a1 on the right', ys[0][1] < ys[1][1] && ys[2][0] > ys[3][0], JSON.stringify(ys));
  await checkBoard(page, 'flipped: pieces still on their cells', 50);
  await checkLabels(page, 'flipped: coordinate labels clear');
  await page.shot(`${suite}-desktop-mccooey-flipped`);
  await page.hook('flip');
}

async function testTwoPlayers(page, suite) {
  section(`${suite}: two players (test hook)`);
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  const fens = [(await page.state()).fen];
  const play = async (mv, wantSan) => {
    const ok = await page.hook('playMove', mv);
    const st = await page.state();
    fens[st.ply] = st.fen;
    fens.length = st.ply + 1;
    const san = st.history[st.history.length - 1];
    check(`playMove("${mv}") plays ${wantSan}`, ok === true && san === wantSan, `returned ${ok}, last move ${san}`);
    return st;
  };
  let st = await play('b1b3', 'b3');
  check('White double step b1-b3 records e.p. cell b2', st.fen.split(' ')[2] === 'b2', st.fen);
  await play('i7i6', 'i6');
  await play('b3b4', 'b4');
  await play('i6i5', 'i5');
  await play('b4b5', 'b5');
  st = await play('c7c5', 'c5');
  check('Black double step c7-c5 records e.p. cell c6', st.fen.split(' ')[2] === 'c6', st.fen);
  await checkBoard(page, 'board after the double steps matches the engine');
  st = await play('b5c6', 'bxc6');
  const b = parseFenBoard(st.fen);
  check('en passant b5xc6: the black pawn on c5 is gone, the white pawn is on c6',
    b[cellIndex('c5')] === 0 && b[cellIndex('c6')] === 1 && b[cellIndex('b5')] === 0, st.fen);
  await checkBoard(page, 'board after en passant: the captured pawn has vanished from c5');
  await play('i5i4', 'i4');
  await play('c6c7', 'c7');
  await play('i4i3', 'i3');
  const N = (await page.state()).ply;

  // Promotion by capture on b7, through the in-board picker, with real mouse clicks.
  await page.clickCell('c7');
  st = await page.state();
  check('mouse click selects the c7 pawn', st.selected === 'c7', st.selected);
  const hints = await page.eval(`[...document.querySelectorAll('#board .hints circle')].map((c) => c.getAttribute('class'))`);
  check('one capture ring (b7) is hinted', hints.length === 1 && /hint-capture/.test(hints[0]), hints.join(','));
  await page.clickCell('b7');
  st = await page.state();
  const options = await page.eval(`[...document.querySelectorAll('#board .promo .promo-option')].map((o) => o.dataset.promo)`);
  check('cxb7 opens the promotion picker without moving yet', st.promotionOpen === true && st.ply === N, `open ${st.promotionOpen}, ply ${st.ply}`);
  check('picker offers queen, rook, bishop, knight (queen first)', options.join(',') === '5,4,3,2', options.join(','));
  await sleep(300);
  await page.mouseMove(5, 5);
  await page.shot(`${suite}-desktop-promotion-picker`);
  const board = await page.eval(`(() => { const r = document.getElementById('board').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  await page.shot(`${suite}-board-promotion-picker`, { clip: board });
  await page.key('Escape');
  st = await page.state();
  check('Escape cancels the promotion', !st.promotionOpen && st.ply === N && st.selected === null, `open ${st.promotionOpen}, ply ${st.ply}, selected ${st.selected}`);
  await checkBoard(page, 'after Escape the pawn is back on c7');
  await page.clickCell('c7');
  await page.clickCell('b7');
  const away = await page.center('#moves-meta');
  await page.click(away.x, away.y);
  st = await page.state();
  check('a click outside the board cancels the picker', st.promotionOpen === false && st.ply === N, `open ${st.promotionOpen}, ply ${st.ply}`);
  await page.clickCell('c7');
  await page.clickCell('b7');
  await sleep(250);
  await page.clickSelector('#board .promo .promo-option[data-promo="2"]');
  st = await page.state();
  check('clicking the knight in the picker promotes to a knight', st.ply === N + 1 && /^cxb7=N/.test(st.history[N]), st.history[N]);
  await checkBoard(page, 'a white knight stands on b7');
  check('undo() takes the promotion back', (await page.hook('undo')) === true && (await page.state()).fen === fens[N]);
  await checkBoard(page, 'after undo the pawn is on c7 and the black pawn back on b7');
  await page.clickCell('c7');
  await page.clickCell('b7');
  await page.key('q');
  st = await page.state();
  check('the Q key picks a queen', st.ply === N + 1 && /^cxb7=Q/.test(st.history[N]) && st.redo === 0, `${st.history[N]}, redo ${st.redo}`);
  fens[st.ply] = st.fen;
  fens.length = st.ply + 1;
  await checkBoard(page, 'a white queen stands on b7');
  check('the page history replays legally in the engine', !replayProblem(st), replayProblem(st));

  // Undo / redo / keyboard / move-list navigation.
  const last = st.ply;
  check('undo() steps back one ply', (await page.hook('undo')) === true && (st = await page.state()).ply === last - 1 && st.fen === fens[last - 1] && st.redo === 1,
    `ply ${st.ply}, redo ${st.redo}`);
  check('redo() replays it', (await page.hook('redo')) === true && (st = await page.state()).ply === last && st.fen === fens[last] && st.redo === 0,
    `ply ${st.ply}, redo ${st.redo}`);
  await page.key('ArrowLeft');
  st = await page.state();
  check('ArrowLeft steps back', st.ply === last - 1 && st.fen === fens[last - 1], st.ply);
  await page.key('ArrowRight');
  st = await page.state();
  check('ArrowRight steps forward', st.ply === last && st.fen === fens[last], st.ply);
  await page.key('Home');
  st = await page.state();
  check('Home goes to the start position', st.ply === 0 && st.fen === fens[0] && st.redo === last, `ply ${st.ply}`);
  await checkBoard(page, 'board shows the start position');
  await page.clickSelector('#move-list [data-ply="5"]');
  st = await page.state();
  check('clicking move 5 in the move list jumps there', st.ply === 5 && st.fen === fens[5], st.ply);
  await checkBoard(page, 'board shows the position after ply 5');
  await page.shot(`${suite}-desktop-review`);
  await page.key('End');
  st = await page.state();
  check('End returns to the latest move', st.ply === last && st.fen === fens[last] && st.redo === 0, st.ply);
  await checkBoard(page, 'board shows the latest position again');

  // Persistence: a reload restores the game.
  await page.reload();
  const ready = await waitReady(page);
  st = await page.state();
  check('after a reload the game is restored from localStorage',
    ready === 'ok' && st.fen === fens[last] && st.ply === last && st.mode === 'hvh', `${ready}; ply ${st.ply}; ${st.fen}`);
  await checkBoard(page, 'restored board matches the engine', 100);
}

async function testFoolsMate(page, suite) {
  section(`${suite}: fool's mate`);
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  const sans = ['Qc3', 'Qc6', 'b2', 'b6', 'Bb1', 'e6', 'Qxf9#'];
  let ok = true;
  for (const san of sans) ok = (await page.hook('playMove', san)) === true && ok;
  const st = await page.state();
  check('1. Qc3 Qc6 2. b2 b6 3. Bb1 e6 4. Qxf9# is accepted', ok && st.history.join(' ') === sans.join(' '), st.history.join(' '));
  check('the game is over: checkmate', st.gameOver === true && st.status === 1, `status ${st.status}`);
  check('result text "Checkmate — White wins", score 1–0', st.resultText === 'Checkmate — White wins' && st.score === '1–0', `${st.resultText} / ${st.score}`);
  check('final FEN (SPEC §2.4, rank 3 corrected)', st.fen === 'b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4', st.fen);
  await sleep(450);
  const over = await page.eval(`(() => { const d = document.getElementById('dlg-over'); return { open: d.open, title: document.getElementById('over-title').textContent, score: document.getElementById('over-score').textContent, detail: document.getElementById('over-detail').textContent, status: document.getElementById('status-main').textContent }; })()`);
  check('the game-over dialog shows "Checkmate", 1–0', over.open && over.title === 'Checkmate' && over.score === '1–0', JSON.stringify(over));
  check('the status line says "Checkmate — White wins"', over.status === 'Checkmate — White wins', over.status);
  const glow = await page.eval(`(() => { const m = document.querySelector('#board .mark-check'); const g = document.querySelector('#board .cells [data-cell="g10"]').getBoundingClientRect(); const r = m.getBoundingClientRect(); return { shown: getComputedStyle(m).display !== 'none', dx: Math.abs((r.left + r.width / 2) - (g.left + g.width / 2)), dy: Math.abs((r.top + r.height / 2) - (g.top + g.height / 2)) }; })()`);
  check('red check glow on the mated king (g10)', glow.shown && glow.dx < 2 && glow.dy < 2, JSON.stringify(glow));
  await page.mouseMove(5, 5);
  await page.shot(`${suite}-desktop-game-over`);
  await page.clickSelector('#over-review');
  await sleep(250);
  check('"Review game" closes the dialog', !(await page.eval(`document.getElementById('dlg-over').open`)));
  await page.clickCell('f1');
  check('board input is ignored once the game is over', (await page.state()).selected === null);
  check('playMove is refused once the game is over', (await page.hook('playMove', 'g10f10')) === false);
  await page.mouseMove(5, 5);
  await page.shot(`${suite}-desktop-checkmate-review`);
}

async function testComputer(page, suite) {
  section(`${suite}: you vs computer`);
  await page.viewport(1400, 900);

  // Level 1: you play White in Gliński.
  let st = await page.hook('newGame', { variant: 0, mode: 'hvc', humanColor: 'white', level: 1 });
  check('new game vs computer, level 1, you play White', st.mode === 'hvc' && st.humanColor === 0 && st.level === 1 && st.ply === 0 && !st.thinking,
    JSON.stringify({ mode: st.mode, human: st.humanColor, level: st.level, thinking: st.thinking }));
  await page.eval(PROBE_START_JS);
  let t0 = Date.now();
  await page.hook('playMove', 'f5f6');
  st = await page.state();
  const indicator = await page.eval(`!document.getElementById('thinking').hidden`);
  check('after your move the computer thinks (state.thinking and the indicator)', st.thinking === true && indicator === true, `${st.thinking} / ${indicator}`);
  st = await waitState(page, (s) => s.ply === 2 && !s.thinking, 8000);
  let dt = Date.now() - t0;
  check(`level 1 answers within 5 s (${dt} ms)`, st && dt < 5000, st ? `ply ${st.ply}` : 'no reply in 8 s');
  if (!st) return;
  check(`its move ${st.history[1]} is legal (game replays in the engine)`, !replayProblem(st), replayProblem(st));
  check('the move came from the Web Worker', st.lastSearch && st.lastSearch.via === 'worker' && st.aiMode === 'worker', JSON.stringify(st.lastSearch));
  check('the thinking indicator is cleared', !(await page.eval(`!document.getElementById('thinking').hidden`)) && !st.thinking);
  let probe = await page.eval(PROBE_STOP_JS);
  check(`the page stayed responsive (longest main-thread gap ${probe.max} ms)`, probe.max < 400, probe.max);
  const evalUi = await page.eval(`({ bar: !document.getElementById('eval').hidden, info: document.getElementById('search-info').textContent })`);
  check('the evaluation bar and search line are shown', evalUi.bar && /depth \d+/.test(evalUi.info), JSON.stringify(evalUi));
  await page.mouseMove(5, 5);
  await page.shot(`${suite}-desktop-vs-computer`);

  // Level 4: McCooey, you play Black, so the computer opens.
  st = await page.hook('newGame', { variant: 1, mode: 'hvc', humanColor: 'black', level: 4 });
  check('level 4 as Black: the board is flipped and the computer starts thinking', st.flipped === true && st.thinking === true,
    `flipped ${st.flipped}, thinking ${st.thinking}`);
  t0 = Date.now();
  st = await waitState(page, (s) => s.ply === 1 && !s.thinking, 8000);
  dt = Date.now() - t0;
  check(`level 4 opens within 5 s (${dt} ms)`, st && dt < 5000, st ? '' : 'no move in 8 s');
  if (!st) return;
  check(`its opening move ${st.history[0]} is legal`, !replayProblem(st), replayProblem(st));
  const reply = legalMovesOf(st).find((m) => m.piece === 1) || legalMovesOf(st)[0];
  check(`you reply ${reply.uci}`, (await page.hook('playMove', reply.uci)) === true);
  t0 = Date.now();
  st = await waitState(page, (s) => s.ply === 3 && !s.thinking, 8000);
  dt = Date.now() - t0;
  check(`level 4 answers within 5 s (${dt} ms)`, st && dt < 5000, st ? '' : 'no reply in 8 s');
  if (!st) return;
  check(`its reply ${st.history[2]} is legal`, !replayProblem(st), replayProblem(st));
  check('level 4 searched in the Web Worker', st.lastSearch && st.lastSearch.via === 'worker', JSON.stringify(st.lastSearch));
  await checkBoard(page, 'flipped McCooey board matches the engine');
  await page.mouseMove(5, 5);
  await page.shot(`${suite}-desktop-mccooey-vs-computer`);

  // Level 7 (5 s budget, no depth cap): the page must keep responding while the worker searches.
  st = await page.hook('newGame', { variant: 0, mode: 'hvc', humanColor: 'white', level: 7 });
  await page.eval(PROBE_START_JS);
  t0 = Date.now();
  await page.hook('playMove', 'e4e5');
  const rtts = [];
  for (let i = 0; i < 6; i++) {
    const t = Date.now();
    const s = await page.state();
    rtts.push(Date.now() - t);
    if (!s.thinking) break;
    await sleep(90);
  }
  st = await waitState(page, (s) => s.ply === 2 && !s.thinking, 14000);
  dt = Date.now() - t0;
  probe = await page.eval(PROBE_STOP_JS);
  check(`level 7 answers within 7 s (${dt} ms)`, st && dt < 7000, st ? '' : 'no reply in 14 s');
  if (!st) return;
  check(`its move ${st.history[1]} is legal`, !replayProblem(st), replayProblem(st));
  const ls = st.lastSearch || {};
  check(`a real search ran in the worker (depth ${ls.depth}, ${ls.nodes} nodes, ${ls.ms} ms)`, ls.via === 'worker' && ls.depth >= 4 && ls.ms >= 200, JSON.stringify(ls));
  // A search of >= 600 ms on the main thread would block it that long; the worker keeps the
  // page answering (typically within a few tens of ms; the bound leaves room for a busy CPU).
  check(`while it searched the page answered within ${Math.max(...rtts)} ms and the longest main-thread gap was ${probe.max} ms`,
    Math.max(...rtts) < 400 && probe.max < 400, `${rtts.join('/')} ms; gap ${probe.max} ms`);

  // A cancelled search never lands: Undo and New game while the computer thinks.
  const workersBefore = page.workers.length;
  st = await page.hook('newGame', { variant: 0, mode: 'hvc', humanColor: 'white', level: 8 });
  await page.hook('playMove', 'e4e5');
  await sleep(250);
  check('level 8 is thinking', (await page.state()).thinking === true);
  await page.clickCell('e7');
  st = await page.state();
  const hintsWhileThinking = await page.eval(`document.querySelectorAll('#board .hints circle').length`);
  check("board clicks are ignored during the computer's turn", st.selected === null && hintsWhileThinking === 0, `selected ${st.selected}, ${hintsWhileThinking} hints`);
  check("playMove is refused during the computer's turn", (await page.hook('playMove', 'e7e6')) === false);
  await page.mouseMove(5, 5);
  if (suite === 'served') await page.shot(`${suite}-desktop-thinking`);
  const stillThinking = (await page.state()).thinking;
  const undone = await page.hook('undo');
  st = await page.state();
  check('Undo while the computer thinks takes your move back and stops the search',
    stillThinking === true && undone === true && st.ply === 0 && !st.thinking, `thinking before ${stillThinking}; ply ${st.ply}, thinking ${st.thinking}`);
  await sleep(3200);
  st = await page.state();
  check('no stale computer move arrives after Undo', st.ply === 0 && st.redo === 1, `ply ${st.ply}, redo ${st.redo}`);
  check('a fresh worker replaced the cancelled one', page.workers.length > workersBefore && st.aiMode === 'worker', `${workersBefore} -> ${page.workers.length} workers, ${st.aiMode}`);
  await page.hook('redo');
  check('redo() replays your move and the computer thinks again', (st = await page.state()).ply === 1 && st.thinking === true, `ply ${st.ply}, thinking ${st.thinking}`);
  await page.hook('newGame', { variant: 1, mode: 'hvh' });
  await sleep(3200);
  st = await page.state();
  check('no stale computer move arrives after New game', st.ply === 0 && st.variant === 1 && st.mode === 'hvh', `ply ${st.ply}`);
  check('the page history is still consistent', !replayProblem(st), replayProblem(st));
}

async function testDemo(page, suite) {
  section(`${suite}: computer vs computer`);
  let st = await page.hook('newGame', { variant: 0, mode: 'cvc', level: 1 });
  check('the demo starts thinking at once', st.mode === 'cvc' && st.thinking === true, `${st.mode} ${st.thinking}`);
  st = await waitState(page, (s) => s.ply >= 3, 9000);
  check('the computer plays both sides (3 plies)', !!st, 'fewer than 3 plies in 9 s');
  await page.clickSelector('#btn-pause');
  st = await page.state();
  const plyAtPause = st.ply;
  check('Pause stops the demo', st.paused === true && !st.thinking, `paused ${st.paused}, thinking ${st.thinking}`);
  await sleep(1600);
  st = await page.state();
  check('no move is played while paused', st.ply === plyAtPause, `${plyAtPause} -> ${st.ply}`);
  await checkButtons(page, 'demo with the Pause button');
  await page.mouseMove(5, 5);
  if (suite === 'served') await page.shot(`${suite}-desktop-demo-paused`);
  await page.clickSelector('#btn-pause');
  st = await waitState(page, (s) => s.ply > plyAtPause, 6000);
  check('Resume continues the demo', !!st && st.paused === false, st ? '' : 'no move after resuming');
  if (st) check('every demo move is legal', !replayProblem(st), replayProblem(st));
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
}

async function testMouse(page, suite) {
  section(`${suite}: mouse`);
  await page.viewport(1400, 900);
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  await sleep(150);
  let st = await page.state();
  const f5 = legalTargets(st, 'f5');
  await page.clickCell('f5');
  st = await page.state();
  check('clicking the f5 pawn selects it', st.selected === 'f5', st.selected);
  const nHints = await page.eval(`document.querySelectorAll('#board .hints circle').length`);
  check(`its legal moves are hinted (${f5.length})`, nHints === f5.length, nHints);
  const f6 = await page.cell('f6');
  await page.mouseMove(f6.x, f6.y);
  await sleep(40);
  check('hovering a legal target highlights it', await page.eval(`getComputedStyle(document.querySelector('#board .mark-hover')).display !== 'none'`));
  await page.click(f6.x, f6.y);
  st = await page.state();
  check('click-to-move: clicking f6 plays f6', st.history.join(' ') === 'f6', st.history.join(' '));
  await checkBoard(page, 'the pawn slid to f6');
  await page.clickCell('e7');
  check('clicking a black pawn selects it', (await page.state()).selected === 'e7');
  await page.clickCell('d7');
  check('clicking another own piece switches the selection', (await page.state()).selected === 'd7');
  await page.clickCell('a1');
  check('clicking an empty non-target cell deselects', (await page.state()).selected === null);
  await page.clickCell('f6');
  check("clicking the opponent's piece selects nothing", (await page.state()).selected === null);

  let lifted = 0;
  await page.drag(await page.cell('e7'), await page.cell('e5'), {
    midway: async () => {
      lifted = await page.eval(`document.querySelectorAll('#board .drag g.piece').length`);
      await page.shot(`${suite}-desktop-dragging`);
    },
  });
  st = await page.state();
  check('while dragging, the piece is lifted into the drag layer', lifted === 1, lifted);
  check('drag-and-drop e7 to e5 plays the double step', st.history.join(' ') === 'f6 e5', st.history.join(' '));
  await checkBoard(page, 'the dropped pawn sits on e5');
  await page.drag(await page.cell('h1'), await page.cell('h5'));
  st = await page.state();
  check('dropping on an illegal cell plays nothing', st.ply === 2, st.ply);
  await checkBoard(page, 'the knight returned to h1');
  const targets = legalTargets(st, 'h1');
  await page.drag(await page.cell('h1'), await page.cell(targets[0]));
  st = await page.state();
  check(`drag-and-drop Nh1-${targets[0]}`, st.ply === 3 && st.history[2].startsWith('N'), st.history.join(' '));
  await checkBoard(page, `the knight sits on ${targets[0]}`);
  check('mouse-played game replays legally in the engine', !replayProblem(st), replayProblem(st));

  // Keyboard: F flips, N opens the new-game dialog, Escape closes it.
  await page.key('f');
  check('F flips the board', (await page.state()).flipped === true);
  await page.key('f');
  await page.key('n');
  await sleep(250);
  check('N opens the New game dialog', await page.eval(`document.getElementById('dlg-new').open`));
  await page.key('Escape');
  await sleep(250);
  check('Escape closes it', !(await page.eval(`document.getElementById('dlg-new').open`)));
  await page.clickCell('d7');
  const sel = (await page.state()).selected;
  await page.key('Escape');
  check('Escape clears a selection', sel === 'd7' && (await page.state()).selected === null, `${sel} -> ${(await page.state()).selected}`);

  // prefers-reduced-motion: moves are drawn at once, without sliding.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.clickCell('d7');
  await page.clickCell('d6');
  st = await page.state();
  check('reduced motion: d6 is played', st.history[st.ply - 1] === 'd6', st.history.join(' '));
  await checkBoard(page, 'reduced motion: the board is final immediately (no slide)', 0);
  await page.scheme(false);

  // Sound on: a gesture-started AudioContext must not produce console errors or warnings.
  await page.clickSelector('#btn-settings');
  await sleep(250);
  await page.clickSelector('#form-settings input[name="sound"] + .switch-ui');
  await page.clickSelector('#form-settings button[type="submit"]');
  await sleep(250);
  check('sound effects can be switched on in Settings', (await page.state()).settings.sound === true);
  const before = page.console.length;
  st = await page.state();
  const mv = legalMovesOf(st).find((m) => m.piece === 1 && !m.isPromotion) || legalMovesOf(st)[0];
  await page.clickCell(mv.fromName);
  await page.clickCell(mv.toName);
  await sleep(300);
  const noise = page.console.slice(before).filter((c) => c.level !== 'info');
  check(`a move with sound on (${mv.uci}) is played without console noise`, (await page.state()).ply === st.ply + 1 && noise.length === 0, noise.map((c) => c.text).join(' | '));
  await page.clickSelector('#btn-settings');
  await sleep(250);
  await page.clickSelector('#form-settings input[name="sound"] + .switch-ui');
  await page.clickSelector('#form-settings button[type="submit"]');
  await sleep(250);
  check('sound effects switched off again', (await page.state()).settings.sound === false);
}

async function testPhone(page, suite, full) {
  section(`${suite}: phone`);
  const dialogs = [['#btn-new', 'dlg-new', 'new-game'], ['#btn-settings', 'dlg-settings', 'settings'], ['#btn-help', 'dlg-help', 'help'], ['#btn-position', 'dlg-position', 'fen']];
  for (const [w, h] of [[360, 740], [390, 844]]) {
    await page.viewport(w, h, { mobile: true, scale: 2 });
    await page.hook('newGame', { variant: 0, mode: 'hvh' });
    for (const mv of ['e4e5', 'd7d5', 'e5d5']) await page.hook('playMove', mv);
    await sleep(400);
    await checkOverflow(page, `${w} px`);
    await checkButtons(page, `${w} px`);
    await checkLabels(page, `${w} px: coordinate labels clear`);
    await checkBoard(page, `${w} px: board matches the engine`, 0);
    for (const dark of [false, true]) {
      if (!full && dark) continue;
      await page.scheme(dark);
      await page.eval('window.scrollTo(0, 0)');
      await page.shot(`${suite}-phone${w}-${dark ? 'dark' : 'light'}`);
      if (w === 390) await page.shot(`${suite}-phone${w}-${dark ? 'dark' : 'light'}-fullpage`, { full: true });
    }
    await page.scheme(false);
    for (const [button, id, name] of dialogs) {
      await page.eval('window.scrollTo(0, 0)');
      await page.clickSelector(button);
      await sleep(300);
      const open = await page.eval(`document.getElementById('${id}').open`);
      check(`${w} px: ${name} dialog opens`, open === true);
      await checkOverflow(page, `${w} px, ${name} dialog open`);
      if (w === 390 && (full || name === 'new-game')) await page.shot(`${suite}-phone${w}-dialog-${name}`);
      await page.key('Escape');
      await sleep(250);
      if (await page.eval(`document.getElementById('${id}').open`)) await page.eval(`document.getElementById('${id}').close()`);
    }
  }

  // Touch: tap-tap and drag with a finger.
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  await sleep(200);
  await page.eval('window.scrollTo(0, 0)');
  await page.tap(await page.cell('f5'));
  check('touch: tapping f5 selects it', (await page.state()).selected === 'f5');
  await page.tap(await page.cell('f6'));
  let st = await page.state();
  check('touch: tapping f6 plays f6', st.history.join(' ') === 'f6', st.history.join(' '));
  await page.touchDrag(await page.cell('e7'), await page.cell('e5'));
  st = await page.state();
  check('touch: dragging e7 to e5 plays e5', st.history.join(' ') === 'f6 e5', st.history.join(' '));
  await checkBoard(page, 'touch: the board matches the engine');
  await page.viewport(1400, 900);
}

async function testMoreStates(page, suite) {
  section(`${suite}: check, stalemate, repetition, auto-flip, FEN dialog, restore`);
  const shots = suite === 'served';
  await page.viewport(1400, 900);
  await page.scheme(false);

  // Check: Qa2-a6+ against a bare king.
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  let err = await page.hook('loadFen', 'k/3/5/7/9/11/11/11/11/Q10/5K5 w - 0 1', 0);
  check('loadFen() starts a game from a legal position', err === null, err);
  let ok = await page.hook('playMove', 'Qa6');
  let st = await page.state();
  check('Qa6+ gives check', ok === true && st.inCheck === true && st.history[0] === 'Qa6+', `${ok} ${st.history.join(' ')}`);
  const status = await page.eval(`({ main: document.getElementById('status-main').textContent, tone: document.getElementById('status-card').dataset.tone })`);
  check('the status line reads "Black to move — check!" in the alert colour', status.main === 'Black to move — check!' && status.tone === 'check', JSON.stringify(status));
  await checkBoard(page, 'board after the check matches the engine');
  await page.mouseMove(5, 5);
  if (shots) await page.shot(`${suite}-desktop-check`);

  // Stalemate: ¾ in Gliński, a draw in McCooey.
  const stalemateFen = 'k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1';
  for (const [variant, text, score] of [[0, 'Stalemate — White scores ¾ (Gliński rule)', '¾–¼'], [1, 'Stalemate — draw', '½–½']]) {
    err = await page.hook('loadFen', stalemateFen, variant);
    ok = await page.hook('playMove', 'Kf9');
    st = await page.state();
    check(`${variant ? 'McCooey' : 'Gliński'}: Kf9 stalemates — "${text}", ${score}`,
      err === null && ok === true && st.status === 2 && st.resultText === text && st.score === score, `${err} ${ok} ${st.status} ${st.resultText} ${st.score}`);
    await sleep(450);
    const over = await overDialog(page);
    check(`${variant ? 'McCooey' : 'Gliński'}: the game-over dialog says "Stalemate", ${score}`, over.open && over.title === 'Stalemate' && over.score === score, JSON.stringify(over));
    await page.mouseMove(5, 5);
    if (shots && variant === 0) await page.shot(`${suite}-desktop-stalemate`);
    await closeOverDialog(page);
  }

  // Threefold repetition with knight shuffles.
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  st = await page.state();
  const w = legalMovesOf(st).find((m) => m.fromName === 'h1');
  await page.hook('playMove', w.uci);
  const b = legalMovesOf(await page.state()).find((m) => m.fromName === 'h9');
  const cycle = [w.uci, b.uci, w.toName + w.fromName, b.toName + b.fromName];
  for (let i = 1; i < 8; i++) await page.hook('playMove', cycle[i % 4]);
  st = await page.state();
  check('the third repetition ends the game: "Draw by threefold repetition", ½–½',
    st.ply === 8 && st.status === 3 && st.resultText === 'Draw by threefold repetition' && st.score === '½–½', `ply ${st.ply}, ${st.status}, ${st.resultText}`);
  await sleep(450);
  const draw = await overDialog(page);
  check('the game-over dialog says "Draw", ½–½', draw.open && draw.title === 'Draw' && draw.score === '½–½', JSON.stringify(draw));
  await closeOverDialog(page);

  // Two players with the board turning after every move.
  st = await page.hook('newGame', { variant: 0, mode: 'hvh', autoFlip: true });
  check('auto-flip: White to move, board upright', st.flipped === false && st.mode === 'hvh');
  await page.hook('playMove', 'f5f6');
  check('auto-flip: Black to move, board turned', (await page.state()).flipped === true);
  await page.hook('playMove', 'e7e6');
  check('auto-flip: White to move again, board upright', (await page.state()).flipped === false);
  await page.hook('newGame', { variant: 0, mode: 'hvh', autoFlip: false });

  // Black promotes on a flipped board: the picker runs back up the file, inside the board.
  err = await page.hook('loadFen', 'k/3/5/7/9/11/11/11/11/4p6/5K5 b - 0 1', 0);
  if (!(await page.state()).flipped) await page.hook('flip');
  await page.clickCell('e2');
  await page.clickCell('e1');
  st = await page.state();
  const picker = await page.eval(`(() => {
    const svg = document.getElementById('board').getBoundingClientRect();
    return [...document.querySelectorAll('#board .promo .promo-option')].map((o) => {
      const r = o.getBoundingClientRect();
      const cell = (n) => { const c = document.querySelector('#board .cells [data-cell="' + n + '"]').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; };
      return { type: o.dataset.promo, x: r.left + r.width / 2, y: r.top + r.height / 2, inside: r.left >= svg.left && r.right <= svg.right && r.top >= svg.top && r.bottom <= svg.bottom, e1: cell('e1') };
    });
  })()`);
  check('Black e2-e1 opens the picker with four choices, all inside the board',
    err === null && st.promotionOpen === true && picker.length === 4 && picker.every((p) => p.inside), JSON.stringify(picker.map((p) => p.inside)));
  check('the queen sits on e1 and the choices run down the screen of the flipped board',
    picker.length === 4 && Math.hypot(picker[0].x - picker[0].e1[0], picker[0].y - picker[0].e1[1]) < 2 && picker[3].y > picker[0].y, JSON.stringify(picker.map((p) => [p.type, Math.round(p.x), Math.round(p.y)])));
  await sleep(250);
  await page.mouseMove(5, 5);
  if (shots) {
    const box = await page.eval(`(() => { const r = document.getElementById('board').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    await page.shot(`${suite}-board-black-promotion-flipped`, { clip: box });
  }
  await page.clickSelector('#board .promo .promo-option[data-promo="4"]');
  st = await page.state();
  check('choosing the rook plays e1=R', st.ply === 1 && /^e1=R/.test(st.history[0]), st.history.join(' '));
  await checkBoard(page, 'a black rook stands on e1');
  await page.hook('flip');

  // The FEN dialog, driven through the real controls.
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  await page.clickSelector('#btn-position');
  await sleep(300);
  await page.clickSelector('#fen-input');
  await page.send('Input.insertText', { text: 'not a position' });
  await page.clickSelector('#fen-load');
  const msg = await page.eval(`({ text: document.getElementById('fen-msg').textContent, kind: document.getElementById('fen-msg').dataset.kind, open: document.getElementById('dlg-position').open })`);
  check('an invalid FEN shows a validation message and keeps the dialog open', msg.open && msg.kind === 'error' && msg.text.length > 20, JSON.stringify(msg));
  if (shots) await page.shot(`${suite}-desktop-fen-error`);
  const g = engine.newGame(1);
  for (const m of ['f4f5', 'e8e6']) g.makeMove(m);
  const fen = g.fen();
  g.destroy();
  await page.eval(`(() => { const t = document.getElementById('fen-input'); t.value = ''; t.dispatchEvent(new Event('input')); document.getElementById('fen-variant').value = '1'; return true; })()`);
  await page.clickSelector('#fen-input');
  await page.send('Input.insertText', { text: fen });
  await page.clickSelector('#fen-load');
  await sleep(200);
  st = await page.state();
  const after = await page.eval(`({ open: document.getElementById('dlg-position').open, toast: document.getElementById('toast').className.includes('show') ? document.getElementById('toast').textContent : '' })`);
  check('a valid McCooey FEN loads through the dialog', !after.open && st.variant === 1 && st.fen === fen && st.startFen === fen && st.ply === 0, `${st.variant} ${st.fen}`);
  check('a "Position loaded" notice appears', after.toast === 'Position loaded', after.toast);
  if (shots) await page.shot(`${suite}-desktop-fen-loaded`);
  await checkBoard(page, 'the board shows the loaded position');

  // Reload while the computer is to move: the restored game goes on.
  await page.hook('newGame', { variant: 0, mode: 'hvc', humanColor: 'white', level: 7 });
  await page.hook('playMove', 'f5f6');
  await page.reload();
  const ready = await waitReady(page);
  st = await page.state();
  check('after a reload mid-search the restored game has the computer thinking again', ready === 'ok' && st.ply === 1 && st.thinking === true && st.mode === 'hvc', `${ready}; ply ${st.ply}, thinking ${st.thinking}`);
  st = await waitState(page, (s) => s.ply === 2 && !s.thinking, 12000);
  check('…and its reply arrives, legal', !!st && !replayProblem(st), st ? replayProblem(st) : 'no reply in 12 s');
}

async function testLongGame(page, suite) {
  section(`${suite}: long game, window sizes`);
  await page.viewport(1400, 900);
  await page.scheme(false);
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  const rnd = rng32(20261102);
  let st = await page.state();
  let accepted = true;
  for (let i = 0; i < 90 && !st.gameOver; i++) {
    const moves = legalMovesOf(st);
    const caps = moves.filter((m) => m.isCapture);
    const pool = caps.length && rnd() < 0.8 ? caps : moves;
    const m = pool[Math.floor(rnd() * pool.length)];
    if ((await page.hook('playMove', m.uci)) !== true) {
      accepted = false;
      break;
    }
    st = await page.state();
  }
  check(`a capture-heavy random game (${st.ply} plies${st.gameOver ? `, ${st.resultText}` : ''}) is accepted move by move`, accepted && (st.ply >= 40 || st.gameOver), `ply ${st.ply}`);
  check('its history replays legally in the engine', !replayProblem(st), replayProblem(st));
  await closeOverDialog(page);
  await checkBoard(page, 'the board matches the engine after the long game');
  const LIST_JS = `(() => { const l = document.getElementById('move-list'); const c = l.querySelector('.move.current'); const a = l.getBoundingClientRect(); const b = c ? c.getBoundingClientRect() : null; return { scrolls: l.scrollHeight > l.clientHeight, visible: !!b && b.top >= a.top - 1 && b.bottom <= a.bottom + 1 }; })()`;
  const list = await page.eval(LIST_JS);
  check('the move list scrolls and keeps the current move in view', list.scrolls && list.visible, JSON.stringify(list));
  await page.mouseMove(5, 5);
  if (suite === 'served') await page.shot(`${suite}-desktop-long-game`);
  for (const [w, h] of [[1280, 720], [1024, 768], [920, 1000], [768, 1024]]) {
    await page.viewport(w, h);
    await sleep(250);
    await checkOverflow(page, `${w}×${h}`);
    await checkButtons(page, `${w}×${h}`);
    await checkLabels(page, `${w}×${h}: coordinate labels clear`);
    await checkBoard(page, `${w}×${h}: board matches the engine`, 0);
    const shown = await page.eval(LIST_JS);
    check(`${w}×${h}: after the resize the current move is still in view`, shown.visible, JSON.stringify(shown));
    if (suite === 'served') await page.shot(`${suite}-window-${w}x${h}`);
  }
  await page.viewport(390, 844, { mobile: true, scale: 2 });
  await sleep(250);
  await checkOverflow(page, '390 px with the long game');
  check('390 px: the current move is still in view', (await page.eval(LIST_JS)).visible);
  if (suite === 'served') await page.shot(`${suite}-phone390-long-game-fullpage`, { full: true });
  await page.viewport(1400, 900);
}

async function setTheme(page, theme) {
  await page.clickSelector('#btn-settings');
  await sleep(250);
  await page.clickSelector(`#theme-grid .theme-swatch[data-board="${theme}"]`);
  await sleep(100);
  const shotName = theme === 'slate' ? 'settings' : null;
  if (shotName) await page.shot(`served-desktop-dialog-${shotName}`);
  await page.clickSelector('#form-settings button[type="submit"]');
  await sleep(250);
}

async function testThemes(page, suite) {
  section(`${suite}: themes and colour schemes`);
  await page.viewport(1400, 900);
  await page.scheme(false);
  await page.hook('newGame', { variant: 0, mode: 'hvh' });
  for (const mv of ['e4e5', 'd7d5', 'e5d5', 'e7e6', 'g4g5', 'f9d5']) await page.hook('playMove', mv);
  const st = await page.state();
  check('theme position set up (with captures on both sides)', st.ply === 6, st.history.join(' '));
  const fills = new Map();
  for (const theme of ['walnut', 'slate', 'jade', 'dusk']) {
    await setTheme(page, theme);
    const cur = await page.eval(`({ board: document.documentElement.dataset.board, fill: getComputedStyle(document.querySelector('#board .cells [data-cell="f1"]')).fill, open: document.getElementById('dlg-settings').open })`);
    fills.set(theme, cur.fill);
    check(`board theme "${theme}" applies`, cur.board === theme && !cur.open, JSON.stringify(cur));
    await page.clickCell('e1');
    await page.mouseMove(5, 5);
    await sleep(200);
    await page.shot(`${suite}-desktop-${theme}-light`);
    if (theme === 'walnut' || theme === 'dusk') {
      await page.scheme(true);
      await page.shot(`${suite}-desktop-${theme}-dark`);
      await page.scheme(false);
    }
    await page.key('Escape');
  }
  check('the four themes colour the cells differently', new Set(fills.values()).size === 4, [...fills.values()].join(' | '));
  await page.reload();
  const ready = await waitReady(page);
  const kept = await page.eval(`({ board: document.documentElement.dataset.board, theme: window.__hexchess.state().settings.theme })`);
  check('the chosen theme survives a reload', ready === 'ok' && kept.board === 'dusk' && kept.theme === 'dusk', JSON.stringify(kept));
  await setTheme(page, 'walnut');
  for (const [button, id, name] of [['#btn-new', 'dlg-new', 'new-game'], ['#btn-help', 'dlg-help', 'help'], ['#btn-position', 'dlg-position', 'fen']]) {
    await page.clickSelector(button);
    await sleep(300);
    check(`${name} dialog opens on the desktop`, await page.eval(`document.getElementById('${id}').open`));
    await checkOverflow(page, `desktop, ${name} dialog open`);
    await page.shot(`${suite}-desktop-dialog-${name}`);
    await page.key('Escape');
    await sleep(250);
  }
  await page.scheme(true);
  await page.clickSelector('#btn-new');
  await sleep(300);
  await page.shot(`${suite}-desktop-dialog-new-game-dark`);
  await page.key('Escape');
  await page.scheme(false);
}

async function testWasmFailure(page, url) {
  section('served: wasm load failure');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*hexchess.wasm*', requestStage: 'Request' }] });
  const off = page.cdp.on((method, p, sid) => {
    if (method === 'Fetch.requestPaused' && sid === page.sid) {
      page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
    }
  });
  try {
    await page.viewport(1400, 900);
    await page.goto(url);
    const t0 = Date.now();
    let shown = null;
    while (Date.now() - t0 < 8000) {
      shown = await page.eval(`({ fatal: !document.getElementById('fatal').hidden, state: document.getElementById('app').dataset.state, status: document.getElementById('status-main').textContent, text: document.querySelector('.fatal-card').innerText })`);
      if (shown.fatal) break;
      await sleep(100);
    }
    check('without hexchess.wasm the error panel explains how to run the app',
      shown.fatal && shown.state === 'error' && /npm run serve/.test(shown.text) && /dist\/hexchess\.html/.test(shown.text), JSON.stringify(shown).slice(0, 300));
    await page.shot('served-desktop-wasm-missing');
  } finally {
    off();
    await page.send('Fetch.disable').catch(() => {});
  }

  // web/index.html opened straight from disk: browsers block its JavaScript modules, so the
  // inline start-up guard must show the same panel instead of an endless spinner.
  section('served: web/index.html opened from disk');
  await page.goto(pathToFileURL(path.join(ROOT, 'web', 'index.html')).href);
  const t1 = Date.now();
  let seen = null;
  while (Date.now() - t1 < 6000) {
    seen = await page.eval(`({ fatal: !document.getElementById('fatal').hidden, state: document.getElementById('app').dataset.state, detail: document.getElementById('fatal-detail').textContent, gear: !document.getElementById('btn-settings').hidden })`);
    if (seen.fatal) break;
    await sleep(100);
  }
  check(`the error panel replaces the endless spinner (${Date.now() - t1} ms)`, seen.fatal && seen.state === 'error' && /file:\/\//.test(seen.detail) && !seen.gear, JSON.stringify(seen));
  await page.shot('served-desktop-index-from-disk');
}

async function runSuite(page, suite, url) {
  page.console = [];
  const full = suite === 'served';
  let loaded = false;
  await guarded('load', async () => { loaded = await testLoad(page, suite, url); });
  if (!loaded) return;
  await guarded('board', () => testBoard(page, suite));
  await guarded('two players', () => testTwoPlayers(page, suite));
  await guarded("fool's mate", () => testFoolsMate(page, suite));
  await guarded('vs computer', () => testComputer(page, suite));
  await guarded('demo', () => testDemo(page, suite));
  await guarded('mouse', () => testMouse(page, suite));
  await guarded('more states', () => testMoreStates(page, suite));
  await guarded('long game', () => testLongGame(page, suite));
  await guarded('phone', () => testPhone(page, suite, full));
  if (full) await guarded('themes', () => testThemes(page, suite));
  section(`${suite}: console`);
  const app = await page.eval(`({ state: document.getElementById('app').dataset.state, fatal: !document.getElementById('fatal').hidden })`);
  check('the app is still up at the end of the suite (no late error panel)', app.state === 'ready' && !app.fatal, JSON.stringify(app));
  const errs = page.errors();
  const warns = page.warnings();
  check(`no console errors or uncaught exceptions during the whole suite (page and worker)`, errs.length === 0, errs.map((e) => e.text).join(' | ').slice(0, 600));
  check('no console warnings', warns.length === 0, warns.map((e) => e.text).join(' | ').slice(0, 600));
  if (VERBOSE) for (const c of page.console) console.log(`    [${c.level}] ${c.text}`);
  if (suite === 'served') await guarded('wasm failure', () => testWasmFailure(page, url));
}

/** The single-file build must be newer than every source it embeds. */
function distStaleness(distFile) {
  if (!fs.existsSync(distFile)) return 'dist/hexchess.html does not exist (run npm run build)';
  const built = fs.statSync(distFile).mtimeMs;
  const sources = [path.join(ROOT, 'web', 'index.html'), path.join(ROOT, 'web', 'style.css'), path.join(ROOT, 'web', 'hexchess.wasm'),
    ...fs.readdirSync(path.join(ROOT, 'web', 'js')).map((f) => path.join(ROOT, 'web', 'js', f))];
  const newer = sources.filter((f) => fs.statSync(f).mtimeMs > built + 1000).map((f) => path.relative(ROOT, f));
  return newer.length ? `older than ${newer.join(', ')} (run npm run build)` : null;
}

// ------------------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  if (!flag('no-shots')) {
    if (option('shots')) {
      shotDir = path.resolve(option('shots'));
    } else {
      // One fixed folder in the OS temp dir, refreshed on every run.
      shotDir = path.join(os.tmpdir(), 'hexchess-e2e-shots');
      fs.rmSync(shotDir, { recursive: true, force: true });
    }
    fs.mkdirSync(shotDir, { recursive: true });
  }
  engine = await loadEngine({ bytes: fs.readFileSync(path.join(ROOT, 'web', 'hexchess.wasm')) });
  let server = null;
  let browser = null;
  let cdp = null;
  try {
    browser = await launchBrowser();
    console.log(`browser: ${browser.exe}`);
    cdp = new Cdp(browser.wsUrl);
    await cdp.connect();
    const page = await Page.attach(cdp);
    if (ONLY !== 'single') {
      let url = option('url');
      if (!url) {
        server = await startServer();
        url = server.url;
      }
      await runSuite(page, 'served', url);
    }
    if (ONLY !== 'served') {
      const distFile = path.join(ROOT, 'dist', 'hexchess.html');
      section('single: build');
      const stale = distStaleness(distFile);
      check('dist/hexchess.html is up to date with web/', !stale, stale);
      if (fs.existsSync(distFile)) {
        const html = fs.readFileSync(distFile, 'utf8');
        const m = html.match(/__HEXCHESS_WASM_B64__ = "([A-Za-z0-9+/=]+)"/);
        const same = m && Buffer.from(m[1], 'base64').equals(fs.readFileSync(path.join(ROOT, 'web', 'hexchess.wasm')));
        check('the embedded wasm is identical to web/hexchess.wasm', same);
        await runSuite(page, 'single', pathToFileURL(distFile).href);
      }
    }
  } finally {
    await closeBrowser(browser, cdp);
    if (server) server.proc.kill();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== e2e summary: ${results.length - failed.length} passed, ${failed.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s) ===`);
  for (const f of failed) console.log(`FAIL  [${f.scope}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  if (shotDir) console.log(`screenshots (${shotFiles.length}): ${shotDir}`);
  return failed.length === 0;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.error(`e2e: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  },
);
