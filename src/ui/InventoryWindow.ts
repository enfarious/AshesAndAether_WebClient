import type { PlayerState }  from '@/state/PlayerState';
import type { SocketClient } from '@/network/SocketClient';
import type { ItemInfo, EquipSlot } from '@/network/Protocol';
import { EQUIP_SLOTS, EQUIP_SLOT_LABELS } from '@/network/Protocol';

/**
 * InventoryWindow — a modal panel showing the character's 40-slot inventory
 * and equipment slots, with weapon-set swap and toggleable self-sort.
 *
 * Press I (or call toggle()) to open/close.
 * Pure HTML/CSS over the canvas — Three.js not involved.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

const ITEM_TYPE_SORT_ORDER: Record<string, number> = {
  weapon: 0, sword: 0, axe: 0, staff: 0, wand: 0, bow: 0, dagger: 0,
  shield: 1, offhand: 1,
  armor: 2, body: 2, chest: 2, helm: 2, head: 2, gloves: 2, hands: 2,
  pants: 2, legs: 2, boots: 2, feet: 2,
  necklace: 3, amulet: 3, bracelet: 3, wrist: 3, ring: 3, jewelry: 3,
  consumable: 4, potion: 4, food: 4,
  misc: 5,
};

function sortOrder(itemType: string): number {
  return ITEM_TYPE_SORT_ORDER[itemType.toLowerCase()] ?? 5;
}

// ── Layout helpers ───────────────────────────────────────────────────────────

/** Logical order for equipment slot display on the right panel */
const EQUIP_LAYOUT: { label: string; slots: EquipSlot[] }[] = [
  { label: 'Head',      slots: ['head'] },
  { label: 'Body',      slots: ['body'] },
  { label: 'Hands',     slots: ['hands'] },
  { label: 'Legs',      slots: ['legs'] },
  { label: 'Feet',      slots: ['feet'] },
  { label: 'Necklace',  slots: ['necklace'] },
  { label: 'Bracelet',  slots: ['bracelet'] },
  { label: 'Ring',      slots: ['ring1', 'ring2'] },
  { label: 'Weapon Set 1', slots: ['mainhand', 'offhand'] },
  { label: 'Weapon Set 2', slots: ['mainhand2', 'offhand2'] },
];

export class InventoryWindow {
  private root:    HTMLElement;
  private visible  = false;
  private autoSort = true;

  /** slotIndex → itemId mapping for manual arrangement (40 slots) */
  private _slotMap: (string | null)[] = new Array(40).fill(null);
  /** Whether the slot map has been loaded from localStorage yet */
  private _slotMapLoaded = false;
  /** Index of the currently "held" slot (picked up via left-click) */
  private _heldSlot: number | null = null;

  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsub = player.onChange(() => {
      if (this.visible) this._refresh();
    });
    this.cleanup.push(unsub);

    // Escape key cancels held item
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._heldSlot !== null) {
        this._heldSlot = null;
        this._renderGrid();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isVisible(): boolean { return this.visible; }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('inv-visible'));
    this.visible = true;
    this._refresh();
  }

  hide(): void {
    this._heldSlot = null;
    this.root.classList.remove('inv-visible');
    this.root.style.display = 'none';
    this.visible = false;
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'inventory-window';
    el.innerHTML = `
      <style>
        #inventory-window {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 200;
          pointer-events: none;
        }
        #inventory-window.inv-visible {
          pointer-events: auto;
        }

        /* Backdrop */
        #inv-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.55);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #inventory-window.inv-visible #inv-backdrop { opacity: 1; }

        /* Panel */
        #inv-panel {
          position: relative;
          display: flex;
          flex-direction: column;
          background: rgba(8,6,4,0.96);
          border: 1px solid rgba(200,98,42,0.30);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8), inset 0 0 60px rgba(30,15,5,0.5);
          width: min(900px, 96vw);
          max-height: 90vh;
          overflow: hidden;
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #inventory-window.inv-visible #inv-panel {
          transform: translateY(0);
          opacity: 1;
        }

        /* Header */
        #inv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 8px;
          border-bottom: 1px solid rgba(200,98,42,0.18);
          flex-shrink: 0;
        }
        .inv-title {
          font-family: var(--font-display, serif);
          font-size: 13px;
          color: rgba(200,145,60,0.90);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .inv-header-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .inv-btn {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212,201,184,0.7);
          background: rgba(30,20,10,0.6);
          border: 1px solid rgba(200,98,42,0.22);
          padding: 3px 10px;
          cursor: pointer;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
        }
        .inv-btn:hover {
          background: rgba(80,40,10,0.5);
          color: rgba(212,180,120,0.95);
          border-color: rgba(200,98,42,0.5);
        }
        .inv-btn.active {
          background: rgba(120,60,10,0.55);
          color: rgba(230,200,140,1);
          border-color: rgba(200,120,42,0.55);
        }
        .inv-close-btn {
          font-size: 14px;
          padding: 2px 8px;
          color: rgba(180,100,60,0.8);
        }

        /* Body */
        #inv-body {
          display: flex;
          gap: 12px;
          padding: 12px 14px;
          overflow: hidden;
          flex: 1;
          min-height: 0;
        }

        /* ── Inventory grid ── */
        #inv-grid-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
        }
        #inv-grid-label {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(150,120,80,0.7);
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        #inv-grid {
          display: grid;
          grid-template-columns: repeat(8, 1fr);
          gap: 3px;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.3) transparent;
        }
        .inv-slot {
          aspect-ratio: 1;
          background: rgba(14,10,6,0.8);
          border: 1px solid rgba(200,98,42,0.12);
          position: relative;
          cursor: default;
          transition: border-color 0.12s, background 0.12s;
          overflow: hidden;
          min-width: 0;
        }
        .inv-slot.occupied {
          cursor: pointer;
          border-color: rgba(200,98,42,0.30);
        }
        .inv-slot.occupied:hover {
          background: rgba(50,25,8,0.7);
          border-color: rgba(200,140,60,0.65);
        }
        .inv-slot.held {
          border-color: rgba(200,180,80,0.8);
          background: rgba(80,60,15,0.5);
          box-shadow: 0 0 8px rgba(200,160,40,0.3);
        }
        .inv-slot.drop-target:hover {
          border-color: rgba(100,180,100,0.6);
          background: rgba(20,60,20,0.3);
        }
        .inv-slot-name {
          position: absolute;
          bottom: 2px;
          left: 2px;
          right: 2px;
          font-family: var(--font-mono);
          font-size: 8px;
          color: rgba(212,201,184,0.85);
          text-overflow: ellipsis;
          overflow: hidden;
          white-space: nowrap;
          text-shadow: 0 1px 2px #000;
          line-height: 1.2;
        }
        .inv-slot-type {
          position: absolute;
          top: 2px;
          right: 2px;
          font-family: var(--font-mono);
          font-size: 7px;
          color: rgba(150,110,50,0.75);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .inv-slot-qty {
          position: absolute;
          top: 2px;
          left: 3px;
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: bold;
          color: rgba(200,170,100,0.9);
          text-shadow: 0 1px 2px #000;
        }

        /* Tooltip */
        #inv-tooltip {
          display: none;
          position: fixed;
          background: rgba(8,6,4,0.97);
          border: 1px solid rgba(200,98,42,0.35);
          padding: 8px 10px;
          max-width: 220px;
          z-index: 300;
          pointer-events: none;
        }
        #inv-tooltip.visible { display: block; }
        .inv-tt-name {
          font-family: var(--font-body, serif);
          font-size: 12px;
          color: rgba(230,200,140,0.95);
          margin-bottom: 3px;
        }
        .inv-tt-type {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(150,110,50,0.8);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 5px;
        }
        .inv-tt-desc {
          font-family: var(--font-body, serif);
          font-size: 10px;
          color: rgba(180,160,130,0.75);
          line-height: 1.45;
          margin-bottom: 5px;
        }
        .inv-tt-equip-hint {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(100,160,100,0.8);
          letter-spacing: 0.06em;
        }
        .inv-tt-stats {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(180,200,220,0.85);
          line-height: 1.5;
          margin-bottom: 4px;
        }
        .inv-tt-dur {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(140,120,80,0.7);
          margin-top: 3px;
        }

        /* ── Equipment panel ── */
        #inv-equip-section {
          width: 200px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.3) transparent;
        }
        .equip-group {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .equip-group-label {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(130,100,60,0.7);
          text-transform: uppercase;
          letter-spacing: 0.10em;
          padding-left: 2px;
        }
        .equip-group-label.weapon-set-active {
          color: rgba(180,140,60,0.95);
        }
        .equip-slot-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-height: 26px;
        }
        .equip-slot-box {
          flex: 1;
          min-height: 26px;
          background: rgba(14,10,6,0.8);
          border: 1px solid rgba(200,98,42,0.15);
          display: flex;
          align-items: center;
          padding: 2px 5px;
          gap: 4px;
          position: relative;
          overflow: hidden;
        }
        .equip-slot-box.occupied {
          border-color: rgba(200,98,42,0.35);
          cursor: pointer;
        }
        .equip-slot-box.occupied:hover {
          background: rgba(50,25,8,0.6);
          border-color: rgba(200,140,60,0.6);
        }
        .equip-slot-box.weapon-set-inactive {
          opacity: 0.45;
        }
        .equip-slot-label {
          font-family: var(--font-mono);
          font-size: 8px;
          color: rgba(130,100,60,0.65);
          min-width: 32px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        .equip-slot-name {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,201,184,0.85);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }
        .equip-slot-name.empty {
          color: rgba(100,80,60,0.4);
          font-style: italic;
        }
        .equip-slot-unequip {
          font-size: 9px;
          color: rgba(160,80,50,0.7);
          cursor: pointer;
          padding: 1px 3px;
          flex-shrink: 0;
          display: none;
        }
        .equip-slot-box.occupied:hover .equip-slot-unequip { display: block; }

        /* Weapon set swap button */
        #inv-weapon-swap {
          margin: 4px 0;
          width: 100%;
          text-align: center;
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(180,140,60,0.8);
          background: rgba(40,25,8,0.55);
          border: 1px solid rgba(180,120,40,0.30);
          padding: 4px;
          cursor: pointer;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          transition: background 0.15s, color 0.15s;
        }
        #inv-weapon-swap:hover {
          background: rgba(80,50,10,0.6);
          color: rgba(230,190,80,1);
          border-color: rgba(200,150,50,0.55);
        }

        /* Equip slot picker modal (slot selection for items that fit multiple slots) */
        #inv-slot-picker {
          display: none;
          position: fixed;
          inset: 0;
          align-items: center;
          justify-content: center;
          z-index: 400;
          background: rgba(0,0,0,0.5);
        }
        #inv-slot-picker.visible { display: flex; }
        #inv-slot-picker-panel {
          background: rgba(8,6,4,0.98);
          border: 1px solid rgba(200,98,42,0.40);
          padding: 16px;
          min-width: 200px;
        }
        .inv-sp-title {
          font-family: var(--font-display, serif);
          font-size: 12px;
          color: rgba(200,145,60,0.90);
          letter-spacing: 0.14em;
          text-transform: uppercase;
          margin-bottom: 10px;
        }
        .inv-sp-slot-btn {
          display: block;
          width: 100%;
          text-align: left;
          font-family: var(--font-mono);
          font-size: 11px;
          color: rgba(212,201,184,0.80);
          background: rgba(14,10,6,0.8);
          border: 1px solid rgba(200,98,42,0.20);
          padding: 5px 10px;
          margin-bottom: 4px;
          cursor: pointer;
          letter-spacing: 0.06em;
          transition: background 0.12s, color 0.12s;
        }
        .inv-sp-slot-btn:hover {
          background: rgba(60,30,8,0.7);
          color: rgba(230,200,140,1);
          border-color: rgba(200,120,42,0.5);
        }
        .inv-sp-cancel {
          margin-top: 8px;
          color: rgba(150,80,50,0.75);
          border-color: rgba(150,60,30,0.20);
        }
      </style>

      <div id="inv-backdrop"></div>

      <div id="inv-panel">
        <div id="inv-header">
          <span class="inv-title">Inventory</span>
          <div class="inv-header-actions">
            <button class="inv-btn active" id="inv-sort-btn">Sort: On</button>
            <button class="inv-btn inv-close-btn" id="inv-close-btn">✕</button>
          </div>
        </div>

        <div id="inv-body">
          <div id="inv-grid-section">
            <div id="inv-grid-label">Inventory — <span id="inv-count">0</span> / 40 slots</div>
            <div id="inv-grid"></div>
          </div>

          <div id="inv-equip-section">
            <div id="inv-equip-slots"></div>
          </div>
        </div>
      </div>

      <!-- Tooltip -->
      <div id="inv-tooltip">
        <div class="inv-tt-name" id="inv-tt-name"></div>
        <div class="inv-tt-type" id="inv-tt-type"></div>
        <div class="inv-tt-stats" id="inv-tt-stats"></div>
        <div class="inv-tt-desc" id="inv-tt-desc"></div>
        <div class="inv-tt-equip-hint" id="inv-tt-equip-hint"></div>
        <div class="inv-tt-dur" id="inv-tt-dur"></div>
      </div>

      <!-- Slot picker -->
      <div id="inv-slot-picker">
        <div id="inv-slot-picker-panel">
          <div class="inv-sp-title">Equip to slot</div>
          <div id="inv-sp-slots"></div>
          <button class="inv-sp-slot-btn inv-sp-cancel" id="inv-sp-cancel">Cancel</button>
        </div>
      </div>
    `;

    // Wire up close button + backdrop click
    el.querySelector('#inv-close-btn')!.addEventListener('click', () => this.hide());
    el.querySelector('#inv-backdrop')!.addEventListener('click', () => {
      if (this._heldSlot !== null) {
        // Cancel held item instead of closing
        this._heldSlot = null;
        this._renderGrid();
        return;
      }
      this.hide();
    });

    // Sort toggle
    el.querySelector('#inv-sort-btn')!.addEventListener('click', () => {
      this.autoSort = !this.autoSort;
      const btn = el.querySelector<HTMLElement>('#inv-sort-btn')!;
      btn.textContent = this.autoSort ? 'Sort: On' : 'Sort: Off';
      btn.classList.toggle('active', this.autoSort);
      this._refresh();
    });

    // Slot picker cancel
    el.querySelector('#inv-sp-cancel')!.addEventListener('click', () => {
      el.querySelector<HTMLElement>('#inv-slot-picker')!.classList.remove('visible');
    });

    return el;
  }

  // ── Slot map persistence ──────────────────────────────────────────────────

  private get _storageKey(): string {
    return `inv-slots:${this.player.id}`;
  }

  private _saveSlotMap(): void {
    try { localStorage.setItem(this._storageKey, JSON.stringify(this._slotMap)); }
    catch { /* storage full or disabled — silently ignore */ }
  }

  private _loadSlotMap(): (string | null)[] | null {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return null;
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length === 40) return arr as (string | null)[];
    } catch { /* corrupted — ignore */ }
    return null;
  }

  /**
   * Sync `_slotMap` with the current inventory items.
   * - autoSort ON:  deterministic sorted order (slot 0 = first sorted item)
   * - autoSort OFF: keep existing positions, prune removed items, place new items in first empty slot
   */
  private _rebuildSlotMap(items: ItemInfo[]): void {
    if (this.autoSort) {
      // Sorted order — just fill sequentially
      this._slotMap = new Array(40).fill(null);
      for (let i = 0; i < items.length && i < 40; i++) {
        this._slotMap[i] = items[i]!.id;
      }
      return;
    }

    // Manual mode — try to load saved map on first open
    if (!this._slotMapLoaded) {
      const saved = this._loadSlotMap();
      if (saved) this._slotMap = saved;
      this._slotMapLoaded = true;
    }

    // Build a set of current item IDs for fast lookup
    const currentIds = new Set(items.map(it => it.id));

    // Prune slots whose item is no longer in inventory
    for (let i = 0; i < 40; i++) {
      if (this._slotMap[i] && !currentIds.has(this._slotMap[i]!)) {
        this._slotMap[i] = null;
      }
    }

    // Place new items (IDs not yet in any slot)
    const mappedIds = new Set(this._slotMap.filter(Boolean));
    for (const item of items) {
      if (!mappedIds.has(item.id)) {
        const emptyIdx = this._slotMap.indexOf(null);
        if (emptyIdx !== -1) {
          this._slotMap[emptyIdx] = item.id;
          mappedIds.add(item.id);
        }
      }
    }

    this._saveSlotMap();
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _refresh(): void {
    this._renderGrid();
    this._renderEquipment();
  }

  private _renderGrid(): void {
    const gridEl    = this.root.querySelector<HTMLElement>('#inv-grid')!;
    const countEl   = this.root.querySelector<HTMLElement>('#inv-count')!;
    const tooltipEl = this.root.querySelector<HTMLElement>('#inv-tooltip')!;

    const sortedItems = this._sortedInventory();
    countEl.textContent = String(sortedItems.length);

    // Rebuild slot map from current inventory
    this._rebuildSlotMap(sortedItems);

    // Build a lookup from item ID → ItemInfo
    const itemById = new Map<string, ItemInfo>();
    for (const it of sortedItems) itemById.set(it.id, it);

    gridEl.innerHTML = '';

    const isHolding = this._heldSlot !== null;

    // Render 40 slots using the slot map
    for (let i = 0; i < 40; i++) {
      const itemId = this._slotMap[i];
      const item = itemId ? itemById.get(itemId) ?? null : null;
      const slot = document.createElement('div');
      const isHeld = isHolding && i === this._heldSlot;

      let cls = 'inv-slot';
      if (item) cls += ' occupied';
      if (isHeld) cls += ' held';
      if (isHolding && !isHeld) cls += ' drop-target';
      slot.className = cls;

      if (item) {
        if (item.quantity > 1) {
          const qty = document.createElement('span');
          qty.className = 'inv-slot-qty';
          qty.textContent = String(item.quantity);
          slot.appendChild(qty);
        }

        const name = document.createElement('span');
        name.className = 'inv-slot-name';
        name.textContent = item.name;
        slot.appendChild(name);

        const type = document.createElement('span');
        type.className = 'inv-slot-type';
        type.textContent = item.itemType.slice(0, 3).toUpperCase();
        slot.appendChild(type);

        // Tooltip on hover (suppress while holding an item)
        slot.addEventListener('mouseenter', (e) => { if (!this._heldSlot) this._showTooltip(e, item, tooltipEl); });
        slot.addEventListener('mousemove',  (e) => { if (!this._heldSlot) this._moveTooltip(e, tooltipEl); });
        slot.addEventListener('mouseleave', ()  => this._hideTooltip(tooltipEl));

        // Right-click → use / equip
        slot.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (this._heldSlot !== null) {
            // Cancel hold on right-click
            this._heldSlot = null;
            this._renderGrid();
            return;
          }
          this._useOrEquipItem(item);
        });
      }

      // Prevent browser context menu on all slots (even empty ones)
      if (!item) {
        slot.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (this._heldSlot !== null) {
            this._heldSlot = null;
            this._renderGrid();
          }
        });
      }

      // Left-click → pick up / place
      {
        const slotIndex = i;
        slot.addEventListener('click', () => this._onSlotClick(slotIndex, item));
      }

      gridEl.appendChild(slot);
    }
  }

  private _renderEquipment(): void {
    const container = this.root.querySelector<HTMLElement>('#inv-equip-slots')!;
    const tooltipEl = this.root.querySelector<HTMLElement>('#inv-tooltip')!;
    const activeSet = this.player.activeWeaponSet;
    const equipment = this.player.equipment;

    container.innerHTML = '';

    for (const group of EQUIP_LAYOUT) {
      const groupEl = document.createElement('div');
      groupEl.className = 'equip-group';

      const isWeaponGroup = group.slots.some(s => s.startsWith('mainhand') || s.startsWith('offhand'));
      const isSet1 = group.slots.some(s => s === 'mainhand' || s === 'offhand');
      const isSet2 = group.slots.some(s => s === 'mainhand2' || s === 'offhand2');
      const isActiveWeaponGroup = isWeaponGroup && ((isSet1 && activeSet === 1) || (isSet2 && activeSet === 2));

      const labelEl = document.createElement('div');
      labelEl.className = isActiveWeaponGroup ? 'equip-group-label weapon-set-active' : 'equip-group-label';
      labelEl.textContent = isActiveWeaponGroup ? `${group.label} ★` : group.label;
      groupEl.appendChild(labelEl);

      for (const slotKey of group.slots) {
        const item   = equipment[slotKey] ?? null;
        const isWpn  = slotKey.startsWith('mainhand') || slotKey.startsWith('offhand');
        const inactive = isWpn && ((isSet1 && activeSet === 2) || (isSet2 && activeSet === 1));

        const rowEl = document.createElement('div');
        rowEl.className = 'equip-slot-row';

        const boxEl = document.createElement('div');
        boxEl.className = 'equip-slot-box' + (item ? ' occupied' : '') + (inactive ? ' weapon-set-inactive' : '');

        const lblSpan = document.createElement('span');
        lblSpan.className = 'equip-slot-label';
        lblSpan.textContent = EQUIP_SLOT_LABELS[slotKey];

        const nameSpan = document.createElement('span');
        nameSpan.className = item ? 'equip-slot-name' : 'equip-slot-name empty';
        nameSpan.textContent = item ? item.name : '—';

        const unequipBtn = document.createElement('span');
        unequipBtn.className = 'equip-slot-unequip';
        unequipBtn.textContent = '×';
        unequipBtn.title = 'Unequip';

        boxEl.appendChild(lblSpan);
        boxEl.appendChild(nameSpan);
        boxEl.appendChild(unequipBtn);
        rowEl.appendChild(boxEl);
        groupEl.appendChild(rowEl);

        if (item) {
          boxEl.addEventListener('mouseenter', (e) => this._showTooltip(e, item, tooltipEl));
          boxEl.addEventListener('mousemove',  (e) => this._moveTooltip(e, tooltipEl));
          boxEl.addEventListener('mouseleave', ()  => this._hideTooltip(tooltipEl));

          unequipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.socket.sendUnequipItem(slotKey as EquipSlot);
          });
        }
      }

      // Weapon set swap button between the two weapon groups
      if (isSet1) {
        const swapBtn = document.createElement('button');
        swapBtn.id = 'inv-weapon-swap';
        swapBtn.textContent = `⇄  Swap Weapon Set  (Active: Set ${activeSet})`;
        swapBtn.addEventListener('click', () => this.socket.sendWeaponSetSwap());
        groupEl.appendChild(swapBtn);
      }

      container.appendChild(groupEl);
    }
  }

  // ── Interactions ───────────────────────────────────────────────────────────

  /** Left-click handler for inventory slot: pick-up / place / swap */
  private _onSlotClick(slotIndex: number, item: ItemInfo | null): void {
    const tooltipEl = this.root.querySelector<HTMLElement>('#inv-tooltip')!;

    if (this._heldSlot === null) {
      // Nothing held — pick up this item (if occupied)
      if (!item) return;
      this._heldSlot = slotIndex;
      this._hideTooltip(tooltipEl);
      this._renderGrid();
      return;
    }

    // Something is held
    if (this._heldSlot === slotIndex) {
      // Clicked same slot — cancel
      this._heldSlot = null;
      this._renderGrid();
      return;
    }

    // Swap the two slots in the map
    const src = this._heldSlot;
    const temp = this._slotMap[src]!;
    this._slotMap[src] = this._slotMap[slotIndex] ?? null;
    this._slotMap[slotIndex] = temp;
    this._heldSlot = null;

    // Persist the new arrangement (only matters when autoSort is OFF)
    if (!this.autoSort) this._saveSlotMap();

    this._renderGrid();
  }

  /** Right-click action: use consumable or equip gear */
  private _useOrEquipItem(item: ItemInfo): void {
    // Consumables — use
    const lowerType = item.itemType.toLowerCase();
    if (lowerType === 'consumable' || lowerType === 'potion' || lowerType === 'food') {
      this.socket.sendCommand(`/use "${item.name}"`);
      return;
    }

    // Determine valid slots for this item type
    const validSlots = validEquipSlotsFor(item.itemType);
    if (validSlots.length === 0) return; // un-equippable item

    if (validSlots.length === 1) {
      this.socket.sendEquipItem(item.id, validSlots[0]!);
      return;
    }

    // Multiple valid slots — show picker
    this._showSlotPicker(item, validSlots);
  }

  private _showSlotPicker(item: ItemInfo, slots: EquipSlot[]): void {
    const picker   = this.root.querySelector<HTMLElement>('#inv-slot-picker')!;
    const slotList = this.root.querySelector<HTMLElement>('#inv-sp-slots')!;

    slotList.innerHTML = '';
    for (const slot of slots) {
      const btn = document.createElement('button');
      btn.className = 'inv-sp-slot-btn';
      const existing = this.player.equipment[slot];
      btn.textContent = existing
        ? `${EQUIP_SLOT_LABELS[slot]} — replace "${existing.name}"`
        : EQUIP_SLOT_LABELS[slot];
      btn.addEventListener('click', () => {
        picker.classList.remove('visible');
        this.socket.sendEquipItem(item.id, slot);
      });
      slotList.appendChild(btn);
    }

    picker.classList.add('visible');
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  private _showTooltip(e: MouseEvent, item: ItemInfo, el: HTMLElement): void {
    el.querySelector<HTMLElement>('#inv-tt-name')!.textContent  = item.name;
    el.querySelector<HTMLElement>('#inv-tt-type')!.textContent  = item.itemType;
    el.querySelector<HTMLElement>('#inv-tt-desc')!.textContent  = item.description;

    // ── Item stat line ──
    el.querySelector<HTMLElement>('#inv-tt-stats')!.textContent = this._buildStatsLine(item);

    const lowerType = item.itemType.toLowerCase();
    const isConsumable = lowerType === 'consumable' || lowerType === 'potion' || lowerType === 'food';
    const isEquipable = validEquipSlotsFor(item.itemType).length > 0;
    let hint: string;
    if (item.equipped) {
      hint = `Equipped: ${item.equipSlot}`;
    } else if (isConsumable) {
      hint = 'LMB move · RMB use';
    } else if (isEquipable) {
      hint = 'LMB move · RMB equip';
    } else {
      hint = 'LMB move';
    }
    el.querySelector<HTMLElement>('#inv-tt-equip-hint')!.textContent = hint;
    el.querySelector<HTMLElement>('#inv-tt-dur')!.textContent =
      item.durability !== undefined ? `Durability: ${item.durability.toFixed(0)}%` : '';

    this._moveTooltip(e, el);
    el.classList.add('visible');
  }

  /** Build a stat summary string from item properties. */
  private _buildStatsLine(item: ItemInfo): string {
    const props = item.properties as Record<string, unknown> | undefined;
    if (!props) return '';

    // Weapon stats
    const weapon = props.weapon as { baseDamage?: number; speed?: number; damageProfiles?: Array<{ damageType?: string; physicalType?: string }> } | undefined;
    if (weapon && typeof weapon.baseDamage === 'number') {
      const dmgType = weapon.damageProfiles?.[0]?.physicalType ?? weapon.damageProfiles?.[0]?.damageType ?? '';
      const label = dmgType.charAt(0).toUpperCase() + dmgType.slice(1);
      return `${weapon.baseDamage} damage \u00B7 ${weapon.speed ?? '?'}s \u00B7 ${label}`;
    }

    // Armor stats
    const armor = props.armor as { qualityBias?: Record<string, number> } | undefined;
    if (armor?.qualityBias) {
      const parts: string[] = [];
      for (const [type, val] of Object.entries(armor.qualityBias)) {
        if (typeof val !== 'number') continue;
        const pct = Math.round(val * 100);
        const sign = pct >= 0 ? '+' : '';
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        parts.push(`${label} ${sign}${pct}%`);
      }
      return parts.join(' \u00B7 ');
    }

    // Consumable stats
    const effect = props.effect as { type?: string; amount?: number } | undefined;
    if (effect && typeof effect.amount === 'number') {
      const cooldown = typeof props.cooldown === 'number' ? ` \u00B7 ${props.cooldown}s cd` : '';
      const label = effect.type === 'heal' ? 'Heals' : effect.type === 'stamina' ? 'Restores stamina' : effect.type === 'mana' ? 'Restores mana' : 'Effect';
      return `${label} ${effect.amount}${cooldown}`;
    }

    return '';
  }

  private _moveTooltip(e: MouseEvent, el: HTMLElement): void {
    const x = e.clientX + 14;
    const y = e.clientY - 10;
    el.style.left = `${Math.min(x, window.innerWidth  - 240)}px`;
    el.style.top  = `${Math.min(y, window.innerHeight - 140)}px`;
  }

  private _hideTooltip(el: HTMLElement): void {
    el.classList.remove('visible');
  }

  // ── Sort ───────────────────────────────────────────────────────────────────

  private _sortedInventory(): ItemInfo[] {
    const items = [...this.player.inventory];
    if (!this.autoSort) return items;
    return items.sort((a, b) => {
      const typeDiff = sortOrder(a.itemType) - sortOrder(b.itemType);
      if (typeDiff !== 0) return typeDiff;
      return a.name.localeCompare(b.name);
    });
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Returns the equip slots that an item of this type can be placed into.
 * Returns [] for items that can't be equipped.
 */
function validEquipSlotsFor(itemType: string): EquipSlot[] {
  switch (itemType.toLowerCase()) {
    case 'weapon':
    case 'sword': case 'axe': case 'staff': case 'wand': case 'bow': case 'dagger':
      return ['mainhand', 'offhand', 'mainhand2', 'offhand2'];
    case 'shield': case 'offhand':
      return ['offhand', 'offhand2'];
    case 'armor': case 'chest': case 'body':
      return ['body'];
    case 'helm': case 'hat': case 'head':
      return ['head'];
    case 'gloves': case 'hands':
      return ['hands'];
    case 'pants': case 'legs':
      return ['legs'];
    case 'boots': case 'feet':
      return ['feet'];
    case 'necklace': case 'amulet':
      return ['necklace'];
    case 'bracelet': case 'wrist':
      return ['bracelet'];
    case 'ring':
      return ['ring1', 'ring2'];
    default:
      return [];
  }
}
