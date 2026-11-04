// Shared ADS-B relay logic (Node server, Vercel function, Cloudflare Worker).
// Community ADS-B APIs don't send CORS headers, so the browser app talks to this tiny relay.
const UPSTREAMS = {
  aircraft: ({ lat, lon, dist }) => [
    `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
  ],
  mil: () => ['https://api.adsb.lol/v2/mil'],
  gp: ({ query }) => [`https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`],
  callsign: ({ callsign }) => [`https://api.adsb.lol/v2/callsign/${callsign}`, `https://opendata.adsb.fi/api/v2/callsign/${callsign}`],
};

const cache = new Map();
const TTL = { aircraft: 5000, mil: 20000, callsign: 8000, gp: 2 * 3600 * 1000 };

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Parse "/api/aircraft?lat=..", "/aircraft", "/api/callsign/UAL1" into a route. */
export function parseRoute(pathname, searchParams) {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter((p) => p && p !== 'api');
  const name = parts[0];
  if (name === 'aircraft') {
    if (searchParams.get('lat') == null || searchParams.get('lon') == null) return { error: 'lat and lon are required' };
    const lat = clamp(Number(searchParams.get('lat')), -90, 90);
    const lon = clamp(Number(searchParams.get('lon')), -180, 180);
    const dist = clamp(Math.round(Number(searchParams.get('dist')) || 250), 1, 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'lat and lon are required' };
    return { name, params: { lat: lat.toFixed(2), lon: lon.toFixed(2), dist } };
  }
  if (name === 'mil') return { name, params: {} };
  if (name === 'callsign') {
    const callsign = String(parts[1] || searchParams.get('callsign') || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(callsign)) return { error: 'invalid callsign' };
    return { name, params: { callsign } };
  }
  if (name === 'gp') {
    // CelesTrak orbital elements, cached 2 h to respect CelesTrak's download policy.
    const k = ['GROUP', 'CATNR', 'NAME'].find((p) => searchParams.get(p));
    const v = k && searchParams.get(k);
    if (!k || !/^[A-Za-z0-9 ._()-]{1,40}$/.test(v)) return { error: 'GROUP, CATNR or NAME required' };
    return { name, params: { query: `${k}=${encodeURIComponent(v)}` } };
  }
  if (name === 'health') return { name };
  return { error: 'unknown route' };
}

function clamp(n, a, b) {
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : NaN;
}

export async function relay(route, { fetchImpl = fetch } = {}) {
  if (route.error) return { status: 400, body: JSON.stringify({ error: route.error }) };
  if (route.name === 'health') return { status: 200, body: JSON.stringify({ ok: true, service: 'argus-relay' }) };
  const key = route.name + JSON.stringify(route.params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL[route.name]) return { status: 200, body: hit.body, cached: true };
  let lastErr = 'no upstream';
  for (const url of UPSTREAMS[route.name](route.params)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'argus-earth-relay/1.0 (+https://github.com/mnbresearch/argus-earth)', Accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `${new URL(url).host} HTTP ${res.status}`;
        continue;
      }
      const body = await res.text();
      cache.set(key, { t: Date.now(), body });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return { status: 200, body };
    } catch (e) {
      lastErr = `${new URL(url).host} ${e.name === 'AbortError' ? 'timeout' : e.message}`;
    }
  }
  if (hit) return { status: 200, body: hit.body, stale: true };
  return { status: 502, body: JSON.stringify({ error: 'upstream failed: ' + lastErr }) };
}
