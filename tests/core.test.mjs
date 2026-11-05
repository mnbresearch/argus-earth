import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, bearingDeg, destination, parseCoordinates, compass, elevationDeg, isDaylight } from '../js/core/geo.js';
import { parseCommand, resolveLayer } from '../js/core/command.js';
import { parseRoute, relay } from '../relay/core.mjs';

test('haversine: Delhi → Mumbai ≈ 1150 km', () => {
  const d = haversineKm(28.6139, 77.209, 19.076, 72.8777);
  assert.ok(Math.abs(d - 1153) < 15, String(d));
});

test('bearing + destination round-trip', () => {
  const p = destination(10, 20, 45, 500);
  assert.ok(Math.abs(haversineKm(10, 20, p.lat, p.lon) - 500) < 0.5);
  assert.ok(Math.abs(bearingDeg(10, 20, p.lat, p.lon) - 45) < 0.5);
  assert.equal(compass(44), 'NE');
});

test('coordinate parsing', () => {
  assert.deepEqual(parseCoordinates('28.61, 77.21'), { lat: 28.61, lon: 77.21 });
  assert.deepEqual(parseCoordinates('geo:39.7392,-104.9903'), { lat: 39.7392, lon: -104.9903 });
  assert.equal(parseCoordinates('tokyo'), null);
  assert.equal(parseCoordinates('95, 10'), null);
});

test('elevation: object straight overhead is 90°, far away is below horizon', () => {
  assert.ok(Math.abs(elevationDeg(0, 400) - 90) < 0.01);
  assert.ok(elevationDeg(5000, 400) < 0);
});

test('daylight: sub-solar side is lit', () => {
  const noonUtcEquinox = new Date('2026-03-20T12:00:00Z');
  assert.equal(isDaylight(0, 0, noonUtcEquinox), true);
  assert.equal(isDaylight(0, 180, noonUtcEquinox), false);
});

test('command grammar', () => {
  assert.deepEqual(parseCommand('fly to Tokyo'), { action: 'fly', place: 'Tokyo' });
  assert.deepEqual(parseCommand('28.6, 77.2'), { action: 'fly', lat: 28.6, lon: 77.2 });
  assert.deepEqual(parseCommand('track ISS'), { action: 'track', target: 'iss' });
  assert.deepEqual(parseCommand('hide planes'), { action: 'layer', layer: 'aircraft', on: false });
  assert.deepEqual(parseCommand('show earthquakes'), { action: 'layer', layer: 'quakes', on: true });
  assert.deepEqual(parseCommand('quakes above 5.5'), { action: 'filterQuakes', minMag: 5.5 });
  assert.deepEqual(parseCommand('zone 200 km around delhi'), { action: 'zone', radiusKm: 200, place: 'delhi' });
  assert.deepEqual(parseCommand('watch zone'), { action: 'zone', radiusKm: 150, place: null });
  assert.deepEqual(parseCommand('passes iss'), { action: 'passes', target: 'iss' });
  assert.deepEqual(parseCommand('thermal'), { action: 'mode', mode: 'flir' });
  assert.deepEqual(parseCommand('night vision mode'), { action: 'mode', mode: 'nvg' });
  assert.deepEqual(parseCommand('how many planes are here?'), { action: 'count', layer: 'aircraft' });
  assert.deepEqual(parseCommand('nearest quake'), { action: 'nearest', layer: 'quakes' });
  assert.deepEqual(parseCommand('strongest earthquake'), { action: 'extreme', layer: 'quakes', by: 'mag' });
  assert.deepEqual(parseCommand('export csv'), { action: 'export', format: 'csv' });
  assert.deepEqual(parseCommand('SITREP'), { action: 'sitrep' });
  assert.deepEqual(parseCommand('stop'), { action: 'untrack' });
  assert.deepEqual(parseCommand('Kathmandu'), { action: 'fly', place: 'Kathmandu' });
  assert.equal(resolveLayer('wildfires'), 'events');
});

test('relay route parsing and validation', () => {
  const sp = (s) => new URLSearchParams(s);
  assert.deepEqual(parseRoute('/api/aircraft', sp('lat=28.6&lon=77.2&dist=900')), { name: 'aircraft', params: { lat: '28.60', lon: '77.20', dist: 250 } });
  assert.ok(parseRoute('/api/aircraft', sp('')).error);
  assert.deepEqual(parseRoute('/api/callsign/ual123', sp('')), { name: 'callsign', params: { callsign: 'UAL123' } });
  assert.ok(parseRoute('/api/callsign/../../etc', sp('')).error);
  assert.equal(parseRoute('/mil', sp('')).name, 'mil');
  assert.ok(parseRoute('/api/whatever', sp('')).error);
});

test('relay falls back to second upstream and caches', async () => {
  let calls = 0;
  const fake = async (url) => {
    calls++;
    if (url.includes('adsb.lol')) return { ok: false, status: 503 };
    return { ok: true, status: 200, text: async () => '{"ac":[]}' };
  };
  const route = parseRoute('/api/aircraft', new URLSearchParams('lat=1&lon=2'));
  const a = await relay(route, { fetchImpl: fake });
  assert.equal(a.status, 200);
  assert.equal(a.body, '{"ac":[]}');
  const b = await relay(route, { fetchImpl: fake });
  assert.equal(b.cached, true);
  assert.equal(calls, 2);
});
