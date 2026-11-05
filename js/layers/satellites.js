/* global Cesium, satellite */
// Satellites propagated in-browser with SGP4 (satellite.js) from CelesTrak OMM elements.
import { Layer } from './base.js';
import { fetchJSON, store } from '../core/util.js';
import { subsolarPoint, EARTH_RADIUS_KM } from '../core/geo.js';

export const SAT_GROUPS = {
  visual: 'Brightest (naked-eye)',
  stations: 'Space stations',
  'gps-ops': 'GPS constellation',
  weather: 'Weather satellites',
  resource: 'Earth observation',
  starlink: 'Starlink (≈ thousands)',
};

const CACHE_MS = 2 * 3600 * 1000; // CelesTrak asks clients not to re-download a group more than every 2 h.

export async function fetchGroup(group) {
  const key = 'omm:' + group;
  const cached = store.get(key);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.data;
  const data = await celestrak(`GROUP=${encodeURIComponent(group)}`);
  if (Array.isArray(data) && data.length < 3000) store.set(key, { t: Date.now(), data });
  return data;
}

export async function fetchByCatnr(catnr) {
  const key = 'omm:cat:' + catnr;
  const cached = store.get(key);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.data;
  const data = await celestrak(`CATNR=${catnr}`);
  store.set(key, { t: Date.now(), data });
  return data;
}

export async function fetchByName(name) {
  return celestrak(`NAME=${encodeURIComponent(name)}`);
}

// Direct from CelesTrak first; if it refuses (CORS error page / rate limit), fall back to the relay's 2-hour cache.
let relayBase = () => '';
export function setRelayResolver(fn) {
  relayBase = fn;
}
async function celestrak(query) {
  try {
    return await fetchJSON(`https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`, { timeout: 30000 });
  } catch (err) {
    const relay = relayBase();
    if (!relay) throw err;
    return fetchJSON(`${relay}/gp?${query}`, { timeout: 30000 });
  }
}

/** Propagate a satrec to geodetic lat/lon/alt at a date. */
export function propagateGeo(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  return {
    lat: satellite.degreesLat(gd.latitude),
    lon: satellite.degreesLong(gd.longitude),
    altM: gd.height * 1000,
    speedKms: v ? Math.hypot(v.x, v.y, v.z) : null,
    ecf: satellite.eciToEcf(pv.position, gmst),
  };
}

export function ommToEntity(omm, kind = 'satellite') {
  let satrec;
  try {
    satrec = satellite.json2satrec(omm);
  } catch {
    return null;
  }
  if (!satrec || satrec.error) return null;
  return {
    uid: 'sat:' + omm.NORAD_CAT_ID,
    kind,
    name: omm.OBJECT_NAME,
    lat: 0,
    lon: 0,
    altM: 0,
    time: omm.EPOCH,
    url: `https://celestrak.org/satcat/table-satcat.php?CATNR=${omm.NORAD_CAT_ID}`,
    satrec,
    props: {
      noradId: omm.NORAD_CAT_ID,
      intlDesignator: omm.OBJECT_ID,
      periodMin: +(1440 / omm.MEAN_MOTION).toFixed(1),
      inclinationDeg: omm.INCLINATION,
      eccentricity: omm.ECCENTRICITY,
      elementEpoch: omm.EPOCH,
      altitudeKm: null,
      speedKms: null,
    },
  };
}

function updatePos(e, date) {
  const g = propagateGeo(e.satrec, date);
  if (!g) return false;
  e.lat = g.lat;
  e.lon = g.lon;
  e.altM = g.altM;
  e.props.altitudeKm = Math.round(g.altM / 1000);
  e.props.speedKms = g.speedKms ? +g.speedKms.toFixed(2) : null;
  return true;
}

export class SatellitesLayer extends Layer {
  constructor(app) {
    super(app, { id: 'satellites', name: 'Satellites', color: '#b18cff', refreshMs: 0, defaultOn: true, source: 'CelesTrak OMM · SGP4 in your browser' });
    this.groups = store.get('satGroups', ['visual', 'stations']);
    this._prim = new Map();
    this._tick = null;
  }

  async enable() {
    await super.enable();
    clearInterval(this._tick);
    this._tick = setInterval(() => this.propagateAll(), this.items.length > 2500 ? 2000 : 1000);
  }
  disable() {
    super.disable();
    clearInterval(this._tick);
  }

  async setGroups(groups) {
    this.groups = groups;
    store.set('satGroups', groups);
    if (this.enabled) {
      this.disable();
      await this.enable();
    }
  }

  async load() {
    const lists = await Promise.allSettled(this.groups.map(fetchGroup));
    const seen = new Map();
    for (const r of lists) {
      if (r.status !== 'fulfilled') continue;
      for (const omm of r.value) {
        if (seen.has(omm.NORAD_CAT_ID)) continue;
        const e = ommToEntity(omm);
        if (e) seen.set(omm.NORAD_CAT_ID, e);
      }
    }
    if (!seen.size) throw new Error(lists.find((r) => r.status === 'rejected')?.reason?.message || 'No satellites');
    const now = new Date();
    return [...seen.values()].filter((e) => updatePos(e, now));
  }

  render() {
    this.points.removeAll();
    this.labels.removeAll();
    this._prim.clear();
    const big = this.items.length > 1500;
    for (const e of this.items) {
      const position = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.altM);
      const pt = this.points.add({
        id: e,
        position,
        pixelSize: big ? 3 : 5,
        color: Cesium.Color.fromCssColorString(e.name.includes('ISS') ? '#ffffff' : this.color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: big ? 0 : 1,
      });
      const lb = big
        ? null
        : this.labels.add({
            id: e,
            position,
            text: e.name,
            font: '11px "JetBrains Mono", ui-monospace, monospace',
            fillColor: Cesium.Color.fromCssColorString(this.color),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(8, -6),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4.5e6),
          });
      this._prim.set(e.uid, { pt, lb });
    }
  }

  propagateAll() {
    if (!this.enabled) return;
    const now = new Date();
    for (const e of this.items) {
      if (!updatePos(e, now)) continue;
      const r = this._prim.get(e.uid);
      if (!r) continue;
      const p = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.altM);
      r.pt.position = p;
      if (r.lb) r.lb.position = p;
    }
    this.app.emit('tick', this);
  }
}

/** Dedicated ISS layer: always-on icon, live orbit ribbon and ground track. */
export class IssLayer extends Layer {
  constructor(app) {
    super(app, { id: 'iss', name: 'ISS + orbit', color: '#ffffff', refreshMs: 0, defaultOn: true, source: 'CelesTrak · NORAD 25544, SGP4' });
    this._tick = null;
    this._orbit = null;
  }
  async load() {
    const [omm] = await fetchByCatnr(25544);
    const e = ommToEntity(omm, 'satellite');
    e.name = 'ISS (ZARYA)';
    updatePos(e, new Date());
    return [e];
  }
  async enable() {
    await super.enable();
    clearInterval(this._tick);
    this._tick = setInterval(() => this.update(), 1000);
  }
  disable() {
    super.disable();
    clearInterval(this._tick);
    if (this._orbit) this.app.viewer.entities.remove(this._orbit);
    this._orbit = null;
  }
  render() {
    super.render();
    this.drawOrbit();
  }
  styleFor() {
    return { color: '#ffffff', size: 12, label: '◆ ISS', labelFar: 3e7, scaleByDistance: new Cesium.NearFarScalar(1e6, 1.4, 4e7, 0.9) };
  }
  update() {
    const e = this.items[0];
    if (!e || !this.enabled) return;
    updatePos(e, new Date());
    const p = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.altM);
    if (this.points.length) this.points.get(0).position = p;
    if (this.labels.length) this.labels.get(0).position = p;
    if (Date.now() - (this._orbitAt || 0) > 60000) this.drawOrbit();
    this.app.emit('tick', this);
  }
  drawOrbit() {
    const e = this.items[0];
    if (!e) return;
    const positions = orbitPositions(e.satrec, new Date(Date.now() - 10 * 60000), e.props.periodMin * 1.0);
    if (this._orbit) this.app.viewer.entities.remove(this._orbit);
    this._orbit = this.app.viewer.entities.add({
      polyline: {
        positions,
        width: 1.6,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.15, color: Cesium.Color.WHITE.withAlpha(0.65) }),
      },
    });
    this._orbitAt = Date.now();
  }
}

export function orbitPositions(satrec, start, minutes, stepSec = 30) {
  const out = [];
  for (let s = 0; s <= minutes * 60; s += stepSec) {
    const g = propagateGeo(satrec, new Date(start.getTime() + s * 1000));
    if (g) out.push(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.altM));
  }
  return out;
}

/** Predict passes over an observer for the next `hours`. */
export function predictPasses(satrec, obs, { hours = 48, minElevationDeg = 10, max = 6 } = {}) {
  const observerGd = {
    latitude: Cesium.Math.toRadians(obs.lat),
    longitude: Cesium.Math.toRadians(obs.lon),
    height: (obs.altM || 0) / 1000,
  };
  const elevAt = (date) => {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return { el: -90 };
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    return { el: Cesium.Math.toDegrees(look.elevation), az: Cesium.Math.toDegrees(look.azimuth), ecf };
  };
  const passes = [];
  const t0 = Date.now();
  const step = 30000;
  let inPass = null;
  for (let t = t0; t < t0 + hours * 3.6e6 && passes.length < max; t += step) {
    const d = new Date(t);
    const s = elevAt(d);
    if (s.el > 0 && !inPass) inPass = { rise: d, riseAz: s.az, peak: d, peakEl: s.el, peakEcf: s.ecf };
    if (inPass && s.el > inPass.peakEl) Object.assign(inPass, { peak: d, peakEl: s.el, peakEcf: s.ecf, peakAz: s.az });
    if (inPass && s.el <= 0) {
      inPass.set = d;
      inPass.setAz = s.az;
      if (inPass.peakEl >= minElevationDeg) {
        inPass.visible = isVisibleSighting(obs, inPass.peak, inPass.peakEcf);
        passes.push(inPass);
      }
      inPass = null;
    }
  }
  return passes;
}

/** Naked-eye visibility: observer in darkness (sun < −6°) and satellite outside Earth's shadow. */
export function isVisibleSighting(obs, date, satEcf) {
  const sun = subsolarPoint(date);
  const toRad = Math.PI / 180;
  const sunDir = {
    x: Math.cos(sun.lat * toRad) * Math.cos(sun.lon * toRad),
    y: Math.cos(sun.lat * toRad) * Math.sin(sun.lon * toRad),
    z: Math.sin(sun.lat * toRad),
  };
  const o = { x: Math.cos(obs.lat * toRad) * Math.cos(obs.lon * toRad), y: Math.cos(obs.lat * toRad) * Math.sin(obs.lon * toRad), z: Math.sin(obs.lat * toRad) };
  const sunElev = 90 - Math.acos(o.x * sunDir.x + o.y * sunDir.y + o.z * sunDir.z) / toRad;
  if (sunElev > -6 || !satEcf) return false;
  const dot = satEcf.x * sunDir.x + satEcf.y * sunDir.y + satEcf.z * sunDir.z;
  if (dot > 0) return true;
  const perp = Math.hypot(satEcf.x - dot * sunDir.x, satEcf.y - dot * sunDir.y, satEcf.z - dot * sunDir.z);
  return perp > EARTH_RADIUS_KM;
}
