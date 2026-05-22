import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { WorldState }     from '@/state/WorldState';
import type { SocketClient }   from '@/network/SocketClient';
import { ClientConfig }        from '@/config/ClientConfig';

/**
 * WorldMapPanel — fullscreen Leaflet strategic map overlay.
 *
 * Toggled with M.  Renders the zone's real Aether Density field (sampled
 * server-side from DangerMap), zone bounds rectangle, civic wards, lit
 * guild beacons, and the local player as a follow-camera marker.
 *
 * Backend feed: GET /api/map/snapshot/:zoneId
 *   - bounds, origin (lat/lon)
 *   - 64×64 AD grid + 32×32 rock/tree density grids
 *   - civic anchors + lit guild beacons
 *
 * Phase 1a: snapshot-only (refetched on each open). Phase 1b adds live
 * deltas while the panel is open.  Portable beacons are intentionally
 * not rendered — see project_map_omits_portables memory.
 */

// ── Types (mirror server payload) ────────────────────────────────────────────

interface Grid    { res: number; values: number[] }
interface CivicAnchor {
  worldX: number; worldY: number; worldZ: number;
  wardRadius: number; type: string; name: string;
}
interface GuildBeacon {
  id: string; guildId: string; guildName: string;
  worldX: number; worldY: number; worldZ: number; effectRadius: number;
}
interface TrainStationMarker {
  worldX: number; worldY: number; worldZ: number; name: string;
}
interface MapSnapshot {
  zoneId:       string;
  version:      number;
  bounds:       { halfX: number; halfZ: number };
  origin:       { lat: number; lon: number } | null;
  civicAnchors: CivicAnchor[];
  guildBeacons: GuildBeacon[];
  /** Null when this zone has no rail station in train-network.json. */
  trainStation: TrainStationMarker | null;
  adGrid:       Grid;
  rockDensity:  Grid;
  treeDensity:  Grid;
}

// ── Coordinate helpers ───────────────────────────────────────────────────────

const EARTH_R = 6_378_137;
const DEG_RAD = Math.PI / 180;

interface Projector {
  worldToLatLng: (x: number, z: number) => L.LatLng;
}

function makeProjector(origin: { lat: number; lon: number }): Projector {
  const rLat = DEG_RAD * EARTH_R;
  const rLon = DEG_RAD * EARTH_R * Math.cos(origin.lat * DEG_RAD);
  return {
    worldToLatLng: (x, z) =>
      L.latLng(origin.lat - z / rLat, origin.lon + x / rLon),
  };
}

// ── AD color ramp ────────────────────────────────────────────────────────────
//
// Continuous LERP between key stops so the rendered field is a smooth
// gradient rather than discrete bands. 0.0 = deep safe (green) → 1.0 =
// lethal (near-black violet). The ≥1.0 stop is the visual marker for the
// deferred lethal-AD mechanic; today's DangerMap clamps to 0..1 so it
// only hints at the threshold today, but the colors are already right
// for when the mechanic ships.
//
// Alpha rises with v so safe terrain barely tints the basemap and deep
// aether obscures it — readable as both a heat field and a "where can I
// see the ground" cue.

interface ColorStop { v: number; rgba: [number, number, number, number] }

const AD_STOPS: ColorStop[] = [
  { v: 0.00, rgba: [ 60, 150, 100,  40] },  // deep safe
  { v: 0.25, rgba: [180, 200,  80, 105] },  // yellow-green
  { v: 0.50, rgba: [220, 140,  50, 140] },  // orange
  { v: 0.70, rgba: [200,  60,  40, 175] },  // red
  { v: 0.90, rgba: [110,  30, 100, 205] },  // violet
  { v: 1.00, rgba: [ 25,   0,  30, 230] },  // lethal (near-black violet)
];

function adColor(v: number): [number, number, number, number] {
  const c = Math.max(0, Math.min(1, v));
  for (let i = 0; i < AD_STOPS.length - 1; i++) {
    const a = AD_STOPS[i]!;
    const b = AD_STOPS[i + 1]!;
    if (c <= b.v) {
      const t = b.v === a.v ? 0 : (c - a.v) / (b.v - a.v);
      return [
        Math.round(a.rgba[0] + (b.rgba[0] - a.rgba[0]) * t),
        Math.round(a.rgba[1] + (b.rgba[1] - a.rgba[1]) * t),
        Math.round(a.rgba[2] + (b.rgba[2] - a.rgba[2]) * t),
        Math.round(a.rgba[3] + (b.rgba[3] - a.rgba[3]) * t),
      ];
    }
  }
  return AD_STOPS[AD_STOPS.length - 1]!.rgba;
}

/** CSS linear-gradient string built from the same stops, so the legend bar
 *  literally renders the same ramp as the field. */
function adGradientCss(): string {
  const parts = AD_STOPS.map(s => {
    const [r, g, b] = s.rgba;
    return `rgb(${r},${g},${b}) ${Math.round(s.v * 100)}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

// ── World view (zoomed-out, multi-zone) ──────────────────────────────────────

interface ZoneRegistryEntry {
  displayName?: string;
  placeType?:   string;
  center:       { lat: number; lon: number };
  active?:      boolean;
}

interface ZoneRegistryResponse {
  version?: string;
  zones?:   Record<string, ZoneRegistryEntry>;
}

/** Below this zoom level the panel switches to "world view": in-zone
 *  overlays fade out, all registered zones surface as glowing markers. */
const WORLD_VIEW_ZOOM = 11;

/** Default zoom restored when the user clicks their current-zone marker
 *  to dive back in. Roughly fits a 2-mile-radius town. */
const IN_ZONE_DEFAULT_ZOOM = 13;

// ── WorldMapPanel ────────────────────────────────────────────────────────────

const FOLLOW_TICK_MS = 250;

export class WorldMapPanel {
  private root:    HTMLElement;
  private visible = false;

  private map: L.Map | null = null;

  private snapshot:  MapSnapshot | null = null;
  private projector: Projector   | null = null;

  // Layers
  private adOverlay:    L.ImageOverlay | null = null;
  private rockOverlay:  L.ImageOverlay | null = null;
  private treeOverlay:  L.ImageOverlay | null = null;
  private zoneRect:     L.Rectangle    | null = null;
  private wardCircles:  L.Circle[]            = [];
  private anchorMarkers: L.Marker[]           = [];
  private guildMarkers:  L.Marker[]           = [];
  private trainMarker:  L.Marker | null      = null;
  private playerMarker:  L.Marker | null      = null;

  // OSM polygon layers — lazily fetched on first toggle, cached for the
  // session.  Water nodes arrive in lat/lon directly; forest polygons
  // arrive in world metres and need projection.
  /** Closed rings (lakes/ponds) — first node === last node. Rendered as
   *  filled polygons. */
  private waterPolyRings: L.LatLng[][] | null = null;
  /** Open polylines (rivers/streams/drains) — waterway=* tags. Rendered
   *  as styled polylines so they trace their actual path instead of
   *  collapsing into Frankenstein closed blobs. */
  private waterLineRings: L.LatLng[][] | null = null;
  private forestRingsM:  Array<{ x: number; z: number }[]> | null = null;  // metres
  private waterPolygons:  L.Polygon[]    = [];
  private waterPolylines: L.Polyline[]   = [];
  private forestPolygons: L.Polygon[]    = [];
  /** Party-member + companion + hireling dots, keyed by entity id so the
   *  4 Hz follow tick can `setLatLng` instead of churning markers. */
  private allyMarkers = new Map<string, L.Marker>();

  // Toggles
  private showWards   = true;
  private showAd      = true;
  private showRocks   = false;
  private showTrees   = false;
  private showWater   = false;
  private showForests = false;
  private follow      = true;

  private followTimer: ReturnType<typeof setInterval> | null = null;
  private fetchedZoneId: string | null = null;
  /** Bound listener refs so we can detach on hide. */
  private readonly _onBeaconUpdate = (p: unknown) => this._applyBeaconUpdate(p);
  private readonly _onAdPatch      = (p: unknown) => this._applyAdPatch(p);
  private subscribed = false;

  // World view (zoomed-out multi-zone layer)
  private worldZones: { id: string; entry: ZoneRegistryEntry }[] | null = null;
  private worldZoneMarkers: L.Marker[] = [];
  private inWorldView = false;

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly world:    WorldState,
    private readonly socket:   SocketClient,
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

    // Instance zones (vault: / boss_arena: / dungeon_entry:) have no real
    // geography — show a friendly "no map" panel instead of fetching/
    // rendering stale data from the player's previous overworld zone.
    const zoneId = this.world.zone?.id ?? '';
    const isInstance = zoneId.startsWith('vault:')
      || zoneId.startsWith('boss_arena:')
      || zoneId.startsWith('dungeon_entry:');
    const mapEl   = this.root.querySelector<HTMLElement>('#wm-map');
    const noMapEl = this.root.querySelector<HTMLElement>('#wm-no-map');
    if (mapEl)   mapEl.style.display   = isInstance ? 'none' : '';
    if (noMapEl) noMapEl.style.display = isInstance ? 'flex' : 'none';
    if (isInstance) return;

    if (!this.map) this._initMap();
    else this.map!.invalidateSize();

    // If the player has changed zones since we last fetched, wipe per-zone
    // caches and refetch. Otherwise just snap the viewport back to the player.
    if (this._maybeReloadForZoneChange()) {
      // refetch in flight — viewport will recenter when snapshot lands.
    } else if (this.snapshot) {
      this._recenter();
    }

    // World-zone registry — fetched once, cached for the session. Cheap
    // and rarely changes (new zones are an admin-time event).
    if (!this.worldZones) void this._fetchWorldZones();

    if (this.followTimer === null) {
      this.followTimer = setInterval(() => this._followTick(), FOLLOW_TICK_MS);
    }

    if (!this.subscribed) {
      this.socket.on('map_beacon_update', this._onBeaconUpdate);
      this.socket.on('map_ad_patch',      this._onAdPatch);
      this.socket.sendMapSubscribe();
      this.subscribed = true;
    }
  }

  hide(): void {
    this.root.classList.remove('wm-visible');
    this.root.style.display = 'none';
    this.visible = false;
    if (this.followTimer !== null) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
    if (this.subscribed) {
      this.socket.sendMapUnsubscribe();
      this.socket.off('map_beacon_update', this._onBeaconUpdate);
      this.socket.off('map_ad_patch',      this._onAdPatch);
      this.subscribed = false;
    }
  }

  dispose(): void {
    this.hide();
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
      center: [42.55, -73.38],  // overwritten by fitBounds() once snapshot lands
      zoom: 13,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 },
    ).addTo(this.map);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.attribution({ position: 'bottomleft' }).addTo(this.map);
    this.map.attributionControl?.addAttribution(
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
    );

    // Any user pan/zoom breaks "follow me" — toggle off so we don't fight them.
    this.map.on('dragstart', () => {
      if (this.follow) this._setFollow(false);
    });

    // Zoom threshold flips between in-zone and world-view layer modes.
    this.map.on('zoomend', () => this._handleZoomChange());
  }

  // ── Snapshot fetch + render ────────────────────────────────────────────────

  /** If the player has changed zones since the last snapshot, wipe per-zone
   *  caches and kick off a fresh fetch. Returns true if a reload was triggered
   *  so callers can skip rendering work on this tick. Each renderer's own
   *  clear-then-redraw runs inside _renderAll on the new snapshot, so the
   *  stale leaflet overlays don't need explicit removal here. */
  private _maybeReloadForZoneChange(): boolean {
    const currentZoneId = this.world.zone?.id;
    if (!currentZoneId || currentZoneId === this.fetchedZoneId) return false;
    // Stamp the new id immediately so concurrent ticks don't pile-fetch.
    this.fetchedZoneId  = currentZoneId;
    this.snapshot       = null;
    this.projector      = null;
    this.waterPolyRings = null;
    this.waterLineRings = null;
    this.forestRingsM   = null;
    void this._fetchSnapshot(currentZoneId);
    return true;
  }

  private async _fetchSnapshot(zoneId: string): Promise<void> {
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/api/map/snapshot/${encodeURIComponent(zoneId)}`);
      if (!res.ok) {
        // 404 = snapshot_not_ready (zone hasn't baked yet); other = real error.
        // Either way we just clear and retry next open.
        this.snapshot = null;
        return;
      }
      const data = await res.json() as MapSnapshot;
      this.snapshot = data;
      this.fetchedZoneId = zoneId;
      this.projector = data.origin ? makeProjector(data.origin) : null;
      this._renderAll();
    } catch {
      this.snapshot = null;
    }
  }

  private _renderAll(): void {
    if (!this.map || !this.snapshot || !this.projector) return;
    this._renderZoneRect();
    this._renderAdOverlay();
    this._renderRockOverlay();
    this._renderTreeOverlay();
    this._renderWaterOverlay();
    this._renderForestOverlay();
    this._renderCivic();
    this._renderGuilds();
    this._renderTrainStation();
    this._renderPlayerMarker();
    this._renderAllies();
    this._fitToZone();
  }

  private _renderZoneRect(): void {
    if (!this.map || !this.snapshot || !this.projector) return;
    if (this.zoneRect) { this.zoneRect.remove(); this.zoneRect = null; }
    const { halfX, halfZ } = this.snapshot.bounds;
    const nw = this.projector.worldToLatLng(-halfX, -halfZ);
    const se = this.projector.worldToLatLng( halfX,  halfZ);
    this.zoneRect = L.rectangle(L.latLngBounds(nw, se), {
      color:       'rgba(200,145,60,0.55)',
      weight:      1,
      fillOpacity: 0,
      interactive: false,
    }).addTo(this.map);
  }

  private _renderAdOverlay(): void {
    if (!this.map || !this.snapshot || !this.projector) return;
    if (this.adOverlay) { this.adOverlay.remove(); this.adOverlay = null; }
    if (!this.showAd) return;

    const { res, values } = this.snapshot.adGrid;
    const canvas = document.createElement('canvas');
    canvas.width  = res;
    canvas.height = res;
    const ctx     = canvas.getContext('2d')!;
    const img     = ctx.createImageData(res, res);
    for (let i = 0; i < values.length; i++) {
      const [r, g, b, a] = adColor(values[i] ?? 0);
      img.data[i * 4 + 0] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);

    const { halfX, halfZ } = this.snapshot.bounds;
    const nw = this.projector.worldToLatLng(-halfX, -halfZ);
    const se = this.projector.worldToLatLng( halfX,  halfZ);
    this.adOverlay = L.imageOverlay(canvas.toDataURL(), L.latLngBounds(nw, se), {
      opacity:     1,
      interactive: false,
      // Smooth interpolation on browsers that respect it — softer cells.
      className:   'wm-ad-overlay',
    }).addTo(this.map);
  }

  /** Paint a density grid as a single-color overlay where alpha tracks
   *  the per-cell value 0..1. Per-zone normalisation means values are
   *  comparable within a zone, not across — exactly what the player needs
   *  for "where in *this* zone is the wood/stone thickest". */
  private _renderDensity(
    grid:    Grid,
    rgb:     [number, number, number],
    maxA:    number,
  ): L.ImageOverlay | null {
    if (!this.map || !this.snapshot || !this.projector) return null;

    const { res, values } = grid;
    const canvas = document.createElement('canvas');
    canvas.width  = res;
    canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(res, res);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] ?? 0;
      img.data[i * 4 + 0] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = Math.round(v * maxA);
    }
    ctx.putImageData(img, 0, 0);

    const { halfX, halfZ } = this.snapshot.bounds;
    const nw = this.projector.worldToLatLng(-halfX, -halfZ);
    const se = this.projector.worldToLatLng( halfX,  halfZ);
    return L.imageOverlay(canvas.toDataURL(), L.latLngBounds(nw, se), {
      opacity:     1,
      interactive: false,
      className:   'wm-ad-overlay', // reuse same image-rendering rule
    }).addTo(this.map);
  }

  private _renderRockOverlay(): void {
    if (this.rockOverlay) { this.rockOverlay.remove(); this.rockOverlay = null; }
    if (!this.showRocks || !this.snapshot) return;
    // Warm bone — reads against grey-green AD without competing for "danger"
    // semantics (no reds in the rock palette).
    this.rockOverlay = this._renderDensity(this.snapshot.rockDensity, [225, 215, 195], 160);
  }

  private _renderTreeOverlay(): void {
    if (this.treeOverlay) { this.treeOverlay.remove(); this.treeOverlay = null; }
    if (!this.showTrees || !this.snapshot) return;
    // Forest green — a touch deeper than the AD safe-end so dense forest
    // cells read as forest even when they overlap a low-AD area.
    this.treeOverlay = this._renderDensity(this.snapshot.treeDensity, [45, 110, 55], 160);
  }

  // ── OSM polygon overlays (water, forests) ─────────────────────────────────

  /** Split OSM water features into closed rings (lakes, natural=water) and
   *  open polylines (rivers/streams/drains, waterway=*). Forcing them all
   *  into polygons turns a 50-node stream into a jagged closed blob —
   *  this is what was happening before.  Cached for the session. */
  private async _ensureWaterData(): Promise<void> {
    if (this.waterPolyRings && this.waterLineRings) return;
    const zoneId = this.world.zone?.id;
    if (!zoneId) return;
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/world/water/${encodeURIComponent(zoneId)}`);
      if (!res.ok) { this.waterPolyRings = []; this.waterLineRings = []; return; }
      const features = await res.json() as Array<{
        nodes?: Array<{ lat: number; lon: number }>;
      }>;

      const polys: L.LatLng[][] = [];
      const lines: L.LatLng[][] = [];
      for (const f of features) {
        const nodes = f.nodes ?? [];
        if (nodes.length < 2) continue;
        const ring = nodes.map(n => L.latLng(n.lat, n.lon));
        const first = nodes[0]!, last = nodes[nodes.length - 1]!;
        const closed = first.lat === last.lat && first.lon === last.lon;
        if (closed && ring.length >= 3) polys.push(ring);
        else                            lines.push(ring);
      }
      this.waterPolyRings = polys;
      this.waterLineRings = lines;
    } catch {
      this.waterPolyRings = [];
      this.waterLineRings = [];
    }
  }

  /** Forest polygons (natural=wood / scrub, landuse=forest) arrive in world
   *  metres relative to the zone manifest origin — same projection the
   *  AD/zone-rect already use. We project here lazily so the cache holds
   *  the raw metres in case the projector arrives later. */
  private async _ensureForestData(): Promise<void> {
    if (this.forestRingsM) return;
    const zoneId = this.world.zone?.id;
    if (!zoneId) return;
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/world/osm/${encodeURIComponent(zoneId)}/forests.json`);
      if (!res.ok) { this.forestRingsM = []; return; }
      const features = await res.json() as Array<{ points?: Array<[number, number]> }>;
      this.forestRingsM = features
        .map(f => (f.points ?? []).map(([x, z]) => ({ x, z })))
        .filter(ring => ring.length >= 3);
    } catch {
      this.forestRingsM = [];
    }
  }

  private _renderWaterOverlay(): void {
    if (!this.map) return;
    this.waterPolygons .forEach(p => p.remove());
    this.waterPolylines.forEach(p => p.remove());
    this.waterPolygons  = [];
    this.waterPolylines = [];
    if (!this.showWater) return;

    if (this.waterPolyRings) {
      for (const ring of this.waterPolyRings) {
        const poly = L.polygon(ring, {
          color:       'rgba(120,180,230,0.75)',
          weight:      1,
          fillColor:   'rgba(70, 140, 210, 0.40)',
          fillOpacity: 0.40,
          interactive: false,
        }).addTo(this.map);
        this.waterPolygons.push(poly);
      }
    }
    if (this.waterLineRings) {
      for (const ring of this.waterLineRings) {
        // Slightly thicker + softer than ward circles so a stream reads at
        // strategic zoom but doesn't dominate when zoomed in.
        const line = L.polyline(ring, {
          color:       'rgba(110,170,225,0.75)',
          weight:      2.5,
          opacity:     0.75,
          interactive: false,
        }).addTo(this.map);
        this.waterPolylines.push(line);
      }
    }
  }

  private _renderForestOverlay(): void {
    if (!this.map || !this.projector) return;
    this.forestPolygons.forEach(p => p.remove());
    this.forestPolygons = [];
    if (!this.showForests || !this.forestRingsM) return;
    for (const ringM of this.forestRingsM) {
      const ring = ringM.map(p => this.projector!.worldToLatLng(p.x, p.z));
      const poly = L.polygon(ring, {
        color:       'rgba(110,180,90,0.55)',
        weight:      1,
        fillColor:   'rgba(60,130,55,0.18)',
        fillOpacity: 0.18,
        interactive: false,
      }).addTo(this.map);
      this.forestPolygons.push(poly);
    }
  }

  private _renderCivic(): void {
    if (!this.map || !this.snapshot || !this.projector) return;

    this.anchorMarkers.forEach(m => m.remove());
    this.wardCircles.forEach(c => c.remove());
    this.anchorMarkers = [];
    this.wardCircles = [];

    for (const a of this.snapshot.civicAnchors) {
      const ll = this.projector.worldToLatLng(a.worldX, a.worldZ);
      const icon = L.divIcon({
        className: 'wm-anchor-icon',
        html: a.type === 'TOWNHALL'
          ? '<div class="wm-icon wm-icon-townhall">&#9733;</div>'
          : '<div class="wm-icon wm-icon-civic">&#9830;</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker(ll, { icon })
        .addTo(this.map)
        .bindPopup(`
          <div style="font-family:monospace;font-size:11px;color:#d4c9b8;">
            <strong style="color:#c8913c;">${escapeHtml(a.name)}</strong><br/>
            ${a.type}<br/>
            Ward radius: ${a.wardRadius}m
          </div>
        `, { className: 'wm-popup' });
      marker.setZIndexOffset(900);
      this.anchorMarkers.push(marker);

      const circle = L.circle(ll, {
        radius:      a.wardRadius,
        color:       'rgba(120,210,140,0.55)',
        fillColor:   'rgba(120,210,140,0.06)',
        weight:      1,
        dashArray:   '5,3',
        interactive: false,
      }).addTo(this.map);
      circle.setStyle({
        opacity:     this.showWards ? 1 : 0,
        fillOpacity: this.showWards ? 0.06 : 0,
      });
      this.wardCircles.push(circle);
    }
  }

  private _renderGuilds(): void {
    if (!this.map || !this.snapshot || !this.projector) return;

    this.guildMarkers.forEach(m => m.remove());
    this.guildMarkers = [];

    for (const b of this.snapshot.guildBeacons) {
      const ll = this.projector.worldToLatLng(b.worldX, b.worldZ);
      const icon = L.divIcon({
        className: 'wm-anchor-icon',
        html:      '<div class="wm-icon wm-icon-guild">&#9670;</div>',
        iconSize:  [22, 22],
        iconAnchor: [11, 11],
      });
      const marker = L.marker(ll, { icon })
        .addTo(this.map)
        .bindPopup(`
          <div style="font-family:monospace;font-size:11px;color:#d4c9b8;">
            <strong style="color:#9c7cd9;">${escapeHtml(b.guildName)}</strong><br/>
            Guild Beacon<br/>
            Effect radius: ${b.effectRadius}m
          </div>
        `, { className: 'wm-popup' });
      marker.setZIndexOffset(950);
      this.guildMarkers.push(marker);

      // Effect bubble — purple, distinct from civic green.
      const bubble = L.circle(ll, {
        radius:      b.effectRadius,
        color:       'rgba(160,120,220,0.55)',
        fillColor:   'rgba(160,120,220,0.07)',
        weight:      1,
        dashArray:   '5,3',
        interactive: false,
      }).addTo(this.map);
      // Reuse the wardCircles pool for show/hide so the toggle covers both.
      bubble.setStyle({
        opacity:     this.showWards ? 1 : 0,
        fillOpacity: this.showWards ? 0.07 : 0,
      });
      this.wardCircles.push(bubble);
    }
  }

  private _renderTrainStation(): void {
    if (!this.map || !this.snapshot || !this.projector) return;

    if (this.trainMarker) { this.trainMarker.remove(); this.trainMarker = null; }
    const s = this.snapshot.trainStation;
    if (!s) return;

    const ll = this.projector.worldToLatLng(s.worldX, s.worldZ);
    const icon = L.divIcon({
      className: 'wm-anchor-icon',
      // Train icon. Keep the divIcon shape consistent with civic/guild so
      // hover + popup behave the same. Color: amber to read distinctly from
      // civic green and guild purple.
      html:      '<div class="wm-icon wm-icon-train">&#9981;</div>',
      iconSize:  [22, 22],
      iconAnchor: [11, 11],
    });
    this.trainMarker = L.marker(ll, { icon })
      .addTo(this.map)
      .bindPopup(`
        <div style="font-family:monospace;font-size:11px;color:#d4c9b8;">
          <strong style="color:#ffb060;">${escapeHtml(s.name)}</strong><br/>
          Train Station<br/>
          Press F here or open Travel (R) → Train
        </div>
      `, { className: 'wm-popup' });
    this.trainMarker.setZIndexOffset(975);
  }

  private _renderPlayerMarker(): void {
    if (!this.map || !this.projector) return;
    if (this.playerMarker) { this.playerMarker.remove(); this.playerMarker = null; }

    const pos = this.player.position;
    const ll  = this.projector.worldToLatLng(pos.x, pos.z);
    const icon = L.divIcon({
      className:  'wm-anchor-icon',
      html:       this._playerIconHtml(this.player.heading),
      iconSize:   [22, 22],
      iconAnchor: [11, 11],
    });
    this.playerMarker = L.marker(ll, { icon, interactive: false })
      .addTo(this.map);
    this.playerMarker.setZIndexOffset(1500);
  }

  /** Render dots for party members + companions + hirelings. Hostiles and
   *  wildlife are deliberately excluded — strategic map, not a hunt-tracker
   *  (also see project_map_omits_portables for the anti-grief stance). */
  private _renderAllies(): void {
    if (!this.map || !this.projector) return;

    const myId     = this.entities.playerId;
    const partyIds = new Set(this.player.partyMembers.map(m => m.id));
    const seen     = new Set<string>();

    for (const e of this.entities.getAll()) {
      if (e.id === myId) continue;

      const isParty = partyIds.has(e.id);
      const isAlly  = e.type === 'companion' || e.type === 'npc';
      if (!isParty && !isAlly) continue;
      if (e.isAlive === false) continue;

      seen.add(e.id);
      const ll = this.projector.worldToLatLng(e.position.x, e.position.z);

      let marker = this.allyMarkers.get(e.id);
      if (!marker) {
        const cls = isParty
          ? 'wm-ally-dot wm-ally-party'
          : e.type === 'npc'
            ? 'wm-ally-dot wm-ally-npc'
            : 'wm-ally-dot wm-ally-companion';
        const icon = L.divIcon({
          className: 'wm-anchor-icon',
          html:      `<div class="${cls}" title="${escapeHtml(e.name ?? '')}"></div>`,
          iconSize:  [10, 10],
          iconAnchor: [5, 5],
        });
        marker = L.marker(ll, { icon, interactive: false }).addTo(this.map);
        marker.setZIndexOffset(1200);
        this.allyMarkers.set(e.id, marker);
      } else {
        marker.setLatLng(ll);
      }
    }

    // Reap stale markers — entity left AoI or died.
    for (const [id, marker] of this.allyMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.allyMarkers.delete(id);
      }
    }
  }

  private _playerIconHtml(heading: number): string {
    // PlayerState.heading is DEGREES (per reference_targeting memory:
    // `rotation.y = degToRad(+heading)`). Convention: heading 0 = facing
    // +Z (south), increases counter-clockwise viewed from above through
    // east (+X, 90), north (-Z, 180), west (-X, 270).
    //
    // CSS rotate: 0° = up in DOM (north on the map), increases clockwise.
    // Map: north up. So heading → CSS angle = 180 - heading.
    //   heading   0 (south) → CSS 180° → tip down  ✓
    //   heading  90 (east)  → CSS  90° → tip right ✓
    //   heading 180 (north) → CSS   0° → tip up    ✓
    //   heading 270 (west)  → CSS -90° → tip left  ✓
    //
    // SVG chevron mirrors Minimap's _drawPlayerArrow: pointed tip + notched
    // tail, ~3:1 aspect so heading reads at a glance.
    const deg = 180 - heading;
    return `<div class="wm-player" style="transform:rotate(${deg}deg)">
      <svg viewBox="-10 -12 20 24" width="22" height="22">
        <polygon points="0,-10 4,8 0,5 -4,8"
                 fill="#f0e6d4"
                 stroke="rgba(0,0,0,0.75)"
                 stroke-width="1"
                 stroke-linejoin="round" />
      </svg>
    </div>`;
  }

  // ── World view (zoomed-out, multi-zone) ────────────────────────────────────

  private async _fetchWorldZones(): Promise<void> {
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/api/travel/zones`);
      if (!res.ok) return;
      const data = await res.json() as ZoneRegistryResponse;
      const zones = data.zones ?? {};
      this.worldZones = Object.entries(zones).map(([id, entry]) => ({ id, entry }));
    } catch {
      // Non-fatal — world view just won't have markers, in-zone view works fine.
    }
  }

  /** Zoom changed.  Below threshold, fade in-zone layers + show all-zones
   *  glowing markers; above threshold, restore in-zone layers + clear
   *  world markers. */
  private _handleZoomChange(): void {
    if (!this.map) return;
    const shouldBeWorld = this.map.getZoom() <= WORLD_VIEW_ZOOM;
    if (shouldBeWorld === this.inWorldView) return;
    this.inWorldView = shouldBeWorld;
    this._setInZoneLayersVisible(!shouldBeWorld);
    if (shouldBeWorld) this._renderWorldZones();
    else               this._clearWorldZones();
  }

  /** Toggle visibility AND interactivity of every in-zone layer in one
   *  shot. Opacity alone leaves an invisible-but-clickable hitbox over
   *  world-zone markers stacked on top, so we also flip pointer-events
   *  on the marker DOM. Density layers respect their own toggle — if
   *  rocks/trees are off they stay invisible regardless. */
  private _setInZoneLayersVisible(v: boolean): void {
    if (this.adOverlay)   this.adOverlay.setOpacity(v && this.showAd    ? 1 : 0);
    if (this.rockOverlay) this.rockOverlay.setOpacity(v && this.showRocks ? 1 : 0);
    if (this.treeOverlay) this.treeOverlay.setOpacity(v && this.showTrees ? 1 : 0);
    if (this.zoneRect)    this.zoneRect.setStyle({ opacity: v ? 0.55 : 0, fillOpacity: 0 });

    this.wardCircles.forEach(c => c.setStyle({
      opacity:     v && this.showWards ? 1    : 0,
      fillOpacity: v && this.showWards ? 0.06 : 0,
    }));
    this.waterPolygons.forEach(p => p.setStyle({
      opacity:     v && this.showWater ? 0.75 : 0,
      fillOpacity: v && this.showWater ? 0.40 : 0,
    }));
    this.waterPolylines.forEach(p => p.setStyle({
      opacity:     v && this.showWater ? 0.75 : 0,
    }));
    this.forestPolygons.forEach(p => p.setStyle({
      opacity:     v && this.showForests ? 0.55 : 0,
      fillOpacity: v && this.showForests ? 0.18 : 0,
    }));

    const pe = v ? 'auto' : 'none';
    const apply = (m: L.Marker) => {
      m.setOpacity(v ? 1 : 0);
      const el = m.getElement();
      if (el) el.style.pointerEvents = pe;
    };
    this.anchorMarkers.forEach(apply);
    this.guildMarkers .forEach(apply);
    this.allyMarkers  .forEach(apply);
    if (this.playerMarker) apply(this.playerMarker);

    // Stale popup from a clicked beacon would float over the world view
    // looking nonsensical — close it on the transition.
    if (!v) this.map?.closePopup();
  }

  private _renderWorldZones(): void {
    if (!this.map || !this.worldZones) return;
    this._clearWorldZones();

    const myZoneId = this.world.zone?.id;

    for (const { id, entry } of this.worldZones) {
      if (!entry.center) continue;
      const isCurrent = id === myZoneId;
      const ll = L.latLng(entry.center.lat, entry.center.lon);
      const cls = isCurrent ? 'wm-world-zone wm-world-zone-current' : 'wm-world-zone wm-world-zone-other';
      const placeType = entry.placeType ? entry.placeType : 'zone';
      const name = entry.displayName ?? id;

      const icon = L.divIcon({
        className:  'wm-anchor-icon',
        html:       `<div class="${cls}" title="${escapeHtml(name)}"></div>`,
        iconSize:   [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker(ll, { icon }).addTo(this.map);
      marker.setZIndexOffset(800);

      if (isCurrent) {
        // Click your own zone = dive back in.
        marker.on('click', () => {
          this.map?.setView(ll, IN_ZONE_DEFAULT_ZOOM, { animate: true });
        });
        marker.bindPopup(`
          <div style="font-family:monospace;font-size:11px;color:#d4c9b8;">
            <strong style="color:#e6c060;">${escapeHtml(name)}</strong><br/>
            <em style="color:#a89880;">${escapeHtml(placeType)} — you are here</em><br/>
            <span style="color:#b0a890;">Click to return.</span>
          </div>
        `, { className: 'wm-popup' });
      } else {
        marker.bindPopup(`
          <div style="font-family:monospace;font-size:11px;color:#d4c9b8;min-width:180px;">
            <strong style="color:#9cb8d9;">${escapeHtml(name)}</strong><br/>
            <em style="color:#7a8aa0;">${escapeHtml(placeType)}</em><br/>
            <span style="color:#7a8aa0;font-size:10px;">Travel: rail / ship / air not yet available.</span>
          </div>
        `, { className: 'wm-popup' });
      }

      this.worldZoneMarkers.push(marker);
    }
  }

  private _clearWorldZones(): void {
    this.worldZoneMarkers.forEach(m => m.remove());
    this.worldZoneMarkers = [];
  }

  // ── Live deltas ────────────────────────────────────────────────────────────

  /** Server says a beacon was added/extinguished/etc.  Mutate the snapshot's
   *  guildBeacons list and rerender just the guild markers — civic + AD +
   *  zone rect stay untouched, no flicker. */
  private _applyBeaconUpdate(payload: unknown): void {
    if (!this.snapshot) return;
    const p = payload as { action?: string; beacon?: GuildBeacon; beaconId?: string };

    if (p.action === 'added' && p.beacon) {
      const exists = this.snapshot.guildBeacons.some(b => b.id === p.beacon!.id);
      if (!exists) this.snapshot.guildBeacons.push(p.beacon);
    } else if (p.action === 'removed' && p.beaconId) {
      this.snapshot.guildBeacons = this.snapshot.guildBeacons.filter(b => b.id !== p.beaconId);
    } else {
      return;
    }
    // Civic ward circles share the wardCircles pool with guild bubbles, so
    // we have to repaint civic too — otherwise the cleared+repopulated
    // guild circles mismatch the existing civic circles' show/hide state.
    this._renderCivic();
    this._renderGuilds();
    this._renderTrainStation();
  }

  /** Server says a pile of AD cells changed.  Mutate the values in place
   *  and repaint the AD overlay only.  Cell-by-cell PNG patching would be
   *  fancier but cheaper to just rebake the 64×64 canvas (~4 KB). */
  private _applyAdPatch(payload: unknown): void {
    if (!this.snapshot) return;
    const p = payload as { cells?: { row: number; col: number; value: number }[] };
    if (!p.cells || p.cells.length === 0) return;

    const N      = this.snapshot.adGrid.res;
    const values = this.snapshot.adGrid.values;
    for (const cell of p.cells) {
      const idx = cell.row * N + cell.col;
      if (idx >= 0 && idx < values.length) values[idx] = cell.value;
    }
    this._renderAdOverlay();
  }

  // ── Player follow tick ─────────────────────────────────────────────────────

  private _followTick(): void {
    if (!this.map) return;

    // Catch zone changes while the map is open — without this, the player
    // would walk into a new zone and still see the old zone's terrain /
    // beacons / overlays until they closed and reopened the panel.
    if (this._maybeReloadForZoneChange()) return;

    if (!this.projector) return;

    // Update marker position + heading
    if (this.playerMarker) {
      const ll = this.projector.worldToLatLng(this.player.position.x, this.player.position.z);
      this.playerMarker.setLatLng(ll);
      const html = this._playerIconHtml(this.player.heading);
      const iconEl = this.playerMarker.getElement();
      if (iconEl) iconEl.innerHTML = html;

      if (this.follow) this.map.panTo(ll, { animate: false });
    } else {
      this._renderPlayerMarker();
    }

    this._renderAllies();
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  private _toggleWards(): void {
    this.showWards = !this.showWards;
    const btn = this.root.querySelector<HTMLElement>('#wm-wards-btn');
    if (btn) {
      btn.textContent = this.showWards ? 'Wards: ON' : 'Wards: OFF';
      btn.classList.toggle('wm-active', this.showWards);
    }
    this.wardCircles.forEach(c => {
      c.setStyle({
        opacity:     this.showWards ? 1   : 0,
        fillOpacity: this.showWards ? 0.06 : 0,
      });
    });
  }

  private _toggleAd(): void {
    this.showAd = !this.showAd;
    const btn = this.root.querySelector<HTMLElement>('#wm-ad-btn');
    if (btn) btn.textContent = this.showAd ? 'Aether: ON' : 'Aether: OFF';
    if (btn) btn.classList.toggle('wm-active', this.showAd);
    this._renderAdOverlay();
  }

  private _toggleRocks(): void {
    this.showRocks = !this.showRocks;
    const btn = this.root.querySelector<HTMLElement>('#wm-rocks-btn');
    if (btn) {
      btn.textContent = this.showRocks ? 'Rocks: ON' : 'Rocks: OFF';
      btn.classList.toggle('wm-active', this.showRocks);
    }
    this._renderRockOverlay();
  }

  private _toggleTrees(): void {
    this.showTrees = !this.showTrees;
    const btn = this.root.querySelector<HTMLElement>('#wm-trees-btn');
    if (btn) {
      btn.textContent = this.showTrees ? 'Trees: ON' : 'Trees: OFF';
      btn.classList.toggle('wm-active', this.showTrees);
    }
    this._renderTreeOverlay();
  }

  private async _toggleWater(): Promise<void> {
    this.showWater = !this.showWater;
    const btn = this.root.querySelector<HTMLElement>('#wm-water-btn');
    if (btn) {
      btn.textContent = this.showWater ? 'Water: ON' : 'Water: OFF';
      btn.classList.toggle('wm-active', this.showWater);
    }
    if (this.showWater) await this._ensureWaterData();
    this._renderWaterOverlay();
  }

  private async _toggleForests(): Promise<void> {
    this.showForests = !this.showForests;
    const btn = this.root.querySelector<HTMLElement>('#wm-forests-btn');
    if (btn) {
      btn.textContent = this.showForests ? 'Forests: ON' : 'Forests: OFF';
      btn.classList.toggle('wm-active', this.showForests);
    }
    if (this.showForests) await this._ensureForestData();
    this._renderForestOverlay();
  }

  private _setFollow(on: boolean): void {
    this.follow = on;
    const btn = this.root.querySelector<HTMLElement>('#wm-follow-btn');
    if (btn) {
      btn.textContent = on ? 'Follow: ON' : 'Follow: OFF';
      btn.classList.toggle('wm-active', on);
    }
  }

  private _toggleFollow(): void {
    this._setFollow(!this.follow);
    if (this.follow) this._panToPlayer();
  }

  private _recenter(): void {
    this._setFollow(true);
    this._panToPlayer();
  }

  private _panToPlayer(): void {
    if (!this.map || !this.projector) return;
    const ll = this.projector.worldToLatLng(this.player.position.x, this.player.position.z);
    this.map.panTo(ll, { animate: true });
  }

  private _fitToZone(): void {
    if (!this.map || !this.zoneRect) return;
    this.map.fitBounds(this.zoneRect.getBounds(), { padding: [40, 40], animate: false });
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
        #world-map-panel.wm-visible { pointer-events: auto; }

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
        .wm-ctrl-btn.wm-active {
          background: rgba(80,55,15,0.85);
          color: rgba(230,200,140,1);
          border-color: rgba(220,170,90,0.55);
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

        #wm-map { flex: 1; min-height: 0; }

        #wm-no-map {
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(12, 8, 4, 0.88);
        }
        .wm-no-map-inner {
          text-align: center;
          color: rgba(212, 201, 184, 0.7);
          font-family: var(--font-body, serif);
        }
        .wm-no-map-icon {
          font-size: 48px;
          color: rgba(200, 145, 60, 0.45);
          line-height: 1;
          margin-bottom: 12px;
        }
        .wm-no-map-text {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 4px;
        }
        .wm-no-map-sub {
          font-size: 12px;
          color: rgba(212, 201, 184, 0.4);
        }

        /* Smooth AD overlay — let the browser bilinearly interpolate the
         * 64-cell grid up to display res so the field reads as a gradient
         * rather than discrete cells. */
        .wm-ad-overlay {
          image-rendering: auto;
        }

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
        .wm-legend-bar-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,201,184,0.60);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .wm-legend-bar {
          width: 220px;
          height: 10px;
          border-radius: 2px;
          border: 1px solid rgba(0,0,0,0.4);
          box-shadow: inset 0 0 4px rgba(0,0,0,0.4);
        }
        .wm-legend-tick { white-space: nowrap; }

        .wm-anchor-icon { background: none !important; border: none !important; }
        .wm-icon {
          width: 22px; height: 22px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 50%;
          font-size: 12px;
          text-shadow: 0 1px 3px #000;
          border: 1px solid rgba(255,255,255,0.2);
        }
        .wm-icon-townhall { background: rgba(200,145,60,0.85);  color: #fff; }
        .wm-icon-civic    { background: rgba(120,210,140,0.85); color: #052; }
        .wm-icon-guild    { background: rgba(160,120,220,0.90); color: #fff; }
        .wm-icon-train    { background: rgba(220,140,60,0.92);  color: #fff; }

        .wm-player {
          width: 22px; height: 22px;
          display: flex; align-items: center; justify-content: center;
          transform-origin: 50% 50%;
          filter: drop-shadow(0 0 3px rgba(0,0,0,0.9));
        }

        .wm-ally-dot {
          width: 10px; height: 10px;
          border-radius: 50%;
          border: 1px solid rgba(0,0,0,0.7);
          box-shadow: 0 0 4px rgba(0,0,0,0.7);
        }
        .wm-ally-party     { background: #5cb8ff; }
        .wm-ally-companion { background: #7ed957; }
        .wm-ally-npc       { background: #e8b85e; }

        /* World-view zone markers (visible only when zoomed out). */
        .wm-world-zone {
          width: 16px; height: 16px;
          border-radius: 50%;
          border: 1px solid rgba(0,0,0,0.6);
          cursor: pointer;
          transition: transform 0.15s ease;
        }
        .wm-world-zone:hover { transform: scale(1.25); }
        .wm-world-zone-current {
          background: radial-gradient(circle at 35% 35%, #ffe8a8 0%, #e6c060 55%, #8a6020 100%);
          box-shadow:
            0 0 8px rgba(230,192,96,0.85),
            0 0 18px rgba(230,192,96,0.45);
          animation: wm-pulse-warm 2.4s ease-in-out infinite;
        }
        .wm-world-zone-other {
          background: radial-gradient(circle at 35% 35%, #c8e0ff 0%, #6a90c8 55%, #1f3858 100%);
          box-shadow:
            0 0 6px rgba(110,160,220,0.6),
            0 0 14px rgba(110,160,220,0.3);
          animation: wm-pulse-cool 3.2s ease-in-out infinite;
        }
        @keyframes wm-pulse-warm {
          0%, 100% { box-shadow: 0 0 8px rgba(230,192,96,0.85), 0 0 18px rgba(230,192,96,0.45); }
          50%      { box-shadow: 0 0 12px rgba(230,192,96,1.00), 0 0 28px rgba(230,192,96,0.70); }
        }
        @keyframes wm-pulse-cool {
          0%, 100% { box-shadow: 0 0 6px rgba(110,160,220,0.55), 0 0 14px rgba(110,160,220,0.25); }
          50%      { box-shadow: 0 0 9px rgba(110,160,220,0.80), 0 0 22px rgba(110,160,220,0.45); }
        }

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
        #wm-map .leaflet-control-attribution a { color: rgba(200,145,60,0.6); }
      </style>

      <div id="wm-backdrop"></div>

      <div id="wm-panel">
        <div class="wm-header">
          <span class="wm-title">World Map — Aether Density</span>
          <div class="wm-controls">
            <button class="wm-ctrl-btn wm-active" id="wm-follow-btn">Follow: ON</button>
            <button class="wm-ctrl-btn" id="wm-recenter-btn">Recenter</button>
            <button class="wm-ctrl-btn wm-active" id="wm-wards-btn">Wards: ON</button>
            <button class="wm-ctrl-btn wm-active" id="wm-ad-btn">Aether: ON</button>
            <button class="wm-ctrl-btn" id="wm-rocks-btn">Rocks: OFF</button>
            <button class="wm-ctrl-btn" id="wm-trees-btn">Trees: OFF</button>
            <button class="wm-ctrl-btn" id="wm-water-btn">Water: OFF</button>
            <button class="wm-ctrl-btn" id="wm-forests-btn">Forests: OFF</button>
            <button class="wm-close-btn" id="wm-close-btn">&times;</button>
          </div>
        </div>

        <div id="wm-map"></div>
        <div id="wm-no-map" style="display:none;">
          <div class="wm-no-map-inner">
            <div class="wm-no-map-icon">⊘</div>
            <div class="wm-no-map-text">No map for this area.</div>
            <div class="wm-no-map-sub">Instanced zones don't appear on the world map.</div>
          </div>
        </div>

        <div class="wm-legend">
          <div class="wm-legend-bar-wrap" title="Aether Density — colors mirror the live overlay. Lethal mechanic deferred; threshold shown anyway.">
            <span class="wm-legend-tick">Safe</span>
            <div class="wm-legend-bar" id="wm-legend-bar"></div>
            <span class="wm-legend-tick">Lethal</span>
          </div>
          <div class="wm-legend-item" style="margin-left:auto;">
            <div class="wm-icon wm-icon-townhall" style="width:14px;height:14px;font-size:9px;">&#9733;</div>
            Civic
          </div>
          <div class="wm-legend-item">
            <div class="wm-icon wm-icon-guild" style="width:14px;height:14px;font-size:9px;">&#9670;</div>
            Guild
          </div>
          <div class="wm-legend-item">
            <div class="wm-icon wm-icon-train" style="width:14px;height:14px;font-size:9px;">&#9981;</div>
            Train
          </div>
        </div>
      </div>
    `;

    // Paint the legend bar with the same stops the AD overlay uses.
    const legendBar = el.querySelector<HTMLElement>('#wm-legend-bar');
    if (legendBar) legendBar.style.background = adGradientCss();

    el.querySelector('#wm-close-btn'   )!.addEventListener('click', () => this.hide());
    el.querySelector('#wm-backdrop'    )!.addEventListener('click', () => this.hide());
    el.querySelector('#wm-wards-btn'   )!.addEventListener('click', () => this._toggleWards());
    el.querySelector('#wm-ad-btn'      )!.addEventListener('click', () => this._toggleAd());
    el.querySelector('#wm-rocks-btn'   )!.addEventListener('click', () => this._toggleRocks());
    el.querySelector('#wm-trees-btn'   )!.addEventListener('click', () => this._toggleTrees());
    el.querySelector('#wm-water-btn'   )!.addEventListener('click', () => { void this._toggleWater(); });
    el.querySelector('#wm-forests-btn' )!.addEventListener('click', () => { void this._toggleForests(); });
    el.querySelector('#wm-follow-btn'  )!.addEventListener('click', () => this._toggleFollow());
    el.querySelector('#wm-recenter-btn')!.addEventListener('click', () => this._recenter());

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.visible) this.hide();
    });

    return el;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
