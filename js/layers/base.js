/* global Cesium */
// Base class for every data layer: fetch loop, feed-health status, and fast primitive rendering.
export class Layer {
  constructor(app, opts) {
    this.app = app;
    this.id = opts.id;
    this.name = opts.name;
    this.color = opts.color || '#7cf';
    this.refreshMs = opts.refreshMs || 60000;
    this.source = opts.source || '';
    this.defaultOn = !!opts.defaultOn;
    this.enabled = false;
    this.items = [];
    this.status = 'idle';
    this.error = null;
    this.lastUpdate = null;
    this.filter = null; // optional predicate
    this._timer = null;
    this._loading = false;

    const prims = app.viewer.scene.primitives;
    this.points = prims.add(new Cesium.PointPrimitiveCollection());
    this.billboards = prims.add(new Cesium.BillboardCollection({ scene: app.viewer.scene }));
    this.labels = prims.add(new Cesium.LabelCollection({ scene: app.viewer.scene }));
    this.setShow(false);
  }

  setShow(v) {
    this.points.show = v;
    this.billboards.show = v;
    this.labels.show = v;
  }

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.setShow(true);
    await this.refresh();
    if (this.refreshMs > 0) this._timer = setInterval(() => this.refresh(), this.refreshMs);
    this.app.emit('layers');
  }

  disable() {
    this.enabled = false;
    clearInterval(this._timer);
    this._timer = null;
    this.setShow(false);
    this.app.emit('layers');
  }

  async refresh() {
    if (!this.enabled || this._loading) return;
    this._loading = true;
    this.status = this.items.length ? this.status : 'loading';
    this.app.emit('layers');
    try {
      const items = await this.load();
      this.items = items;
      this.status = 'ok';
      this.error = null;
      this.lastUpdate = new Date();
      this.render();
      this.app.emit('data', this);
    } catch (err) {
      console.warn(`[${this.id}]`, err);
      this.error = err.message || String(err);
      this.status = this.items.length ? 'stale' : 'error';
    } finally {
      this._loading = false;
      this.app.emit('layers');
    }
  }

  /** Items currently visible after filters. */
  visible() {
    return this.filter ? this.items.filter(this.filter) : this.items;
  }

  // Subclasses implement load(); default render draws coloured points + optional labels.
  async load() {
    return [];
  }

  styleFor(_e) {
    return { color: this.color, size: 8, label: null };
  }

  render() {
    this.points.removeAll();
    this.labels.removeAll();
    this.billboards.removeAll();
    for (const e of this.visible()) {
      const st = this.styleFor(e);
      const position = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, e.altM || 0);
      this.points.add({
        id: e,
        position,
        color: Cesium.Color.fromCssColorString(st.color),
        pixelSize: st.size,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: st.scaleByDistance || new Cesium.NearFarScalar(1.5e5, 1.6, 2.0e7, 0.6),
        disableDepthTestDistance: e.altM ? 0 : Number.POSITIVE_INFINITY,
      });
      if (st.label) {
        this.labels.add({
          id: e,
          position,
          text: st.label,
          font: '12px "JetBrains Mono", ui-monospace, monospace',
          fillColor: Cesium.Color.fromCssColorString(st.color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(10, -10),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, st.labelFar || 2.5e6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
  }

  find(uid) {
    return this.items.find((e) => e.uid === uid);
  }
}
