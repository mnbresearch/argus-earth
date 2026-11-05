// Cloudflare Worker relay — free tier is plenty. Deploy: `npx wrangler deploy worker/cloudflare-worker.mjs --name argus-relay`
// Then set the relay URL in ARGUS Settings to https://argus-relay.<you>.workers.dev/api
import { parseRoute, relay, CORS } from '../relay/core.mjs';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const out = await relay(parseRoute(url.pathname, url.searchParams));
    return new Response(out.body, { status: out.status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=5' } });
  },
};
