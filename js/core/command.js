// Natural-ish command grammar shared by the command bar and keyless voice control.
// parseCommand() is pure and unit-tested; the app maps the result to actions.
import { parseCoordinates } from './geo.js';

export const LAYER_ALIASES = {
  aircraft: ['aircraft', 'planes', 'plane', 'flights', 'flight', 'air', 'traffic'],
  military: ['military', 'mil', 'military aircraft'],
  satellites: ['satellites', 'satellite', 'sats', 'sat', 'orbit', 'orbits'],
  iss: ['iss', 'space station', 'station'],
  quakes: ['quakes', 'quake', 'earthquakes', 'earthquake', 'seismic'],
  events: ['events', 'nasa', 'eonet', 'fires', 'wildfires', 'volcanoes', 'storms', 'natural events'],
  disasters: ['disasters', 'disaster', 'gdacs', 'alerts', 'cyclones'],
  launches: ['launches', 'launch', 'rockets', 'rocket'],
};

export const MODES = ['normal', 'nvg', 'flir', 'crt', 'noir'];

export function resolveLayer(word) {
  const w = String(word || '').toLowerCase().trim();
  for (const [id, aliases] of Object.entries(LAYER_ALIASES)) if (aliases.includes(w)) return id;
  return null;
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';

/**
 * @returns {{action: string, [k: string]: any}}
 */
export function parseCommand(input) {
  const raw = String(input || '').trim();
  const t = raw.toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  if (!t) return { action: 'none' };

  const coords = parseCoordinates(raw);
  if (coords) return { action: 'fly', ...coords };

  if (/^(help|commands|\?)$/.test(t)) return { action: 'help' };
  if (/^(home|reset|reset globe|whole earth|zoom out)$/.test(t)) return { action: 'home' };
  if (/^(sitrep|brief|briefing|report|situation report|what'?s happening( here)?)$/.test(t)) return { action: 'sitrep' };
  if (/^(share|share link|copy link)$/.test(t)) return { action: 'share' };
  if (/^(stop|untrack|stop tracking|release)$/.test(t)) return { action: 'untrack' };
  if (/^(where am i|locate me|my location|find me)$/.test(t)) return { action: 'locate' };
  if (/^(spin|rotate|orbit view)$/.test(t)) return { action: 'spin' };
  if (/^(clear zones|clear fences|remove zones)$/.test(t)) return { action: 'clearZones' };

  let m;
  if ((m = t.match(/^(?:export|download|save)(?: as)? (geojson|csv)$/))) return { action: 'export', format: m[1] };
  if ((m = t.match(/^(?:export|download|save)$/))) return { action: 'export', format: 'geojson' };

  if ((m = t.match(/^(?:mode|vision|sensor|switch to|set mode)?\s*(normal|nvg|night vision|flir|thermal|crt|noir)(?: mode| vision)?$/))) {
    const map = { 'night vision': 'nvg', thermal: 'flir' };
    return { action: 'mode', mode: map[m[1]] || m[1] };
  }

  if ((m = t.match(/^(?:show|enable|turn on|layer on|on) (.+)$/))) {
    const layer = resolveLayer(m[1]);
    if (layer) return { action: 'layer', layer, on: true };
  }
  if ((m = t.match(/^(?:hide|disable|turn off|layer off|off) (.+)$/))) {
    const layer = resolveLayer(m[1]);
    if (layer) return { action: 'layer', layer, on: false };
  }

  if ((m = t.match(new RegExp(`^(?:fence|zone|watch|geofence|watch zone)(?: (?:of|radius))? ${NUM}\\s*(?:km)?(?: (?:around|at|over|on) (.+))?$`)))) {
    return { action: 'zone', radiusKm: Number(m[1]), place: m[2] || null };
  }
  if ((m = t.match(/^(?:fence|zone|watch|geofence|watch zone)(?: (?:around|at|over|on) (.+))?$/))) {
    return { action: 'zone', radiusKm: 150, place: m[1] || null };
  }

  if ((m = t.match(/^(?:passes|pass|when (?:does|will|can i see)|next pass(?: of)?)\s*(?:the )?(.+?)(?: (?:pass|rise|be visible))?(?: over me)?$/))) {
    return { action: 'passes', target: m[1].trim() };
  }

  if ((m = t.match(/^(?:track|follow|lock(?: on)?(?: to)?|find) (.+)$/))) return { action: 'track', target: m[1].trim() };

  // Analyst queries: "count quakes", "how many planes", "quakes > 5", "biggest quake", "nearest fire"
  if ((m = t.match(/^(?:count|how many) (.+?)(?: (?:are )?(?:here|nearby|in view|near me))?$/))) {
    const layer = resolveLayer(m[1]);
    if (layer) return { action: 'count', layer };
  }
  if ((m = t.match(new RegExp(`^(?:show )?(quakes|earthquakes)(?: (?:above|over|>|>=|greater than|magnitude))+ ?${NUM}$`)))) {
    return { action: 'filterQuakes', minMag: Number(m[2]) };
  }
  if ((m = t.match(/^(?:biggest|largest|strongest) (?:quake|earthquake)$/))) return { action: 'extreme', layer: 'quakes', by: 'mag' };
  if ((m = t.match(/^(?:highest|fastest) (?:plane|aircraft|flight)$/))) {
    return { action: 'extreme', layer: 'aircraft', by: t.startsWith('highest') ? 'alt' : 'speed' };
  }
  if ((m = t.match(/^(?:nearest|closest) (.+)$/))) {
    const layer = resolveLayer(m[1]);
    if (layer) return { action: 'nearest', layer };
  }
  if ((m = t.match(/^(?:time machine|replay)(?: quakes)?$/))) return { action: 'timeMachine' };

  const flyRe = /^(?:go to|goto|fly to|fly|take me to|show me|zoom to|zoom in on|navigate to) (.+)$/i;
  if ((m = raw.replace(/[?!.]+$/, '').replace(/\s+/g, ' ').match(flyRe))) {
    const c = parseCoordinates(m[1]);
    return c ? { action: 'fly', ...c } : { action: 'fly', place: m[1].trim() };
  }

  // Bare layer name toggles that layer on.
  const bare = resolveLayer(t);
  if (bare) return { action: 'layer', layer: bare, on: true };

  // Fallback: treat as a place search.
  return { action: 'fly', place: raw };
}

export const HELP = [
  ['fly to tokyo · 28.61, 77.21', 'Fly anywhere (place or coordinates)'],
  ['track iss · track UAL123', 'Lock the camera onto a satellite or flight'],
  ['show quakes · hide aircraft', 'Toggle any layer'],
  ['quakes above 5', 'Filter earthquakes by magnitude'],
  ['count planes · nearest quake', 'Analyst answers for the current view'],
  ['zone 200 km around delhi', 'Create a geofence watch zone with alerts'],
  ['passes iss', 'Next visible passes over your location'],
  ['sitrep', 'Situation report for the area in view'],
  ['flir · nvg · crt · noir · normal', 'Sensor vision modes'],
  ['export geojson · export csv', 'Download everything currently loaded'],
  ['time machine', 'Replay the last 7 days of earthquakes'],
  ['share · home · stop', 'Share link, reset globe, stop tracking'],
];
