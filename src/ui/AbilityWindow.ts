/**
 * AbilityWindow — ability tree, loadout, and unlock interface.
 *
 * Two tabs:  Active (36 nodes, T1–T4)  |  Passive (30 nodes, T1–T3)
 *
 * Layout: 6 sector columns × tier rows, each cell = one node button.
 * Below the grid: 8 loadout slots (slot 8 is the capstone slot).
 *
 * Interactions
 *   • Hover node        → tooltip with name / effect / cost
 *   • Click locked node → if affordable & adjacent: confirm-unlock inline
 *   • Click unlocked node → assign to selected loadout slot (or first empty)
 *   • Click loadout slot  → select that slot for assignment  (glow)
 *   • Right-click slot    → clear that slot
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

/** Row layout for active web (sector × row → nodeId suffix). */
const ACTIVE_ROWS: { label: string; suffix: string }[] = [
  { label: 'T1', suffix: 't1'  },
  { label: 'T2', suffix: 't2a' },
  { label: 'T2', suffix: 't2b' },
  { label: 'T3', suffix: 't3a' },
  { label: 'T3', suffix: 't3b' },
  { label: 'T4', suffix: 't4'  },
];

/** Row layout for passive web. */
const PASSIVE_ROWS: { label: string; suffix: string }[] = [
  { label: 'T1', suffix: 't1'  },
  { label: 'T2', suffix: 't2a' },
  { label: 'T2', suffix: 't2b' },
  { label: 'T3', suffix: 't3a' },
  { label: 'T3', suffix: 't3b' },
];

const ACTIVE_SLOT_COUNT  = 8;
const PASSIVE_SLOT_COUNT = 8;

// ── AbilityWindow ─────────────────────────────────────────────────────────────

export class AbilityWindow {
  private root:        HTMLElement;
  private overlay:     HTMLElement;    // tooltip
  private unsubAbility: (() => void) | null = null;

  private activeTab:   'active' | 'passive' = 'active';
  private selectedSlot: number | null = null;  // 1-based, null = auto-assign

  /** Pending unlock confirmation: nodeId to confirm. */
  private pendingUnlock: string | null = null;

  // Cached maps from nodeId → button element (re-built on full refresh)
  private nodeButtons  = new Map<string, HTMLButtonElement>();
  private slotButtons: { active: HTMLButtonElement[]; passive: HTMLButtonElement[] } = {
    active: [], passive: [],
  };

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
        width: 760px;
        max-height: 90vh;
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

      /* ── Sector header row ── */
      #ability-window .aw-grid-wrap {
        display: grid;
        grid-template-columns: 28px repeat(6, 1fr);
        gap: 4px 6px;
      }
      #ability-window .aw-tier-lbl {
        font-size: 9px;
        color: rgba(212, 201, 184, 0.25);
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding-right: 4px;
        letter-spacing: 0.06em;
      }
      #ability-window .aw-col-head {
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-align: center;
        padding: 2px 0 4px;
      }
      #ability-window .aw-gap-row {
        grid-column: 1 / -1;
        height: 4px;
      }

      /* ── Node buttons ── */
      #ability-window .aw-node {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 46px;
        padding: 3px 4px;
        border: 1px solid;
        cursor: default;
        font-family: var(--font-mono);
        text-align: center;
        position: relative;
        transition: filter 0.12s, border-color 0.12s;
        overflow: hidden;
      }
      #ability-window .aw-node-name {
        font-size: 9.5px;
        letter-spacing: 0.04em;
        line-height: 1.2;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #ability-window .aw-node-cost {
        font-size: 8.5px;
        margin-top: 2px;
        letter-spacing: 0.04em;
      }
      #ability-window .aw-node-slot {
        position: absolute;
        top: 2px; right: 3px;
        font-size: 8px;
        opacity: 0.7;
      }

      /* State variants are applied inline via JS for per-sector colour */

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
        max-width: 240px;
        background: rgba(8, 6, 4, 0.96);
        border: 1px solid rgba(200, 145, 60, 0.3);
        padding: 8px 10px;
        font-family: var(--font-mono);
        display: none;
      }
      #ability-tooltip .att-name {
        font-size: 12px;
        color: rgba(212, 201, 184, 0.9);
        margin-bottom: 4px;
      }
      #ability-tooltip .att-meta {
        font-size: 9.5px;
        color: rgba(212, 201, 184, 0.4);
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      #ability-tooltip .att-desc {
        font-size: 10px;
        color: rgba(212, 201, 184, 0.65);
        line-height: 1.4;
        margin-bottom: 5px;
      }
      #ability-tooltip .att-effect {
        font-size: 9.5px;
        color: rgba(200, 145, 60, 0.75);
        line-height: 1.4;
        margin-bottom: 4px;
      }
      #ability-tooltip .att-cost-row {
        font-size: 9.5px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      #ability-tooltip .att-cost-row span {
        color: rgba(212, 201, 184, 0.5);
      }
      #ability-tooltip .att-cost-row .highlight {
        color: rgba(200, 145, 60, 0.85);
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
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.hide());
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
    this.nodeButtons.clear();
    this.slotButtons.active  = [];
    this.slotButtons.passive = [];

    const web       = this.activeTab;
    const rows      = web === 'active' ? ACTIVE_ROWS : PASSIVE_ROWS;
    const manifest  = this._manifestMap();
    const unlocked  = web === 'active'
      ? new Set(this.player.unlockedActiveNodes)
      : new Set(this.player.unlockedPassiveNodes);
    const loadout   = web === 'active' ? this.player.activeLoadout : this.player.passiveLoadout;
    const slotCount = web === 'active' ? ACTIVE_SLOT_COUNT : PASSIVE_SLOT_COUNT;

    // ── Grid ─────────────────────────────────────────────────────────────────
    const grid = document.createElement('div');
    grid.className = 'aw-grid-wrap';

    // Column headers (empty tier-label cell + 6 sector headers)
    const emptyHead = document.createElement('div');
    grid.appendChild(emptyHead);

    for (const sector of SECTORS) {
      const h = document.createElement('div');
      h.className = 'aw-col-head';
      h.style.color = `hsla(${SECTOR_HUE[sector]}, 55%, 62%, 0.65)`;
      h.textContent = SECTOR_LABEL[sector];
      grid.appendChild(h);
    }

    // Node rows
    let prevLabel = '';
    for (const row of rows) {
      // Thin gap between tier groups (T2→T3 etc.)
      if (row.label !== prevLabel && prevLabel !== '') {
        const gap = document.createElement('div');
        gap.className = 'aw-gap-row';
        grid.appendChild(gap);
      }
      prevLabel = row.label;

      const tierLbl = document.createElement('div');
      tierLbl.className = 'aw-tier-lbl';
      tierLbl.textContent = row.label;
      grid.appendChild(tierLbl);

      for (const sector of SECTORS) {
        const nodeId = `${web}_${sector}_${row.suffix}`;
        const node   = manifest.get(nodeId);
        const btn    = this._buildNodeButton(nodeId, node, unlocked, loadout, manifest);
        this.nodeButtons.set(nodeId, btn);
        grid.appendChild(btn);
      }
    }

    content.appendChild(grid);

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
        empty.textContent = '·';
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

  // ── Node button ───────────────────────────────────────────────────────────

  private _buildNodeButton(
    nodeId:   string,
    node:     AbilityNodeSummary | undefined,
    unlocked: Set<string>,
    loadout:  (string | null)[],
    manifest: Map<string, AbilityNodeSummary>,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'aw-node';

    if (!node) {
      // Placeholder for nodes not in manifest yet
      btn.style.borderColor = 'rgba(212,201,184,0.06)';
      btn.style.background  = 'rgba(0,0,0,0.2)';
      btn.style.cursor      = 'default';
      return btn;
    }

    const hue         = SECTOR_HUE[node.sector as Sector] ?? '36';
    const isUnlocked  = unlocked.has(nodeId);
    const slotIdx     = loadout.findIndex(s => s === nodeId);
    const inSlot      = slotIdx !== -1;
    const canAfford   = this.player.abilityPoints >= node.cost;
    const isAdjacent  = this._isAdjacent(nodeId, unlocked, manifest);
    const isTier1     = node.tier === 1;
    const isAvailable = !isUnlocked && (isTier1 || isAdjacent) && canAfford;

    // Visuals
    if (isUnlocked) {
      btn.style.borderColor = `hsla(${hue}, 55%, 55%, 0.7)`;
      btn.style.background  = `hsla(${hue}, 45%, 14%, 0.6)`;
      btn.style.cursor      = 'pointer';
      btn.style.color       = `hsla(${hue}, 60%, 75%, 0.9)`;
    } else if (isAvailable) {
      btn.style.borderColor = `hsla(${hue}, 40%, 40%, 0.45)`;
      btn.style.background  = `hsla(${hue}, 20%, 8%, 0.5)`;
      btn.style.cursor      = 'pointer';
      btn.style.color       = `hsla(${hue}, 40%, 55%, 0.65)`;
    } else {
      btn.style.borderColor = 'rgba(212,201,184,0.08)';
      btn.style.background  = 'rgba(8,6,4,0.4)';
      btn.style.cursor      = 'default';
      btn.style.color       = 'rgba(212,201,184,0.2)';
    }

    // Slot badge
    if (inSlot) {
      const badge = document.createElement('span');
      badge.className   = 'aw-node-slot';
      badge.textContent = String(slotIdx + 1);
      badge.style.color = `hsla(${hue}, 60%, 70%, 0.7)`;
      btn.appendChild(badge);
    }

    const nameLbl = document.createElement('span');
    nameLbl.className   = 'aw-node-name';
    nameLbl.textContent = node.name;
    btn.appendChild(nameLbl);

    const costLbl = document.createElement('span');
    costLbl.className   = 'aw-node-cost';
    costLbl.textContent = `${node.cost} AP`;
    costLbl.style.color = isUnlocked
      ? `hsla(${hue}, 40%, 50%, 0.45)`
      : canAfford ? `hsla(${hue}, 50%, 60%, 0.6)` : 'rgba(212,201,184,0.18)';
    btn.appendChild(costLbl);

    // Tooltip
    btn.addEventListener('mouseenter', (e) => this._showTooltip(e, node, isUnlocked, isAvailable));
    btn.addEventListener('mousemove',  (e) => this._positionTooltip(e));
    btn.addEventListener('mouseleave', ()  => this._hideTooltip());

    // Click
    btn.addEventListener('click', () => {
      if (isUnlocked) {
        this._assignToLoadout(nodeId, this.activeTab);
      } else if (isAvailable) {
        this._requestUnlock(nodeId);
      }
    });

    return btn;
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

  private _onSlotClick(slotNum: number, web: 'active' | 'passive'): void {
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
          // All slots full — do nothing (user should select a slot manually)
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
    meta.textContent = `T${node.tier} · ${webLabel} · ${sectLabel}`;
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
        .join(' · ');
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
      st.style.cssText = 'margin-top:5px;font-size:9px;color:rgba(140,200,100,0.6);';
      st.textContent = '✓ Unlocked';
      o.appendChild(st);
    } else if (!isAvailable) {
      const st = document.createElement('div');
      st.style.cssText = 'margin-top:5px;font-size:9px;color:rgba(212,201,184,0.25);';
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
