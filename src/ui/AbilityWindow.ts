/**
 * AbilityWindow -- ability tree, loadout, and unlock interface.
 *
 * Two tabs:  Active (36 nodes, T1-T4)  |  Passive (30 nodes, T1-T3)
 *
 * Layout: SVG radial web -- 6 sector wedges, concentric tier rings.
 * Below the web: 8 loadout slots (slot 8 is the capstone slot).
 *
 * Interactions
 *   - Hover node        -> tooltip with name / effect / cost
 *   - Click locked node -> if affordable & adjacent: confirm-unlock inline
 *   - Click unlocked node -> assign to selected loadout slot (or first empty)
 *   - Click loadout slot  -> select that slot for assignment  (glow)
 *   - Right-click slot    -> clear that slot
 *
 * Press K (or Escape) to close.
 */

import type { PlayerState }  from '@/state/PlayerState';
import type { SocketClient } from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type { AbilityNodeSummary, AbilityUpdatePayload } from '@/network/Protocol';

// ── Constants ────────────────────────────────────────────────────────────────

const SECTORS   = ['tank', 'phys', 'control', 'magic', 'healer', 'support'] as const;
type Sector = typeof SECTORS[number];

const SECTOR_LABEL: Record<Sector, string> = {
  tank: 'Tank', phys: 'Physical', control: 'Control',
  magic: 'Magic', healer: 'Healer', support: 'Support',
};

const SECTOR_HUE: Record<Sector, string> = {
  tank:    '36',   // amber
  phys:    '15',   // orange-red
  control: '210',  // blue
  magic:   '270',  // purple
  healer:  '140',  // green
  support: '175',  // teal
};

const ACTIVE_SLOT_COUNT  = 8;
const PASSIVE_SLOT_COUNT = 8;

// ── Radial layout constants ──────────────────────────────────────────────────

const SVG_SIZE = 560;
const CX = SVG_SIZE / 2;
const CY = SVG_SIZE / 2;

/** Tier radii (pixels from centre). */
const TIER_RADIUS: Record<number, number> = { 1: 80, 2: 140, 3: 200, 4: 260 };

/** Sector base angles (0 deg = top, clockwise). */
const SECTOR_ANGLE: Record<string, number> = {
  tank: 0, phys: 60, control: 120, magic: 180, healer: 240, support: 300,
};

/** Variant offsets within a sector wedge. */
const VARIANT_OFFSET: Record<string, number> = { '': 0, 'a': -15, 'b': 15 };

/** Active-web row suffixes. */
const ACTIVE_SUFFIXES = ['t1', 't2a', 't2b', 't3a', 't3b', 't4'];
/** Passive-web row suffixes. */
const PASSIVE_SUFFIXES = ['t1', 't2a', 't2b', 't3a', 't3b'];

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseNodeId(id: string): { web: string; sector: string; tier: number; suffix: string } {
  const parts  = id.split('_');
  const web    = parts[0] ?? '';
  const sector = parts[1] ?? '';
  const suffix = parts[2] ?? 't1'; // "t1", "t2a", "t2b", "t3a", "t3b", "t4"
  const tier   = parseInt(suffix.charAt(1), 10);
  return { web, sector, tier, suffix };
}

function nodePosition(sector: string, tier: number, suffix: string): { x: number; y: number } {
  const variant  = suffix.replace(/^t\d/, ''); // extract 'a', 'b', or ''
  const angleDeg = (SECTOR_ANGLE[sector] ?? 0) + (VARIANT_OFFSET[variant] ?? 0) - 90; // -90 so 0 deg = top
  const angleRad = (angleDeg * Math.PI) / 180;
  const r        = TIER_RADIUS[tier] ?? 140;
  return { x: CX + r * Math.cos(angleRad), y: CY + r * Math.sin(angleRad) };
}

// ── AbilityWindow ─────────────────────────────────────────────────────────────

export class AbilityWindow {
  private root:        HTMLElement;
  private overlay:     HTMLElement;    // tooltip
  private unsubAbility: (() => void) | null = null;

  private activeTab:   'active' | 'passive' = 'active';
  private selectedSlot: number | null = null;  // 1-based, null = auto-assign

  /** Pending unlock confirmation: nodeId to confirm. */
  private pendingUnlock: string | null = null;

  // Cached maps from nodeId -> SVG <g> element (re-built on full refresh)
  private nodeGroups   = new Map<string, SVGGElement>();
  private slotButtons: { active: HTMLButtonElement[]; passive: HTMLButtonElement[] } = {
    active: [], passive: [],
  };

  // Zoom / pan state for the radial web
  private _svgEl: SVGSVGElement | null = null;
  private _zoomLevel = 1;
  private _viewBoxX = 0;
  private _viewBoxY = 0;
  private _viewBoxW = SVG_SIZE;
  private _viewBoxH = SVG_SIZE;
  private _dragState: { startX: number; startY: number; vbX: number; vbY: number } | null = null;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root    = document.createElement('div');
    this.overlay = document.createElement('div');
    this._injectStyles();
    this._buildDOM();
    this.mountEl.appendChild(this.root);

    // Subscribe to ability updates so the tree re-renders live
    this.unsubAbility = this.router.onAbilityUpdate((_p: AbilityUpdatePayload) => {
      this._refresh();
    });

    // Start hidden
    this.root.style.display = 'none';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  show(): void {
    this._refresh();
    this.root.style.display = 'flex';
    this.pendingUnlock  = null;
    this.selectedSlot   = null;
    this._updateSlotHighlights();
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  toggle(): void {
    if (this.root.style.display === 'none') this.show();
    else                                    this.hide();
  }

  get isVisible(): boolean { return this.root.style.display !== 'none'; }

  dispose(): void {
    this.unsubAbility?.();
    this.root.remove();
    this.overlay.remove();
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #ability-window {
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        width: 640px;
        max-height: 94vh;
        background: rgba(8, 6, 4, 0.94);
        border: 1px solid rgba(200, 145, 60, 0.35);
        z-index: 800;
        font-family: var(--font-mono);
        user-select: none;
        pointer-events: auto;
        overflow: hidden;
      }

      /* ── Header ── */
      #ability-window .aw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px 0;
        border-bottom: 1px solid rgba(200, 145, 60, 0.18);
        padding-bottom: 8px;
      }
      #ability-window .aw-title {
        font-size: 13px;
        color: rgba(212, 201, 184, 0.85);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      #ability-window .aw-ap {
        font-size: 13px;
        color: rgba(200, 145, 60, 0.9);
        letter-spacing: 0.08em;
      }
      #ability-window .aw-close {
        background: none;
        border: none;
        color: rgba(212, 201, 184, 0.45);
        font-size: 16px;
        cursor: pointer;
        line-height: 1;
        padding: 0 2px;
      }
      #ability-window .aw-close:hover { color: rgba(212, 201, 184, 0.9); }

      /* ── Respec button ── */
      #ability-window .aw-respec-btn {
        font-family: var(--font-mono);
        font-size: 9px;
        background: none;
        border: 1px solid rgba(200, 98, 42, 0.25);
        color: rgba(200, 98, 42, 0.65);
        cursor: pointer;
        padding: 2px 8px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        transition: color 0.12s, border-color 0.12s;
        margin-left: 10px;
      }
      #ability-window .aw-respec-btn:hover {
        color: rgba(200, 98, 42, 0.9);
        border-color: rgba(200, 98, 42, 0.5);
      }

      /* ── Tabs ── */
      #ability-window .aw-tabs {
        display: flex;
        gap: 0;
        padding: 8px 14px 0;
      }
      #ability-window .aw-tab {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 4px 16px 6px;
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(212, 201, 184, 0.4);
        cursor: pointer;
      }
      #ability-window .aw-tab.active {
        color: rgba(212, 201, 184, 0.9);
        border-bottom-color: rgba(200, 145, 60, 0.65);
      }
      #ability-window .aw-tab:hover:not(.active) {
        color: rgba(212, 201, 184, 0.6);
      }

      /* ── Content ── */
      #ability-window .aw-content {
        overflow-y: auto;
        padding: 10px 14px 14px;
        flex: 1;
        min-height: 0;
      }

      /* ── SVG radial web ── */
      #ability-window .aw-svg-wrap {
        width: 560px;
        height: 560px;
        margin: 0 auto;
        overflow: hidden;
      }
      #ability-window .aw-svg-wrap svg {
        width: 100%;
        height: 100%;
      }
      #ability-window .aw-svg-name {
        font-family: var(--font-mono);
        font-size: 8px;
        fill: currentColor;
        pointer-events: none;
      }
      #ability-window .aw-svg-cost {
        font-family: var(--font-mono);
        font-size: 7px;
        fill: currentColor;
        opacity: 0.75;
        pointer-events: none;
      }
      #ability-window .aw-svg-badge {
        font-family: var(--font-mono);
        font-size: 7px;
        fill: currentColor;
        opacity: 0.85;
        pointer-events: none;
      }
      #ability-window .aw-sector-label {
        font-family: var(--font-mono);
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-anchor: middle;
        pointer-events: none;
      }
      #ability-window .aw-edge {
        stroke-width: 1.5;
        pointer-events: none;
      }

      /* ── Loadout row ── */
      #ability-window .aw-loadout {
        margin-top: 12px;
        display: flex;
        gap: 6px;
        align-items: flex-start;
      }
      #ability-window .aw-loadout-label {
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(212, 201, 184, 0.3);
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        padding-bottom: 4px;
        align-self: center;
      }
      #ability-window .aw-slots {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      #ability-window .aw-slot {
        width: 60px;
        height: 52px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(200, 145, 60, 0.22);
        background: rgba(200, 145, 60, 0.04);
        cursor: pointer;
        font-family: var(--font-mono);
        position: relative;
        transition: border-color 0.12s;
      }
      #ability-window .aw-slot:hover {
        border-color: rgba(200, 145, 60, 0.45);
      }
      #ability-window .aw-slot.selected {
        border-color: rgba(200, 145, 60, 0.85);
        background: rgba(200, 145, 60, 0.10);
        box-shadow: 0 0 6px rgba(200, 145, 60, 0.25);
      }
      #ability-window .aw-slot.capstone {
        border-color: rgba(160, 80, 220, 0.35);
        background: rgba(160, 80, 220, 0.05);
      }
      #ability-window .aw-slot.capstone:hover {
        border-color: rgba(160, 80, 220, 0.65);
      }
      #ability-window .aw-slot-num {
        font-size: 8px;
        color: rgba(212, 201, 184, 0.25);
        position: absolute;
        top: 2px; left: 4px;
      }
      #ability-window .aw-slot-name {
        font-size: 9px;
        color: rgba(212, 201, 184, 0.7);
        text-align: center;
        padding: 0 4px;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.2;
        max-width: 100%;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      #ability-window .aw-slot-empty {
        font-size: 18px;
        color: rgba(212, 201, 184, 0.08);
      }

      /* ── Confirm strip (inline unlock confirm) ── */
      #ability-window .aw-confirm {
        margin-top: 8px;
        padding: 8px 10px;
        background: rgba(200, 145, 60, 0.08);
        border: 1px solid rgba(200, 145, 60, 0.28);
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 11px;
        color: rgba(212, 201, 184, 0.75);
      }
      #ability-window .aw-confirm-btn {
        background: rgba(200, 145, 60, 0.18);
        border: 1px solid rgba(200, 145, 60, 0.45);
        color: rgba(212, 201, 184, 0.9);
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.06em;
        padding: 3px 10px;
        cursor: pointer;
      }
      #ability-window .aw-confirm-btn:hover {
        background: rgba(200, 145, 60, 0.3);
      }
      #ability-window .aw-confirm-cancel {
        background: none;
        border: none;
        color: rgba(212, 201, 184, 0.35);
        font-family: var(--font-mono);
        font-size: 10px;
        cursor: pointer;
        padding: 3px 6px;
      }
      #ability-window .aw-confirm-cancel:hover {
        color: rgba(212, 201, 184, 0.65);
      }

      /* ── Tooltip ── */
      #ability-tooltip {
        position: fixed;
        pointer-events: none;
        z-index: 900;
        max-width: 290px;
        background: rgba(8, 6, 4, 0.96);
        border: 1px solid rgba(200, 145, 60, 0.3);
        padding: 10px 12px;
        font-family: var(--font-mono);
        display: none;
      }
      #ability-tooltip .att-name {
        font-size: 15px;
        color: rgba(212, 201, 184, 0.9);
        margin-bottom: 5px;
      }
      #ability-tooltip .att-meta {
        font-size: 11px;
        color: rgba(212, 201, 184, 0.45);
        letter-spacing: 0.06em;
        margin-bottom: 5px;
      }
      #ability-tooltip .att-desc {
        font-size: 12px;
        color: rgba(212, 201, 184, 0.65);
        line-height: 1.45;
        margin-bottom: 6px;
      }
      #ability-tooltip .att-effect {
        font-size: 11.5px;
        color: rgba(200, 145, 60, 0.75);
        line-height: 1.45;
        margin-bottom: 5px;
      }
      #ability-tooltip .att-cost-row {
        font-size: 11.5px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      #ability-tooltip .att-cost-row span {
        color: rgba(212, 201, 184, 0.55);
      }
      #ability-tooltip .att-cost-row .highlight {
        color: rgba(200, 145, 60, 0.9);
      }
    `;
    document.head.appendChild(style);

    // Tooltip element lives on document.body so it's never clipped
    this.overlay.id = 'ability-tooltip';
    document.body.appendChild(this.overlay);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private _buildDOM(): void {
    this.root.id = 'ability-window';

    // Header
    const header = document.createElement('div');
    header.className = 'aw-header';

    const title = document.createElement('span');
    title.className = 'aw-title';
    title.textContent = 'Abilities';
    header.appendChild(title);

    const apLabel = document.createElement('span');
    apLabel.className = 'aw-ap';
    apLabel.id = 'aw-ap-val';
    header.appendChild(apLabel);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'aw-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => this.hide());

    // Respec button (inserted before close)
    const respecBtn = document.createElement('button');
    respecBtn.className = 'aw-respec-btn';
    respecBtn.textContent = 'Respec';
    respecBtn.addEventListener('click', () => {
      if (confirm('Reset all abilities and refund AP? (1 hour cooldown)')) {
        this.socket.sendRespecAbilities();
      }
    });
    header.appendChild(respecBtn);

    header.appendChild(closeBtn);
    this.root.appendChild(header);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'aw-tabs';

    const tabActive  = document.createElement('button');
    const tabPassive = document.createElement('button');
    tabActive.className  = 'aw-tab active';
    tabPassive.className = 'aw-tab';
    tabActive.textContent  = 'Active';
    tabPassive.textContent = 'Passive';
    tabActive.addEventListener('click',  () => this._switchTab('active',  tabActive,  tabPassive));
    tabPassive.addEventListener('click', () => this._switchTab('passive', tabActive,  tabPassive));
    tabs.appendChild(tabActive);
    tabs.appendChild(tabPassive);
    this.root.appendChild(tabs);

    // Content area (rebuilt on each refresh)
    const content = document.createElement('div');
    content.className = 'aw-content';
    content.id = 'aw-content';
    this.root.appendChild(content);

    // ESC closes
    window.addEventListener('keydown', this._onKey);
  }

  private _switchTab(
    tab:     'active' | 'passive',
    tabA:    HTMLButtonElement,
    tabP:    HTMLButtonElement,
  ): void {
    this.activeTab    = tab;
    this.selectedSlot = null;
    this.pendingUnlock = null;
    // Reset zoom when switching tabs
    this._zoomLevel = 1;
    this._viewBoxX = 0;
    this._viewBoxY = 0;
    this._viewBoxW = SVG_SIZE;
    this._viewBoxH = SVG_SIZE;
    tabA.className = tab === 'active'  ? 'aw-tab active' : 'aw-tab';
    tabP.className = tab === 'passive' ? 'aw-tab active' : 'aw-tab';
    this._refresh();
  }

  private _onKey = (e: KeyboardEvent): void => {
    if (!this.isVisible) return;
    if (e.key === 'Escape') this.hide();
  };

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _refresh(): void {
    // Update AP display
    const apEl = document.getElementById('aw-ap-val');
    if (apEl) apEl.textContent = `AP: ${this.player.abilityPoints}`;

    const content = document.getElementById('aw-content');
    if (!content) return;

    content.innerHTML = '';
    this.nodeGroups.clear();
    this.slotButtons.active  = [];
    this.slotButtons.passive = [];

    const web       = this.activeTab;
    const manifest  = this._manifestMap();
    const unlocked  = web === 'active'
      ? new Set(this.player.unlockedActiveNodes)
      : new Set(this.player.unlockedPassiveNodes);
    const loadout   = web === 'active' ? this.player.activeLoadout : this.player.passiveLoadout;
    const slotCount = web === 'active' ? ACTIVE_SLOT_COUNT : PASSIVE_SLOT_COUNT;

    // ── Radial SVG web ────────────────────────────────────────────────────────
    const svgWrap = document.createElement('div');
    svgWrap.className = 'aw-svg-wrap';

    const svg = this._buildRadialWeb(web, manifest, unlocked, loadout);
    svgWrap.appendChild(svg);

    // Apply persisted zoom state & attach zoom/pan handlers
    this._svgEl = svg;
    svg.setAttribute('viewBox', `${this._viewBoxX} ${this._viewBoxY} ${this._viewBoxW} ${this._viewBoxH}`);

    // Wheel zoom (centred on cursor)
    svgWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor  = e.deltaY > 0 ? 1.12 : 0.88;          // scroll-down = zoom out
      const newZoom = Math.min(3, Math.max(0.5, this._zoomLevel / factor));

      const rect = svgWrap.getBoundingClientRect();
      // Mouse position in viewBox coords
      const mx = ((e.clientX - rect.left) / rect.width)  * this._viewBoxW + this._viewBoxX;
      const my = ((e.clientY - rect.top)  / rect.height) * this._viewBoxH + this._viewBoxY;

      const newW = SVG_SIZE / newZoom;
      const newH = SVG_SIZE / newZoom;

      // Keep the cursor point stable
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top)  / rect.height;

      this._viewBoxX = mx - fx * newW;
      this._viewBoxY = my - fy * newH;
      this._viewBoxW = newW;
      this._viewBoxH = newH;
      this._zoomLevel = newZoom;

      this._svgEl?.setAttribute('viewBox',
        `${this._viewBoxX} ${this._viewBoxY} ${this._viewBoxW} ${this._viewBoxH}`);
      svgWrap.style.cursor = this._zoomLevel > 1.05 ? 'grab' : '';
    }, { passive: false });

    // Drag to pan (pointer capture keeps events on svgWrap even if cursor leaves)
    svgWrap.addEventListener('pointerdown', (e) => {
      if (this._zoomLevel <= 1.05) return;
      svgWrap.setPointerCapture(e.pointerId);
      this._dragState = {
        startX: e.clientX, startY: e.clientY,
        vbX: this._viewBoxX, vbY: this._viewBoxY,
      };
      svgWrap.style.cursor = 'grabbing';
    });
    svgWrap.addEventListener('pointermove', (e) => {
      if (!this._dragState) return;
      const rect = svgWrap.getBoundingClientRect();
      const dx = (e.clientX - this._dragState.startX) / rect.width  * this._viewBoxW;
      const dy = (e.clientY - this._dragState.startY) / rect.height * this._viewBoxH;
      this._viewBoxX = this._dragState.vbX - dx;
      this._viewBoxY = this._dragState.vbY - dy;
      this._svgEl?.setAttribute('viewBox',
        `${this._viewBoxX} ${this._viewBoxY} ${this._viewBoxW} ${this._viewBoxH}`);
    });
    svgWrap.addEventListener('pointerup', () => {
      this._dragState = null;
      svgWrap.style.cursor = this._zoomLevel > 1.05 ? 'grab' : '';
    });

    content.appendChild(svgWrap);

    // ── Confirm strip ─────────────────────────────────────────────────────────
    const confirmStrip = document.createElement('div');
    confirmStrip.id = 'aw-confirm-strip';
    confirmStrip.style.display = 'none';
    content.appendChild(confirmStrip);

    if (this.pendingUnlock) {
      this._showConfirmStrip(this.pendingUnlock, manifest, confirmStrip);
    }

    // ── Loadout row ───────────────────────────────────────────────────────────
    const loadoutWrap = document.createElement('div');
    loadoutWrap.className = 'aw-loadout';

    const lbl = document.createElement('div');
    lbl.className = 'aw-loadout-label';
    lbl.textContent = web === 'active' ? 'Loadout' : 'Passives';
    loadoutWrap.appendChild(lbl);

    const slots = document.createElement('div');
    slots.className = 'aw-slots';

    for (let i = 0; i < slotCount; i++) {
      const slotNum  = i + 1;
      const nodeId   = loadout[i] ?? null;
      const node     = nodeId ? manifest.get(nodeId) : null;
      const isCapstone = web === 'active' && slotNum === 8;

      const slotBtn = document.createElement('button');
      slotBtn.className = 'aw-slot' + (isCapstone ? ' capstone' : '');
      slotBtn.title = isCapstone ? 'Capstone slot (T4 only)' : `Slot ${slotNum}`;

      const numLbl = document.createElement('span');
      numLbl.className = 'aw-slot-num';
      numLbl.textContent = String(slotNum);
      slotBtn.appendChild(numLbl);

      if (node) {
        const nameLbl = document.createElement('span');
        nameLbl.className = 'aw-slot-name';
        nameLbl.textContent = node.name;
        nameLbl.style.color = `hsla(${SECTOR_HUE[node.sector as Sector] ?? '36'}, 55%, 65%, 0.85)`;
        slotBtn.appendChild(nameLbl);
      } else {
        const empty = document.createElement('span');
        empty.className = 'aw-slot-empty';
        empty.textContent = '\u00b7';
        slotBtn.appendChild(empty);
      }

      slotBtn.addEventListener('click', () => this._onSlotClick(slotNum, web));
      slotBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._clearSlot(slotNum, web);
      });
      slots.appendChild(slotBtn);

      if (web === 'active') this.slotButtons.active.push(slotBtn);
      else                  this.slotButtons.passive.push(slotBtn);
    }

    loadoutWrap.appendChild(slots);
    content.appendChild(loadoutWrap);

    // Apply current selection highlight
    this._updateSlotHighlights();
  }

  // ── Radial SVG builder ─────────────────────────────────────────────────────

  private _buildRadialWeb(
    web:      'active' | 'passive',
    manifest: Map<string, AbilityNodeSummary>,
    unlocked: Set<string>,
    loadout:  (string | null)[],
  ): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SVG_SIZE} ${SVG_SIZE}`);
    svg.setAttribute('width', String(SVG_SIZE));
    svg.setAttribute('height', String(SVG_SIZE));

    const suffixes = web === 'active' ? ACTIVE_SUFFIXES : PASSIVE_SUFFIXES;
    const maxTier  = web === 'active' ? 4 : 3;

    // Collect all node IDs for this web
    const nodeIds: string[] = [];
    for (const sector of SECTORS) {
      for (const suf of suffixes) {
        nodeIds.push(`${web}_${sector}_${suf}`);
      }
    }

    // Pre-compute positions
    const positions = new Map<string, { x: number; y: number }>();
    for (const id of nodeIds) {
      const { sector, tier, suffix } = parseNodeId(id);
      positions.set(id, nodePosition(sector, tier, suffix));
    }

    // ── 1. Background tier rings ──────────────────────────────────────────────
    for (let t = 1; t <= maxTier; t++) {
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', String(CX));
      ring.setAttribute('cy', String(CY));
      ring.setAttribute('r', String(TIER_RADIUS[t]));
      ring.setAttribute('stroke', 'rgba(200,145,60,0.12)');
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke-width', '1');
      svg.appendChild(ring);
    }

    // ── 2. Sector divider lines ───────────────────────────────────────────────
    // Dividers sit at the midpoints between sector centres: 30, 90, 150, 210, 270, 330 deg
    const outerR = (TIER_RADIUS[maxTier] ?? 200) + 30;
    for (let i = 0; i < 6; i++) {
      const angleDeg = 30 + i * 60 - 90; // -90 to rotate so 0=top
      const angleRad = (angleDeg * Math.PI) / 180;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(CX));
      line.setAttribute('y1', String(CY));
      line.setAttribute('x2', String(CX + outerR * Math.cos(angleRad)));
      line.setAttribute('y2', String(CY + outerR * Math.sin(angleRad)));
      line.setAttribute('stroke', 'rgba(200,145,60,0.09)');
      line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
    }

    // ── 3. Sector labels ──────────────────────────────────────────────────────
    const labelR = (TIER_RADIUS[maxTier] ?? 200) + 22;
    for (const sector of SECTORS) {
      const angleDeg = (SECTOR_ANGLE[sector] ?? 0) - 90;
      const angleRad = (angleDeg * Math.PI) / 180;
      const lx = CX + labelR * Math.cos(angleRad);
      const ly = CY + labelR * Math.sin(angleRad);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(lx));
      text.setAttribute('y', String(ly));
      text.setAttribute('class', 'aw-sector-label');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('fill', `hsla(${SECTOR_HUE[sector]}, 55%, 65%, 0.75)`);
      text.textContent = SECTOR_LABEL[sector];
      svg.appendChild(text);
    }

    // ── 4. Edge connections ───────────────────────────────────────────────────
    // Deduplicate edges: sort pair alphabetically
    const drawnEdges = new Set<string>();
    for (const id of nodeIds) {
      const node = manifest.get(id);
      if (!node) continue;
      const posA = positions.get(id);
      if (!posA) continue;

      for (const adjId of node.adjacentTo) {
        const posB = positions.get(adjId);
        if (!posB) continue; // adjacent node might be in the other web

        const edgeKey = id < adjId ? `${id}|${adjId}` : `${adjId}|${id}`;
        if (drawnEdges.has(edgeKey)) continue;
        drawnEdges.add(edgeKey);

        const aUnlocked = unlocked.has(id);
        const bUnlocked = unlocked.has(adjId);

        let strokeColor: string;
        if (aUnlocked && bUnlocked) {
          strokeColor = 'rgba(200,145,60,0.6)';
        } else if (aUnlocked || bUnlocked) {
          strokeColor = 'rgba(200,145,60,0.3)';
        } else {
          strokeColor = 'rgba(212,201,184,0.12)';
        }

        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(posA.x));
        line.setAttribute('y1', String(posA.y));
        line.setAttribute('x2', String(posB.x));
        line.setAttribute('y2', String(posB.y));
        line.setAttribute('class', 'aw-edge');
        line.setAttribute('stroke', strokeColor);
        svg.appendChild(line);
      }
    }

    // ── 5. Node circles ───────────────────────────────────────────────────────
    for (const id of nodeIds) {
      const node = manifest.get(id);
      const pos  = positions.get(id)!;
      const { tier } = parseNodeId(id);

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-node-id', id);
      g.setAttribute('style', 'cursor:pointer');
      g.setAttribute('transform', `translate(${pos.x},${pos.y})`);

      // Node radius: T1 and T4 are bigger
      const r = (tier === 1 || tier === 4) ? 22 : 18;

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', '0');
      circle.setAttribute('cy', '0');
      circle.setAttribute('r', String(r));

      if (!node) {
        // Placeholder for nodes not in manifest
        circle.setAttribute('fill', 'rgba(0,0,0,0.2)');
        circle.setAttribute('stroke', 'rgba(212,201,184,0.06)');
        circle.setAttribute('stroke-width', '1');
        g.appendChild(circle);
        svg.appendChild(g);
        continue;
      }

      const hue         = SECTOR_HUE[node.sector as Sector] ?? '36';
      const isUnlocked  = unlocked.has(id);
      const slotIdx     = loadout.findIndex(s => s === id);
      const inSlot      = slotIdx !== -1;
      const canAfford   = this.player.abilityPoints >= node.cost;
      const isAdjacent  = this._isAdjacent(id, unlocked, manifest);
      const isTier1     = node.tier === 1;
      const isAvailable = !isUnlocked && (isTier1 || isAdjacent) && canAfford;

      // Circle styling
      if (isUnlocked) {
        circle.setAttribute('fill', `hsla(${hue},50%,18%,0.85)`);
        circle.setAttribute('stroke', `hsla(${hue},60%,62%,0.9)`);
        circle.setAttribute('stroke-width', '2');
        g.setAttribute('style', 'cursor:pointer');
      } else if (isAvailable) {
        circle.setAttribute('fill', `hsla(${hue},25%,12%,0.65)`);
        circle.setAttribute('stroke', `hsla(${hue},45%,48%,0.65)`);
        circle.setAttribute('stroke-width', '1.5');
        g.setAttribute('style', 'cursor:pointer');
      } else {
        circle.setAttribute('fill', 'rgba(20,16,12,0.5)');
        circle.setAttribute('stroke', 'rgba(212,201,184,0.16)');
        circle.setAttribute('stroke-width', '1');
        g.setAttribute('style', 'cursor:default');
      }
      g.appendChild(circle);

      // Text colour
      let textColor: string;
      if (isUnlocked) {
        textColor = `hsla(${hue},65%,80%,0.95)`;
      } else if (isAvailable) {
        textColor = `hsla(${hue},50%,62%,0.8)`;
      } else {
        textColor = 'rgba(212,201,184,0.35)';
      }

      // Name text
      const nameText = document.createElementNS(SVG_NS, 'text');
      nameText.setAttribute('y', '-3');
      nameText.setAttribute('text-anchor', 'middle');
      nameText.setAttribute('dominant-baseline', 'auto');
      nameText.setAttribute('class', 'aw-svg-name');
      nameText.setAttribute('fill', textColor);
      nameText.textContent = node.name;
      g.appendChild(nameText);

      // Cost text
      const costColor = isUnlocked
        ? `hsla(${hue},45%,55%,0.55)`
        : canAfford ? `hsla(${hue},55%,65%,0.75)` : 'rgba(212,201,184,0.3)';
      const costText = document.createElementNS(SVG_NS, 'text');
      costText.setAttribute('y', '8');
      costText.setAttribute('text-anchor', 'middle');
      costText.setAttribute('dominant-baseline', 'auto');
      costText.setAttribute('class', 'aw-svg-cost');
      costText.setAttribute('fill', costColor);
      costText.textContent = `${node.cost} AP`;
      g.appendChild(costText);

      // Slot badge
      if (inSlot) {
        const badge = document.createElementNS(SVG_NS, 'text');
        badge.setAttribute('x', String(r - 8));
        badge.setAttribute('y', String(-(r - 8)));
        badge.setAttribute('class', 'aw-svg-badge');
        badge.setAttribute('fill', `hsla(${hue},65%,75%,0.85)`);
        badge.textContent = String(slotIdx + 1);
        g.appendChild(badge);
      }

      // Events -- attach to the <g> group
      g.addEventListener('mouseenter', (e) => this._showTooltip(e as MouseEvent, node, isUnlocked, isAvailable));
      g.addEventListener('mousemove',  (e) => this._positionTooltip(e as MouseEvent));
      g.addEventListener('mouseleave', ()  => this._hideTooltip());
      g.addEventListener('click', () => {
        if (isUnlocked) {
          this._assignToLoadout(id, this.activeTab);
        } else if (isAvailable) {
          this._requestUnlock(id);
        }
      });

      this.nodeGroups.set(id, g);
      svg.appendChild(g);
    }

    return svg;
  }

  // ── Adjacency check ───────────────────────────────────────────────────────

  private _isAdjacent(
    nodeId:   string,
    unlocked: Set<string>,
    manifest: Map<string, AbilityNodeSummary>,
  ): boolean {
    const node = manifest.get(nodeId);
    if (!node) return false;
    return node.adjacentTo.some(adjId => unlocked.has(adjId));
  }

  // ── Unlock flow ───────────────────────────────────────────────────────────

  private _requestUnlock(nodeId: string): void {
    this.pendingUnlock = nodeId;
    this._refresh();
  }

  private _showConfirmStrip(
    nodeId:   string,
    manifest: Map<string, AbilityNodeSummary>,
    strip:    HTMLElement,
  ): void {
    const node = manifest.get(nodeId);
    if (!node) return;

    strip.style.display = 'flex';
    strip.className = 'aw-confirm';
    strip.innerHTML = '';

    const msg = document.createElement('span');
    msg.textContent = `Unlock "${node.name}" for ${node.cost} AP?`;
    strip.appendChild(msg);

    const yes = document.createElement('button');
    yes.className = 'aw-confirm-btn';
    yes.textContent = 'Unlock';
    yes.addEventListener('click', () => {
      this.socket.sendUnlockAbility(nodeId);
      this.pendingUnlock = null;
    });
    strip.appendChild(yes);

    const no = document.createElement('button');
    no.className = 'aw-confirm-cancel';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => {
      this.pendingUnlock = null;
      strip.style.display = 'none';
    });
    strip.appendChild(no);
  }

  // ── Loadout management ────────────────────────────────────────────────────

  private _onSlotClick(slotNum: number, _web: 'active' | 'passive'): void {
    if (this.selectedSlot === slotNum) {
      // Deselect
      this.selectedSlot = null;
    } else {
      this.selectedSlot = slotNum;
    }
    this._updateSlotHighlights();
  }

  private _assignToLoadout(nodeId: string, web: 'active' | 'passive'): void {
    const slotCount = web === 'active' ? ACTIVE_SLOT_COUNT : PASSIVE_SLOT_COUNT;
    const loadout   = web === 'active' ? this.player.activeLoadout : this.player.passiveLoadout;

    let targetSlot: number;

    if (this.selectedSlot !== null) {
      targetSlot = this.selectedSlot;
    } else {
      // Auto-assign to first empty slot (T4 goes to slot 8, skip slot 8 for others)
      const manifest = this._manifestMap();
      const node = manifest.get(nodeId);
      const isCapstone = node?.tier === 4;

      if (isCapstone && web === 'active') {
        targetSlot = 8;
      } else {
        // Find first empty slot, skip slot 8 for non-capstones
        let found = -1;
        for (let i = 0; i < slotCount; i++) {
          if ((web === 'active' && i === 7) && !isCapstone) continue; // skip capstone slot
          if (!loadout[i]) { found = i + 1; break; }
        }
        if (found === -1) {
          // All slots full -- do nothing (user should select a slot manually)
          return;
        }
        targetSlot = found;
      }
    }

    if (web === 'active') {
      this.socket.sendSlotActiveAbility(targetSlot, nodeId);
    } else {
      this.socket.sendSlotPassiveAbility(targetSlot, nodeId);
    }
    this.selectedSlot = null;
  }

  private _clearSlot(slotNum: number, web: 'active' | 'passive'): void {
    if (web === 'active') {
      this.socket.sendSlotActiveAbility(slotNum, '');
    } else {
      this.socket.sendSlotPassiveAbility(slotNum, '');
    }
  }

  private _updateSlotHighlights(): void {
    const list = this.activeTab === 'active' ? this.slotButtons.active : this.slotButtons.passive;
    list.forEach((btn, i) => {
      const slotNum = i + 1;
      const isCapstone = this.activeTab === 'active' && slotNum === 8;
      const base = 'aw-slot' + (isCapstone ? ' capstone' : '');
      btn.className = base + (this.selectedSlot === slotNum ? ' selected' : '');
    });
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  private _showTooltip(
    e:           MouseEvent,
    node:        AbilityNodeSummary,
    isUnlocked:  boolean,
    isAvailable: boolean,
  ): void {
    const o = this.overlay;
    o.innerHTML = '';

    const name = document.createElement('div');
    name.className = 'att-name';
    const hue = SECTOR_HUE[node.sector as Sector] ?? '36';
    name.style.color = `hsla(${hue}, 55%, 70%, 0.9)`;
    name.textContent = node.name;
    o.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'att-meta';
    const webLabel  = node.web.charAt(0).toUpperCase() + node.web.slice(1);
    const sectLabel = SECTOR_LABEL[node.sector as Sector] ?? node.sector;
    meta.textContent = `T${node.tier} \u00b7 ${webLabel} \u00b7 ${sectLabel}`;
    o.appendChild(meta);

    const desc = document.createElement('div');
    desc.className = 'att-desc';
    desc.textContent = node.description;
    o.appendChild(desc);

    if (node.effectDescription) {
      const eff = document.createElement('div');
      eff.className = 'att-effect';
      eff.textContent = node.effectDescription;
      o.appendChild(eff);
    }

    if (node.statBonuses && Object.keys(node.statBonuses).length) {
      const bonusLines = Object.entries(node.statBonuses)
        .map(([k, v]) => `+${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
        .join(' \u00b7 ');
      const eff = document.createElement('div');
      eff.className = 'att-effect';
      eff.textContent = bonusLines;
      o.appendChild(eff);
    }

    const costs = document.createElement('div');
    costs.className = 'att-cost-row';

    const apSpan = document.createElement('span');
    apSpan.className = 'highlight';
    apSpan.textContent = `${node.cost} AP`;
    costs.appendChild(apSpan);

    if (node.staminaCost) {
      const s = document.createElement('span');
      s.textContent = `${node.staminaCost} STA`;
      costs.appendChild(s);
    }
    if (node.manaCost) {
      const m = document.createElement('span');
      m.textContent = `${node.manaCost} MP`;
      costs.appendChild(m);
    }
    if (node.cooldown) {
      const cd = document.createElement('span');
      cd.textContent = `${node.cooldown}s CD`;
      costs.appendChild(cd);
    }
    if (node.range) {
      const r = document.createElement('span');
      r.textContent = `${node.range}m`;
      costs.appendChild(r);
    }
    if (node.questGate) {
      const q = document.createElement('span');
      q.style.color = 'rgba(212,201,184,0.35)';
      q.textContent = 'Quest-gated';
      costs.appendChild(q);
    }
    o.appendChild(costs);

    if (isUnlocked) {
      const st = document.createElement('div');
      st.style.cssText = 'margin-top:6px;font-size:11px;color:rgba(140,200,100,0.6);';
      st.textContent = '\u2713 Unlocked';
      o.appendChild(st);
    } else if (!isAvailable) {
      const st = document.createElement('div');
      st.style.cssText = 'margin-top:6px;font-size:11px;color:rgba(212,201,184,0.3);';
      st.textContent = this.player.abilityPoints < node.cost
        ? 'Not enough AP'
        : 'Prerequisites not met';
      o.appendChild(st);
    }

    o.style.display = 'block';
    this._positionTooltip(e);
  }

  private _positionTooltip(e: MouseEvent): void {
    const o    = this.overlay;
    const marg = 12;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const w    = o.offsetWidth  || 240;
    const h    = o.offsetHeight || 120;
    let x = e.clientX + marg;
    let y = e.clientY + marg;
    if (x + w > vw) x = e.clientX - w - marg;
    if (y + h > vh) y = e.clientY - h - marg;
    o.style.left = `${x}px`;
    o.style.top  = `${y}px`;
  }

  private _hideTooltip(): void {
    this.overlay.style.display = 'none';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _manifestMap(): Map<string, AbilityNodeSummary> {
    const m = new Map<string, AbilityNodeSummary>();
    for (const node of this.player.abilityManifest) m.set(node.id, node);
    return m;
  }
}
