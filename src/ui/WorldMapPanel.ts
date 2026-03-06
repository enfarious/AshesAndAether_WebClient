import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * WorldMapPanel — fullscreen Leaflet corruption map overlay.
 *
 * Shows real Stephentown geography with a corruption gradient overlay
 * computed from civic ward anchors (townhalls, libraries).  Toggle with M key.
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface Anchor {
  id: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  wardRadius: number;
  wardStrength: number;
  metadata?: Record<string, string>;
}

interface CorruptionBand {
  label: string;
  rangeDesc: string;
  rate: number;
}

interface CorruptionConfig {
  zoneTags: Record<string, { corruption_per_minute: number }>;
  timeOfDay: Record<string, { corruption_multiplier: number }>;
  gradientModel: { bands: CorruptionBand[] };
}

// ── Fallback data (if server unavailable) ────────────────────────────────────

const FALLBACK_ANCHORS: Anchor[] = [
  {
    id: 'fallback-townhall',
    type: 'TOWNHALL',
    name: 'Stephentown Town Hall',
    lat: 42.5513326,
    lon: -73.3792285,
    wardRadius: 500,
    wardStrength: -0.05,
  },
  {
    id: 'fallback-library',
    type: 'LIBRARY',
    name: 'Stephentown Memorial Library',
    lat: 42.5507,
    lon: -73.3806,
    wardRadius: 300,
    wardStrength: -0.03,
  },
];

// ── Corruption color helpers ─────────────────────────────────────────────────

/** Map a corruption rate to an RGBA color. */
function corruptionColor(rate: number, nightMult: number): string {
  const r = rate * nightMult;
  // Negative = warded (green), 0 = neutral (yellow), positive = corrupt (red)
  if (r <= -0.04) return 'rgba(40,180,80,0.45)';
  if (r <= -0.02) return 'rgba(80,190,80,0.38)';
  if (r <= 0)     return 'rgba(180,180,60,0.30)';
  if (r <= 0.02)  return 'rgba(200,150,40,0.35)';
  if (r <= 0.04)  return 'rgba(200,100,30,0.40)';
  if (r <= 0.06)  return 'rgba(180,50,30,0.45)';
  return 'rgba(120,20,20,0.50)';
}

/** Distance between two lat/lon points in metres (equirectangular). */
function distMetres(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6378137;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const avgLat = (lat1 + lat2) / 2 * Math.PI / 180;
  const x = dLon * Math.cos(avgLat) * R;
  const y = dLat * R;
  return Math.sqrt(x * x + y * y);
}

// ── WorldMapPanel ────────────────────────────────────────────────────────────

export class WorldMapPanel {
  private root:      HTMLElement;
  private visible    = false;
  private map:       L.Map | null = null;
  private anchors:   Anchor[] = [];
  private config:    CorruptionConfig | null = null;
  private nightMode  = false;

  private corruptionCanvas: HTMLCanvasElement | null = null;
  private corruptionOverlay: L.ImageOverlay | null = null;
  private wardCircles: L.Circle[] = [];
  private anchorMarkers: L.Marker[] = [];
  private showWards = true;
  private showCorruption = true;
  private dataLoaded = false;

  constructor(
    private readonly uiRoot: HTMLElement,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isVisible(): boolean { return this.visible; }

  toggle(): void { this.visible ? this.hide() : this.show(); }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('wm-visible'));
    this.visible = true;

    // Lazy-init the Leaflet map on first show
    if (!this.map) {
      this._initMap();
    } else {
      this.map.invalidateSize();
    }

    if (!this.dataLoaded) {
      this._fetchData();
    }
  }

  hide(): void {
    this.root.classList.remove('wm-visible');
    this.root.style.display = 'none';
    this.visible = false;
  }

  dispose(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.root.remove();
  }

  // ── Leaflet init ───────────────────────────────────────────────────────────

  private _initMap(): void {
    const container = this.root.querySelector<HTMLElement>('#wm-map')!;

    this.map = L.map(container, {
      center: [42.5513326, -73.3792285],  // Stephentown Town Hall
      zoom: 14,
      zoomControl: false,
      attributionControl: false,
    });

    // Dark tiles
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 },
    ).addTo(this.map);

    // Zoom control bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Attribution
    L.control.attribution({ position: 'bottomleft' }).addTo(this.map);
    this.map.attributionControl?.addAttribution(
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
    );

    // Redraw corruption on move/zoom
    this.map.on('moveend', () => this._renderCorruption());
  }

  // ── Data fetch ─────────────────────────────────────────────────────────────

  private async _fetchData(): Promise<void> {
    try {
      const [anchorsRes, configRes] = await Promise.all([
        fetch('/api/map/anchors'),
        fetch('/api/map/corruption-config'),
      ]);

      if (anchorsRes.ok) {
        const data = await anchorsRes.json();
        this.anchors = data.anchors ?? [];
      }
      if (configRes.ok) {
        this.config = await configRes.json();
      }
    } catch {
      // Fallback to hardcoded anchors
    }

    if (this.anchors.length === 0) {
      this.anchors = FALLBACK_ANCHORS;
    }

    this.dataLoaded = true;
    this._addAnchorsToMap();
    this._renderCorruption();
  }

  // ── Anchor markers + ward circles ──────────────────────────────────────────

  private _addAnchorsToMap(): void {
    if (!this.map) return;

    // Clear previous
    this.anchorMarkers.forEach(m => m.remove());
    this.wardCircles.forEach(c => c.remove());
    this.anchorMarkers = [];
    this.wardCircles = [];

    for (const anchor of this.anchors) {
      // Marker
      const icon = L.divIcon({
        className: 'wm-anchor-icon',
        html: anchor.type === 'TOWNHALL'
          ? '<div class="wm-icon wm-icon-townhall">&#9733;</div>'
          : '<div class="wm-icon wm-icon-library">&#9830;</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([anchor.lat, anchor.lon], { icon })
        .addTo(this.map)
        .bindPopup(`
          <div style="font-family:monospace;font-size:12px;color:#d4c9b8;">
            <strong style="color:#c8913c;">${anchor.name}</strong><br/>
            Type: ${anchor.type}<br/>
            Ward radius: ${anchor.wardRadius}m<br/>
            Ward strength: ${anchor.wardStrength}/min
          </div>
        `, { className: 'wm-popup' });

      this.anchorMarkers.push(marker);

      // Ward radius circle
      const circle = L.circle([anchor.lat, anchor.lon], {
        radius: anchor.wardRadius,
        color: 'rgba(80,200,100,0.5)',
        fillColor: 'rgba(80,200,100,0.08)',
        weight: 1,
        dashArray: '6,4',
      }).addTo(this.map);

      circle.setStyle({
        opacity: this.showWards ? 1 : 0,
        fillOpacity: this.showWards ? 0.08 : 0,
      });

      this.wardCircles.push(circle);
    }
  }

  // ── Corruption gradient rendering ──────────────────────────────────────────

  private _renderCorruption(): void {
    if (!this.map || this.anchors.length === 0) return;

    const bounds = this.map.getBounds();
    const size = this.map.getSize();

    // Render at 1/4 resolution for performance
    const scale = 4;
    const w = Math.ceil(size.x / scale);
    const h = Math.ceil(size.y / scale);

    if (!this.corruptionCanvas) {
      this.corruptionCanvas = document.createElement('canvas');
    }
    this.corruptionCanvas.width = w;
    this.corruptionCanvas.height = h;
    const ctx = this.corruptionCanvas.getContext('2d')!;

    const nightMult = this.nightMode ? 1.5 : 1.0;

    const nw = bounds.getNorthWest();
    const se = bounds.getSouthEast();
    const latRange = nw.lat - se.lat;
    const lonRange = se.lng - nw.lng;

    for (let py = 0; py < h; py++) {
      const lat = nw.lat - (py / h) * latRange;
      for (let px = 0; px < w; px++) {
        const lon = nw.lng + (px / w) * lonRange;

        // Evaluate corruption from each anchor independently.
        // The strongest ward (lowest rate) wins at each point, so a
        // large townhall ward isn't overridden by a nearer but weaker library.
        let rate = 0.08; // default: deep corruption (no anchor influence)
        for (const anchor of this.anchors) {
          const d = distMetres(lat, lon, anchor.lat, anchor.lon);
          const ratio = d / anchor.wardRadius;
          let anchorRate: number;
          if (ratio <= 1.0) {
            anchorRate = anchor.wardStrength; // full ward zone
          } else if (ratio <= 2.0) {
            // Fade from ward strength to neutral (WILDS)
            const t = ratio - 1.0;
            anchorRate = anchor.wardStrength * (1 - t);
          } else if (ratio <= 4.0) {
            // Fade from WILDS (0) to RUINS_CITY_EDGE (+0.02)
            const t = (ratio - 2.0) / 2.0;
            anchorRate = t * 0.02;
          } else if (ratio <= 8.0) {
            // Fade to OLD_CITY_CORE (+0.06)
            const t = (ratio - 4.0) / 4.0;
            anchorRate = 0.02 + t * 0.04;
          } else {
            // Beyond influence — deep corruption
            anchorRate = 0.06 + Math.min((ratio - 8.0) / 8.0, 1.0) * 0.02;
          }
          // Keep the most protective (lowest) rate from any anchor
          if (anchorRate < rate) rate = anchorRate;
        }

        ctx.fillStyle = corruptionColor(rate, nightMult);
        ctx.fillRect(px, py, 1, 1);
      }
    }

    // Remove old overlay
    if (this.corruptionOverlay) {
      this.corruptionOverlay.remove();
    }

    if (this.showCorruption) {
      this.corruptionOverlay = L.imageOverlay(
        this.corruptionCanvas.toDataURL(),
        bounds,
        { opacity: 1, interactive: false },
      ).addTo(this.map);

      // Ensure markers stay on top
      this.anchorMarkers.forEach(m => m.setZIndexOffset(1000));
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  private _toggleNight(): void {
    this.nightMode = !this.nightMode;
    const btn = this.root.querySelector<HTMLElement>('#wm-night-btn');
    if (btn) btn.textContent = this.nightMode ? 'Night: ON' : 'Night: OFF';
    this._renderCorruption();
  }

  private _toggleWards(): void {
    this.showWards = !this.showWards;
    const btn = this.root.querySelector<HTMLElement>('#wm-wards-btn');
    if (btn) btn.textContent = this.showWards ? 'Wards: ON' : 'Wards: OFF';
    this.wardCircles.forEach(c => {
      c.setStyle({
        opacity: this.showWards ? 1 : 0,
        fillOpacity: this.showWards ? 0.08 : 0,
      });
    });
  }

  private _toggleCorruption(): void {
    this.showCorruption = !this.showCorruption;
    const btn = this.root.querySelector<HTMLElement>('#wm-corruption-btn');
    if (btn) btn.textContent = this.showCorruption ? 'Corruption: ON' : 'Corruption: OFF';
    if (this.showCorruption) {
      this._renderCorruption();
    } else if (this.corruptionOverlay) {
      this.corruptionOverlay.remove();
      this.corruptionOverlay = null;
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'world-map-panel';
    el.innerHTML = `
      <style>
        #world-map-panel {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 200;
          pointer-events: none;
        }
        #world-map-panel.wm-visible {
          pointer-events: auto;
        }

        #wm-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.65);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #world-map-panel.wm-visible #wm-backdrop { opacity: 1; }

        #wm-panel {
          position: relative;
          display: flex;
          flex-direction: column;
          background: rgba(8,6,4,0.97);
          border: 1px solid rgba(200,145,60,0.30);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8), inset 0 0 60px rgba(30,15,5,0.5);
          width: min(1100px, 96vw);
          height: min(800px, 90vh);
          overflow: hidden;
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #world-map-panel.wm-visible #wm-panel {
          transform: translateY(0);
          opacity: 1;
        }

        .wm-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 8px;
          border-bottom: 1px solid rgba(200,145,60,0.18);
          flex-shrink: 0;
        }
        .wm-title {
          font-family: var(--font-display, serif);
          font-size: 13px;
          color: rgba(200,145,60,0.90);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .wm-controls {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .wm-ctrl-btn {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,201,184,0.70);
          background: rgba(30,20,10,0.6);
          border: 1px solid rgba(200,145,60,0.22);
          padding: 3px 8px;
          cursor: pointer;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          transition: background 0.15s, color 0.15s;
        }
        .wm-ctrl-btn:hover {
          background: rgba(80,40,10,0.5);
          color: rgba(230,200,140,1);
        }
        .wm-close-btn {
          font-family: var(--font-mono);
          font-size: 14px;
          color: rgba(180,100,60,0.8);
          background: rgba(30,20,10,0.6);
          border: 1px solid rgba(200,98,42,0.22);
          padding: 2px 8px;
          cursor: pointer;
          margin-left: 10px;
          transition: background 0.15s, color 0.15s;
        }
        .wm-close-btn:hover {
          background: rgba(80,40,10,0.5);
          color: rgba(212,180,120,0.95);
        }

        #wm-map {
          flex: 1;
          min-height: 0;
        }

        /* Legend */
        .wm-legend {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 6px 14px;
          border-top: 1px solid rgba(200,145,60,0.12);
          flex-shrink: 0;
          flex-wrap: wrap;
        }
        .wm-legend-item {
          display: flex;
          align-items: center;
          gap: 5px;
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,201,184,0.60);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .wm-legend-swatch {
          width: 14px;
          height: 10px;
          border-radius: 2px;
        }

        /* Anchor icon styling */
        .wm-anchor-icon {
          background: none !important;
          border: none !important;
        }
        .wm-icon {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          font-size: 14px;
          text-shadow: 0 1px 3px #000;
          border: 1px solid rgba(255,255,255,0.2);
        }
        .wm-icon-townhall {
          background: rgba(200,145,60,0.85);
          color: #fff;
        }
        .wm-icon-library {
          background: rgba(80,160,200,0.85);
          color: #fff;
        }

        /* Leaflet popup override */
        .wm-popup .leaflet-popup-content-wrapper {
          background: rgba(8,6,4,0.95);
          border: 1px solid rgba(200,145,60,0.30);
          border-radius: 4px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        }
        .wm-popup .leaflet-popup-tip {
          background: rgba(8,6,4,0.95);
          border: 1px solid rgba(200,145,60,0.30);
        }

        /* Override Leaflet defaults for dark theme */
        #wm-map .leaflet-control-zoom a {
          background: rgba(8,6,4,0.9);
          color: rgba(200,145,60,0.8);
          border-color: rgba(200,145,60,0.2);
        }
        #wm-map .leaflet-control-zoom a:hover {
          background: rgba(30,20,10,0.9);
          color: rgba(230,200,140,1);
        }
        #wm-map .leaflet-control-attribution {
          background: rgba(8,6,4,0.7) !important;
          color: rgba(150,120,80,0.5);
          font-size: 9px;
        }
        #wm-map .leaflet-control-attribution a {
          color: rgba(200,145,60,0.6);
        }
      </style>

      <div id="wm-backdrop"></div>

      <div id="wm-panel">
        <div class="wm-header">
          <span class="wm-title">World Map — Corruption Overlay</span>
          <div class="wm-controls">
            <button class="wm-ctrl-btn" id="wm-night-btn">Night: OFF</button>
            <button class="wm-ctrl-btn" id="wm-wards-btn">Wards: ON</button>
            <button class="wm-ctrl-btn" id="wm-corruption-btn">Corruption: ON</button>
            <button class="wm-close-btn" id="wm-close-btn">&times;</button>
          </div>
        </div>

        <div id="wm-map"></div>

        <div class="wm-legend">
          <div class="wm-legend-item">
            <div class="wm-legend-swatch" style="background:rgba(40,180,80,0.7)"></div>
            Ward Zone
          </div>
          <div class="wm-legend-item">
            <div class="wm-legend-swatch" style="background:rgba(180,180,60,0.7)"></div>
            Wilds
          </div>
          <div class="wm-legend-item">
            <div class="wm-legend-swatch" style="background:rgba(200,130,40,0.7)"></div>
            Ruins Edge
          </div>
          <div class="wm-legend-item">
            <div class="wm-legend-swatch" style="background:rgba(180,50,30,0.7)"></div>
            Old City Core
          </div>
          <div class="wm-legend-item">
            <div class="wm-legend-swatch" style="background:rgba(120,20,20,0.7)"></div>
            Deep Corruption
          </div>
          <div class="wm-legend-item" style="margin-left:auto;">
            <div class="wm-icon-townhall wm-icon" style="width:16px;height:16px;font-size:10px;">&#9733;</div>
            Townhall
          </div>
          <div class="wm-legend-item">
            <div class="wm-icon-library wm-icon" style="width:16px;height:16px;font-size:10px;">&#9830;</div>
            Library
          </div>
        </div>
      </div>
    `;

    // Wire events
    el.querySelector('#wm-close-btn')!.addEventListener('click', () => this.hide());
    el.querySelector('#wm-backdrop')!.addEventListener('click', () => this.hide());
    el.querySelector('#wm-night-btn')!.addEventListener('click', () => this._toggleNight());
    el.querySelector('#wm-wards-btn')!.addEventListener('click', () => this._toggleWards());
    el.querySelector('#wm-corruption-btn')!.addEventListener('click', () => this._toggleCorruption());

    // Escape key closes
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.visible) this.hide();
    };
    window.addEventListener('keydown', onKey);

    return el;
  }
}
