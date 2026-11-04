// Shared Vercel handler — api/aircraft.js, api/mil.js and api/callsign/[cs].js re-export it.
import { parseRoute, relay, CORS } from './core.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const out = await relay(parseRoute(path, url.searchParams));
  res.writeHead(out.status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=5, stale-while-revalidate=10' });
  res.end(out.body);
}
