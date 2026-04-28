import type { WorldState }  from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';
import { ClientConfig }      from '@/config/ClientConfig';

// ── Types (mirror highway-network.json) ──────────────────────────────────────

interface TollBooth { lat: number; lon: number; name: string; }

interface RouteStop {
  name:          string;
  placeType:     string;
  lat:           number;
  lon:           number;
  distanceMiles: number;
  direction:     'ahead' | 'behind';
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

interface TravelData {
  zoneId:      string;
  displayName: string;
  routes:      TravelRoute[];
  generated:   string;
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
  private _activeRoute: TravelRoute | null = null;
  private _lastZoneId: string | null = null;
  private _loading = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly world:   WorldState,
    private readonly socket:  SocketClient,
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
      if (this._visible) this._fetchRoutes();
    });
    this.cleanup.push(unsubZone);
  }

  get isVisible(): boolean { return this._visible; }

  toggle(): void { this._visible ? this.hide() : this.show(); }

  show(): void {
    this._visible = true;
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('tp-visible'));
    if (this._routes.length === 0) this._fetchRoutes();
    else this._render();
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
      this._activeRoute = data.routes[0] ?? null;
      this._selected    = null;
      this._render();
    } catch (e) {
      this._showEmpty(`Could not load routes: ${(e as Error).message}`);
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

    if (this._routes.length === 0) {
      body.innerHTML = `<div class="tp-status">No highway routes pass through this zone.</div>`;
      return;
    }

    const activeRoute = (this._activeRoute ?? this._routes[0])!;

    // Split stops into two directions and sort each by distance
    const ahead  = activeRoute.stops.filter(s => s.direction === 'ahead')
                     .sort((a, b) => a.distanceMiles - b.distanceMiles);
    const behind = activeRoute.stops.filter(s => s.direction === 'behind')
                     .sort((a, b) => a.distanceMiles - b.distanceMiles);

    const routeTabsHtml = this._routes.map(r => `
      <button class="tp-route-tab ${r.ref === activeRoute.ref ? 'tp-active' : ''}"
              data-ref="${r.ref}">
        ${r.ref}${r.toll ? ' <span class="tp-toll-badge">TOLL</span>' : ''}
      </button>
    `).join('');

    const stopRowHtml = (stop: RouteStop) => {
      const isSel = this._selected?.stop === stop;
      return `
        <button class="tp-stop-row ${isSel ? 'tp-stop-selected' : ''} ${stop.active ? 'tp-stop-active' : ''}"
                data-ref="${activeRoute.ref}" data-idx="${activeRoute.stops.indexOf(stop)}">
          <span class="tp-stop-name">${stop.name}</span>
          <span class="tp-stop-meta">
            ${stop.tollBooth ? '<span class="tp-toll-icon" title="Toll booth ahead">⚠</span>' : ''}
            ${stop.active ? '<span class="tp-active-icon" title="Playable zone">★</span>' : ''}
            <span class="tp-stop-dist">${stop.distanceMiles} mi</span>
          </span>
        </button>
      `;
    };

    const footerHtml = this._selected ? (() => {
      const { stop } = this._selected;
      return `
        <div class="tp-footer-info">
          <span class="tp-footer-dest">${stop.name}</span>
          <span class="tp-footer-detail">
            ${stop.distanceMiles} miles via ${activeRoute.ref}
            ${stop.tollBooth ? ' · <span class="tp-footer-toll">⚠ toll road</span>' : ' · no toll'}
            ${stop.active ? ' · <span class="tp-footer-active">zone active</span>' : ''}
          </span>
        </div>
        <button class="tp-setout-btn">Set Out</button>
      `;
    })() : `<div class="tp-footer-hint">Select a destination above.</div>`;

    body.innerHTML = `
      <div class="tp-layout">
        <aside class="tp-sidebar">
          <div class="tp-sidebar-label">ROUTES</div>
          <div class="tp-route-tabs">${routeTabsHtml}</div>
        </aside>

        <div class="tp-main">
          <div class="tp-route-header">
            <span class="tp-route-name">${activeRoute.name || activeRoute.ref}</span>
            <span class="tp-route-stops-count">${activeRoute.stops.length} stop${activeRoute.stops.length !== 1 ? 's' : ''}</span>
          </div>

          <div class="tp-columns">
            <div class="tp-direction">
              <div class="tp-dir-label">← Behind</div>
              <div class="tp-stop-list">
                ${behind.length ? behind.map(stopRowHtml).join('') : '<div class="tp-dir-empty">—</div>'}
              </div>
            </div>
            <div class="tp-direction">
              <div class="tp-dir-label">Ahead →</div>
              <div class="tp-stop-list">
                ${ahead.length ? ahead.map(stopRowHtml).join('') : '<div class="tp-dir-empty">—</div>'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="tp-footer">${footerHtml}</div>
    `;

    // Route tab clicks
    body.querySelectorAll<HTMLButtonElement>('.tp-route-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const found = this._routes.find(r => r.ref === btn.dataset.ref);
        if (found) { this._activeRoute = found; this._selected = null; this._render(); }
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

    // Set Out
    body.querySelector<HTMLButtonElement>('.tp-setout-btn')?.addEventListener('click', () => {
      if (this._selected) this._depart(this._selected.route, this._selected.stop);
    });
  }

  private _depart(route: TravelRoute, stop: RouteStop): void {
    this.socket.sendTravelRequest({
      destinationName:   stop.name,
      destinationZoneId: stop.zoneId,
      routeRef:          route.ref,
      distanceMiles:     stop.distanceMiles,
      hasToll:           stop.tollBooth !== null,
    });
    this.hide();
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
          max-height: 80vh;
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
