#!/usr/bin/env node
/**
 * Tiny zero-dependency static dev server for Plus Ultra Puppet.
 * Binds 0.0.0.0 so the Arena live preview (and your phone on the same Wi-Fi) can reach it.
 *
 *   npm run dev            # http://0.0.0.0:5173
 *   PORT=8080 npm run dev
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = join(root, rel);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let target = safeJoin(ROOT, req.url || '/');
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(target).catch(() => null);
    if (info && info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info) {
      // SPA fallback for deep links like /#settings
      const fallback = join(ROOT, 'index.html');
      const body = await readFile(fallback);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(body);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    }).end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🥦 Plus Ultra Puppet is alive!`);
  console.log(`  local:   http://localhost:${PORT}`);
  console.log(`  network: http://${HOST}:${PORT}  (open this on your phone, same Wi-Fi)\n`);
  console.log(`  Permissions tip: camera + mic need https or localhost.`);
});
