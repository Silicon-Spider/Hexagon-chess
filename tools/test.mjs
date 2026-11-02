// Runs the whole test suite (`npm test`):
//   1. Rust engine tests (native, release mode so perft is fast)   cargo test --release
//   2. a fresh wasm build → web/hexchess.wasm                       tools/build.mjs --wasm-only
//   3. Node tests driving the real .wasm through web/js/engine.js   tools/wasm-tests.mjs
//   4. self-tests of the independent reference implementation      tools/reference/hexref.test.mjs
//   5. differential test, engine vs reference (quick subset)        tools/difftest.mjs --quick
// Steps 3 and 5 need step 2 (they would otherwise test a stale .wasm) and are skipped if it
// fails. The thorough differential run is `node tools/difftest.mjs --full`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const tool = (...p) => path.join(ROOT, 'tools', ...p);

function run(title, cmd, args, cwd) {
  console.log(`\n=== ${title} ===`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  const secs = (Date.now() - t0) / 1000;
  if (r.error) {
    console.error(`failed to start ${cmd}: ${r.error.message}`);
    return { ok: false, secs };
  }
  return { ok: r.status === 0, secs };
}

const steps = [
  ['engine: cargo test --release', () => run('engine: cargo test --release', 'cargo', ['test', '--release'], path.join(ROOT, 'engine'))],
  ['wasm build', () => run('wasm build', node, [tool('build.mjs'), '--wasm-only'], ROOT)],
  ['wasm tests (node)', () => run('wasm tests (node)', node, [tool('wasm-tests.mjs')], ROOT), 'wasm build'],
  ['reference self-tests', () => run('reference self-tests', node, [tool('reference', 'hexref.test.mjs')], ROOT)],
  ['difftest --quick (engine vs reference)', () => run('difftest --quick (engine vs reference)', node, [tool('difftest.mjs'), '--quick'], ROOT), 'wasm build'],
];

const results = new Map();
for (const [name, fn, needs] of steps) {
  if (needs && !results.get(needs).ok) {
    console.log(`\n=== ${name} === SKIPPED (${needs} failed)`);
    results.set(name, { ok: false, secs: 0, skipped: true });
    continue;
  }
  results.set(name, fn());
}

console.log('\n=== summary ===');
for (const [name, r] of results) {
  console.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${name}${r.skipped ? '' : `  (${r.secs.toFixed(1)} s)`}`);
}
const ok = [...results.values()].every((r) => r.ok);
console.log(ok ? '\nall test stages passed' : '\nSOME TEST STAGES FAILED');
process.exit(ok ? 0 : 1);
