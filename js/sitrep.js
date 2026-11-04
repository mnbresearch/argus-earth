// One-click situation report (SITREP) for the area in view — plain-text/Markdown, copy or download.
import { fetchJSON, fmtNum, timeAgo } from './core/util.js';
import { haversineKm, bearingDeg, compass, formatLatLon, isDaylight, elevationDeg } from './core/geo.js';

const WMO = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle',
  55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow',
  73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'heavy showers', 82: 'violent showers', 85: 'snow showers',
  86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

export async function buildSitrep(app, center, radiusKm) {
  const { lat, lon } = center;
  const near = (layerId) =>
    app.layers[layerId].enabled
      ? app.layers[layerId]
          .visible()
          .map((e) => ({ e, d: haversineKm(lat, lon, e.lat, e.lon) }))
          .filter((x) => x.d <= radiusKm)
          .sort((a, b) => a.d - b.d)
      : null;
  const where = (x) => `${fmtNum(x.d)} km ${compass(bearingDeg(lat, lon, x.e.lat, x.e.lon))}`;

  let wx = null;
  try {
    wx = await fetchJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover,visibility&timezone=auto`,
      { timeout: 8000 },
    );
  } catch {
    /* weather optional */
  }
  let place = null;
  try {
    const r = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=8&lat=${lat}&lon=${lon}`, { timeout: 6000 });
    place = r.display_name ? r.display_name.split(',').slice(-3).join(',').trim() : null;
  } catch {
    /* offline / ocean */
  }

  const L = [];
  const now = new Date();
  L.push(`SITREP · ARGUS EARTH`);
  L.push(`DTG     ${now.toISOString().replace('T', ' ').slice(0, 16)}Z`);
  L.push(`AOI     ${formatLatLon(lat, lon)}${place ? ` (${place})` : ''} · radius ${radiusKm} km`);
  if (wx?.current) {
    const c = wx.current;
    const local = new Date(Date.now() + (wx.utc_offset_seconds || 0) * 1000).toISOString().slice(11, 16);
    L.push(`LOCAL   ${local} (${wx.timezone_abbreviation || wx.timezone}) · ${isDaylight(lat, lon) ? 'daylight' : 'night'}`);
    L.push(
      `WX      ${WMO[c.weather_code] || 'code ' + c.weather_code}, ${c.temperature_2m}°C, RH ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h from ${compass(c.wind_direction_10m)} (gusts ${c.wind_gusts_10m}), cloud ${c.cloud_cover}%, vis ${c.visibility != null ? fmtNum(c.visibility / 1000, 1) + ' km' : 'n/a'}`,
    );
  } else L.push(`LOCAL   ${isDaylight(lat, lon) ? 'daylight' : 'night'} at AOI center`);
  L.push('');

  const findings = [];
  const sections = [];

  const ac = near('aircraft');
  const mil = near('military');
  if (ac) {
    const emerg = ac.filter((x) => x.e.props.emergency);
    const airborne = ac.filter((x) => x.e.props.altitudeFt !== 'ground');
    const hi = [...airborne].sort((a, b) => b.e.altM - a.e.altM)[0];
    const s = [`AIR     ${ac.length} ADS-B contacts (${airborne.length} airborne)`];
    if (hi) s.push(`        highest: ${hi.e.name} at ${fmtNum(hi.e.altM / 0.3048)} ft, ${where(hi)}`);
    ac.slice(0, 5).forEach((x) => s.push(`        · ${x.e.name.padEnd(9)} ${String(x.e.props.type || '').padEnd(5)} ${x.e.props.altitudeFt === 'ground' ? 'GND' : fmtNum(x.e.props.altitudeFt) + ' ft'} ${where(x)}`));
    emerg.forEach((x) => s.push(`        !! ${x.e.name} squawk ${x.e.props.squawk} ${x.e.props.emergency} — ${where(x)}`));
    if (emerg.length) findings.push(`${emerg.length} aircraft squawking emergency`);
    if (ac.length) findings.push(`${ac.length} aircraft in AOI`);
    sections.push(s.join('\n'));
  } else if (app.layers.aircraft.status === 'error') sections.push(`AIR     feed unavailable (${app.layers.aircraft.error})`);
  if (mil && mil.length) {
    sections.push([`MIL     ${mil.length} military-flagged aircraft`, ...mil.slice(0, 5).map((x) => `        · ${x.e.name} ${x.e.props.type || ''} ${where(x)}`)].join('\n'));
    findings.push(`${mil.length} military aircraft`);
  }

  const q = near('quakes');
  if (q) {
    const strongest = [...q].sort((a, b) => b.e.props.mag - a.e.props.mag)[0];
    const day = q.filter((x) => Date.now() - new Date(x.e.time) < 86400000);
    const s = [`SEISMIC ${q.length} M2.5+ quakes in 7 days (${day.length} in last 24 h)`];
    if (strongest) {
      s.push(`        strongest: M${strongest.e.props.mag} ${strongest.e.props.place}, depth ${fmtNum(strongest.e.props.depthKm)} km, ${timeAgo(strongest.e.time)}`);
      if (strongest.e.props.mag >= 5) findings.push(`M${strongest.e.props.mag} quake ${timeAgo(strongest.e.time)}`);
    }
    sections.push(s.join('\n'));
  }

  const ev = near('events');
  if (ev && ev.length) {
    sections.push([`HAZARD  ${ev.length} open NASA EONET events`, ...ev.slice(0, 6).map((x) => `        · ${x.e.props.category}: ${x.e.name} — ${where(x)}`)].join('\n'));
    findings.push(`${ev.length} natural-hazard events`);
  }
  const gd = near('disasters');
  if (gd && gd.length) {
    sections.push([`GDACS   ${gd.length} disaster alerts`, ...gd.slice(0, 6).map((x) => `        · ${x.e.props.alertLevel.toUpperCase()} ${x.e.props.type}: ${x.e.name} — ${where(x)}`)].join('\n'));
    const red = gd.filter((x) => x.e.props.alertLevel === 'Red').length;
    if (red) findings.push(`${red} RED disaster alert${red > 1 ? 's' : ''}`);
  }
  const ln = near('launches');
  if (ln && ln.length) {
    sections.push([`SPACE   ${ln.length} upcoming launches from pads in AOI`, ...ln.slice(0, 4).map((x) => `        · ${x.e.name} — NET ${new Date(x.e.time).toUTCString().slice(5, 22)}Z (${x.e.props.status})`)].join('\n'));
  }

  const sats = [...(app.layers.satellites.enabled ? app.layers.satellites.items : []), ...(app.layers.iss.enabled ? app.layers.iss.items : [])];
  if (sats.length) {
    const overhead = sats
      .map((e) => ({ e, el: elevationDeg(haversineKm(lat, lon, e.lat, e.lon), e.altM / 1000) }))
      .filter((x) => x.el > 10)
      .sort((a, b) => b.el - a.el);
    sections.push([`ORBIT   ${overhead.length} tracked satellites >10° above the horizon now`, ...overhead.slice(0, 5).map((x) => `        · ${x.e.name} el ${x.el.toFixed(0)}°, alt ${fmtNum(x.e.altM / 1000)} km`)].join('\n'));
  }

  const zones = app.zones.filter((z) => haversineKm(lat, lon, z.lat, z.lon) <= radiusKm + z.radiusKm);
  if (zones.length) sections.push([`ZONES   ${zones.length} watch zone(s) overlap AOI`, ...zones.map((z) => `        · ${z.name} (${z.radiusKm} km)`)].join('\n'));

  const stale = Object.values(app.layers).filter((l) => l.enabled && l.status !== 'ok');
  L.unshift(`BLUF: ${findings.length ? findings.slice(0, 4).join('; ') : 'No significant activity detected in loaded feeds'} within ${radiusKm} km of ${place || formatLatLon(lat, lon, 1)}.`, '');
  L.push(...sections.flatMap((s) => [s, '']));
  L.push(`SOURCES ${Object.values(app.layers).filter((l) => l.enabled).map((l) => `${l.id}${l.lastUpdate ? ' (' + timeAgo(l.lastUpdate) + ')' : ''}`).join(', ')}`);
  if (stale.length) L.push(`CAVEAT  degraded feeds: ${stale.map((l) => `${l.id}=${l.status}`).join(', ')}`);
  L.push(`NOTE    Open public data; positions may be delayed, filtered or incomplete. Not for safety-of-life decisions.`);
  return L.join('\n');
}
