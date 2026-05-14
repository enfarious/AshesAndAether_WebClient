import type { WorldState }  from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';
import type { SessionState } from '@/state/SessionState';
import { ClientConfig }      from '@/config/ClientConfig';

// ── Types (mirror highway-network.json) ──────────────────────────────────────

interface TollBooth { lat: number; lon: number; name: string; }

type Octant = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

interface RouteStop {
  name:          string;
  placeType:     string;
  lat:           number;
  lon:           number;
  distanceMiles: number;
  /** Legacy OSM-node-ordering relative; not shown in UI but kept for compat. */
  direction:     'ahead' | 'behind';
  /** Compass bearing from zone center. */
  bearingDeg:    number;
  bearingOctant: Octant;
  zoneId:        string | null;
  active:        boolean;
  tollBooth:     TollBooth | null;
}

interface TravelRoute {
  ref:        string;
  name:       string;
  toll:       boolean;
  tollBooths: TollBooth[];
  stops:      RouteStop[];
}

/** Caravan fare: matches the server-side debit in TravelHandler. */
function caravanFare(miles: number): number {
  return miles > 0 ? Math.max(1, Math.ceil(miles * 0.5)) : 0;
}

interface TravelData {
  zoneId:      string;
  displayName: string;
  routes:      TravelRoute[];
  generated:   string;
}

// ── Train tab ───────────────────────────────────────────────────────────────

interface TrainRoute {
  destZoneId:      string;
  destDisplayName: string;
  destStationName: string;
  miles:           number;
  gold:            number;
  bearingDeg:      number;
  bearingOctant:   Octant;
  active:          boolean;
}

interface TrainData {
  zoneId:      string;
  displayName: string;
  station:     { name: string; lat: number; lon: number } | null;
  routes:      TrainRoute[];
  generated:   string;
}

type TravelMode = 'caravan' | 'train';
type TrainSort  = 'distance-asc' | 'distance-desc' | 'fare-asc' | 'name-asc';

/** A single rendered row in the destination list. The canonical `stop`+
 *  `route` is what the player selects on click (shortest-distance route).
 *  `alternativeRoutes` lists ref strings for OTHER highways that also
 *  reach this destination — empty for per-route view, populated in All
 *  view when a destination is on multiple highways. */
interface VisibleEntry {
  stop:              RouteStop;
  route:             TravelRoute;
  alternativeRoutes: string[];
}

// ── TravelPanel ───────────────────────────────────────────────────────────────

/**
 * TravelPanel — highway travel map overlay.
 *
 * Shows which named highways pass through the player's current zone and
 * what towns/cities can be reached along each one.  Toll booths between
 * the zone and each stop are surfaced so players know what they'll owe.
 *
 * Toggle with the R key (Roads).
 */
export class TravelPanel {
  private root:       HTMLElement;
  private _visible  = false;
  private _routes:   TravelRoute[] = [];
  private _selected: { route: TravelRoute; stop: RouteStop } | null = null;
  /** null = "All routes" view; otherwise filter to that route's stops only. */
  private _activeRoute: TravelRoute | null = null;

  // ── Sort + filter state ─────────────────────────────────────────────────
  private _sortMode:     'distance-asc' | 'distance-desc' | 'name-asc' = 'distance-asc';
  /** Empty set = no direction filter (show all). Otherwise stops whose
   *  bearingOctant is in the set are shown. */
  private _octantFilter: Set<Octant> = new Set();
  private _minDistance:  number = 0;
  private _maxDistance:  number | null = null;
  /** Show only stops whose destination zone is already built ("active"). */
  private _activeOnly:   boolean = false;
  private _lastZoneId: string | null = null;
  private _loading = false;
  private cleanup: (() => void)[] = [];

  // ── Tab state ───────────────────────────────────────────────────────────
  private _activeMode:    TravelMode = 'caravan';
  private _trainRoutes:   TrainRoute[] = [];
  private _trainStation:  { name: string; lat: number; lon: number } | null = null;
  private _trainSort:     TrainSort = 'distance-asc';
  private _trainLastZone: string | null = null;

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly world:   WorldState,
    private readonly socket:  SocketClient,
    private readonly session: SessionState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    let _lastZoneId = world.zone?.id;
    const unsubZone = world.onZoneChange(() => {
      const zoneId = world.zone?.id;
      if (zoneId === _lastZoneId) return; // environment-only update (weather, time-of-day)
      _lastZoneId = zoneId;
      this._routes      = [];
      this._selected    = null;
      this._activeRoute = null;
      this._trainRoutes  = [];
      this._trainStation = null;
      if (this._visible) this._fetchForActiveMode();
    });
    this.cleanup.push(unsubZone);

    // Server signal that opens this panel and pre-selects a tab. Fired by
    // F-key on a train_station static interactable (and any future
    // contextual openers). Cheap payload — client fetches the route data
    // itself via the appropriate HTTP endpoint.
    socket.on('open_travel_panel', (payload: unknown) => {
      const tab = (payload as { tab?: TravelMode } | null)?.tab;
      if (tab === 'train' || tab === 'caravan') this._activeMode = tab;
      this.show();
    });
  }

  get isVisible(): boolean { return this._visible; }

  toggle(): void { this._visible ? this.hide() : this.show(); }

  show(): void {
    this._visible = true;
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('tp-visible'));
    this._fetchForActiveMode();
  }

  /** Dispatch the data fetch for whichever tab is active. Caravan reads
   *  /api/travel/routes; Train reads /api/train/destinations. Cached on
   *  the current zone so flipping tabs is instant after first load. */
  private _fetchForActiveMode(): void {
    if (this._activeMode === 'caravan') {
      if (this._routes.length > 0 && this._lastZoneId === this.world.zone?.id) this._render();
      else this._fetchRoutes();
    } else {
      if (this._trainRoutes.length > 0 && this._trainLastZone === this.world.zone?.id) this._render();
      else void this._fetchTrainRoutes();
    }
  }

  hide(): void {
    this._visible = false;
    this.root.classList.remove('tp-visible');
    setTimeout(() => { if (!this._visible) this.root.style.display = 'none'; }, 250);
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private async _fetchRoutes(): Promise<void> {
    const zoneId = this.world.zone?.id;
    if (!zoneId) { this._showEmpty('No zone loaded.'); return; }
    if (zoneId === this._lastZoneId && this._routes.length > 0) { this._render(); return; }

    this._loading = true;
    this._showLoading();

    try {
      const resp = await fetch(`${ClientConfig.serverUrl}/api/travel/routes?zoneId=${encodeURIComponent(zoneId)}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data: TravelData = await resp.json();
      this._routes      = data.routes;
      this._lastZoneId  = zoneId;
      // Default to "All routes" view — players see everything around them
      // by default, and pick a specific route via the sidebar tabs.
      this._activeRoute = null;
      this._selected    = null;
      this._render();
    } catch (e) {
      this._showEmpty(`Could not load routes: ${(e as Error).message}`);
    } finally {
      this._loading = false;
    }
  }

  private async _fetchTrainRoutes(): Promise<void> {
    const zoneId = this.world.zone?.id;
    if (!zoneId) { this._showEmpty('No zone loaded.'); return; }

    this._loading = true;
    this._showLoading();
    try {
      const resp = await fetch(`${ClientConfig.serverUrl}/api/train/destinations?zoneId=${encodeURIComponent(zoneId)}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data: TrainData = await resp.json();
      this._trainRoutes   = data.routes ?? [];
      this._trainStation  = data.station ?? null;
      this._trainLastZone = zoneId;
      this._render();
    } catch (e) {
      this._showEmpty(`Could not load trains: ${(e as Error).message}`);
    } finally {
      this._loading = false;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private _showLoading(): void {
    const body = this.root.querySelector('.tp-body') as HTMLElement;
    if (body) body.innerHTML = `<div class="tp-status">Loading routes…</div>`;
  }

  private _showEmpty(msg: string): void {
    const body = this.root.querySelector('.tp-body') as HTMLElement;
    if (body) body.innerHTML = `<div class="tp-status">${msg}</div>`;
  }

  private _render(): void {
    const zone      = this.world.zone;
    const titleZone = this.root.querySelector('.tp-zone') as HTMLElement;
    if (titleZone) titleZone.textContent = zone?.name ?? zone?.id ?? '';

    const body = this.root.querySelector('.tp-body') as HTMLElement;
    if (!body) return;

    // Tab bar — always rendered above the body so the player can flip
    // between travel modes without re-opening the panel.
    const tabBarHtml = `
      <div class="tp-mode-tabs">
        <button class="tp-mode-tab ${this._activeMode === 'caravan' ? 'tp-active' : ''}" data-mode="caravan">Caravan</button>
        <button class="tp-mode-tab ${this._activeMode === 'train'   ? 'tp-active' : ''}" data-mode="train">Train</button>
        <button class="tp-mode-tab tp-mode-disabled" data-mode="ship" disabled title="Coming soon">Ship</button>
      </div>
    `;

    if (this._activeMode === 'train') {
      body.innerHTML = tabBarHtml + this._renderTrainBody();
      this._wireTabBar(body);
      this._wireTrainBody(body);
      return;
    }

    if (this._routes.length === 0) {
      body.innerHTML = tabBarHtml + `<div class="tp-status">No highway routes pass through this zone.</div>`;
      this._wireTabBar(body);
      return;
    }

    const visible = this._visibleStops();

    // Sidebar: All + per-route tabs.
    const allActive = this._activeRoute === null;
    const routeTabsHtml = `
      <button class="tp-route-tab ${allActive ? 'tp-active' : ''}" data-ref="__ALL__">
        All
      </button>
      ${this._routes.map(r => `
        <button class="tp-route-tab ${r.ref === this._activeRoute?.ref ? 'tp-active' : ''}"
                data-ref="${this._esc(r.ref)}">
          ${this._esc(r.ref)}${r.toll ? ' <span class="tp-toll-badge">TOLL</span>' : ''}
        </button>
      `).join('')}
    `;

    const stopRowHtml = (entry: VisibleEntry) => {
      const { stop, route, alternativeRoutes } = entry;
      const isSel = this._selected?.stop === stop && this._selected?.route === route;
      // Compose the route badge — primary route plus any alternatives in
      // muted text. "US-22 · also US-20, CR-5" reads as "this is shortest,
      // these others also work."
      const altsHtml = alternativeRoutes.length > 0
        ? `<span class="tp-stop-route-alts" title="Also reachable via these routes">+${alternativeRoutes.map((r) => this._esc(r)).join(', ')}</span>`
        : '';
      const fare = caravanFare(stop.distanceMiles);
      return `
        <button class="tp-stop-row ${isSel ? 'tp-stop-selected' : ''} ${stop.active ? 'tp-stop-active' : ''}"
                data-ref="${this._esc(route.ref)}" data-idx="${route.stops.indexOf(stop)}">
          <span class="tp-stop-name">${this._esc(stop.name)}</span>
          <span class="tp-stop-meta">
            <span class="tp-stop-route">${this._esc(route.ref)}</span>
            ${altsHtml}
            ${stop.tollBooth ? '<span class="tp-toll-icon" title="Toll booth ahead">⚠</span>' : ''}
            ${stop.active ? '<span class="tp-active-icon" title="Playable zone">★</span>' : ''}
            <span class="tp-stop-dist">${stop.distanceMiles} mi</span>
            <span class="tp-stop-fare" title="Caravan fare">${fare}g</span>
            <span class="tp-stop-octant" title="${stop.bearingDeg}° from here">${this._esc(stop.bearingOctant)}</span>
          </span>
        </button>
      `;
    };

    const legendHtml = `
      <div class="tp-legend">
        <span class="tp-active-icon">★</span> ready to travel ·
        no ★: one-time build (~5-10 min) — confirm before departing
      </div>
    `;

    const footerHtml = this._selected ? (() => {
      const { stop, route } = this._selected;
      const fare = caravanFare(stop.distanceMiles);
      return `
        <div class="tp-footer-info">
          <span class="tp-footer-dest">${this._esc(stop.name)}</span>
          <span class="tp-footer-detail">
            ${stop.distanceMiles} miles ${this._esc(stop.bearingOctant)} via ${this._esc(route.ref)}
            · <span class="tp-footer-fare">Fare ${fare}g</span>
            ${stop.tollBooth ? ' · <span class="tp-footer-toll">⚠ toll road</span>' : ' · no toll'}
            ${stop.active ? ' · <span class="tp-footer-active">zone active</span>' : ' · <span class="tp-footer-unbuilt">needs build</span>'}
          </span>
        </div>
        ${legendHtml}
        <button class="tp-setout-btn">Set Out</button>
      `;
    })() : `<div class="tp-footer-hint">Select a destination above.</div>${legendHtml}`;

    // Filter chips (compass octants).
    const OCTANTS: Octant[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const octantChipsHtml = OCTANTS.map((o) => `
      <button class="tp-octant-chip ${this._octantFilter.has(o) ? 'tp-active' : ''}" data-octant="${o}">${o}</button>
    `).join('');

    const filtersResetable = this._octantFilter.size > 0
                          || this._minDistance > 0
                          || this._maxDistance != null
                          || this._activeOnly;

    body.innerHTML = tabBarHtml + `
      <div class="tp-layout">
        <aside class="tp-sidebar">
          <div class="tp-sidebar-label">ROUTES</div>
          <div class="tp-route-tabs">${routeTabsHtml}</div>
        </aside>

        <div class="tp-main">
          <div class="tp-filter-bar">
            <div class="tp-filter-row">
              <label class="tp-filter-label">Sort</label>
              <select class="tp-sort-select" id="tp-sort">
                <option value="distance-asc"  ${this._sortMode === 'distance-asc'  ? 'selected' : ''}>Distance · nearest first</option>
                <option value="distance-desc" ${this._sortMode === 'distance-desc' ? 'selected' : ''}>Distance · farthest first</option>
                <option value="name-asc"      ${this._sortMode === 'name-asc'      ? 'selected' : ''}>Name · A → Z</option>
              </select>
              <label class="tp-filter-checkbox">
                <input type="checkbox" id="tp-active-only" ${this._activeOnly ? 'checked' : ''}>
                <span>★ active zones only</span>
              </label>
              ${filtersResetable ? '<button class="tp-filter-reset" id="tp-filter-reset">Reset filters</button>' : ''}
            </div>
            <div class="tp-filter-row">
              <label class="tp-filter-label">Direction</label>
              <div class="tp-octant-chips">${octantChipsHtml}</div>
            </div>
            <div class="tp-filter-row">
              <label class="tp-filter-label">Distance (mi)</label>
              <input type="number" id="tp-min-dist" class="tp-dist-input" placeholder="min" min="0"
                     value="${this._minDistance > 0 ? this._minDistance : ''}">
              <span class="tp-dist-sep">–</span>
              <input type="number" id="tp-max-dist" class="tp-dist-input" placeholder="max" min="0"
                     value="${this._maxDistance ?? ''}">
            </div>
          </div>

          <div class="tp-result-header">
            <span class="tp-result-count">${visible.length} destination${visible.length !== 1 ? 's' : ''}</span>
            ${this._activeRoute ? `<span class="tp-result-route">${this._esc(this._activeRoute.name || this._activeRoute.ref)}</span>` : ''}
          </div>

          <div class="tp-stop-list">
            ${visible.length ? visible.map(stopRowHtml).join('') : '<div class="tp-dir-empty">No destinations match these filters.</div>'}
          </div>
        </div>
      </div>

      <div class="tp-footer">${footerHtml}</div>
    `;

    // ── Wire interactions ──────────────────────────────────────────────────

    this._wireTabBar(body);

    // Route tab clicks (incl. the synthetic "All" tab).
    body.querySelectorAll<HTMLButtonElement>('.tp-route-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const ref = btn.dataset.ref;
        if (ref === '__ALL__') {
          this._activeRoute = null;
        } else {
          const found = this._routes.find(r => r.ref === ref);
          if (found) this._activeRoute = found;
        }
        this._selected = null;
        this._render();
      });
    });

    // Stop row clicks
    body.querySelectorAll<HTMLButtonElement>('.tp-stop-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const route = this._routes.find(r => r.ref === btn.dataset.ref);
        const stop  = route?.stops[Number(btn.dataset.idx)];
        if (route && stop) {
          this._selected = { route, stop };
          this._render();
        }
      });
    });

    // Sort dropdown
    body.querySelector<HTMLSelectElement>('#tp-sort')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value as typeof this._sortMode;
      this._sortMode = v;
      this._render();
    });

    // Active-only checkbox
    body.querySelector<HTMLInputElement>('#tp-active-only')?.addEventListener('change', (e) => {
      this._activeOnly = (e.target as HTMLInputElement).checked;
      this._render();
    });

    // Octant chips toggle
    body.querySelectorAll<HTMLButtonElement>('.tp-octant-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const o = btn.dataset.octant as Octant | undefined;
        if (!o) return;
        if (this._octantFilter.has(o)) this._octantFilter.delete(o);
        else                            this._octantFilter.add(o);
        this._render();
      });
    });

    // Distance inputs — debounced to avoid re-render on every keystroke
    const minInput = body.querySelector<HTMLInputElement>('#tp-min-dist');
    const maxInput = body.querySelector<HTMLInputElement>('#tp-max-dist');
    const onDistChange = () => {
      const minVal = minInput?.value.trim() ?? '';
      const maxVal = maxInput?.value.trim() ?? '';
      this._minDistance = minVal ? Math.max(0, Number(minVal)) : 0;
      this._maxDistance = maxVal ? Math.max(0, Number(maxVal)) : null;
      this._render();
    };
    minInput?.addEventListener('change', onDistChange);
    maxInput?.addEventListener('change', onDistChange);

    // Reset filters
    body.querySelector<HTMLButtonElement>('#tp-filter-reset')?.addEventListener('click', () => {
      this._octantFilter.clear();
      this._minDistance = 0;
      this._maxDistance = null;
      this._activeOnly  = false;
      this._render();
    });

    // Set Out
    body.querySelector<HTMLButtonElement>('.tp-setout-btn')?.addEventListener('click', () => {
      if (this._selected) this._depart(this._selected.route, this._selected.stop);
    });
  }

  /** Apply sort + filter state to the route data and return a list of
   *  rows ready for rendering. In the "All routes" view, destinations
   *  reachable via multiple highways collapse to one row with all route
   *  refs collected — the canonical (shortest) route is the primary
   *  selection, the others are shown inline as alternatives.
   *  Per-route view skips grouping (each stop is unique within its route). */
  private _visibleStops(): VisibleEntry[] {
    const sourceRoutes = this._activeRoute ? [this._activeRoute] : this._routes;
    const flat: Array<{ stop: RouteStop; route: TravelRoute }> = [];
    for (const route of sourceRoutes) {
      for (const stop of route.stops) flat.push({ stop, route });
    }

    const filtered = flat.filter(({ stop }) => {
      if (this._octantFilter.size > 0 && !this._octantFilter.has(stop.bearingOctant)) return false;
      if (this._minDistance > 0 && stop.distanceMiles < this._minDistance) return false;
      if (this._maxDistance != null && stop.distanceMiles > this._maxDistance) return false;
      if (this._activeOnly && !stop.active) return false;
      return true;
    });

    // Per-route view: no grouping, each stop stands alone.
    let entries: VisibleEntry[];
    if (this._activeRoute !== null) {
      entries = filtered.map(({ stop, route }) => ({ stop, route, alternativeRoutes: [] }));
    } else {
      // All view: group by destination identity (name + zoneId). Same town
      // reachable on US-22 and US-20 collapses to one row with both refs.
      // Canonical = shortest-distance route; alternatives are the others.
      const groups = new Map<string, Array<{ stop: RouteStop; route: TravelRoute }>>();
      for (const entry of filtered) {
        const key = `${entry.stop.name}|${entry.stop.zoneId ?? ''}`;
        const g = groups.get(key);
        if (g) g.push(entry);
        else   groups.set(key, [entry]);
      }
      entries = Array.from(groups.values()).map((stops) => {
        stops.sort((a, b) => a.stop.distanceMiles - b.stop.distanceMiles);
        const canonical = stops[0]!;
        return {
          stop: canonical.stop,
          route: canonical.route,
          alternativeRoutes: stops.slice(1).map((s) => s.route.ref),
        };
      });
    }

    entries.sort((a, b) => {
      switch (this._sortMode) {
        case 'distance-asc':  return a.stop.distanceMiles - b.stop.distanceMiles;
        case 'distance-desc': return b.stop.distanceMiles - a.stop.distanceMiles;
        case 'name-asc':      return a.stop.name.localeCompare(b.stop.name);
      }
    });
    return entries;
  }

  // ── Tab bar wiring ────────────────────────────────────────────────────────

  private _wireTabBar(body: HTMLElement): void {
    body.querySelectorAll<HTMLButtonElement>('.tp-mode-tab').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as TravelMode | undefined;
        if (!mode || mode === this._activeMode) return;
        this._activeMode = mode;
        this._selected = null;
        this._fetchForActiveMode();
      });
    });
  }

  // ── Train tab render + wire ───────────────────────────────────────────────

  private _renderTrainBody(): string {
    if (!this._trainStation) {
      return `<div class="tp-status">No train station in this zone. Caravans only — try the Caravan tab.</div>`;
    }

    if (this._trainRoutes.length === 0) {
      return `
        <div class="tp-status">
          ${this._esc(this._trainStation.name)} is open, but no trains run from here today.<br/>
          (Train network rebuild needed? Ask an admin to /baketrains.)
        </div>
      `;
    }

    const sortedRoutes = this._trainRoutes.slice().sort((a, b) => this._compareTrain(a, b));

    const rowsHtml = sortedRoutes.map((r) => `
      <button class="tp-train-row ${r.active ? 'tp-stop-active' : ''}" data-zone="${this._esc(r.destZoneId)}">
        <span class="tp-train-dest">${this._esc(r.destDisplayName)}</span>
        <span class="tp-train-meta">
          <span class="tp-train-station">${this._esc(r.destStationName)}</span>
          <span class="tp-stop-dist">${r.miles} mi</span>
          <span class="tp-stop-fare" title="Train fare">${r.gold}g</span>
          <span class="tp-stop-octant" title="${r.bearingDeg}° from here">${this._esc(r.bearingOctant)}</span>
        </span>
      </button>
    `).join('');

    return `
      <div class="tp-train-layout">
        <div class="tp-train-header">
          <span class="tp-train-station-name">${this._esc(this._trainStation.name)}</span>
          <span class="tp-train-station-sub">${sortedRoutes.length} destination${sortedRoutes.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="tp-filter-bar">
          <div class="tp-filter-row">
            <label class="tp-filter-label">Sort</label>
            <select class="tp-sort-select" id="tp-train-sort">
              <option value="distance-asc"  ${this._trainSort === 'distance-asc'  ? 'selected' : ''}>Distance · nearest first</option>
              <option value="distance-desc" ${this._trainSort === 'distance-desc' ? 'selected' : ''}>Distance · farthest first</option>
              <option value="fare-asc"      ${this._trainSort === 'fare-asc'      ? 'selected' : ''}>Fare · cheapest first</option>
              <option value="name-asc"      ${this._trainSort === 'name-asc'      ? 'selected' : ''}>Name · A → Z</option>
            </select>
          </div>
        </div>
        <div class="tp-stop-list">
          ${rowsHtml}
        </div>
      </div>
    `;
  }

  private _wireTrainBody(body: HTMLElement): void {
    body.querySelector<HTMLSelectElement>('#tp-train-sort')?.addEventListener('change', (e) => {
      this._trainSort = (e.target as HTMLSelectElement).value as TrainSort;
      this._render();
    });
    body.querySelectorAll<HTMLButtonElement>('.tp-train-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const destZoneId = btn.dataset.zone;
        if (!destZoneId) return;
        // Route through /train slash command — server validates the route,
        // debits gold, updates DB position, emits zone_transfer. Panel
        // closes on zone_transfer event.
        this.socket.sendCommand(`/train ${destZoneId}`);
        this.hide();
      });
    });
  }

  private _compareTrain(a: TrainRoute, b: TrainRoute): number {
    switch (this._trainSort) {
      case 'distance-asc':  return a.miles - b.miles;
      case 'distance-desc': return b.miles - a.miles;
      case 'fare-asc':      return a.gold - b.gold;
      case 'name-asc':      return a.destDisplayName.localeCompare(b.destDisplayName);
    }
  }

  private _depart(route: TravelRoute, stop: RouteStop): void {
    // Built zones travel immediately. Unbuilt zones get a confirm modal so
    // the player can choose: cancel, build-and-travel-anyway (flat platform
    // until ready), or build-and-defer (keep playing here, get notified
    // when the zone is ready). Respects the player's time when a build
    // takes ~10 minutes.
    if (stop.active) {
      this._issueTravel(route, stop, /* deferBuild */ false);
      return;
    }
    this._showUnbuiltConfirmModal(route, stop);
  }

  private _issueTravel(route: TravelRoute, stop: RouteStop, deferBuild: boolean): void {
    this.socket.sendTravelRequest({
      destinationName:   stop.name,
      destinationZoneId: stop.zoneId,
      routeRef:          route.ref,
      distanceMiles:     stop.distanceMiles,
      hasToll:           stop.tollBooth !== null,
      deferBuild,
    });
    // Phase change is server-driven now. The server emits zone_transfer
    // (→ loading_world) for built zones, or zone_build_progress (→ stay
    // in_world) for unbuilt zones. Optimistically setting loading_world
    // here was destructive (nulls heightmap, detaches input, resets
    // _loadedZoneId) — when the server rejected with BUILD_IN_PROGRESS or
    // routed to defer instead of transfer, reverting back to in_world
    // re-ran _loadWorldAssets and snapped the player to their DB position.
    // The system_toast the server fires immediately on travel_request
    // covers the 50-500ms feedback gap.
    this.hide();
  }

  private _showUnbuiltConfirmModal(route: TravelRoute, stop: RouteStop): void {
    const modal = document.createElement('div');
    modal.className = 'tp-unbuilt-modal';
    modal.style.cssText = `
      position: absolute; inset: 0;
      background: rgba(8,6,4,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 50; pointer-events: auto;
    `;
    modal.innerHTML = `
      <div style="
        background: var(--ui-bg, rgba(20,15,10,0.98));
        border: 1px solid rgba(200,98,42,0.40);
        padding: 1.6rem 1.6rem 1.2rem; width: min(440px, 92vw);
        display: flex; flex-direction: column; gap: 0.9rem;
      ">
        <div style="font-family: var(--font-display, serif); letter-spacing: 0.18em;
                    color: rgba(200,145,60,0.95); font-size: 1rem; text-transform: uppercase;">
          ${this._esc(stop.name)} — Not Yet Charted
        </div>
        <div style="font-size: 0.88rem; color: rgba(200,180,150,0.85); line-height: 1.5;">
          This zone has never been visited. The map data takes a few minutes to download
          and process. You can travel now and arrive on flat terrain (full terrain loads
          on re-entry), or stay here and we'll build it in the background — you'll get a
          notification when it's ready to visit.
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="cs-btn" id="tp-modal-defer"  style="flex:1; min-width: 120px;">Build &amp; Defer</button>
          <button class="cs-btn" id="tp-modal-now"    style="flex:1; min-width: 120px;
                  background: transparent; color: rgba(200,180,150,0.8);
                  border-color: rgba(200,98,42,0.30);">Travel Now</button>
          <button class="cs-btn" id="tp-modal-cancel" style="flex:1; min-width: 120px;
                  background: transparent; color: rgba(150,120,80,0.7);
                  border-color: rgba(120,90,50,0.30);">Cancel</button>
        </div>
      </div>
    `;

    modal.querySelector('#tp-modal-defer')?.addEventListener('click', () => {
      this._issueTravel(route, stop, /* deferBuild */ true);
      modal.remove();
    });
    modal.querySelector('#tp-modal-now')?.addEventListener('click', () => {
      this._issueTravel(route, stop, /* deferBuild */ false);
      modal.remove();
    });
    modal.querySelector('#tp-modal-cancel')?.addEventListener('click', () => {
      modal.remove();
    });

    this.root.appendChild(modal);
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── DOM build ─────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'travel-panel';
    el.innerHTML = `
      <style>
        #travel-panel {
          position: fixed;
          inset: 0;
          display: none;
          opacity: 0;
          transition: opacity 0.2s ease;
          z-index: 600;
          pointer-events: auto;
          background: rgba(4, 3, 2, 0.88);
          font-family: var(--font-body, serif);
          color: rgba(210, 185, 140, 0.95);
        }
        #travel-panel.tp-visible { opacity: 1; }

        .tp-panel {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(820px, 94vw);
          /* Fixed height so the panel doesn't reflow when you switch
           *  between highways with different stop counts. The stop list
           *  inside (.tp-stop-list) scrolls when contents overflow. */
          height: min(720px, 85vh);
          display: flex;
          flex-direction: column;
          background: rgba(10, 8, 5, 0.97);
          border: 1px solid rgba(200, 145, 60, 0.25);
          border-radius: 5px;
          box-shadow: 0 8px 40px rgba(0,0,0,0.7);
          overflow: hidden;
        }

        /* ── Header ── */
        .tp-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 18px 10px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.15);
          background: rgba(6, 5, 3, 0.6);
          flex-shrink: 0;
        }
        .tp-title {
          font-size: 11px;
          letter-spacing: 2.5px;
          text-transform: uppercase;
          color: rgba(200, 145, 60, 0.70);
          font-family: var(--font-mono, monospace);
        }
        .tp-zone {
          font-size: 14px;
          font-weight: 600;
          color: rgba(240, 210, 150, 0.95);
          flex: 1;
        }
        .tp-close-btn {
          background: none;
          border: none;
          color: rgba(200, 145, 60, 0.50);
          font-size: 18px;
          cursor: pointer;
          line-height: 1;
          padding: 2px 6px;
          border-radius: 3px;
          transition: color 0.15s, background 0.15s;
        }
        .tp-close-btn:hover {
          color: rgba(200, 145, 60, 0.95);
          background: rgba(200, 145, 60, 0.10);
        }

        /* ── Body ── */
        .tp-body {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .tp-status {
          padding: 40px;
          text-align: center;
          color: rgba(180, 155, 110, 0.55);
          font-size: 13px;
        }

        /* ── Mode tabs (Caravan / Train / Ship) ── */
        .tp-mode-tabs {
          display: flex;
          gap: 2px;
          padding: 10px 14px 0;
          border-bottom: 1px solid rgba(200, 145, 60, 0.18);
          flex-shrink: 0;
        }
        .tp-mode-tab {
          background: transparent;
          border: 1px solid rgba(200, 145, 60, 0.28);
          border-bottom: none;
          color: rgba(220, 200, 170, 0.75);
          padding: 8px 18px;
          cursor: pointer;
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          transition: background 0.12s, color 0.12s;
        }
        .tp-mode-tab:hover:not(:disabled) {
          background: rgba(120, 80, 38, 0.35);
          color: rgba(245, 215, 150, 0.95);
        }
        .tp-mode-tab.tp-active {
          background: rgba(120, 80, 38, 0.55);
          color: rgba(255, 225, 150, 1);
          border-color: rgba(220, 170, 100, 0.55);
        }
        .tp-mode-tab.tp-mode-disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        /* ── Train tab body ── */
        .tp-train-layout {
          display: flex;
          flex-direction: column;
          flex: 1;
          overflow: hidden;
          min-height: 0;
          padding: 14px 18px 10px;
        }
        .tp-train-header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.18);
          margin-bottom: 8px;
        }
        .tp-train-station-name {
          font-family: var(--font-display, serif);
          font-size: 17px;
          color: rgba(255, 225, 150, 1);
          letter-spacing: 0.04em;
        }
        .tp-train-station-sub {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(210, 185, 140, 0.75);
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .tp-train-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          padding: 9px 12px;
          background: rgba(30, 22, 14, 0.6);
          border: 1px solid rgba(120, 90, 55, 0.3);
          font-family: var(--font-mono, monospace);
          color: rgba(240, 225, 200, 1);
          cursor: pointer;
          width: 100%;
          text-align: left;
        }
        .tp-train-row:hover {
          background: rgba(80, 50, 18, 0.5);
          border-color: rgba(220, 170, 100, 0.55);
        }
        .tp-train-dest {
          color: #fff0d6;
          font-weight: 600;
          font-size: 14px;
        }
        .tp-train-meta {
          display: flex;
          gap: 12px;
          align-items: center;
          font-size: 12px;
          color: rgba(220, 205, 180, 0.92);
        }
        .tp-train-station {
          color: rgba(200, 220, 240, 0.92);
          font-size: 11px;
        }

        /* ── Layout ── */
        .tp-layout {
          display: flex;
          flex: 1;
          overflow: hidden;
          min-height: 0;
        }

        /* ── Sidebar ── */
        .tp-sidebar {
          width: 130px;
          flex-shrink: 0;
          border-right: 1px solid rgba(200, 145, 60, 0.12);
          display: flex;
          flex-direction: column;
          padding: 14px 0 10px;
          overflow-y: auto;
        }
        .tp-sidebar-label {
          font-size: 9px;
          letter-spacing: 2px;
          color: rgba(180, 145, 90, 0.45);
          padding: 0 14px 8px;
          font-family: var(--font-mono, monospace);
        }
        .tp-route-tabs {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 0 8px;
        }
        .tp-route-tab {
          background: none;
          border: 1px solid transparent;
          border-radius: 3px;
          padding: 7px 10px;
          text-align: left;
          color: rgba(200, 175, 125, 0.70);
          font-size: 12px;
          font-family: var(--font-mono, monospace);
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, color 0.12s;
        }
        .tp-route-tab:hover {
          background: rgba(200, 145, 60, 0.08);
          color: rgba(220, 190, 135, 0.95);
        }
        .tp-route-tab.tp-active {
          background: rgba(200, 145, 60, 0.12);
          border-color: rgba(200, 145, 60, 0.30);
          color: rgba(240, 210, 150, 0.97);
        }
        .tp-toll-badge {
          font-size: 9px;
          letter-spacing: 1px;
          color: rgba(220, 120, 40, 0.80);
          vertical-align: middle;
        }

        /* ── Main panel ── */
        .tp-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-width: 0;
        }
        .tp-route-header {
          display: flex;
          align-items: baseline;
          gap: 10px;
          padding: 12px 18px 8px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.10);
          flex-shrink: 0;
        }
        .tp-route-name {
          font-size: 13px;
          font-weight: 600;
          color: rgba(235, 205, 140, 0.95);
        }
        .tp-route-stops-count {
          font-size: 11px;
          color: rgba(180, 155, 105, 0.50);
        }

        /* ── Two-column stop layout ── */
        .tp-columns {
          display: flex;
          flex: 1;
          overflow: hidden;
          min-height: 0;
        }
        .tp-direction {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border-right: 1px solid rgba(200, 145, 60, 0.08);
        }
        .tp-direction:last-child { border-right: none; }
        .tp-dir-label {
          font-size: 9px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: rgba(180, 145, 90, 0.45);
          padding: 8px 14px 4px;
          font-family: var(--font-mono, monospace);
          flex-shrink: 0;
        }
        .tp-dir-empty {
          padding: 10px 14px;
          color: rgba(160, 135, 90, 0.30);
          font-size: 12px;
        }
        .tp-stop-list {
          flex: 1;
          overflow-y: auto;
          padding: 4px 6px 6px;
        }
        .tp-stop-list::-webkit-scrollbar { width: 4px; }
        .tp-stop-list::-webkit-scrollbar-track { background: transparent; }
        .tp-stop-list::-webkit-scrollbar-thumb { background: rgba(200, 145, 60, 0.20); border-radius: 2px; }

        /* ── Stop rows ── */
        .tp-stop-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          width: 100%;
          padding: 7px 10px;
          background: none;
          border: 1px solid transparent;
          border-radius: 3px;
          cursor: pointer;
          text-align: left;
          color: rgba(200, 175, 125, 0.75);
          font-family: var(--font-body, serif);
          font-size: 12px;
          transition: background 0.10s, border-color 0.10s, color 0.10s;
          margin-bottom: 1px;
        }
        .tp-stop-row:hover {
          background: rgba(200, 145, 60, 0.07);
          color: rgba(225, 195, 135, 0.95);
        }
        .tp-stop-row.tp-stop-selected {
          background: rgba(200, 145, 60, 0.15);
          border-color: rgba(200, 145, 60, 0.35);
          color: rgba(245, 215, 150, 1.0);
        }
        .tp-stop-row.tp-stop-active .tp-stop-name {
          color: rgba(100, 200, 120, 0.90);
        }
        .tp-stop-row.tp-stop-selected.tp-stop-active .tp-stop-name {
          color: rgba(120, 220, 140, 1.0);
        }
        .tp-stop-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tp-stop-meta { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
        .tp-stop-dist {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(165, 140, 90, 0.65);
        }
        .tp-toll-icon { font-size: 11px; color: rgba(220, 140, 40, 0.80); }
        .tp-active-icon { font-size: 10px; color: rgba(100, 200, 120, 0.80); }
        .tp-stop-route {
          font-family: var(--font-mono, monospace);
          font-size: 9.5px;
          letter-spacing: 0.04em;
          padding: 1px 5px;
          border: 1px solid rgba(200, 145, 60, 0.25);
          border-radius: 2px;
          color: rgba(200, 175, 125, 0.85);
          background: rgba(8, 6, 4, 0.40);
        }
        .tp-stop-route-alts {
          font-family: var(--font-mono, monospace);
          font-size: 9px;
          color: rgba(150, 130, 90, 0.55);
          letter-spacing: 0.02em;
          margin-left: -2px;
        }
        .tp-stop-octant {
          font-family: var(--font-mono, monospace);
          font-size: 9.5px;
          font-weight: 700;
          color: rgba(180, 200, 220, 0.78);
          min-width: 22px;
          text-align: center;
          letter-spacing: 0.05em;
        }

        /* ── Filter bar ── */
        .tp-filter-bar {
          padding: 8px 14px 6px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.10);
          background: rgba(8, 6, 4, 0.30);
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .tp-filter-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          min-height: 24px;
        }
        .tp-filter-label {
          font-family: var(--font-mono, monospace);
          font-size: 9.5px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: rgba(160, 135, 90, 0.60);
          min-width: 64px;
        }
        .tp-sort-select {
          background: rgba(14, 10, 6, 0.80);
          border: 1px solid rgba(200, 145, 60, 0.25);
          color: rgba(212, 195, 155, 0.95);
          font-family: var(--font-body, serif);
          font-size: 11.5px;
          padding: 3px 6px;
          outline: none;
        }
        .tp-sort-select:focus { border-color: rgba(200, 145, 60, 0.55); }
        .tp-filter-checkbox {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: rgba(180, 160, 110, 0.80);
          cursor: pointer;
        }
        .tp-filter-checkbox input { cursor: pointer; }
        .tp-filter-reset {
          background: rgba(120, 80, 40, 0.18);
          border: 1px solid rgba(180, 100, 50, 0.45);
          color: rgba(220, 170, 110, 0.85);
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          letter-spacing: 0.05em;
          padding: 3px 8px;
          cursor: pointer;
          margin-left: auto;
        }
        .tp-filter-reset:hover {
          background: rgba(180, 100, 50, 0.28);
          color: rgba(240, 200, 130, 0.95);
        }
        .tp-octant-chips {
          display: flex;
          gap: 3px;
          flex-wrap: wrap;
        }
        .tp-octant-chip {
          background: rgba(14, 10, 6, 0.65);
          border: 1px solid rgba(200, 145, 60, 0.25);
          color: rgba(180, 160, 110, 0.75);
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          font-weight: 700;
          padding: 3px 8px;
          min-width: 30px;
          cursor: pointer;
          letter-spacing: 0.05em;
          transition: background 0.10s, border-color 0.10s, color 0.10s;
        }
        .tp-octant-chip:hover {
          border-color: rgba(200, 145, 60, 0.55);
          color: rgba(220, 195, 140, 0.95);
        }
        .tp-octant-chip.tp-active {
          background: rgba(200, 145, 60, 0.22);
          border-color: rgba(220, 165, 80, 0.70);
          color: rgba(240, 215, 150, 0.98);
        }
        .tp-dist-input {
          background: rgba(14, 10, 6, 0.80);
          border: 1px solid rgba(200, 145, 60, 0.25);
          color: rgba(212, 195, 155, 0.95);
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          padding: 3px 6px;
          width: 60px;
          outline: none;
        }
        .tp-dist-input:focus { border-color: rgba(200, 145, 60, 0.55); }
        .tp-dist-sep {
          color: rgba(160, 135, 90, 0.60);
          font-family: var(--font-mono, monospace);
        }

        /* ── Result header (count + active route name) ── */
        .tp-result-header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 6px 14px 2px;
        }
        .tp-result-count {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(160, 135, 90, 0.65);
          letter-spacing: 0.06em;
        }
        .tp-result-route {
          font-family: var(--font-display, serif);
          font-size: 12px;
          color: rgba(220, 180, 120, 0.80);
          letter-spacing: 0.10em;
          text-transform: uppercase;
        }

        /* ── Footer ── */
        .tp-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 18px 12px;
          border-top: 1px solid rgba(200, 145, 60, 0.15);
          background: rgba(6, 5, 3, 0.50);
          flex-shrink: 0;
          min-height: 52px;
        }
        .tp-footer-hint {
          font-size: 12px;
          color: rgba(160, 135, 90, 0.40);
        }
        .tp-footer-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
        }
        .tp-footer-dest {
          font-size: 14px;
          font-weight: 600;
          color: rgba(240, 210, 150, 0.97);
        }
        .tp-footer-detail {
          font-size: 11px;
          color: rgba(175, 150, 100, 0.65);
        }
        .tp-footer-toll  { color: rgba(220, 130, 40, 0.85); }
        .tp-footer-active { color: rgba(100, 200, 120, 0.80); }
        .tp-footer-unbuilt { color: rgba(220, 160, 90, 0.85); font-style: italic; }
        .tp-legend {
          font-size: 10.5px;
          color: rgba(160, 140, 100, 0.65);
          font-style: italic;
          padding: 4px 0 6px;
          line-height: 1.4;
        }
        .tp-legend .tp-active-icon { font-style: normal; font-size: 11px; }

        .tp-setout-btn {
          background: rgba(200, 145, 60, 0.18);
          border: 1px solid rgba(200, 145, 60, 0.40);
          border-radius: 3px;
          color: rgba(240, 210, 140, 0.95);
          padding: 8px 22px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          font-family: var(--font-body, serif);
          letter-spacing: 0.5px;
          transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
          white-space: nowrap;
        }
        .tp-setout-btn:hover {
          background: rgba(200, 145, 60, 0.32);
          border-color: rgba(200, 145, 60, 0.65);
          box-shadow: 0 0 10px rgba(200, 145, 60, 0.15);
        }
      </style>

      <div class="tp-panel">
        <div class="tp-header">
          <span class="tp-title">Travel</span>
          <span class="tp-zone"></span>
          <button class="tp-close-btn" title="Close (R)">✕</button>
        </div>
        <div class="tp-body"></div>
      </div>
    `;

    el.querySelector('.tp-close-btn')?.addEventListener('click', () => this.hide());
    // Click backdrop to close
    el.addEventListener('click', e => { if (e.target === el) this.hide(); });

    return el;
  }
}
