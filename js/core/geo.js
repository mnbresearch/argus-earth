// Pure geodesy helpers (no Cesium dependency) — unit-tested in tests/.
export const EARTH_RADIUS_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees (0 = north, clockwise). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached travelling distanceKm from (lat, lon) on a bearing. */
export function destination(lat, lon, bearing, distanceKm) {
  const d = distanceKm / EARTH_RADIUS_KM;
  const b = toRad(bearing);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

export function compass(bearing) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

export function formatLatLon(lat, lon, digits = 3) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}°${ns} ${Math.abs(lon).toFixed(digits)}°${ew}`;
}

/** Parse "lat, lon", "lat lon" or "geo:lat,lon". Returns null if not coordinates. */
export function parseCoordinates(text) {
  if (!text) return null;
  const m = String(text)
    .trim()
    .replace(/^geo:/i, '')
    .match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Sub-solar point, used for day/night stats in SITREPs. */
export function subsolarPoint(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = toRad((357.528 + 0.9856003 * n) % 360);
  const lambda = toRad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = toRad(23.439 - 0.0000004 * n);
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  let lon = toDeg(ra) - gmst * 15;
  lon = ((lon + 540) % 360) - 180;
  return { lat: toDeg(decl), lon };
}

export function isDaylight(lat, lon, date = new Date()) {
  const s = subsolarPoint(date);
  return haversineKm(lat, lon, s.lat, s.lon) < (Math.PI / 2) * EARTH_RADIUS_KM;
}

/** Elevation (deg) of an object at altKm seen from a ground point groundKm away (spherical Earth). */
export function elevationDeg(groundKm, altKm) {
  const R = EARTH_RADIUS_KM;
  const th = groundKm / R;
  return (Math.atan2(Math.cos(th) - R / (R + altKm), Math.sin(th)) * 180) / Math.PI;
}
