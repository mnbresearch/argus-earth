/* global Cesium */
// Keyless, CORS-friendly public feeds: USGS, NASA EONET, GDACS, Launch Library 2.
import { Layer } from './base.js';
import { fetchJSON } from '../core/util.js';

const QUAKE_DEPTH_COLORS = [
  [70, '#ff4d4f'], // shallow
  [300, '#ffb020'], // intermediate
  [Infinity, '#ffe066'], // deep
];

export class QuakesLayer extends Layer {
  constructor(app) {
    super(app, { id: 'quakes', name: 'Earthquakes', color: '#ff4d4f', refreshMs: 120000, defaultOn: true, source: 'USGS · M2.5+ past 7 days' });
    this.minMag = 0;
    this.timeCursor = null; // Date | null — set by Time Machine
    this.filter = (e) =>
      e.props.mag >= this.minMag &&
      (!this.timeCursor || (new Date(e.time) <= this.timeCursor && new Date(e.time) > this.timeCursor - 3 * 86400000));
  }
  async load() {
    const d = await fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson');
    return d.features.map((f) => ({
      uid: 'eq:' + f.id,
      kind: 'quake',
      name: f.properties.title,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      altM: 0,
      time: new Date(f.properties.time).toISOString(),
      url: f.properties.url,
      props: {
        mag: f.properties.mag,
        depthKm: f.geometry.coordinates[2],
        place: f.properties.place,
        tsunami: f.properties.tsunami ? 'yes' : 'no',
        felt: f.properties.felt,
        alert: f.properties.alert,
        significance: f.properties.sig,
      },
    }));
  }
  styleFor(e) {
    const color = QUAKE_DEPTH_COLORS.find(([d]) => e.props.depthKm <= d)[1];
    const ageH = (Date.now() - new Date(e.time)) / 3.6e6;
    return {
      color: ageH < 24 && !this.timeCursor ? color : color + 'b0',
      size: Math.max(5, (e.props.mag - 1.5) * 4.2),
      label: e.props.mag >= 5 ? `M${e.props.mag.toFixed(1)}` : null,
      labelFar: 1.2e7,
    };
  }
}

const EONET_COLORS = {
  wildfires: '#ff7a1a',
  severeStorms: '#9b8cff',
  volcanoes: '#ff3d71',
  seaLakeIce: '#7fd8ff',
  floods: '#3fa7ff',
  landslides: '#c9a26b',
  dustHaze: '#d8c690',
  drought: '#e0b84c',
  snow: '#e8f4ff',
  tempExtremes: '#ff5ac8',
  earthquakes: '#ff4d4f',
  manmade: '#aaaaaa',
  waterColor: '#2fd6c3',
};

export class EventsLayer extends Layer {
  constructor(app) {
    super(app, { id: 'events', name: 'NASA natural events', color: '#ff7a1a', refreshMs: 600000, defaultOn: true, source: 'NASA EONET · open events, 30 days' });
  }
  async load() {
    const d = await fetchJSON('https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30');
    const latest = new Map();
    for (const f of d.features) {
      const p = f.properties;
      let lon, lat;
      if (f.geometry.type === 'Point') [lon, lat] = f.geometry.coordinates;
      else if (f.geometry.type === 'Polygon') {
        const ring = f.geometry.coordinates[0];
        lon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
        lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      } else continue;
      const prev = latest.get(p.id);
      if (prev && new Date(prev.time) > new Date(p.date)) continue;
      const cat = p.categories?.[0] || {};
      latest.set(p.id, {
        uid: 'eo:' + p.id,
        kind: 'event',
        name: p.title,
        lat,
        lon,
        altM: 0,
        time: p.date,
        url: p.sources?.[0]?.url || p.link,
        props: { category: cat.title, categoryId: cat.id, magnitude: p.magnitudeValue ? `${p.magnitudeValue} ${p.magnitudeUnit || ''}`.trim() : null },
      });
    }
    return [...latest.values()];
  }
  styleFor(e) {
    return { color: EONET_COLORS[e.props.categoryId] || this.color, size: 9, label: null };
  }
}

const GDACS_LEVEL = { Red: '#ff2d55', Orange: '#ff9f0a', Green: '#30d158' };
const GDACS_TYPE = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', WF: 'Wildfire', DR: 'Drought', TS: 'Tsunami' };

export class DisastersLayer extends Layer {
  constructor(app) {
    super(app, { id: 'disasters', name: 'GDACS disaster alerts', color: '#ff9f0a', refreshMs: 900000, defaultOn: true, source: 'UN/EC GDACS · current alerts' });
  }
  async load() {
    const d = await fetchJSON('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;WF;DR&alertlevel=Green;Orange;Red');
    return d.features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        const p = f.properties;
        return {
          uid: `gd:${p.eventtype}:${p.eventid}`,
          kind: 'disaster',
          name: p.name,
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          altM: 0,
          time: p.fromdate + 'Z',
          url: p.url?.report,
          props: {
            type: GDACS_TYPE[p.eventtype] || p.eventtype,
            alertLevel: p.alertlevel,
            country: p.country,
            severity: p.severitydata?.severitytext,
            until: p.todate,
            current: p.iscurrent,
          },
        };
      });
  }
  styleFor(e) {
    const lvl = e.props.alertLevel;
    return {
      color: GDACS_LEVEL[lvl] || this.color,
      size: lvl === 'Red' ? 18 : lvl === 'Orange' ? 14 : 10,
      label: lvl === 'Green' ? null : `${lvl.toUpperCase()} · ${e.props.type}`,
      labelFar: 1.5e7,
    };
  }
}

export class LaunchesLayer extends Layer {
  constructor(app) {
    super(app, { id: 'launches', name: 'Upcoming launches', color: '#64d2ff', refreshMs: 1800000, source: 'The Space Devs · Launch Library 2' });
  }
  async load() {
    const d = await fetchJSON('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30');
    return d.results
      .filter((r) => r.pad?.latitude && r.pad?.longitude)
      .map((r) => ({
        uid: 'ln:' + r.id,
        kind: 'launch',
        name: r.name,
        lat: Number(r.pad.latitude),
        lon: Number(r.pad.longitude),
        altM: 0,
        time: r.net,
        url: r.url ? `https://thespacedevs.com/llapi?launch=${r.id}` : null,
        props: {
          status: r.status?.name,
          provider: r.launch_service_provider?.name,
          rocket: r.rocket?.configuration?.full_name,
          pad: r.pad?.name,
          site: r.pad?.location?.name,
          mission: r.mission?.name,
          orbit: r.mission?.orbit?.name,
        },
      }));
  }
  styleFor(e) {
    const soon = new Date(e.time) - Date.now() < 48 * 3.6e6;
    return { color: soon ? '#64d2ff' : '#64d2ff99', size: soon ? 13 : 9, label: soon ? '🚀 ' + e.name.split('|')[0].trim() : null, labelFar: 8e6 };
  }
}
