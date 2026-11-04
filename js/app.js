/* global Cesium */
import { store, esc, timeAgo, fmtNum, toast, download, toGeoJSON, toCSV, fetchJSON } from './core/util.js';
import { haversineKm, bearingDeg, compass, formatLatLon, isDaylight } from './core/geo.js';
import { parseCommand, HELP } from './core/command.js';
import { createSensorController } from './core/sensors.js';
import { geocode } from './core/places.js';
import { QuakesLayer, EventsLayer, DisastersLayer, LaunchesLayer } from './layers/feeds.js';
import { AircraftLayer, MilitaryLayer, normalizeAircraft } from './layers/aircraft.js';
import { SatellitesLayer, IssLayer, SAT_GROUPS, predictPasses, propagateGeo, orbitPositions, fetchByName, ommToEntity, setRelayResolver } from './layers/satellites.js';
import { buildSitrep } from './sitrep.js';

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.listeners = {};
    this.settings = { relayUrl: '', ionToken: '', googleKey: '', photoreal: false, voiceReplies: true, ...store.get('settings', {}) };
    this.selected = null;
    this.tracked = null;
    this.pendingTrackUid = null;
    this.alerts = [];
    this.alertSeen = new Set();
    this.zones = store.get('zones', []);
    this.zoneState = new Map();
    this.zoneEntities = new Map();
    this.placingZone = false;
    this.startedAt = Date.now();
  }

  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  emit(ev, payload) {
    for (const fn of this.listeners[ev] || []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------------------------------------------------------------- setup
  async init() {
    if (typeof Cesium === 'undefined') {
      document.body.innerHTML = '<p style="padding:24px">Could not load CesiumJS from the CDN. Check your connection or ad-blocker and reload.</p>';
      return;
    }
    const esri = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: new Cesium.Credit('Imagery © Esri, Maxar, Earthstar Geographics', false),
    });
    const viewerOpts = {
      baseLayer: new Cesium.ImageryLayer(esri),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: false,
      msaaSamples: 4,
    };
    if (this.settings.ionToken) Cesium.Ion.defaultAccessToken = this.settings.ionToken;
    this.viewer = new Cesium.Viewer('globe', viewerOpts);
    const v = this.viewer;
    v.scene.globe.enableLighting = true;
    v.scene.globe.dynamicAtmosphereLighting = true;
    v.scene.globe.showGroundAtmosphere = true;
    v.scene.skyAtmosphere.show = true;
    v.scene.fog.enabled = true;
    v.clock.shouldAnimate = true;
    v.clock.multiplier = 1;
    v.clock.currentTime = Cesium.JulianDate.now();
    v.scene.screenSpaceCameraController.minimumZoomDistance = 50;
    this.sensors = createSensorController(v);
    setRelayResolver(() => this.relayBase());

    this.layers = {
      aircraft: new AircraftLayer(this),
      military: new MilitaryLayer(this),
      satellites: new SatellitesLayer(this),
      iss: new IssLayer(this),
      quakes: new QuakesLayer(this),
      events: new EventsLayer(this),
      disasters: new DisastersLayer(this),
      launches: new LaunchesLayer(this),
    };

    this.applyTerrainAndTiles();
    this.buildSelectionMarker();
    this.bindGlobeInput();
    this.bindUI();
    this.on('layers', () => this.renderLayerList());
    this.on('data', (layer) => this.onData(layer));
    v.scene.preRender.addEventListener(() => this.followTick());
    v.camera.moveEnd.addEventListener(() => this.onMoveEnd());
    setInterval(() => this.updateClock(), 1000);

    const fromHash = this.restoreFromHash();
    if (!fromHash.camera) this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(78, 20, 2.2e7) });
    const initial = fromHash.layers || store.get('layersOn', null) || Object.values(this.layers).filter((l) => l.defaultOn).map((l) => l.id);
    this.renderLayerList();
    this.zones.forEach((z) => this.drawZone(z));
    this.renderZones();
    if (!store.get('welcomed') && !location.hash) $('#welcome').hidden = false;
    window.argus = this; // handy for the console and automated tests
    await Promise.all(initial.filter((id) => this.layers[id]).map((id) => this.layers[id].enable()));
  }

  async applyTerrainAndTiles() {
    const v = this.viewer;
    try {
      if (this.settings.ionToken) {
        Cesium.Ion.defaultAccessToken = this.settings.ionToken;
        v.scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
      }
      if (this.tileset) {
        v.scene.primitives.remove(this.tileset);
        this.tileset = null;
        v.scene.globe.show = true;
      }
      if (this.settings.photoreal && (this.settings.googleKey || this.settings.ionToken)) {
        if (this.settings.googleKey) Cesium.GoogleMaps.defaultApiKey = this.settings.googleKey;
        this.tileset = await Cesium.createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true });
        v.scene.primitives.add(this.tileset);
        v.scene.globe.show = false;
        toast('Photorealistic 3D tiles enabled');
      }
    } catch (e) {
      console.warn(e);
      toast('Could not enable 3D terrain/tiles: ' + e.message, 'warn');
    }
  }

  relayBase() {
    const s = (this.settings.relayUrl || window.ARGUS_CONFIG?.relay || '').trim().replace(/\/$/, '');
    if (s) return s;
    if (/^https?:$/.test(location.protocol) && !location.hostname.endsWith('github.io')) return `${location.origin}/api`;
    return '';
  }

  // ---------------------------------------------------------------- camera helpers
  viewCenter() {
    const v = this.viewer;
    const c = v.scene.canvas;
    const cart = v.camera.pickEllipsoid(new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2));
    const carto = cart ? Cesium.Cartographic.fromCartesian(cart) : v.camera.positionCartographic;
    return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
  }
  cameraHeightKm() {
    return this.viewer.camera.positionCartographic.height / 1000;
  }
  viewRadiusKm() {
    return Math.max(40, Math.min(1500, this.cameraHeightKm() * 0.6));
  }
  flyTo(lat, lon, heightKm = 400, duration = 2.2) {
    this.untrack(true);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightKm * 1000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration,
    });
  }
  home(duration = 2) {
    this.untrack(true);
    const c = this.viewCenter();
    this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(Number.isFinite(c.lon) ? c.lon : 78, 20, 2.2e7), duration });
  }

  livePosition(e) {
    if (!e) return null;
    if (e.satrec) {
      const g = propagateGeo(e.satrec, new Date());
      if (g) return { lat: g.lat, lon: g.lon, altM: g.altM };
    }
    return { lat: e.lat, lon: e.lon, altM: e.altM || 0 };
  }

  // ---------------------------------------------------------------- selection & tracking
  buildSelectionMarker() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.strokeStyle = '#ffcc33';
    g.lineWidth = 3;
    const s = 14;
    for (const [x, y, dx, dy] of [[4, 4, 1, 1], [60, 4, -1, 1], [4, 60, 1, -1], [60, 60, -1, -1]]) {
      g.beginPath();
      g.moveTo(x + dx * s, y);
      g.lineTo(x, y);
      g.lineTo(x, y + dy * s);
      g.stroke();
    }
    const Prop = Cesium.CallbackPositionProperty || Cesium.CallbackProperty;
    this.selMarker = this.viewer.entities.add({
      position: new Prop(() => {
        const p = this.livePosition(this.selected);
        return p ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM) : undefined;
      }, false),
      billboard: { image: c, scale: 0.6, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      show: false,
    });
  }

  select(e) {
    this.selected = e;
    this.selMarker.show = !!e;
    if (this.orbitEntity) {
      this.viewer.entities.remove(this.orbitEntity);
      this.orbitEntity = null;
    }
    if (e?.satrec && e.uid !== 'sat:25544') {
      this.orbitEntity = this.viewer.entities.add({
        polyline: {
          positions: orbitPositions(e.satrec, new Date(), e.props.periodMin || 95, 40),
          width: 1.4,
          material: Cesium.Color.fromCssColorString('#b18cff').withAlpha(0.7),
        },
      });
    }
    this.renderInspector();
    if (e && window.innerWidth <= 860) this.openDrawer('rightPanel');
  }

  track(e) {
    if (!e) return;
    this.select(e);
    this.tracked = e;
    const p = this.livePosition(e);
    const range = e.satrec ? 1800e3 : e.kind === 'aircraft' || e.kind === 'military' ? 60e3 : 300e3;
    this._trackRange = range;
    this.viewer.camera.lookAt(
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM),
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(e.satrec ? -60 : -35), range),
    );
    this.renderInspector();
    this.reply(`Tracking ${e.name}. Say “stop” to release.`);
  }

  untrack(silent) {
    if (!this.tracked) return;
    this.tracked = null;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (!silent) this.reply('Tracking released.');
    this.renderInspector();
  }

  followTick() {
    const e = this.tracked;
    if (!e) return;
    const p = this.livePosition(e);
    if (!p) return;
    const cam = this.viewer.camera;
    const target = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM);
    const range = Cesium.Cartesian3.magnitude(cam.position) || this._trackRange;
    cam.lookAt(target, new Cesium.HeadingPitchRange(cam.heading, cam.pitch, range));
  }

  resolveEntity(uid) {
    for (const l of Object.values(this.layers)) {
      const e = l.find(uid);
      if (e) return e;
    }
    return null;
  }

  onData(layer) {
    // Re-bind selection/tracking to fresh objects after a refresh.
    if (this.selected && this.selected.uid) {
      const fresh = layer.find(this.selected.uid);
      if (fresh && fresh !== this.selected) {
        if (this.tracked === this.selected) this.tracked = fresh;
        this.selected = fresh;
        this.renderInspector();
      }
    }
    if (this.pendingTrackUid) {
      const e = layer.find(this.pendingTrackUid);
      if (e) {
        this.pendingTrackUid = null;
        this.track(e);
      }
    }
    this.checkWatchRules(layer);
    this.checkZones(layer);
    this.renderHudFeeds();
  }

  // ---------------------------------------------------------------- input
  bindGlobeInput() {
    const v = this.viewer;
    const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    h.setInputAction((ev) => {
      if (this.placingZone) {
        const cart = v.camera.pickEllipsoid(ev.position);
        if (cart) {
          const c = Cesium.Cartographic.fromCartesian(cart);
          this.addZone(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude), this._placingRadius || 150);
        }
        this.setPlacing(false);
        return;
      }
      const picked = v.scene.pick(ev.position);
      const e = picked?.id;
      if (e && e.uid) this.select(e);
      else if (e instanceof Cesium.Entity && e.id?.startsWith('zone:')) this.flyToZone(e.id.slice(5));
      else this.select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction((ev) => {
      const picked = v.scene.pick(ev.position);
      if (picked?.id?.uid) this.track(picked.id);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    let last = 0;
    h.setInputAction((ev) => {
      const now = performance.now();
      if (now - last < 60) return;
      last = now;
      const cart = v.camera.pickEllipsoid(ev.endPosition);
      if (!cart) return ($('#hudCursor').textContent = 'CURSOR —');
      const c = Cesium.Cartographic.fromCartesian(cart);
      $('#hudCursor').textContent = 'CURSOR ' + formatLatLon(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude));
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    v.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  bindUI() {
    $('#cmdForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const t = $('#cmd').value;
      $('#cmd').value = '';
      $('#cmd').blur();
      this.run(t);
    });
    document.addEventListener('keydown', (ev) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if (ev.key === 'Escape') {
        this.setPlacing(false);
        if (typing) document.activeElement.blur();
      }
      if (typing) return;
      if (ev.key === '/' || (ev.key === 'k' && (ev.metaKey || ev.ctrlKey))) {
        ev.preventDefault();
        $('#cmd').focus();
      } else if (ev.key === 'v' || ev.key === 'V') this.listen();
      else if (ev.key === 'h' || ev.key === 'H') this.home();
      else if (ev.key === '?') this.showHelp();
    });
    $('#micBtn').addEventListener('click', () => this.listen());
    $('#sitrepBtn').addEventListener('click', () => this.sitrep());
    $('#shareBtn').addEventListener('click', () => this.share());
    $('#helpBtn').addEventListener('click', () => this.showHelp());
    $('#settingsBtn').addEventListener('click', () => this.showSettings());
    $('#zoneBtn').addEventListener('click', () => this.setPlacing(!this.placingZone));
    $('#timeBtn').addEventListener('click', () => this.timeMachine(true));
    $('#exportGeo').addEventListener('click', () => this.export('geojson'));
    $('#exportCsv').addEventListener('click', () => this.export('csv'));
    $('#locateBtn').addEventListener('click', () => this.locate());
    $('#homeBtn').addEventListener('click', () => this.home());
    $('#notifyBtn').addEventListener('click', async () => {
      if (!('Notification' in window)) return toast('Desktop notifications are not supported in this browser', 'warn');
      const p = await Notification.requestPermission();
      toast(p === 'granted' ? 'Desktop alerts on' : 'Desktop alerts blocked', p === 'granted' ? 'info' : 'warn');
    });
    $('#sensorSeg').addEventListener('click', (ev) => {
      const m = ev.target.closest('button')?.dataset.mode;
      if (m) this.setMode(m);
    });
    $('#welcomeGo').addEventListener('click', () => this.closeWelcome());
    $('#welcome').addEventListener('click', (ev) => {
      const cmd = ev.target.closest('[data-cmd]')?.dataset.cmd;
      if (cmd) {
        this.closeWelcome();
        this.run(cmd);
      }
    });
    // Time machine
    $('#tmRange').addEventListener('input', () => this.setTimeCursor(Number($('#tmRange').value)));
    $('#tmPlay').addEventListener('click', () => this.toggleTimePlay());
    $('#tmClose').addEventListener('click', () => this.timeMachine(false));
    // Mobile drawers
    const tabs = document.createElement('div');
    tabs.className = 'mobile-tabs';
    tabs.innerHTML = '<button class="btn" data-d="leftPanel">Layers</button><button class="btn" data-d="rightPanel">Intel <span class="badge" id="alertCount2" data-n="0">0</span></button>';
    document.body.appendChild(tabs);
    tabs.addEventListener('click', (ev) => {
      const d = ev.target.closest('[data-d]')?.dataset.d;
      if (d) this.openDrawer(d, true);
    });
  }

  openDrawer(id, toggle) {
    const el = document.getElementById(id);
    const willOpen = toggle ? !el.classList.contains('open') : true;
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('open'));
    el.classList.toggle('open', willOpen);
    document.body.classList.toggle('panel-open', willOpen);
  }

  closeWelcome() {
    $('#welcome').hidden = true;
    store.set('welcomed', true);
  }

  // ---------------------------------------------------------------- commands
  reply(text, speak = true) {
    const el = $('#cmdReply');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._replyT);
    this._replyT = setTimeout(() => el.classList.remove('show'), 6000);
    if (speak && this._voiceTurn && this.settings.voiceReplies && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/[◆·]/g, ',')));
    }
  }

  async run(text, fromVoice = false) {
    this._voiceTurn = fromVoice;
    const c = parseCommand(text);
    try {
      switch (c.action) {
        case 'none':
          return;
        case 'help':
          return this.showHelp();
        case 'home':
          this.home();
          return this.reply('Whole Earth.');
        case 'sitrep':
          return this.sitrep();
        case 'share':
          return this.share();
        case 'untrack':
          return this.untrack();
        case 'locate':
          return this.locate();
        case 'clearZones':
          [...this.zones].forEach((z) => this.removeZone(z.id));
          return this.reply('All watch zones removed.');
        case 'spin':
          this.untrack(true);
          this._spin = !this._spin;
          if (this._spin) {
            this._spinFn = () => this.viewer.scene.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0012);
            this.viewer.scene.postRender.addEventListener(this._spinFn);
          } else this.viewer.scene.postRender.removeEventListener(this._spinFn);
          return this.reply(this._spin ? 'Orbiting. Say “spin” again to stop.' : 'Rotation stopped.');
        case 'export':
          return this.export(c.format);
        case 'mode':
          this.setMode(c.mode);
          return this.reply(`${c.mode.toUpperCase()} vision.`);
        case 'layer':
          return this.setLayer(c.layer, c.on);
        case 'timeMachine':
          return this.timeMachine(true);
        case 'filterQuakes': {
          const q = this.layers.quakes;
          q.minMag = c.minMag;
          if (!q.enabled) await q.enable();
          else q.render();
          this.renderLayerList();
          const n = q.visible().length;
          const top = [...q.visible()].sort((a, b) => b.props.mag - a.props.mag)[0];
          if (top) this.flyTo(top.lat, top.lon, 6000);
          return this.reply(`${n} earthquakes M${c.minMag}+ in the past 7 days${top ? ` — strongest: ${top.name}` : ''}.`);
        }
        case 'count':
          return this.countLayer(c.layer);
        case 'nearest':
          return this.nearest(c.layer);
        case 'extreme':
          return this.extreme(c.layer, c.by);
        case 'zone': {
          let lat, lon, name;
          if (c.place) {
            const g = await geocode(c.place);
            if (!g) return this.reply(`Couldn’t find “${c.place}”.`);
            ({ lat, lon } = g);
            name = g.name;
          } else ({ lat, lon } = this.viewCenter());
          this.addZone(lat, lon, c.radiusKm, name);
          this.flyTo(lat, lon, Math.max(200, c.radiusKm * 4));
          return;
        }
        case 'passes':
          return this.passes(c.target);
        case 'track':
          return this.trackByName(c.target);
        case 'fly': {
          if (Number.isFinite(c.lat)) {
            this.flyTo(c.lat, c.lon, 250);
            return this.reply(`Flying to ${formatLatLon(c.lat, c.lon)}.`);
          }
          this.reply(`Searching “${c.place}”…`, false);
          const g = await geocode(c.place);
          if (!g) return this.reply(`No place found for “${c.place}”. Try “help”.`);
          this.flyTo(g.lat, g.lon, Math.max(25, Math.min(6000, g.spanKm * 2.2)));
          return this.reply(`Flying to ${g.name}.`);
        }
      }
    } catch (e) {
      console.error(e);
      this.reply('Something went wrong: ' + e.message);
    }
  }

  async setLayer(id, on) {
    const l = this.layers[id];
    if (!l) return;
    if (on) await l.enable();
    else l.disable();
    store.set('layersOn', Object.values(this.layers).filter((x) => x.enabled).map((x) => x.id));
    this.reply(`${l.name} ${on ? 'on' : 'off'}${on && l.status === 'error' ? ` — feed error: ${l.error}` : ''}.`);
  }

  setMode(m) {
    const mode = this.sensors.set(m);
    document.querySelectorAll('#sensorSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  }

  inView(layerId, radiusKm = this.viewRadiusKm()) {
    const c = this.viewCenter();
    const l = this.layers[layerId];
    return l.visible().filter((e) => haversineKm(c.lat, c.lon, e.lat, e.lon) <= radiusKm);
  }

  async countLayer(id) {
    const l = this.layers[id];
    if (!l.enabled) await l.enable();
    const r = Math.round(this.viewRadiusKm());
    const n = this.inView(id).length;
    const stale = l.status !== 'ok' ? ` (feed ${l.status})` : '';
    this.reply(`${n} ${l.name.toLowerCase()} within ${r} km of view center; ${l.visible().length} loaded in total${stale}.`);
  }

  async nearest(id) {
    const l = this.layers[id];
    if (!l.enabled) await l.enable();
    const c = this.viewCenter();
    let best = null;
    let bd = Infinity;
    for (const e of l.visible()) {
      const d = haversineKm(c.lat, c.lon, e.lat, e.lon);
      if (d < bd) [best, bd] = [e, d];
    }
    if (!best) return this.reply(`No ${l.name.toLowerCase()} loaded.`);
    this.select(best);
    this.flyTo(best.lat, best.lon, Math.max(80, Math.min(3000, bd * 1.5)));
    this.reply(`Nearest: ${best.name} — ${fmtNum(bd)} km ${compass(bearingDeg(c.lat, c.lon, best.lat, best.lon))}.`);
  }

  async extreme(id, by) {
    const l = this.layers[id];
    if (!l.enabled) await l.enable();
    const key = { mag: (e) => e.props.mag, alt: (e) => e.altM, speed: (e) => e.props.groundSpeedKt || 0 }[by];
    const best = [...l.visible()].sort((a, b) => key(b) - key(a))[0];
    if (!best) return this.reply('Nothing loaded yet.');
    this.select(best);
    this.flyTo(best.lat, best.lon, id === 'quakes' ? 1500 : 120);
    const v = by === 'mag' ? `M${best.props.mag}` : by === 'alt' ? `${fmtNum(best.altM / 0.3048)} ft` : `${fmtNum(best.props.groundSpeedKt)} kt`;
    this.reply(`${best.name}: ${v}.`);
  }

  async trackByName(target) {
    const q = target.toLowerCase().replace(/^the /, '');
    if (/^(iss|space station|international space station)$/.test(q)) {
      if (!this.layers.iss.enabled) await this.layers.iss.enable();
      return this.track(this.layers.iss.items[0]);
    }
    const match = (e) =>
      [e.name, e.props?.callsign, e.props?.registration, e.props?.icao24, String(e.props?.noradId || '')].some(
        (s) => s && String(s).toLowerCase().replace(/\s+/g, '') === q.replace(/\s+/g, ''),
      );
    const loose = (e) => e.name && e.name.toLowerCase().includes(q);
    for (const pass of [match, loose]) {
      for (const l of Object.values(this.layers)) {
        const e = l.items.find(pass);
        if (e) {
          if (!l.enabled) await l.enable();
          return e.kind === 'quake' || e.kind === 'event' || e.kind === 'disaster' || e.kind === 'launch'
            ? (this.select(e), this.flyTo(e.lat, e.lon, 800), this.reply(`Found ${e.name}.`))
            : this.track(e);
        }
      }
    }
    // Global flight lookup by callsign through the relay.
    const relay = this.relayBase();
    if (relay && /^[a-z0-9]{3,8}$/i.test(q)) {
      try {
        const d = await fetchJSON(`${relay}/callsign/${encodeURIComponent(q.toUpperCase())}`);
        const a = (d.ac || [])[0];
        if (a) {
          const e = normalizeAircraft(a, 'aircraft');
          this.pendingTrackUid = e.uid;
          if (!this.layers.aircraft.enabled) await this.layers.aircraft.enable();
          this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 300e3) });
          this.layers.aircraft.refresh();
          return this.reply(`Found ${e.name} over ${formatLatLon(e.lat, e.lon, 1)} — locking on…`);
        }
      } catch (err) {
        console.warn(err);
      }
    }
    // Satellite lookup by name on CelesTrak.
    try {
      const list = await fetchByName(target);
      if (Array.isArray(list) && list.length) {
        const e = ommToEntity(list[0]);
        const sl = this.layers.satellites;
        if (!sl.enabled) await sl.enable();
        if (!sl.find(e.uid)) {
          sl.items.push(e);
          sl.render();
        }
        return this.track(sl.find(e.uid));
      }
    } catch (err) {
      console.warn(err);
    }
    this.reply(`Couldn’t find “${target}” in any loaded layer.`);
  }

  async locate() {
    if (!navigator.geolocation) return this.reply('Geolocation unavailable.');
    this.reply('Locating…', false);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.me = { lat: p.coords.latitude, lon: p.coords.longitude };
        this.flyTo(this.me.lat, this.me.lon, 300);
        this.reply(`You are at ${formatLatLon(this.me.lat, this.me.lon, 2)}.`);
      },
      () => this.reply('Location permission denied — using the view center instead.'),
      { timeout: 10000 },
    );
  }

  // ---------------------------------------------------------------- satellite passes
  async passes(target) {
    const q = target.toLowerCase().replace(/^the /, '');
    let e = null;
    if (/^(iss|space station)$/.test(q)) {
      if (!this.layers.iss.enabled) await this.layers.iss.enable();
      e = this.layers.iss.items[0];
    } else {
      e = [...this.layers.satellites.items, ...this.layers.iss.items].find((s) => s.name.toLowerCase().includes(q));
      if (!e) {
        const list = await fetchByName(target).catch(() => []);
        if (list?.length) e = ommToEntity(list[0]);
      }
    }
    if (!e) return this.reply(`No satellite matching “${target}”.`);
    const obs = this.me || this.viewCenter();
    const list = predictPasses(e.satrec, obs, { hours: 72, max: 8 });
    $('#passesSection').hidden = false;
    $('#passesTitle').textContent = `· ${e.name} over ${this.me ? 'you' : formatLatLon(obs.lat, obs.lon, 1)}`;
    $('#passList').innerHTML = list.length
      ? list
          .map(
            (p) => `<li><b>${p.rise.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</b>
              → ${p.set.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              · max ${p.peakEl.toFixed(0)}° · ${compass(p.riseAz)}→${compass(p.setAz)}
              ${p.visible ? '<span class="vis">· VISIBLE</span>' : '<span class="muted">· not naked-eye</span>'}</li>`,
          )
          .join('')
      : '<li class="muted">No passes above 10° in the next 72 h.</li>';
    if (window.innerWidth <= 860) this.openDrawer('rightPanel');
    const vis = list.find((p) => p.visible);
    this.reply(
      list.length
        ? `${list.length} passes of ${e.name} in 72 h. Next: ${list[0].rise.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, max ${list[0].peakEl.toFixed(0)}°.${vis ? ` Next naked-eye sighting: ${vis.rise.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}`
        : `No good passes of ${e.name} in the next 72 hours.`,
    );
  }

  // ---------------------------------------------------------------- alerts & zones
  pushAlert({ id, level = 'info', title, entity }) {
    if (this.alertSeen.has(id)) return;
    this.alertSeen.add(id);
    this.alerts.unshift({ id, level, title, uid: entity?.uid, lat: entity?.lat, lon: entity?.lon, t: new Date() });
    this.alerts = this.alerts.slice(0, 120);
    this.renderAlerts();
    if (level === 'red' || level === 'amber') toast(title, 'alert', 6000);
    if (level !== 'info' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        new Notification('ARGUS alert', { body: title });
      } catch {
        /* ignore */
      }
    }
  }

  checkWatchRules(layer) {
    const fresh = Date.now() - this.startedAt < 1000 * 60 * 0.5;
    if (layer.id === 'aircraft' || layer.id === 'military') {
      for (const e of layer.items) if (e.props.emergency) this.pushAlert({ id: 'sq:' + e.uid + e.props.squawk, level: 'red', title: `✈ ${e.name} squawking ${e.props.squawk || ''} ${e.props.emergency}`, entity: e });
    }
    if (layer.id === 'quakes') {
      for (const e of layer.items) {
        const ageH = (Date.now() - new Date(e.time)) / 3.6e6;
        if (e.props.mag >= 5.5 && ageH < (fresh ? 24 : 6)) this.pushAlert({ id: e.uid, level: e.props.mag >= 6.5 ? 'red' : 'amber', title: `🌋 ${e.name} · ${timeAgo(e.time)}`, entity: e });
        if (e.props.tsunami === 'yes' && ageH < 48) this.pushAlert({ id: e.uid + ':ts', level: 'red', title: `🌊 Tsunami flag: ${e.name}`, entity: e });
      }
    }
    if (layer.id === 'disasters') {
      for (const e of layer.items) if (e.props.alertLevel === 'Red') this.pushAlert({ id: e.uid, level: 'red', title: `⚠ RED alert · ${e.name} (${e.props.country || 'n/a'})`, entity: e });
    }
  }

  setPlacing(on) {
    this.placingZone = on;
    document.body.classList.toggle('placing', on);
    $('#placingHint').hidden = !on;
    $('#zoneBtn').classList.toggle('active', on);
    this._placingRadius = Math.round(Math.max(25, Math.min(800, this.viewRadiusKm() * 0.35)));
    if (on) $('#placingHint').innerHTML = `Click the globe to drop a ${this._placingRadius} km watch zone · <kbd>Esc</kbd> to cancel`;
  }

  addZone(lat, lon, radiusKm, name) {
    const z = { id: Math.random().toString(36).slice(2, 8), name: name || `Zone ${this.zones.length + 1}`, lat, lon, radiusKm: Math.round(radiusKm) };
    this.zones.push(z);
    store.set('zones', this.zones);
    this.drawZone(z);
    this.renderZones();
    for (const l of Object.values(this.layers)) if (l.enabled) this.checkZones(l);
    this.reply(`Watch zone “${z.name}” armed: ${z.radiusKm} km around ${formatLatLon(lat, lon, 2)}. You’ll be alerted when anything enters.`);
  }

  drawZone(z) {
    const color = Cesium.Color.fromCssColorString('#ffcc33');
    const ent = this.viewer.entities.add({
      id: 'zone:' + z.id,
      position: Cesium.Cartesian3.fromDegrees(z.lon, z.lat),
      ellipse: {
        semiMajorAxis: z.radiusKm * 1000,
        semiMinorAxis: z.radiusKm * 1000,
        height: 0,
        material: color.withAlpha(0.07),
        outline: true,
        outlineColor: color.withAlpha(0.9),
        outlineWidth: 2,
      },
      label: {
        text: '⬡ ' + z.name.toUpperCase(),
        font: '12px "JetBrains Mono", monospace',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.2e7),
      },
    });
    this.zoneEntities.set(z.id, ent);
  }

  removeZone(id) {
    this.zones = this.zones.filter((z) => z.id !== id);
    store.set('zones', this.zones);
    const ent = this.zoneEntities.get(id);
    if (ent) this.viewer.entities.remove(ent);
    this.zoneEntities.delete(id);
    for (const k of [...this.zoneState.keys()]) if (k.startsWith(id + '|')) this.zoneState.delete(k);
    this.renderZones();
  }

  flyToZone(id) {
    const z = this.zones.find((x) => x.id === id);
    if (z) this.flyTo(z.lat, z.lon, Math.max(150, z.radiusKm * 4));
  }

  checkZones(layer) {
    if (!layer.enabled) return;
    for (const z of this.zones) {
      const key = z.id + '|' + layer.id;
      const inside = layer.visible().filter((e) => haversineKm(z.lat, z.lon, e.lat, e.lon) <= z.radiusKm);
      const prev = this.zoneState.get(key);
      const now = new Set(inside.map((e) => e.uid));
      this.zoneState.set(key, now);
      z.counts = { ...(z.counts || {}), [layer.id]: inside.length };
      if (!prev) continue; // seed silently on first look
      const entered = inside.filter((e) => !prev.has(e.uid));
      const level = layer.id === 'quakes' || layer.id === 'disasters' || layer.id === 'military' ? 'amber' : 'info';
      entered.slice(0, 4).forEach((e) =>
        this.pushAlert({ id: `zn:${z.id}:${e.uid}:${Date.now()}`, level, title: `⬡ ${z.name}: ${e.name} entered (${layer.name})`, entity: e }),
      );
      if (entered.length > 4) this.pushAlert({ id: `zn:${z.id}:${layer.id}:${Date.now()}`, level: 'info', title: `⬡ ${z.name}: +${entered.length - 4} more ${layer.name.toLowerCase()}` });
    }
    this.renderZones();
  }

  // ---------------------------------------------------------------- time machine
  timeMachine(on) {
    $('#timebar').hidden = !on;
    const q = this.layers.quakes;
    if (on) {
      if (!q.enabled) q.enable();
      $('#tmRange').value = 0;
      this.setTimeCursor(0);
      this.home();
      this.toggleTimePlay(true);
      this.reply('Time machine: replaying 7 days of earthquakes (3-day trailing window).');
    } else {
      this.toggleTimePlay(false);
      q.timeCursor = null;
      q.render();
      this.renderLayerList();
    }
  }
  setTimeCursor(v) {
    const q = this.layers.quakes;
    const t = new Date(Date.now() - 7 * 86400000 + (v / 1000) * 7 * 86400000);
    q.timeCursor = v >= 1000 ? null : t;
    q.render();
    $('#tmLabel').textContent = v >= 1000 ? 'NOW' : t.toUTCString().slice(5, 22) + ' UTC';
    this.renderLayerList();
  }
  toggleTimePlay(force) {
    const play = force ?? !this._tmTimer;
    clearInterval(this._tmTimer);
    this._tmTimer = null;
    $('#tmPlay').textContent = play ? '❚❚' : '▶';
    if (!play) return;
    this._tmTimer = setInterval(() => {
      const r = $('#tmRange');
      const v = Math.min(1000, Number(r.value) + 4);
      r.value = v;
      this.setTimeCursor(v);
      if (v >= 1000) this.toggleTimePlay(false);
    }, 80);
  }

  // ---------------------------------------------------------------- export / share / sitrep
  export(format) {
    const all = Object.values(this.layers)
      .filter((l) => l.enabled)
      .flatMap((l) => l.visible().map(({ satrec, _base, ...rest }) => rest));
    if (!all.length) return this.reply('Nothing to export yet.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (format === 'csv') download(`argus-${stamp}.csv`, toCSV(all), 'text/csv');
    else download(`argus-${stamp}.geojson`, JSON.stringify(toGeoJSON(all), null, 1), 'application/geo+json');
    this.reply(`Exported ${fmtNum(all.length)} features as ${format.toUpperCase()}.`);
  }

  hashState() {
    const cam = this.viewer.camera;
    const c = cam.positionCartographic;
    const p = new URLSearchParams();
    p.set('c', [Cesium.Math.toDegrees(c.latitude).toFixed(4), Cesium.Math.toDegrees(c.longitude).toFixed(4), Math.round(c.height), Cesium.Math.toDegrees(cam.heading).toFixed(1), Cesium.Math.toDegrees(cam.pitch).toFixed(1)].join(','));
    p.set('l', Object.values(this.layers).filter((l) => l.enabled).map((l) => l.id).join(','));
    if (this.sensors.mode !== 'normal') p.set('m', this.sensors.mode);
    if (this.tracked) p.set('t', this.tracked.uid);
    if (this.layers.quakes.minMag) p.set('q', this.layers.quakes.minMag);
    return p.toString();
  }

  onMoveEnd() {
    if (this.tracked) return;
    clearTimeout(this._hashT);
    this._hashT = setTimeout(() => history.replaceState(null, '', '#' + this.hashState()), 400);
    const h = this.cameraHeightKm();
    $('#hudCam').textContent = `ALT ${h > 1000 ? fmtNum(h) : fmtNum(h, 1)} km · HDG ${Math.round(Cesium.Math.toDegrees(this.viewer.camera.heading))}°`;
    const c = this.viewCenter();
    $('#hudSun').textContent = isDaylight(c.lat, c.lon) ? '☀ DAYLIGHT AT CENTER' : '☾ NIGHT AT CENTER';
    // Re-centre the regional aircraft feed after big moves.
    const a = this.layers.aircraft;
    if (a.enabled && (!this._lastAcCenter || haversineKm(c.lat, c.lon, this._lastAcCenter.lat, this._lastAcCenter.lon) > 150)) {
      this._lastAcCenter = c;
      a.refresh();
    }
  }

  restoreFromHash() {
    const out = {};
    if (!location.hash) return out;
    const p = new URLSearchParams(location.hash.slice(1));
    const c = p.get('c')?.split(',').map(Number);
    if (c && c.length >= 3 && c.every(Number.isFinite)) {
      this.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(c[1], c[0], c[2]),
        orientation: { heading: Cesium.Math.toRadians(c[3] || 0), pitch: Cesium.Math.toRadians(c[4] ?? -90), roll: 0 },
      });
      out.camera = true;
    }
    if (p.get('l') != null) out.layers = p.get('l').split(',').filter(Boolean);
    if (p.get('m')) this.setMode(p.get('m'));
    if (p.get('t')) this.pendingTrackUid = p.get('t');
    if (p.get('q')) this.layers.quakes.minMag = Number(p.get('q')) || 0;
    return out;
  }

  async share() {
    const url = location.origin + location.pathname + '#' + this.hashState();
    try {
      await navigator.clipboard.writeText(url);
      this.reply('Share link copied — it restores camera, layers, sensor mode and tracked target.');
    } catch {
      this.showModal('Share link', `<p>Copy this link:</p><input style="width:100%" class="form" value="${esc(url)}" onclick="this.select()">`);
    }
  }

  async sitrep() {
    const center = this.tracked ? this.livePosition(this.tracked) : this.viewCenter();
    const radiusKm = Math.round(Math.min(800, Math.max(100, this.viewRadiusKm())));
    this.showModal('SITREP', '<p class="muted">Compiling situation report…</p>');
    const md = await buildSitrep(this, center, radiusKm);
    this.showModal('SITREP', `<pre class="sitrep">${esc(md)}</pre>`, [
      ['Copy', () => navigator.clipboard.writeText(md).then(() => toast('SITREP copied'))],
      ['Download .md', () => download(`sitrep-${new Date().toISOString().slice(0, 16).replace(':', '')}.md`, md, 'text/markdown')],
    ]);
    const first = md.split('\n').find((l) => l.startsWith('BLUF'));
    if (first) this.reply(first.replace('BLUF: ', ''));
  }

  // ---------------------------------------------------------------- voice
  listen() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return this.reply('Voice needs Chrome, Edge or Safari (Web Speech API).');
    if (this._rec) {
      this._rec.stop();
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this._rec = rec;
    $('#micBtn').classList.add('listening');
    this.reply('Listening…', false);
    rec.onresult = (ev) => {
      const r = ev.results[ev.results.length - 1];
      $('#cmd').value = r[0].transcript;
      if (r.isFinal) {
        $('#cmd').value = '';
        this.run(r[0].transcript, true);
      }
    };
    rec.onerror = (ev) => this.reply('Voice error: ' + ev.error, false);
    rec.onend = () => {
      this._rec = null;
      $('#micBtn').classList.remove('listening');
    };
    rec.start();
  }

  // ---------------------------------------------------------------- rendering (DOM)
  updateClock() {
    const d = new Date();
    $('#clock').textContent = d.toISOString().slice(11, 19) + ' UTC';
  }

  renderHudFeeds() {
    $('#hudFeeds').innerHTML = Object.values(this.layers)
      .filter((l) => l.enabled)
      .map((l) => `<span class="${l.status}" title="${esc(l.name)}: ${l.status}${l.lastUpdate ? ' · ' + timeAgo(l.lastUpdate) : ''}">${l.id.toUpperCase()}</span>`)
      .join('');
  }

  renderLayerList() {
    const ul = $('#layerList');
    ul.innerHTML = Object.values(this.layers)
      .map((l) => {
        const n = l.enabled ? l.visible().length : 0;
        let extra = '';
        if (l.id === 'quakes' && l.enabled)
          extra = `<div class="extra">Min mag <input type="range" min="0" max="7" step="0.5" value="${l.minMag}" data-qmag> <b>M${l.minMag}+</b></div>`;
        if (l.id === 'satellites' && l.enabled)
          extra = `<div class="extra">${Object.entries(SAT_GROUPS)
            .map(([g, label]) => `<button class="chip ${l.groups.includes(g) ? 'on' : ''}" data-satgroup="${g}" title="${esc(label)}">${g}</button>`)
            .join('')}</div>`;
        return `<li class="layer">
          <label><input type="checkbox" data-layer="${l.id}" ${l.enabled ? 'checked' : ''}>
            <span class="swatch" style="background:${l.color}"></span>
            <span class="name">${esc(l.name)}</span>
            <span class="count">${l.enabled ? fmtNum(n) : ''}</span>
            <span class="dot ${l.enabled ? l.status : ''}" title="${esc(l.error || l.status)}"></span></label>
          <div class="src">${esc(l.source)}${l.lastUpdate ? ' · ' + timeAgo(l.lastUpdate) : ''}</div>
          ${l.enabled && l.error ? `<div class="err">⚠ ${esc(l.error)}</div>` : ''}
          ${extra}</li>`;
      })
      .join('');
    ul.querySelectorAll('[data-layer]').forEach((cb) => cb.addEventListener('change', () => this.setLayer(cb.dataset.layer, cb.checked)));
    const qm = ul.querySelector('[data-qmag]');
    if (qm)
      qm.addEventListener('change', () => {
        this.layers.quakes.minMag = Number(qm.value);
        this.layers.quakes.render();
        this.renderLayerList();
      });
    ul.querySelectorAll('[data-satgroup]').forEach((b) =>
      b.addEventListener('click', () => {
        const l = this.layers.satellites;
        const g = b.dataset.satgroup;
        const next = l.groups.includes(g) ? l.groups.filter((x) => x !== g) : [...l.groups, g];
        if (!next.length) return;
        l.setGroups(next);
      }),
    );
    this.renderHudFeeds();
  }

  renderInspector() {
    const e = this.selected;
    const body = $('#inspectorBody');
    $('#inspector').classList.toggle('empty', !e);
    if (!e) {
      body.innerHTML = '<p class="muted">Click anything on the globe — a plane, satellite, quake or alert — to inspect it. Double-click to track.</p>';
      return;
    }
    const p = this.livePosition(e);
    const rows = Object.entries(e.props || {})
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<dt>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</dt><dd class="${k === 'emergency' ? 'emergency' : ''}">${esc(typeof v === 'number' ? fmtNum(v, Math.abs(v) < 10 && v % 1 ? 2 : 0) : v)}</dd>`)
      .join('');
    const c = this.viewCenter();
    const dist = haversineKm(c.lat, c.lon, p.lat, p.lon);
    const isMover = !!e.satrec || e.kind === 'aircraft' || e.kind === 'military';
    body.innerHTML = `
      <div class="kind">${esc(e.kind)}</div>
      <h4>${esc(e.name)}</h4>
      <dl class="kv">
        <dt>position</dt><dd>${formatLatLon(p.lat, p.lon)}</dd>
        ${p.altM > 1 ? `<dt>altitude</dt><dd>${p.altM > 1e5 ? fmtNum(p.altM / 1000) + ' km' : fmtNum(p.altM) + ' m'}</dd>` : ''}
        ${e.time ? `<dt>${e.kind === 'launch' ? 'NET' : 'time'}</dt><dd>${esc(new Date(e.time).toUTCString().slice(5, 22))} · ${timeAgo(e.time)}</dd>` : ''}
        <dt>from view center</dt><dd>${fmtNum(dist)} km ${compass(bearingDeg(c.lat, c.lon, p.lat, p.lon))}</dd>
        ${rows}
      </dl>
      <div class="actions">
        ${isMover ? `<button class="btn" data-act="${this.tracked === e ? 'untrack' : 'track'}">${this.tracked === e ? '■ Stop tracking' : '◎ Track'}</button>` : ''}
        <button class="btn" data-act="fly">➜ Fly to</button>
        <button class="btn" data-act="zone">⬡ Zone here</button>
        ${e.satrec ? '<button class="btn" data-act="passes">☄ Passes</button>' : ''}
        ${e.url ? `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">↗ Source</a>` : ''}
      </div>`;
    body.querySelector('[data-act="track"]')?.addEventListener('click', () => this.track(e));
    body.querySelector('[data-act="untrack"]')?.addEventListener('click', () => this.untrack());
    body.querySelector('[data-act="fly"]')?.addEventListener('click', () => this.flyTo(p.lat, p.lon, e.satrec ? 2500 : e.kind === 'aircraft' ? 60 : 400));
    body.querySelector('[data-act="zone"]')?.addEventListener('click', () => this.addZone(p.lat, p.lon, 150, e.name.slice(0, 24)));
    body.querySelector('[data-act="passes"]')?.addEventListener('click', () => this.passes(e.name));
  }

  renderAlerts() {
    const n = this.alerts.length;
    for (const id of ['#alertCount', '#alertCount2']) {
      const el = $(id);
      if (el) {
        el.textContent = n;
        el.dataset.n = n;
      }
    }
    const ul = $('#alertList');
    ul.innerHTML = this.alerts
      .slice(0, 60)
      .map((a, i) => `<li class="${a.level}" data-i="${i}">${esc(a.title)}<span class="t">${a.t.toLocaleTimeString()}${a.lat != null ? ' · ' + formatLatLon(a.lat, a.lon, 1) : ''}</span></li>`)
      .join('');
    ul.querySelectorAll('li[data-i]').forEach((li) =>
      li.addEventListener('click', () => {
        const a = this.alerts[Number(li.dataset.i)];
        const e = a.uid && this.resolveEntity(a.uid);
        if (e) this.select(e);
        if (a.lat != null) this.flyTo(a.lat, a.lon, e?.kind === 'aircraft' ? 80 : 900);
      }),
    );
  }

  renderZones() {
    const ul = $('#zoneList');
    if (!this.zones.length) {
      ul.innerHTML = '<li class="muted">No zones yet. Use “＋ Watch zone” or say “zone 200 km around Mumbai”.</li>';
      return;
    }
    ul.innerHTML = this.zones
      .map((z) => {
        const counts = Object.entries(z.counts || {})
          .filter(([, n]) => n)
          .map(([k, n]) => `${n} ${k}`)
          .join(' · ');
        return `<li><span class="z" data-z="${z.id}">⬡ ${esc(z.name)}<small>${z.radiusKm} km · ${counts || 'clear'}</small></span><button class="icon-btn" data-rm="${z.id}" title="Remove">✕</button></li>`;
      })
      .join('');
    ul.querySelectorAll('[data-z]').forEach((s) => s.addEventListener('click', () => this.flyToZone(s.dataset.z)));
    ul.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => this.removeZone(b.dataset.rm)));
  }

  showModal(title, html, buttons = []) {
    const d = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    const f = $('#modalFooter');
    f.innerHTML = '';
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      f.appendChild(b);
    }
    if (!d.open) d.showModal();
  }

  showHelp() {
    this.showModal(
      'COMMANDS',
      `<p class="muted">Type in the command bar (<kbd>/</kbd>) or press <kbd>V</kbd> and speak. Double-click anything to track it.</p>
      <table class="help-table">${HELP.map(([c, d]) => `<tr><td>${esc(c)}</td><td>${esc(d)}</td></tr>`).join('')}</table>
      <p class="muted">Keys: <kbd>/</kbd> command · <kbd>V</kbd> voice · <kbd>H</kbd> whole Earth · <kbd>Esc</kbd> cancel · <kbd>?</kbd> help</p>`,
    );
  }

  showSettings() {
    const s = this.settings;
    this.showModal(
      'SETTINGS',
      `<div class="form">
        <label>ADS-B relay URL (needed for aircraft on static hosting such as GitHub Pages)
          <input type="text" id="setRelay" placeholder="${esc(this.relayBase() || 'https://your-relay.example.com/api')}" value="${esc(s.relayUrl)}"></label>
        <label>Cesium ion token (optional — world terrain; free for personal use)
          <input type="password" id="setIon" value="${esc(s.ionToken)}"></label>
        <label>Google Maps Platform key (optional — Photorealistic 3D Tiles, metered by Google)
          <input type="password" id="setGoogle" value="${esc(s.googleKey)}"></label>
        <label class="row"><input type="checkbox" id="setPhoto" ${s.photoreal ? 'checked' : ''}> Photorealistic 3D cities (needs ion token or Google key)</label>
        <label class="row"><input type="checkbox" id="setVoice" ${s.voiceReplies ? 'checked' : ''}> Speak replies to voice commands</label>
        <p class="muted">Keys are stored only in this browser (localStorage) and sent only to the provider they belong to.</p>
      </div>`,
      [
        [
          'Save',
          () => {
            Object.assign(this.settings, {
              relayUrl: $('#setRelay').value.trim(),
              ionToken: $('#setIon').value.trim(),
              googleKey: $('#setGoogle').value.trim(),
              photoreal: $('#setPhoto').checked,
              voiceReplies: $('#setVoice').checked,
            });
            store.set('settings', this.settings);
            $('#modal').close();
            this.applyTerrainAndTiles();
            this.layers.aircraft.refresh();
            this.layers.military.refresh();
            toast('Settings saved');
          },
        ],
      ],
    );
  }
}

const app = new App();
app.init().catch((e) => {
  console.error(e);
  toast('Startup error: ' + e.message, 'error', 10000);
});

