#!/usr/bin/env node
/**
 * Static self-check for the whole project. Catches the boring errors before
 * they reach a phone:
 *   • every file referenced by index.html / manifest / sw.js / package.json exists
 *   • every ES import path resolves on disk
 *   • every getElementById() id used by the UI code exists in index.html
 *   • every svg part class required by css/puppet.css exists in js/puppet-art.js
 *   • tool specs are unique and well formed
 *   • no stray console.log in shipped modules
 *
 * Run: npm run lint
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const read = (p) => readFile(resolve(ROOT, p), 'utf8');
const exists = (p) => existsSync(resolve(ROOT, p));

async function walk(dir, out = []) {
  for (const entry of await readdir(resolve(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const files = await walk('.');
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));

/* 1 ── referenced files exist */
const html = await read('index.html');
for (const m of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  const target = m[1].split('?')[0];
  if (target === 'index.html' || target.startsWith('#')) continue;
  if (!exists(target)) fail(`index.html references missing file: ${target}`);
}
const manifest = JSON.parse(await read('manifest.webmanifest'));
for (const icon of manifest.icons || []) {
  if (!exists(icon.src)) fail(`manifest references missing icon: ${icon.src}`);
}
const pkg = JSON.parse(await read('package.json'));
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  const m = /node\s+(tools\/[\w.-]+)/.exec(cmd);
  if (m && !exists(m[1])) fail(`npm script "${name}" points at missing file ${m[1]}`);
}
const sw = await read('sw.js');
for (const m of sw.matchAll(/'\.\/([\w./-]+)'/g)) {
  const target = m[1];
  if (target === '' ) continue;
  if (!exists(target)) fail(`sw.js caches missing file: ${target}`);
}

/* 2 ── imports resolve */
for (const file of jsFiles) {
  const src = await read(file);
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(ROOT, dirname(file), m[1]);
    if (!existsSync(target)) fail(`${file} imports missing module: ${m[1]}`);
  }
  for (const m of src.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolve(ROOT, dirname(file), m[1]);
    if (!existsSync(target)) fail(`${file} dynamically imports missing module: ${m[1]}`);
  }
}

/* 3 ── DOM ids used by js exist in index.html */
const idsInHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const file of jsFiles) {
  const src = await read(file);
  for (const m of src.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)) {
    if (!idsInHtml.has(m[1])) fail(`${file} looks for #${m[1]} which index.html does not define`);
  }
  for (const m of src.matchAll(/querySelector(?:All)?\(['"]#([\w-]+)['"]\)/g)) {
    if (!idsInHtml.has(m[1])) fail(`${file} looks for #${m[1]} which index.html does not define`);
  }
}

/* 4 ── puppet CSS contract vs the SVG art */
const css = await read('css/puppet.css');
const { PUPPET_SVG, ICON_SVG, PUPPET_PARTS } = await import('../js/puppet-art.js');
const requiredParts = new Set(
  [...css.matchAll(/\.puppet[^{]*?\.([a-z][\w-]*)/g)]
    .map((m) => m[1])
    // `is-dragging` / `is-landed` / `is-sparkling` are runtime state flags added
    // to the <svg> element by js/puppet.js, not artwork parts.
    .filter((cls) => !cls.startsWith('is-')),
);
for (const part of PUPPET_PARTS) requiredParts.delete(part);
for (const part of requiredParts) {
  if (!new RegExp(`class="[^"]*\\b${part}\\b`).test(PUPPET_SVG)) fail(`css/puppet.css animates .${part} but the SVG art has no such part`);
}
for (const svg of [PUPPET_SVG, ICON_SVG]) {
  if (!/^<svg/.test(svg.trim())) fail('puppet-art.js exports something that is not an <svg>');
  if (/<script|on\w+=/i.test(svg)) fail('puppet-art.js must stay script-free (no inline JS in artwork)');
}
const puppetIds = [...PUPPET_SVG.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
if (new Set(puppetIds).size !== puppetIds.length) fail('duplicate gradient ids inside PUPPET_SVG');

/* 5 ── tools are sane */
const { TOOLS, toolNames } = await import('../js/tools.js');
const names = toolNames();
if (new Set(names).size !== names.length) fail('duplicate tool names in js/tools.js');
for (const t of TOOLS) {
  if (!t.name || !t.description) fail(`tool ${t.name || '?'} is missing a name/description`);
  if (!Array.isArray(t.patterns)) fail(`tool ${t.name} has no patterns array`);
  if (typeof t.run !== 'function') fail(`tool ${t.name} has no run()`);
  if (t.parameters?.required?.some((r) => !(r in (t.parameters.properties || {})))) fail(`tool ${t.name}: required arg missing from properties`);
}
if (TOOLS.length < 20) fail(`expected at least 20 tools, found ${TOOLS.length}`);
else notes.push(`${TOOLS.length} tools registered`);

/* 6 ── gateways are sane */
const { GATEWAY_CATALOG } = await import('../js/gateways.js');
const keyless = GATEWAY_CATALOG.filter((g) => g.keyless && !g.local);
if (keyless.length < 4) fail(`expected at least 4 keyless remote gateways, found ${keyless.length}`);
else notes.push(`${keyless.length} keyless gateways + ${GATEWAY_CATALOG.filter((g) => g.local).length} local bridges`);
for (const g of GATEWAY_CATALOG) {
  if (!/^https?:\/\//.test(g.base)) fail(`gateway ${g.id} has an odd base url: ${g.base}`);
  if (!g.models?.length) fail(`gateway ${g.id} has no models`);
}

/* 7 ── no stray debug logging in shipped modules */
for (const file of jsFiles.filter((f) => f.startsWith('js/'))) {
  const src = await read(file);
  if (/^\s*console\.log\(/m.test(src)) fail(`${file} contains console.log (use console.info/warn or remove)`);
}

/* report */
console.log('\n🥦 Plus Ultra Puppet — project lint\n');
for (const n of notes) console.log(`  • ${n}`);
if (problems.length) {
  console.error(`\n  ❌ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`     - ${p}`);
  process.exit(1);
}
console.log('  ✅ no missing files, ids, imports or art parts\n');
