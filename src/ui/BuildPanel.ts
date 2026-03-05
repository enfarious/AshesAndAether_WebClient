import type { SocketClient }  from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type { VillageCatalogEntry } from '@/network/Protocol';

/**
 * BuildPanel — village structure placement catalog.
 *
 * Toggled with the B key (only in player's own village).
 * Fetches the catalog from the server on first show, caches it.
 * Cards are grouped by category. Clicking a card sends `/village place <name>`.
 */
export class BuildPanel {
  private root:    HTMLElement;
  private body:    HTMLElement;
  private _visible = false;
  private _catalog: VillageCatalogEntry[] | null = null;
  private _pending = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this._injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'build-panel';
    this.root.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'bp-header';

    const title = document.createElement('span');
    title.className = 'bp-title';
    title.textContent = 'Build';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'bp-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.root.appendChild(header);

    // Body
    this.body = document.createElement('div');
    this.body.className = 'bp-body';
    this.root.appendChild(this.body);

    uiRoot.appendChild(this.root);

    // Listen for catalog data
    const unsub = router.onVillageCatalog(p => {
      this._catalog = p.structures;
      this._pending = false;
      if (this._visible) this._render();
    });
    this.cleanup.push(unsub);
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._visible = true;
    this.root.style.display = '';
    if (!this._catalog && !this._pending) {
      this._pending = true;
      this.socket.sendCommand('/village catalog');
      this.body.innerHTML = '<div class="bp-loading">Loading catalog\u2026</div>';
    } else {
      this._render();
    }
  }

  hide(): void {
    this._visible = false;
    this.root.style.display = 'none';
  }

  toggle(): void {
    if (this._visible) this.hide();
    else this.show();
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private _render(): void {
    this.body.innerHTML = '';
    const catalog = this._catalog;
    if (!catalog || catalog.length === 0) {
      this.body.innerHTML = '<div class="bp-loading">No structures available.</div>';
      return;
    }

    // Group by category
    const groups = new Map<string, VillageCatalogEntry[]>();
    for (const entry of catalog) {
      const cat = entry.category || 'Other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(entry);
    }

    for (const [category, entries] of groups) {
      const section = document.createElement('div');
      section.className = 'bp-section';

      const catLabel = document.createElement('div');
      catLabel.className = 'bp-category';
      catLabel.textContent = category;
      section.appendChild(catLabel);

      const grid = document.createElement('div');
      grid.className = 'bp-grid';

      for (const entry of entries) {
        const card = document.createElement('div');
        card.className = 'bp-card';
        card.addEventListener('click', () => {
          this.socket.sendCommand(`/village place ${entry.name}`);
          this.hide();
        });

        card.innerHTML = `
          <div class="bp-card-name">${entry.displayName}</div>
          <div class="bp-card-meta">
            <span class="bp-card-cost">${entry.goldCost}g</span>
            <span class="bp-card-size">${entry.sizeX}\u00d7${entry.sizeZ}</span>
          </div>
          <div class="bp-card-desc">${entry.description}</div>
        `;

        grid.appendChild(card);
      }

      section.appendChild(grid);
      this.body.appendChild(section);
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('build-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'build-panel-styles';
    style.textContent = `
      #build-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 420px;
        max-height: 70vh;
        background: rgba(8, 6, 4, 0.94);
        border: 1px solid rgba(200, 145, 60, 0.25);
        border-radius: 6px;
        z-index: 800;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
      }

      .bp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(200, 145, 60, 0.15);
      }

      .bp-title {
        font-family: var(--font-display, serif);
        font-size: 14px;
        letter-spacing: 0.06em;
        color: rgba(212, 201, 184, 0.8);
      }

      .bp-close {
        background: none;
        border: none;
        color: rgba(212, 201, 184, 0.4);
        font-size: 14px;
        cursor: pointer;
        padding: 2px 6px;
      }

      .bp-close:hover {
        color: rgba(212, 201, 184, 0.8);
      }

      .bp-body {
        padding: 8px 12px;
        overflow-y: auto;
        flex: 1;
      }

      .bp-loading {
        color: rgba(212, 201, 184, 0.4);
        font-family: var(--font-body, serif);
        font-size: 11px;
        text-align: center;
        padding: 20px;
      }

      .bp-section {
        margin-bottom: 10px;
      }

      .bp-category {
        font-family: var(--font-display, serif);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(200, 145, 60, 0.5);
        margin-bottom: 4px;
        padding-bottom: 2px;
        border-bottom: 1px solid rgba(200, 145, 60, 0.08);
      }

      .bp-grid {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .bp-card {
        background: rgba(20, 14, 8, 0.6);
        border: 1px solid rgba(200, 145, 60, 0.1);
        border-radius: 3px;
        padding: 6px 8px;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }

      .bp-card:hover {
        background: rgba(50, 32, 10, 0.7);
        border-color: rgba(200, 145, 60, 0.35);
      }

      .bp-card-name {
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212, 201, 184, 0.85);
        margin-bottom: 2px;
      }

      .bp-card-meta {
        display: flex;
        gap: 10px;
        margin-bottom: 2px;
      }

      .bp-card-cost {
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        color: #dab050;
      }

      .bp-card-size {
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.4);
      }

      .bp-card-desc {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.4);
        line-height: 1.3;
      }
    `;
    document.head.appendChild(style);
  }
}
