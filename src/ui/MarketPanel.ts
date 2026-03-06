import type { PlayerState }    from '@/state/PlayerState';
import type { SocketClient }   from '@/network/SocketClient';
import type { MessageRouter }  from '@/network/MessageRouter';
import type {
  MarketDataPayload,
  MarketSearchResult,
  MarketOrderInfo,
} from '@/network/Protocol';

type Tab = 'browse' | 'sell' | 'orders';

/**
 * MarketPanel — graphical market UI (Ctrl+M or target stall → Market).
 *
 * Browse / Sell / My Orders tabs.  Wallet + orders always work; trade
 * commands that need a stall will surface the proximity error in chat.
 */
export class MarketPanel {
  private root:    HTMLElement;
  private visible  = false;
  private cleanup: (() => void)[] = [];

  private activeTab: Tab = 'browse';
  private balance       = 0;

  // Cached data from server responses
  private searchResults: MarketSearchResult[] = [];
  private myOrders:      MarketOrderInfo[]    = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    router: MessageRouter,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    // Listen for structured market data from the server
    const unsub = router.onMarketData(p => this._onMarketData(p));
    this.cleanup.push(unsub);

    // Refresh sell tab when inventory changes
    const unsubInv = player.onChange(() => {
      if (this.visible && this.activeTab === 'sell') this._renderSell();
    });
    this.cleanup.push(unsubInv);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get isVisible(): boolean { return this.visible; }

  toggle(): void { this.visible ? this.hide() : this.show(); }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('mp-visible'));
    this.visible = true;
    // Fetch wallet balance on every open
    this.socket.sendCommand('/market wallet');
    this._switchTab(this.activeTab);
  }

  hide(): void {
    this.root.classList.remove('mp-visible');
    this.root.style.display = 'none';
    this.visible = false;
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Data handler ─────────────────────────────────────────────────────────

  private _onMarketData(p: MarketDataPayload): void {
    if (!this.visible) return;

    switch (p.type) {
      case 'market_wallet':
        this.balance = p.balance;
        this._renderGold();
        break;

      case 'market_search':
        this.searchResults = p.results;
        this._renderBrowseResults();
        break;

      case 'market_orders':
        this.myOrders = p.orders;
        this._renderOrders();
        break;

      case 'market_list':
      case 'market_buy':
      case 'market_cancel':
        // Refresh relevant views after a mutation
        this.socket.sendCommand('/market wallet');
        if (this.activeTab === 'orders') this.socket.sendCommand('/market myorders');
        break;
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────────

  private _switchTab(tab: Tab): void {
    this.activeTab = tab;

    // Highlight active tab button
    this.root.querySelectorAll<HTMLElement>('.mp-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset['tab'] === tab);
    });

    // Render the active tab content
    const body = this.root.querySelector<HTMLElement>('#mp-body')!;
    body.innerHTML = '';

    switch (tab) {
      case 'browse':
        this._renderBrowse(body);
        break;
      case 'sell':
        this._renderSell();
        break;
      case 'orders':
        this.socket.sendCommand('/market myorders');
        this._renderOrders();
        break;
    }
  }

  // ── Browse tab ───────────────────────────────────────────────────────────

  private _renderBrowse(body?: HTMLElement): void {
    const container = body ?? this.root.querySelector<HTMLElement>('#mp-body')!;
    if (body) {
      // First render — build search bar
      container.innerHTML = `
        <div class="mp-search-row">
          <input type="text" class="mp-input" id="mp-search-input" placeholder="Item name…" />
          <select class="mp-select" id="mp-search-scope">
            <option value="">All</option>
            <option value="regional">Regional</option>
            <option value="world">World</option>
          </select>
          <button class="mp-btn" id="mp-search-btn">Search</button>
        </div>
        <div id="mp-browse-results" class="mp-scroll-area"></div>
      `;

      const searchBtn   = container.querySelector<HTMLElement>('#mp-search-btn')!;
      const searchInput = container.querySelector<HTMLInputElement>('#mp-search-input')!;

      const doSearch = () => {
        const term  = searchInput.value.trim();
        if (!term) return;
        const scope = (container.querySelector<HTMLSelectElement>('#mp-search-scope')!).value;
        this.socket.sendCommand(`/market search ${term}${scope ? ' ' + scope : ''}`);
      };

      searchBtn.addEventListener('click', doSearch);
      searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    }

    this._renderBrowseResults();
  }

  private _renderBrowseResults(): void {
    const el = this.root.querySelector<HTMLElement>('#mp-browse-results');
    if (!el) return;

    if (this.searchResults.length === 0) {
      el.innerHTML = '<div class="mp-empty">Search for items to browse listings.</div>';
      return;
    }

    el.innerHTML = `
      <table class="mp-table">
        <thead><tr>
          <th>Item</th><th>Qty</th><th>Price</th><th>Scope</th><th>Region</th><th></th>
        </tr></thead>
        <tbody id="mp-browse-tbody"></tbody>
      </table>
    `;

    const tbody = el.querySelector<HTMLElement>('#mp-browse-tbody')!;
    for (const r of this.searchResults) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(r.itemName)}</td>
        <td>${r.quantity}</td>
        <td>${r.pricePerUnit}g</td>
        <td>${r.scope === 'WORLD' ? 'W' : 'R'}</td>
        <td>${esc(r.regionName)}</td>
        <td><button class="mp-btn mp-btn-sm" data-oid="${esc(r.orderId)}">Buy</button></td>
      `;
      const buyBtn = tr.querySelector<HTMLElement>('button')!;
      buyBtn.addEventListener('click', () => {
        this.socket.sendCommand(`/market buy ${r.orderId}`);
      });
      tbody.appendChild(tr);
    }
  }

  // ── Sell tab ─────────────────────────────────────────────────────────────

  private _renderSell(): void {
    const body = this.root.querySelector<HTMLElement>('#mp-body')!;

    // Get unequipped inventory items
    const items = this.player.inventory.filter(i => !i.equipped);

    if (items.length === 0) {
      body.innerHTML = '<div class="mp-empty">No unequipped items to sell.</div>';
      return;
    }

    body.innerHTML = `
      <table class="mp-table">
        <thead><tr>
          <th>Item</th><th>Qty</th><th>Price</th><th>Scope</th><th></th>
        </tr></thead>
        <tbody id="mp-sell-tbody"></tbody>
      </table>
    `;

    const tbody = body.querySelector<HTMLElement>('#mp-sell-tbody')!;
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(item.name)}</td>
        <td>${item.quantity}</td>
        <td><input type="number" class="mp-input mp-price-input" min="1" value="1" /></td>
        <td>
          <select class="mp-select mp-scope-select">
            <option value="">Regional</option>
            <option value="world">World</option>
          </select>
        </td>
        <td><button class="mp-btn mp-btn-sm">List</button></td>
      `;

      const listBtn    = tr.querySelector<HTMLElement>('button')!;
      const priceInput = tr.querySelector<HTMLInputElement>('.mp-price-input')!;
      const scopeSel   = tr.querySelector<HTMLSelectElement>('.mp-scope-select')!;

      listBtn.addEventListener('click', () => {
        const price = parseInt(priceInput.value, 10);
        if (!price || price < 1) return;
        const scope = scopeSel.value;
        this.socket.sendCommand(`/market list "${item.name}" ${price}${scope ? ' ' + scope : ''}`);
      });

      tbody.appendChild(tr);
    }
  }

  // ── Orders tab ───────────────────────────────────────────────────────────

  private _renderOrders(): void {
    const body = this.root.querySelector<HTMLElement>('#mp-body')!;

    if (this.activeTab !== 'orders') return;

    if (this.myOrders.length === 0) {
      body.innerHTML = '<div class="mp-empty">No active orders.</div>';
      return;
    }

    body.innerHTML = `
      <table class="mp-table">
        <thead><tr>
          <th>Item</th><th>Qty</th><th>Filled</th><th>Price</th><th>Scope</th><th></th>
        </tr></thead>
        <tbody id="mp-orders-tbody"></tbody>
      </table>
    `;

    const tbody = body.querySelector<HTMLElement>('#mp-orders-tbody')!;
    for (const o of this.myOrders) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(o.itemName)}</td>
        <td>${o.quantity}</td>
        <td>${o.filledQuantity}</td>
        <td>${o.pricePerUnit}g</td>
        <td>${o.scope === 'WORLD' ? 'W' : 'R'}</td>
        <td><button class="mp-btn mp-btn-sm mp-btn-danger" data-oid="${esc(o.orderId)}">Cancel</button></td>
      `;
      const cancelBtn = tr.querySelector<HTMLElement>('button')!;
      cancelBtn.addEventListener('click', () => {
        this.socket.sendCommand(`/market cancel ${o.orderId}`);
      });
      tbody.appendChild(tr);
    }
  }

  // ── Gold display ─────────────────────────────────────────────────────────

  private _renderGold(): void {
    const el = this.root.querySelector<HTMLElement>('#mp-gold');
    if (el) el.textContent = `${this.balance}g`;
  }

  // ── DOM construction ─────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'market-panel';
    el.innerHTML = `
      <style>
        #market-panel {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 200;
          pointer-events: none;
        }
        #market-panel.mp-visible {
          pointer-events: auto;
        }

        #mp-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.55);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #market-panel.mp-visible #mp-backdrop { opacity: 1; }

        #mp-panel {
          position: relative;
          display: flex;
          flex-direction: column;
          background: rgba(8,6,4,0.96);
          border: 1px solid rgba(200,145,60,0.30);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8), inset 0 0 60px rgba(30,15,5,0.5);
          width: min(680px, 96vw);
          max-height: 85vh;
          overflow: hidden;
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #market-panel.mp-visible #mp-panel {
          transform: translateY(0);
          opacity: 1;
        }

        /* Header */
        .mp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 8px;
          border-bottom: 1px solid rgba(200,145,60,0.18);
          flex-shrink: 0;
        }
        .mp-title {
          font-family: var(--font-display, serif);
          font-size: 16px;
          color: rgba(200,145,60,0.95);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .mp-gold {
          font-family: var(--font-mono);
          font-size: 14px;
          color: rgba(240,210,110,0.95);
          letter-spacing: 0.06em;
        }
        .mp-close-btn {
          font-family: var(--font-mono);
          font-size: 14px;
          color: rgba(180,100,60,0.8);
          background: rgba(30,20,10,0.6);
          border: 1px solid rgba(200,98,42,0.22);
          padding: 2px 8px;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }
        .mp-close-btn:hover {
          background: rgba(80,40,10,0.5);
          color: rgba(212,180,120,0.95);
        }

        /* Tabs */
        .mp-tabs {
          display: flex;
          gap: 0;
          border-bottom: 1px solid rgba(200,145,60,0.12);
          flex-shrink: 0;
        }
        .mp-tab-btn {
          flex: 1;
          padding: 10px 0;
          font-family: var(--font-mono);
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.10em;
          color: rgba(212,201,184,0.65);
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          transition: color 0.15s, border-color 0.15s;
        }
        .mp-tab-btn:hover {
          color: rgba(212,201,184,0.90);
        }
        .mp-tab-btn.active {
          color: rgba(200,145,60,1);
          border-bottom-color: rgba(200,145,60,0.75);
        }

        /* Body */
        #mp-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 10px 14px;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,145,60,0.3) transparent;
        }

        /* Shared components */
        .mp-input {
          font-family: var(--font-mono);
          font-size: 13px;
          color: rgba(220,210,195,0.95);
          background: rgba(14,10,6,0.8);
          border: 1px solid rgba(200,145,60,0.30);
          padding: 6px 10px;
          outline: none;
          transition: border-color 0.15s;
        }
        .mp-input:focus {
          border-color: rgba(200,145,60,0.60);
        }
        .mp-input::placeholder {
          color: rgba(150,120,80,0.55);
        }

        .mp-select {
          font-family: var(--font-mono);
          font-size: 13px;
          color: rgba(220,210,195,0.95);
          background: rgba(14,10,6,0.8);
          border: 1px solid rgba(200,145,60,0.30);
          padding: 6px 8px;
          outline: none;
        }

        .mp-btn {
          font-family: var(--font-mono);
          font-size: 12px;
          color: rgba(220,210,195,0.90);
          background: rgba(30,20,10,0.6);
          border: 1px solid rgba(200,145,60,0.30);
          padding: 6px 14px;
          cursor: pointer;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
          white-space: nowrap;
        }
        .mp-btn:hover {
          background: rgba(80,40,10,0.5);
          color: rgba(240,220,160,1);
          border-color: rgba(200,145,60,0.6);
        }
        .mp-btn-sm {
          padding: 4px 10px;
          font-size: 11px;
        }
        .mp-btn-danger {
          color: rgba(220,110,90,0.90);
          border-color: rgba(180,60,40,0.35);
        }
        .mp-btn-danger:hover {
          background: rgba(80,20,10,0.5);
          color: rgba(250,150,130,1);
          border-color: rgba(200,80,60,0.6);
        }

        /* Search row */
        .mp-search-row {
          display: flex;
          gap: 6px;
          margin-bottom: 10px;
        }
        .mp-search-row .mp-input {
          flex: 1;
        }

        /* Table */
        .mp-table {
          width: 100%;
          border-collapse: collapse;
          font-family: var(--font-mono);
          font-size: 13px;
        }
        .mp-table th {
          text-align: left;
          font-size: 11px;
          color: rgba(180,150,100,0.85);
          text-transform: uppercase;
          letter-spacing: 0.10em;
          padding: 6px 8px;
          border-bottom: 1px solid rgba(200,145,60,0.20);
        }
        .mp-table td {
          padding: 7px 8px;
          color: rgba(220,210,195,0.90);
          border-bottom: 1px solid rgba(200,145,60,0.08);
          vertical-align: middle;
        }
        .mp-table tr:hover td {
          background: rgba(200,145,60,0.08);
        }

        /* Price input inside table */
        .mp-price-input {
          width: 70px;
          text-align: right;
        }
        .mp-scope-select {
          font-size: 12px;
          padding: 4px 6px;
        }

        /* Empty state */
        .mp-empty {
          text-align: center;
          padding: 32px 10px;
          font-family: var(--font-body, serif);
          font-size: 14px;
          color: rgba(180,150,100,0.65);
          font-style: italic;
        }

        /* Scroll area */
        .mp-scroll-area {
          overflow-y: auto;
          max-height: 50vh;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,145,60,0.3) transparent;
        }
      </style>

      <div id="mp-backdrop"></div>

      <div id="mp-panel">
        <div class="mp-header">
          <span class="mp-title">Market</span>
          <span class="mp-gold" id="mp-gold">${this.balance}g</span>
          <button class="mp-close-btn" id="mp-close-btn">&times;</button>
        </div>

        <div class="mp-tabs">
          <button class="mp-tab-btn active" data-tab="browse">Browse</button>
          <button class="mp-tab-btn" data-tab="sell">Sell</button>
          <button class="mp-tab-btn" data-tab="orders">My Orders</button>
        </div>

        <div id="mp-body"></div>
      </div>
    `;

    // Close
    el.querySelector('#mp-close-btn')!.addEventListener('click', () => this.hide());
    el.querySelector('#mp-backdrop')!.addEventListener('click', () => this.hide());

    // Tab clicks
    el.querySelectorAll<HTMLElement>('.mp-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._switchTab(btn.dataset['tab'] as Tab);
      });
    });

    return el;
  }
}

/** Escape HTML to prevent XSS from item names / region names. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
