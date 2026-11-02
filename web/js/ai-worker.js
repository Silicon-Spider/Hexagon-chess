/* Hexchess AI worker — a classic (non-module) Web Worker with no imports
 * (docs/SPEC.md §8.1, §8.2). It receives the compiled WebAssembly.Module from the main
 * thread, so it can also be started from a Blob URL in the single-file build.
 *
 *   main → worker  {type:'init', module}
 *   worker → main  {type:'ready'} | {type:'error', message}
 *   main → worker  {type:'search', id, variant, startFen, moves, maxDepth, timeMs, noise, seed}
 *   worker → main  {type:'result', id, move, info:{depth, score, nodes, ms, pv}}
 */
'use strict';

var hc = null; // wasm exports once initialised
var encoder = new TextEncoder();

function errorText(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function loadFen(g, fen) {
  var bytes = encoder.encode(String(fen));
  var size = Math.max(bytes.length, 1);
  var ptr = hc.hc_alloc(size) >>> 0;
  if (!ptr) throw new Error('hc_alloc failed');
  try {
    new Uint8Array(hc.memory.buffer, ptr, bytes.length).set(bytes);
    return hc.hc_load_fen(g, ptr, bytes.length) === 1;
  } finally {
    hc.hc_free(ptr, size);
  }
}

function readInfo() {
  var ptr = hc.hc_search_info_ptr() >>> 0;
  var a = new Int32Array(hc.memory.buffer, ptr, 38);
  var pvLen = Math.max(0, Math.min(32, a[5]));
  var pv = [];
  for (var i = 0; i < pvLen; i++) pv.push(a[6 + i] >>> 0);
  return {
    depth: a[0],
    score: a[1],
    nodes: (a[2] >>> 0) + (a[3] >>> 0) * 4294967296,
    ms: a[4],
    pv: pv
  };
}

function runSearch(msg) {
  var g = hc.hc_new(msg.variant >>> 0) >>> 0;
  if (!g) throw new Error('invalid variant ' + msg.variant);
  try {
    if (msg.startFen && !loadFen(g, msg.startFen)) throw new Error('start FEN rejected: ' + msg.startFen);
    var moves = msg.moves || [];
    for (var i = 0; i < moves.length; i++) {
      if (hc.hc_make_move(g, moves[i] >>> 0) !== 1) throw new Error('illegal move #' + (i + 1) + ' while rebuilding the game');
    }
    var move = hc.hc_search(g, msg.maxDepth >>> 0, msg.timeMs >>> 0, msg.noise >>> 0, msg.seed >>> 0) >>> 0;
    return { type: 'result', id: msg.id, move: move, info: readInfo() };
  } finally {
    hc.hc_destroy(g);
  }
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'init') {
    var imports = { env: { now_ms: function () { return performance.now(); } } };
    WebAssembly.instantiate(msg.module, imports).then(function (instance) {
      hc = instance.exports;
      self.postMessage({ type: 'ready' });
    }, function (err) {
      self.postMessage({ type: 'error', message: 'wasm instantiation failed in worker: ' + errorText(err) });
    });
    return;
  }
  if (msg.type === 'search') {
    if (!hc) {
      self.postMessage({ type: 'error', id: msg.id, message: 'worker not initialised' });
      return;
    }
    var reply;
    try {
      reply = runSearch(msg);
    } catch (err) {
      reply = { type: 'error', id: msg.id, message: errorText(err) };
    }
    self.postMessage(reply);
  }
};
