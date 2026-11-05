/* global Cesium */
// Live ADS-B aircraft via a tiny relay (server.mjs, Vercel function, or Cloudflare Worker),
// because community ADS-B APIs do not send CORS headers. Positions are dead-reckoned between polls.
import { Layer } from './base.js';
import { fetchJSON } from '../core/util.js';
import { destination } from '../core/geo.js';

const EMERGENCY = { '7500': 'HIJACK', '7600': 'RADIO FAILURE', '7700': 'EMERGENCY' };

function planeIcon(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.translate(16, 16);
  g.fillStyle = color;
  g.strokeStyle = 'rgba(0,0,0,.75)';
  g.lineWidth = 1.5;
  g.beginPath();
  // Simple top-down airliner silhouette pointing up (north).
  g.moveTo(0, -14);
  g.lineTo(2.2, -6);
  g.lineTo(13, 1);
  g.lineTo(13, 4);
  g.lineTo(2.2, 0.5);
  g.lineTo(1.8, 9);
  g.lineTo(5.5, 12);
  g.lineTo(5.5, 14);
  g.lineTo(0, 12.5);
  g.lineTo(-5.5, 14);
  g.lineTo(-5.5, 12);
  g.lineTo(-1.8, 9);
  g.lineTo(-2.2, 0.5);
  g.lineTo(-13, 4);
  g.lineTo(-13, 1);
  g.lineTo(-2.2, -6);
  g.closePath();
  g.fill();
  g.stroke();
  return c;
}

export function normalizeAircraft(a, kind) {
  if (a.lat == null || a.lon == null) return null;
  const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : 0;
  const callsign = (a.flight || '').trim();
  const squawk = a.squawk || null;
  return {
    uid: 'ac:' + a.hex,
    kind,
    name: callsign || a.r || a.hex.toUpperCase(),
    lat: a.lat,
    lon: a.lon,
    altM: altFt * 0.3048,
    time: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(),
    url: `https://globe.adsb.lol/?icao=${a.hex}`,
    props: {
      callsign: callsign || null,
      icao24: a.hex,
      registration: a.r || null,
      type: a.t || null,
      description: a.desc || null,
      operator: a.ownOp || null,
      altitudeFt: a.alt_baro === 'ground' ? 'ground' : altFt,
      groundSpeedKt: a.gs ?? null,
      trackDeg: a.track ?? a.true_heading ?? null,
      verticalRateFpm: a.baro_rate ?? a.geom_rate ?? null,
      squawk,
      emergency: EMERGENCY[squawk] || (a.emergency && a.emergency !== 'none' ? a.emergency.toUpperCase() : null),
      category: a.category || null,
    },
  };
}

export class AircraftLayer extends Layer {
  constructor(app, opts = {}) {
    super(app, {
      id: opts.id || 'aircraft',
      name: opts.name || 'Aircraft (ADS-B)',
      color: opts.color || '#3ee0ff',
      refreshMs: opts.refreshMs || 10000,
      defaultOn: opts.defaultOn ?? true,
      source: opts.source || 'adsb.lol / adsb.fi community ADS-B · 250 nm around view',
    });
    this.kind = opts.kind || 'aircraft';
    this.icons = {
      normal: planeIcon(this.color),
      emergency: planeIcon('#ff2d55'),
    };
    this._bb = new Map();
    this._tick = null;
  }

  async enable() {
    await super.enable();
    clearInterval(this._tick);
    this._tick = setInterval(() => this.deadReckon(), 1000);
  }
  disable() {
    super.disable();
    clearInterval(this._tick);
  }

  url() {
    const relay = this.app.relayBase();
    if (!relay) throw new Error('No ADS-B relay configured — run `node server.mjs` or set a relay in Settings');
    const c = this.app.viewCenter();
    return `${relay}/aircraft?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}&dist=250`;
  }

  async load() {
    const d = await fetchJSON(this.url(), { timeout: 15000 });
    const list = d.ac || d.aircraft || [];
    return list.map((a) => normalizeAircraft(a, this.kind)).filter(Boolean);
  }

  render() {
    this.points.removeAll();
    this.labels.removeAll();
    this.billboards.removeAll();
    this._bb.clear();
    const now = Date.now();
    for (const e of this.visible()) {
      e._base = { lat: e.lat, lon: e.lon, t: new Date(e.time).getTime() || now };
      const emergency = !!e.props.emergency;
      const pos = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.altM);
      const bb = this.billboards.add({
        id: e,
        position: pos,
        image: emergency ? this.icons.emergency : this.icons.normal,
        rotation: -Cesium.Math.toRadians(e.props.trackDeg || 0),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        scale: emergency ? 0.95 : 0.65,
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.4, 8e6, 0.35),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      const lb = this.labels.add({
        id: e,
        position: pos,
        text: emergency ? `${e.name} · ${e.props.emergency}` : e.name,
        font: '11px "JetBrains Mono", ui-monospace, monospace',
        fillColor: emergency ? Cesium.Color.fromCssColorString('#ff2d55') : Cesium.Color.fromCssColorString(this.color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, -8),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, emergency ? 2e7 : 6e5),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      this._bb.set(e.uid, { bb, lb });
    }
  }

  deadReckon() {
    if (!this.enabled) return;
    const now = Date.now();
    for (const e of this.visible()) {
      const r = this._bb.get(e.uid);
      if (!r || !e._base || !e.props.groundSpeedKt || e.props.altitudeFt === 'ground') continue;
      const dt = Math.min(60, (now - e._base.t) / 1000);
      const km = (e.props.groundSpeedKt * 1.852 * dt) / 3600;
      const p = destination(e._base.lat, e._base.lon, e.props.trackDeg || 0, km);
      e.lat = p.lat;
      e.lon = p.lon;
      const pos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, e.altM);
      r.bb.position = pos;
      r.lb.position = pos;
    }
    this.app.emit('tick', this);
  }
}

export class MilitaryLayer extends AircraftLayer {
  constructor(app) {
    super(app, {
      id: 'military',
      kind: 'military',
      name: 'Military aircraft (global)',
      color: '#ffcc33',
      refreshMs: 30000,
      defaultOn: false,
      source: 'adsb.lol military feed · worldwide, unfiltered by view',
    });
  }
  url() {
    const relay = this.app.relayBase();
    if (!relay) throw new Error('No ADS-B relay configured');
    return `${relay}/mil`;
  }
}
