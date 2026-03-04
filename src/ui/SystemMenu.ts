/**
 * SystemMenu — FFXIV-style button bar for opening game panels.
 *
 * Always visible during gameplay. Sits at the top-left of the screen
 * as a vertical column. Each button toggles the corresponding panel
 * and shows the keybind hint.
 *
 * Escape key toggles the menu visibility for a cleaner screen when desired.
 */

export interface SystemMenuCallbacks {
  character:  () => void;
  inventory:  () => void;
  abilities:  () => void;
  companion:  () => void;
  guild:      () => void;
  party:      () => void;
  map:        () => void;
  market:     () => void;
}

interface MenuEntry {
  id:      keyof SystemMenuCallbacks;
  icon:    string;
  label:   string;
  keybind: string;
}

const ENTRIES: MenuEntry[] = [
  { id: 'character',  icon: '\u2666', label: 'Character',  keybind: 'C' },
  { id: 'inventory',  icon: '\u25C8', label: 'Inventory',  keybind: 'I' },
  { id: 'abilities',  icon: '\u2726', label: 'Abilities',  keybind: 'K' },
  { id: 'companion',  icon: '\u2740', label: 'Companion',  keybind: 'N' },
  { id: 'guild',      icon: '\u269C', label: 'Guild',      keybind: 'G' },
  { id: 'party',      icon: '\u2630', label: 'Party',      keybind: 'P' },
  { id: 'map',        icon: '\u25CE', label: 'Map',        keybind: 'M' },
  { id: 'market',     icon: '\u2696', label: 'Market',     keybind: 'Ctrl+M' },
];

export class SystemMenu {
  private root: HTMLElement;
  private _visible = true;
  private callbacks: Partial<SystemMenuCallbacks> = {};

  constructor(private readonly uiRoot: HTMLElement) {
    this._injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'system-menu';
    this._build();
    uiRoot.appendChild(this.root);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get isVisible(): boolean { return this._visible; }

  setCallbacks(cbs: SystemMenuCallbacks): void {
    this.callbacks = cbs;
  }

  show(): void {
    this._visible = true;
    this.root.style.display = '';
  }

  hide(): void {
    this._visible = false;
    this.root.style.display = 'none';
  }

  toggle(): void {
    if (this._visible) this.hide();
    else               this.show();
  }

  dispose(): void {
    this.root.remove();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  private _build(): void {
    let html = '';
    for (const entry of ENTRIES) {
      html += `
        <button class="sm-btn" data-panel="${entry.id}" title="${entry.label} (${entry.keybind})">
          <span class="sm-icon">${entry.icon}</span>
          <span class="sm-label">${entry.label}</span>
          <span class="sm-key">${entry.keybind}</span>
        </button>
      `;
    }
    this.root.innerHTML = html;

    // Wire click handlers
    this.root.querySelectorAll<HTMLButtonElement>('.sm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.panel as keyof SystemMenuCallbacks;
        this.callbacks[id]?.();
      });
    });
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('system-menu-styles')) return;
    const style = document.createElement('style');
    style.id = 'system-menu-styles';
    style.textContent = `
      #system-menu {
        position: fixed;
        top: 100px;
        left: 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px;
        background: rgba(8, 6, 4, 0.88);
        border: 1px solid rgba(200, 145, 60, 0.15);
        border-radius: 4px;
        z-index: 600;
        pointer-events: auto;
      }

      .sm-btn {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 6px;
        padding: 5px 10px 5px 8px;
        background: rgba(20, 14, 8, 0.6);
        border: 1px solid rgba(200, 145, 60, 0.1);
        border-radius: 3px;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
        position: relative;
        white-space: nowrap;
      }

      .sm-btn:hover {
        background: rgba(50, 32, 10, 0.8);
        border-color: rgba(200, 145, 60, 0.4);
      }

      .sm-btn:active {
        background: rgba(70, 42, 10, 0.9);
      }

      .sm-icon {
        font-size: 16px;
        color: rgba(212, 201, 184, 0.75);
        line-height: 1;
      }

      .sm-btn:hover .sm-icon {
        color: var(--ember, #c86a2a);
      }

      .sm-label {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.55);
        letter-spacing: 0.04em;
        flex: 1;
      }

      .sm-key {
        font-family: var(--font-mono, monospace);
        font-size: 8px;
        color: rgba(212, 201, 184, 0.3);
        line-height: 1;
        margin-left: auto;
      }
    `;
    document.head.appendChild(style);
  }
}
