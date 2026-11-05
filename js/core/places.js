// Keyless geocoding: bundled places first (instant, offline), then OpenStreetMap Nominatim.
import { fetchJSON } from './util.js';

export const PLACES = {
  'new delhi': [28.6139, 77.209], delhi: [28.6139, 77.209], mumbai: [19.076, 72.8777], bengaluru: [12.9716, 77.5946],
  bangalore: [12.9716, 77.5946], chennai: [13.0827, 80.2707], kolkata: [22.5726, 88.3639], hyderabad: [17.385, 78.4867],
  pune: [18.5204, 73.8567], chandigarh: [30.7333, 76.7794], 'new york': [40.7128, -74.006], nyc: [40.7128, -74.006],
  'san francisco': [37.7749, -122.4194], 'los angeles': [34.0522, -118.2437], chicago: [41.8781, -87.6298],
  washington: [38.9072, -77.0369], london: [51.5074, -0.1278], paris: [48.8566, 2.3522], berlin: [52.52, 13.405],
  moscow: [55.7558, 37.6173], kyiv: [50.4501, 30.5234], istanbul: [41.0082, 28.9784], dubai: [25.2048, 55.2708],
  riyadh: [24.7136, 46.6753], 'tel aviv': [32.0853, 34.7818], tehran: [35.6892, 51.389], cairo: [30.0444, 31.2357],
  lagos: [6.5244, 3.3792], nairobi: [-1.2921, 36.8219], johannesburg: [-26.2041, 28.0473], tokyo: [35.6762, 139.6503],
  seoul: [37.5665, 126.978], beijing: [39.9042, 116.4074], shanghai: [31.2304, 121.4737], 'hong kong': [22.3193, 114.1694],
  taipei: [25.033, 121.5654], singapore: [1.3521, 103.8198], jakarta: [-6.2088, 106.8456], manila: [14.5995, 120.9842],
  bangkok: [13.7563, 100.5018], sydney: [-33.8688, 151.2093], melbourne: [-37.8136, 144.9631], auckland: [-36.8485, 174.7633],
  'sao paulo': [-23.5505, -46.6333], 'rio de janeiro': [-22.9068, -43.1729], 'buenos aires': [-34.6037, -58.3816],
  'mexico city': [19.4326, -99.1332], toronto: [43.6532, -79.3832], vancouver: [49.2827, -123.1207],
  'cape canaveral': [28.3922, -80.6077], baikonur: [45.965, 63.305], sriharikota: [13.72, 80.23], 'mount everest': [27.9881, 86.925],
  everest: [27.9881, 86.925], 'strait of hormuz': [26.566, 56.25], 'panama canal': [9.08, -79.68], 'suez canal': [30.58, 32.27],
  'english channel': [50.2, -1.0], 'taiwan strait': [24.5, 119.5], 'san andreas fault': [35.5, -120.0], iceland: [64.9, -18.6],
  hawaii: [19.9, -155.6], 'ring of fire': [20, 150], antarctica: [-82, 0], arctic: [85, 0],
};

export async function geocode(query) {
  const q = String(query || '').toLowerCase().trim().replace(/^the /, '');
  if (PLACES[q]) return { lat: PLACES[q][0], lon: PLACES[q][1], name: titleCase(q), spanKm: 60 };
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const r = await fetchJSON(url, { headers: { Accept: 'application/json' } });
  if (!r.length) return null;
  const b = r[0].boundingbox?.map(Number);
  const spanKm = b ? Math.max(Math.abs(b[1] - b[0]), Math.abs(b[3] - b[2]) * Math.cos((Number(r[0].lat) * Math.PI) / 180)) * 111 : 50;
  return { lat: Number(r[0].lat), lon: Number(r[0].lon), name: r[0].display_name.split(',').slice(0, 2).join(','), spanKm };
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
