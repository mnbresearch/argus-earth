export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('argus:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('argus:' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable — feature degrades gracefully */
    }
  },
};

export async function fetchJSON(url, { timeout = 20000, ...opts } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function timeAgo(t) {
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 0) return 'in ' + timeAgo(Date.now() + s * 1000).replace(' ago', '');
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtNum(n, d = 0) {
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function toast(msg, kind = 'info', ms = 3800) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/** Entities -> GeoJSON FeatureCollection. */
export function toGeoJSON(entities) {
  return {
    type: 'FeatureCollection',
    generated: new Date().toISOString(),
    generator: 'ARGUS Earth',
    features: entities.map((e) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: e.altM ? [e.lon, e.lat, Math.round(e.altM)] : [e.lon, e.lat] },
      properties: { uid: e.uid, kind: e.kind, name: e.name, time: e.time ?? null, ...flat(e.props) },
    })),
  };
}

export function toCSV(entities) {
  const cols = ['uid', 'kind', 'name', 'lat', 'lon', 'alt_m', 'time', 'details'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entities.map((e) =>
    [e.uid, e.kind, e.name, e.lat?.toFixed(5), e.lon?.toFixed(5), e.altM ? Math.round(e.altM) : '', e.time ?? '', JSON.stringify(flat(e.props))]
      .map(q)
      .join(','),
  );
  return [cols.join(','), ...rows].join('\n');
}

function flat(props = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props)) if (v != null && typeof v !== 'object') out[k] = v;
  return out;
}
