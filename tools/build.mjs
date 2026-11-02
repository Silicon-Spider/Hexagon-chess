// Build script (zero npm dependencies).
//   node tools/build.mjs              → cargo build (wasm32) → web/hexchess.wasm → dist/hexchess.html
//   node tools/build.mjs --wasm-only  → only the first two steps
//
// The single-file bundle inlines style.css, every ES module reachable from js/main.js
// (each wrapped in its own function scope, see docs/SPEC.md §8.1 for the conventions that
// make this possible), the AI worker source, and the wasm binary as base64. The result
// runs from file:// with no server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');
const WEB = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');
const WASM_NAME = 'hexchess_engine.wasm';

function log(msg) { console.log(`[build] ${msg}`); }

function buildWasm() {
  log('cargo build --release --target wasm32-unknown-unknown');
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd: ENGINE,
    stdio: 'inherit',
  });
  const src = path.join(ENGINE, 'target', 'wasm32-unknown-unknown', 'release', WASM_NAME);
  if (!fs.existsSync(src)) throw new Error(`expected wasm output not found: ${src}`);
  const dst = path.join(WEB, 'hexchess.wasm');
  fs.copyFileSync(src, dst);
  const bytes = fs.readFileSync(dst);
  // Sanity check: valid module whose only import is env.now_ms.
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
  const bad = imports.filter((i) => i !== 'env.now_ms');
  if (bad.length) throw new Error(`unexpected wasm imports: ${bad.join(', ')}`);
  log(`wrote web/hexchess.wasm (${(bytes.length / 1024).toFixed(1)} KiB, imports: ${imports.join(', ') || 'none'})`);
  return bytes;
}

// ---------------------------------------------------------------------------------------
// Minimal ES-module bundler for the conventions in docs/SPEC.md §8.1.
const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+\.js)['"]\s*;?\s*$/;
const ANY_IMPORT_RE = /^\s*import[\s{*'"]/;
const EXPORT_DECL_RE = /^(\s*)export\s+((?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*))/;

function parseModule(file) {
  const text = fs.readFileSync(path.join(WEB, 'js', file), 'utf8');
  const deps = [];
  const exportsList = [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const im = line.match(IMPORT_RE);
    if (im) {
      const names = im[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        if (/\s/.test(n)) throw new Error(`${file}: import aliases are not supported: "${n}"`);
      }
      deps.push({ file: im[2], names });
      out.push(''); // keep line numbers stable-ish
      continue;
    }
    if (ANY_IMPORT_RE.test(line) && !/^\s*import\s*\(/.test(line)) {
      throw new Error(`${file}: unsupported import form: ${line.trim()}`);
    }
    if (/^\s*export\s+(default|\{|\*)/.test(line)) {
      throw new Error(`${file}: unsupported export form: ${line.trim()}`);
    }
    const ex = line.match(EXPORT_DECL_RE);
    if (ex) {
      exportsList.push(ex[3]);
      out.push(line.replace(EXPORT_DECL_RE, '$1$2'));
      continue;
    }
    if (/\bimport\.meta\b/.test(line)) throw new Error(`${file}: import.meta is not supported`);
    out.push(line);
  }
  return { file, deps, exports: exportsList, body: out.join('\n') };
}

function bundleModules(entry) {
  const modules = new Map();
  const order = [];
  const visiting = new Set();
  function visit(file) {
    if (modules.has(file)) return;
    if (visiting.has(file)) throw new Error(`circular import involving ${file}`);
    visiting.add(file);
    const m = parseModule(file);
    for (const d of m.deps) visit(d.file);
    visiting.delete(file);
    modules.set(file, m);
    order.push(file);
  }
  visit(entry);
  const ident = (f) => '__mod_' + f.replace(/\.js$/, '').replace(/[^\w$]/g, '_');
  const parts = ['"use strict";'];
  for (const f of order) {
    const m = modules.get(f);
    for (const d of m.deps) {
      const dm = modules.get(d.file);
      for (const n of d.names) {
        if (!dm.exports.includes(n)) throw new Error(`${f} imports "${n}" which ${d.file} does not export`);
      }
    }
    const imports = m.deps.map((d) => `const { ${d.names.join(', ')} } = ${ident(d.file)};`).join('\n');
    parts.push(
      `// ---- ${f} ----\nconst ${ident(f)} = (() => {\n${imports}\n${m.body}\nreturn { ${m.exports.join(', ')} };\n})();`
    );
  }
  return { code: parts.join('\n\n'), files: order };
}

function escapeScript(text) {
  return text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function buildSingleFile(wasmBytes) {
  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const linkRe = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](?:\.\/)?style\.css["'][^>]*>/i;
  if (!linkRe.test(html)) throw new Error('index.html: <link rel="stylesheet" href="style.css"> not found');
  html = html.replace(linkRe, () => `<style>\n${css}\n</style>`);

  const scriptRe = /<script\b[^>]*type=["']module["'][^>]*src=["'](?:\.\/)?js\/main\.js["'][^>]*>\s*<\/script>/i;
  if (!scriptRe.test(html)) throw new Error('index.html: <script type="module" src="js/main.js"> not found');
  html = html.replace(scriptRe, '');

  const { code, files } = bundleModules('main.js');
  const worker = fs.readFileSync(path.join(WEB, 'js', 'ai-worker.js'), 'utf8');
  const b64 = Buffer.from(wasmBytes).toString('base64');
  const injected =
    `<script type="text/plain" id="ai-worker-src">${escapeScript(worker)}</script>\n` +
    `<script>globalThis.__HEXCHESS_WASM_B64__ = "${b64}";</script>\n` +
    `<script>\n${escapeScript(code)}\n</script>\n`;
  if (!/<\/body>/i.test(html)) throw new Error('index.html: </body> not found');
  html = html.replace(/<\/body>/i, () => `${injected}</body>`);

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'hexchess.html');
  fs.writeFileSync(out, html);
  log(`bundled ${files.length} modules (${files.join(', ')})`);
  log(`wrote dist/hexchess.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`);
}

try {
  const wasm = buildWasm();
  if (!process.argv.includes('--wasm-only')) buildSingleFile(wasm);
  log('done');
} catch (e) {
  console.error(`[build] FAILED: ${e.message}`);
  process.exit(1);
}
