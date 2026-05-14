import type { SocketClient } from '@/network/SocketClient';

/**
 * MerchantPanel — buy/sell modal opened by F-keying a vendor NPC.
 *
 * Listens for `open_merchant_panel` server pushes (sent on F-key + after
 * every buy/sell so the gold + sellable list refresh). Buttons fire `/buy`
 * and `/sell` slash commands — same path as in-chat versions, preserving
 * future text-client compatibility (slash-commands-first).
 *
 * Two tabs: Buy (catalog) | Sell (player's non-equipped weapons).
 * Filters: weapon type, level, quality, class. Sort: price / level /
 * damage / name. State persists in localStorage so the player's chosen
 * filter/sort survives panel close + reopen.
 */

// ── Payload (server → client) ────────────────────────────────────────────────

interface MerchantCatalogEntry {
  templateId:    string;
  name:          string;
  description:   string;
  itemType:      string;
  iconUrl?:      string;
  buyPrice:      number;
  weaponDefId:   string;
  weaponClass:   'physical' | 'magic' | 'hybrid';
  range:         'short' | 'mid' | 'long';
  requiredLevel: number;
  quality:       'poor' | 'average' | 'fine';
  damage:        number;
}

interface MerchantSellEntry {
  inventoryItemId: string;
  templateId:      string;
  name:            string;
  itemType:        string;
  quantity:        number;
  sellPrice:       number;
  weaponDefId?:    string;
  requiredLevel?:  number;
  quality?:        string;
  damage?:         number;
}

export interface MerchantPanelPayload {
  merchantId:   string;
  merchantName: string;
  gold:         number;
  catalog:      MerchantCatalogEntry[];
  sellable:     MerchantSellEntry[];
  timestamp:    number;
}

// ── Filter / sort state ──────────────────────────────────────────────────────

type Tab          = 'buy' | 'sell';
type TypeFilter   = 'all' | string;
type LevelFilter  = 'all' | 1 | 5 | 10;
type QualityFilter = 'all' | 'poor' | 'average' | 'fine';
type ClassFilter  = 'all' | 'physical' | 'magic' | 'hybrid';
type SortKey      = 'price' | 'level' | 'damage' | 'name' | 'type';

interface PanelState {
  tab:     Tab;
  type:    TypeFilter;
  level:   LevelFilter;
  quality: QualityFilter;
  klass:   ClassFilter;
  sort:    SortKey;
}

const STATE_KEY = 'aa.merchantPanel.state.v1';

function loadState(): PanelState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return { ...defaultState(), ...parsed };
  } catch { return defaultState(); }
}
function defaultState(): PanelState {
  return { tab: 'buy', type: 'all', level: 'all', quality: 'all', klass: 'all', sort: 'price' };
}
function saveState(s: PanelState): void {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ── Display helpers ─────────────────────────────────────────────────────────

const TYPE_OPTIONS: { id: string; label: string }[] = [
  { id: 'all',        label: 'All' },
  { id: 'sword',      label: 'Sword' },
  { id: 'dagger',     label: 'Dagger' },
  { id: 'axe',        label: 'Axe' },
  { id: 'bow',        label: 'Bow' },
  { id: 'rune_blade', label: 'Rune Blade' },
  { id: 'staff',      label: 'Staff' },
  { id: 'crook',      label: 'Crook' },
  { id: 'wand',       label: 'Wand' },
];

const QUALITY_LABEL: Record<string, string> = {
  poor: 'Poor', average: 'Average', fine: 'Fine',
};

const QUALITY_COLOR: Record<string, string> = {
  poor:    '#9c8870',
  average: '#dccda9',
  fine:    '#ffd585',
};

// ── Component ────────────────────────────────────────────────────────────────

export class MerchantPanel {
  private root:    HTMLElement;
  private headerEl: HTMLElement;
  private subEl:   HTMLElement;
  private tabsEl:  HTMLElement;
  private filtersEl: HTMLElement;
  private listEl:  HTMLElement;
  private cleanup: (() => void)[] = [];
  private _open = false;
  private _payload: MerchantPanelPayload | null = null;
  private _state:   PanelState = loadState();

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root      = document.createElement('div');
    this.headerEl  = document.createElement('h2');
    this.subEl     = document.createElement('div');
    this.tabsEl    = document.createElement('div');
    this.filtersEl = document.createElement('div');
    this.listEl    = document.createElement('div');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    this.socket.on('open_merchant_panel', (payload: unknown) => {
      this.show(payload as MerchantPanelPayload);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._open) {
        e.preventDefault();
        this.hide();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  show(payload: MerchantPanelPayload): void {
    this._payload = payload;
    this._open = true;
    this._renderAll();
    this.root.style.display = 'flex';
  }

  hide(): void {
    this._open = false;
    this.root.style.display = 'none';
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build (one-time) ──────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'merchant-panel';
    const style = document.createElement('style');
    style.textContent = `
      #merchant-panel {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 850;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      #mp-box {
        background: var(--ui-bg, #1a140d);
        border: 1px solid var(--ui-border, #5a4226);
        width: clamp(540px, 70vw, 920px);
        max-height: 86vh;
        padding: 22px 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 0 24px rgba(0,0,0,0.6);
      }
      #mp-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: var(--ember, #ffb060);
        letter-spacing: 0.04em;
      }
      .mp-sub {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(220,205,180,0.7);
        letter-spacing: 0.04em;
        display: flex;
        justify-content: space-between;
      }
      .mp-gold {
        color: rgba(255,215,140,0.95);
      }
      .mp-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid rgba(120,90,55,0.45);
        padding-bottom: 0;
      }
      .mp-tab {
        background: transparent;
        border: 1px solid rgba(120,90,55,0.35);
        border-bottom: none;
        color: rgba(220,205,180,0.7);
        padding: 6px 16px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .mp-tab.active {
        background: rgba(120,80,38,0.6);
        color: rgba(255,235,210,0.95);
        border-color: rgba(200,150,80,0.55);
      }
      .mp-filters {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 10px;
        align-items: center;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(220,205,180,0.75);
        padding: 4px 0 2px;
      }
      .mp-filter-label {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(200,185,160,0.6);
      }
      .mp-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .mp-chip {
        background: transparent;
        border: 1px solid rgba(120,90,55,0.4);
        color: rgba(220,205,180,0.8);
        padding: 3px 8px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.04em;
      }
      .mp-chip:hover { background: rgba(100,75,50,0.4); }
      .mp-chip.active {
        background: rgba(120,80,38,0.55);
        color: rgba(255,235,210,0.95);
        border-color: rgba(200,150,80,0.55);
      }
      .mp-sort {
        background: rgba(20,14,8,0.65);
        border: 1px solid rgba(120,90,55,0.4);
        color: rgba(220,205,180,0.9);
        padding: 3px 6px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
      }
      .mp-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 50vh;
        padding-right: 4px;
      }
      .mp-list::-webkit-scrollbar { width: 8px; }
      .mp-list::-webkit-scrollbar-track { background: rgba(20,14,8,0.4); }
      .mp-list::-webkit-scrollbar-thumb { background: rgba(120,90,55,0.5); }
      .mp-row {
        display: grid;
        grid-template-columns: 22px 1fr 80px 56px 70px 86px 78px;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(30,22,14,0.6);
        border: 1px solid rgba(120,90,55,0.25);
        font-family: var(--font-mono, monospace);
        font-size: 14px;
        color: rgba(238,225,200,1);
      }
      .mp-row-quality {
        width: 8px;
        height: 22px;
      }
      .mp-row-name { color: #fff0d6; font-weight: 600; font-size: 14px; }
      .mp-row-cell { color: rgba(232,218,194,0.96); text-align: right; font-size: 13px; }
      .mp-row-price { color: #ffd585; text-align: right; font-size: 14px; font-weight: 600; }
      .mp-row button {
        background: rgba(140,92,44,0.75);
        color: #fff2dc;
        border: 1px solid rgba(220,170,100,0.75);
        padding: 5px 12px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .mp-row button:hover:not(:disabled) { background: rgba(180,118,55,0.85); }
      .mp-row button:disabled { opacity: 0.4; cursor: not-allowed; }
      .mp-list-header {
        display: grid;
        grid-template-columns: 22px 1fr 80px 56px 70px 86px 78px;
        gap: 8px;
        padding: 0 12px 6px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(210,195,170,0.85);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border-bottom: 1px solid rgba(120,90,55,0.35);
      }
      .mp-empty {
        font-size: 12px;
        color: rgba(180,165,140,0.55);
        font-style: italic;
        padding: 18px;
        text-align: center;
      }
      .mp-footer {
        display: flex;
        justify-content: flex-end;
        padding-top: 6px;
        border-top: 1px solid rgba(120,90,55,0.25);
      }
      .mp-footer button {
        background: transparent;
        border: 1px solid rgba(180,140,90,0.4);
        color: rgba(220,205,180,0.85);
        padding: 5px 14px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .mp-footer button:hover { background: rgba(100,75,50,0.4); }
    `;
    this.root.appendChild(style);

    const box = document.createElement('div');
    box.id = 'mp-box';
    this.headerEl.textContent = 'Merchant';
    box.appendChild(this.headerEl);
    this.subEl.className = 'mp-sub';
    box.appendChild(this.subEl);

    this.tabsEl.className = 'mp-tabs';
    box.appendChild(this.tabsEl);

    this.filtersEl.className = 'mp-filters';
    box.appendChild(this.filtersEl);

    this.listEl.className = 'mp-list';
    box.appendChild(this.listEl);

    const footer = document.createElement('div');
    footer.className = 'mp-footer';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    footer.appendChild(closeBtn);
    box.appendChild(footer);

    this.root.appendChild(box);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private _renderAll(): void {
    if (!this._payload) return;
    this._renderHeader();
    this._renderTabs();
    this._renderFilters();
    this._renderList();
  }

  private _renderHeader(): void {
    if (!this._payload) return;
    this.headerEl.textContent = this._payload.merchantName || 'Merchant';
    this.subEl.innerHTML = '';
    const left = document.createElement('span');
    left.textContent = `${this._payload.catalog.length} items for sale · ${this._payload.sellable.length} sellable in inventory`;
    const right = document.createElement('span');
    right.className = 'mp-gold';
    right.textContent = `Gold: ${this._payload.gold}`;
    this.subEl.appendChild(left);
    this.subEl.appendChild(right);
  }

  private _renderTabs(): void {
    this.tabsEl.innerHTML = '';
    for (const [tab, label] of [['buy', 'Buy'], ['sell', 'Sell']] as [Tab, string][]) {
      const btn = document.createElement('button');
      btn.className = 'mp-tab' + (this._state.tab === tab ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this._state.tab = tab;
        saveState(this._state);
        this._renderTabs();
        this._renderFilters();
        this._renderList();
      });
      this.tabsEl.appendChild(btn);
    }
  }

  private _renderFilters(): void {
    this.filtersEl.innerHTML = '';

    // Chip-pick → mutate state, persist, re-render filters AND list. Without
    // the filters re-render, the active highlight stays on the prior chip
    // even though filtering is correct.
    const pick = (apply: () => void): void => {
      apply();
      saveState(this._state);
      this._renderFilters();
      this._renderList();
    };

    // Type chips
    this._addChipRow('Type', TYPE_OPTIONS.map(o => ({ id: o.id, label: o.label })),
      this._state.type, id => pick(() => { this._state.type = id; }));

    // Level chips
    this._addChipRow('Level', [
      { id: 'all', label: 'All' }, { id: '1', label: 'L1' }, { id: '5', label: 'L5' }, { id: '10', label: 'L10' },
    ], String(this._state.level),
      id => pick(() => { this._state.level = id === 'all' ? 'all' : (Number.parseInt(id, 10) as 1 | 5 | 10); }));

    // Quality chips
    this._addChipRow('Quality', [
      { id: 'all', label: 'All' }, { id: 'poor', label: 'Poor' }, { id: 'average', label: 'Average' }, { id: 'fine', label: 'Fine' },
    ], this._state.quality,
      id => pick(() => { this._state.quality = id as QualityFilter; }));

    // Class chips
    this._addChipRow('Class', [
      { id: 'all', label: 'All' }, { id: 'physical', label: 'Phys' }, { id: 'magic', label: 'Magic' }, { id: 'hybrid', label: 'Hybrid' },
    ], this._state.klass,
      id => pick(() => { this._state.klass = id as ClassFilter; }));

    // Sort dropdown
    const label = document.createElement('span');
    label.className = 'mp-filter-label';
    label.textContent = 'Sort';
    const sel = document.createElement('select');
    sel.className = 'mp-sort';
    for (const [key, name] of [
      ['price', 'Price'], ['level', 'Level'], ['damage', 'Damage'], ['name', 'Name'], ['type', 'Type'],
    ] as [SortKey, string][]) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = name;
      if (this._state.sort === key) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      this._state.sort = sel.value as SortKey;
      saveState(this._state);
      this._renderList();
    });
    this.filtersEl.appendChild(label);
    this.filtersEl.appendChild(sel);
  }

  private _addChipRow(
    title: string,
    options: { id: string; label: string }[],
    active: string,
    onPick: (id: string) => void,
  ): void {
    const lbl = document.createElement('span');
    lbl.className = 'mp-filter-label';
    lbl.textContent = title;
    const row = document.createElement('div');
    row.className = 'mp-chips';
    for (const opt of options) {
      const chip = document.createElement('button');
      chip.className = 'mp-chip' + (opt.id === active ? ' active' : '');
      chip.textContent = opt.label;
      chip.addEventListener('click', () => onPick(opt.id));
      row.appendChild(chip);
    }
    this.filtersEl.appendChild(lbl);
    this.filtersEl.appendChild(row);
  }

  private _renderList(): void {
    if (!this._payload) return;
    this.listEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'mp-list-header';
    const cols = this._state.tab === 'buy'
      ? ['', 'Name', 'Type', 'Lv', 'Dmg', 'Price', '']
      : ['', 'Name', 'Type', 'Lv', 'Dmg', 'Sell', ''];
    for (const c of cols) {
      const s = document.createElement('span');
      s.textContent = c;
      header.appendChild(s);
    }
    this.listEl.appendChild(header);

    if (this._state.tab === 'buy') {
      const rows = this._filteredCatalog();
      if (rows.length === 0) {
        this._emptyState('No items match the current filters.');
        return;
      }
      for (const r of rows) this.listEl.appendChild(this._buyRow(r));
    } else {
      const rows = this._filteredSell();
      if (rows.length === 0) {
        this._emptyState('Nothing in your inventory is sellable to this merchant.');
        return;
      }
      for (const r of rows) this.listEl.appendChild(this._sellRow(r));
    }
  }

  private _emptyState(msg: string): void {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.textContent = msg;
    this.listEl.appendChild(empty);
  }

  // ── Filter + sort ─────────────────────────────────────────────────────────

  private _filteredCatalog(): MerchantCatalogEntry[] {
    if (!this._payload) return [];
    const s = this._state;
    let rows = this._payload.catalog.slice();
    if (s.type    !== 'all') rows = rows.filter(r => r.weaponDefId === s.type);
    if (s.level   !== 'all') rows = rows.filter(r => r.requiredLevel === s.level);
    if (s.quality !== 'all') rows = rows.filter(r => r.quality === s.quality);
    if (s.klass   !== 'all') rows = rows.filter(r => r.weaponClass === s.klass);
    rows.sort((a, b) => this._sortCatalog(a, b));
    return rows;
  }

  private _sortCatalog(a: MerchantCatalogEntry, b: MerchantCatalogEntry): number {
    switch (this._state.sort) {
      case 'price':  return a.buyPrice - b.buyPrice;
      case 'level':  return a.requiredLevel - b.requiredLevel || a.buyPrice - b.buyPrice;
      case 'damage': return a.damage - b.damage;
      case 'name':   return a.name.localeCompare(b.name);
      case 'type':   return a.weaponDefId.localeCompare(b.weaponDefId) || a.requiredLevel - b.requiredLevel;
      default:       return 0;
    }
  }

  private _filteredSell(): MerchantSellEntry[] {
    if (!this._payload) return [];
    const s = this._state;
    let rows = this._payload.sellable.slice();
    if (s.type    !== 'all') rows = rows.filter(r => r.weaponDefId === s.type);
    if (s.level   !== 'all') rows = rows.filter(r => r.requiredLevel === s.level);
    if (s.quality !== 'all') rows = rows.filter(r => r.quality === s.quality);
    rows.sort((a, b) => this._sortSell(a, b));
    return rows;
  }

  private _sortSell(a: MerchantSellEntry, b: MerchantSellEntry): number {
    switch (this._state.sort) {
      case 'price':  return a.sellPrice - b.sellPrice;
      case 'level':  return (a.requiredLevel ?? 0) - (b.requiredLevel ?? 0);
      case 'damage': return (a.damage ?? 0) - (b.damage ?? 0);
      case 'name':   return a.name.localeCompare(b.name);
      case 'type':   return (a.weaponDefId ?? '').localeCompare(b.weaponDefId ?? '');
      default:       return 0;
    }
  }

  // ── Row builders ──────────────────────────────────────────────────────────

  private _buyRow(r: MerchantCatalogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mp-row';

    const quality = document.createElement('span');
    quality.className = 'mp-row-quality';
    quality.style.background = QUALITY_COLOR[r.quality] ?? '#999';
    quality.title = `${QUALITY_LABEL[r.quality]} quality`;

    const name = document.createElement('span');
    name.className = 'mp-row-name';
    name.textContent = r.name;
    name.title = r.description;

    const type = document.createElement('span');
    type.className = 'mp-row-cell';
    type.textContent = readableType(r.weaponDefId);

    const level = document.createElement('span');
    level.className = 'mp-row-cell';
    level.textContent = `L${r.requiredLevel}`;

    const dmg = document.createElement('span');
    dmg.className = 'mp-row-cell';
    dmg.textContent = String(r.damage);

    const price = document.createElement('span');
    price.className = 'mp-row-price';
    price.textContent = `${r.buyPrice}g`;

    const buy = document.createElement('button');
    buy.textContent = 'Buy';
    const canAfford = this._payload!.gold >= r.buyPrice;
    buy.disabled = !canAfford;
    if (!canAfford) buy.title = 'Not enough gold';
    buy.addEventListener('click', () => {
      this.socket.sendCommand(`/buy ${r.templateId}`);
    });

    row.appendChild(quality);
    row.appendChild(name);
    row.appendChild(type);
    row.appendChild(level);
    row.appendChild(dmg);
    row.appendChild(price);
    row.appendChild(buy);
    return row;
  }

  private _sellRow(r: MerchantSellEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mp-row';

    const quality = document.createElement('span');
    quality.className = 'mp-row-quality';
    if (r.quality) {
      quality.style.background = QUALITY_COLOR[r.quality] ?? '#999';
      quality.title = `${QUALITY_LABEL[r.quality]} quality`;
    }

    const name = document.createElement('span');
    name.className = 'mp-row-name';
    name.textContent = r.quantity > 1 ? `${r.name} ×${r.quantity}` : r.name;

    const type = document.createElement('span');
    type.className = 'mp-row-cell';
    type.textContent = r.weaponDefId ? readableType(r.weaponDefId) : r.itemType;

    const level = document.createElement('span');
    level.className = 'mp-row-cell';
    level.textContent = r.requiredLevel ? `L${r.requiredLevel}` : '—';

    const dmg = document.createElement('span');
    dmg.className = 'mp-row-cell';
    dmg.textContent = r.damage != null ? String(r.damage) : '—';

    const price = document.createElement('span');
    price.className = 'mp-row-price';
    price.textContent = `${r.sellPrice}g`;

    const sell = document.createElement('button');
    sell.textContent = 'Sell';
    sell.addEventListener('click', () => {
      this.socket.sendCommand(`/sell ${r.inventoryItemId}`);
    });

    row.appendChild(quality);
    row.appendChild(name);
    row.appendChild(type);
    row.appendChild(level);
    row.appendChild(dmg);
    row.appendChild(price);
    row.appendChild(sell);
    return row;
  }
}

function readableType(weaponDefId: string): string {
  if (weaponDefId === 'rune_blade') return 'Rune Blade';
  return weaponDefId.charAt(0).toUpperCase() + weaponDefId.slice(1);
}
