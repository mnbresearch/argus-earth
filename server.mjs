#!/usr/bin/env node
// Zero-dependency local server: serves the app and the ADS-B relay at /api/*.
//   node server.mjs            → http://localhost:8080
//   PORT=3000 node server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoute, relay, CORS } from './relay/core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
    const out = await relay(parseRoute(url.pathname, url.searchParams));
    res.writeHead(out.status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(out.stale ? { 'X-Argus-Stale': '1' } : {}) });
    return res.end(out.body);
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || /[/\\]\.(git|env)/.test(file)) return res.writeHead(403).end('Forbidden');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, HOST, () => console.log(`\n  ARGUS Earth → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n  ADS-B relay → /api/aircraft · /api/mil · /api/callsign/:cs\n`));
