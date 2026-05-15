/**
 * SystemMenu — FFXIV-style button bar for opening game panels.
 *
 * Always-visible vertical column at the top-left during gameplay. Each
 * button toggles the corresponding panel and shows the keybind hint.
 *
 * Gamepad nav mode (entered via the bound `menu` action, default Start):
 *   - Highlights one button at a time with an arrow cursor
 *   - Arrow keys / d-pad walk the cursor (gamepad goes to `modal` state)
 *   - Enter / Confirm activates the highlighted panel and exits nav mode
 *   - Escape / Cancel exits without activating
 *   - Reports `isVisible = true` to ModalStack ONLY while in nav mode, so
 *     the gamepad routes d-pad to arrow keys without affecting the rest
 *     of the input flow. The visual panel itself is always shown.
 */

export interface SystemMenuCallbacks {
  character:  () => void;
  inventory:  () => void;
  abilities:  () => void;
  companion:  () => void;
  guild:      () => void;
  party:      () => void;
  map:        () => void;
  travel:     () => void;
  market:     () => void;
  layout:     () => void;
  settings:   () => void;
}

interface MenuEntry {
  id:      keyof SystemMenuCallbacks;
  icon:    string;
  label:   string;
  keybind: string;
}

const ENTRIES: MenuEntry[] = [
  { id: 'character',  icon: '♦', label: 'Character',  keybind: 'C' },
  { id: 'inventory',  icon: '◈', label: 'Inventory',  keybind: 'I' },
  { id: 'abilities',  icon: '✦', label: 'Abilities',  keybind: 'K' },
  { id: 'companion',  icon: '❀', label: 'Companion',  keybind: 'N' },
  { id: 'guild',      icon: '⚜', label: 'Guild',      keybind: 'G' },
  { id: 'party',      icon: '☰', label: 'Party',      keybind: 'P' },
  { id: 'map',        icon: '◎', label: 'Map',        keybind: 'M' },
  { id: 'travel',     icon: '✈', label: 'Travel',     keybind: 'R' },
  { id: 'market',     icon: '⚖', label: 'Market',     keybind: 'Ctrl+M' },
  { id: 'layout',     icon: '⬚', label: 'Layout',     keybind: 'F10' },
  { id: 'settings',   icon: '⚙', label: 'Settings',   keybind: 'O' },
];

export class SystemMenu {
  private root: HTMLElement;
  /** Panel visibility on screen — driven by show/hide (e.g. phase changes). */
  private _shown = true;
  /** Gamepad nav-mode flag. Doubles as the ModalLike `isVisible` signal so
   *  the gamepad routes d-pad to this panel's keydown handler. */
  private _navMode = false;
  private _cursor = 0;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private callbacks: Partial<SystemMenuCallbacks> = {};

  constructor(private readonly uiRoot: HTMLElement) {
    this._injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'system-menu';
    this._build();
    uiRoot.appendChild(this.root);

    this._keyHandler = (e: KeyboardEvent) => this._onKey(e);
    window.addEventListener('keydown', this._keyHandler);
  }

  // ── ModalLike contract ──────────────────────────────────────────────────
  // isVisible reports nav-mode (not panel visibility). When true, ModalStack
  // treats SystemMenu as the active modal and the gamepad routes d-pad arrows
  // to this panel. When false (default), SystemMenu is a passive HUD bar.
  get isVisible(): boolean { return this._navMode; }
  close(): void { this.exitNavMode(); }

  setCallbacks(cbs: SystemMenuCallbacks): void {
    this.callbacks = cbs;
  }

  show(): void {
    this._shown = true;
    this.root.style.display = '';
  }

  hide(): void {
    this._shown = false;
    this.root.style.display = 'none';
    // Hiding the bar also drops any nav-mode in progress.
    if (this._navMode) this.exitNavMode();
  }

  /** Legacy toggle — flips screen visibility, not nav mode. */
  toggle(): void {
    if (this._shown) this.hide();
    else             this.show();
  }

  // ── Nav mode (gamepad) ──────────────────────────────────────────────────

  enterNavMode(): void {
    if (this._navMode) return;
    this._navMode = true;
    this._cursor = 0;
    this._updateCursor();
  }

  exitNavMode(): void {
    if (!this._navMode) return;
    this._navMode = false;
    this._updateCursor();
  }

  toggleNavMode(): void {
    if (this._navMode) this.exitNavMode();
    else               this.enterNavMode();
  }

  dispose(): void {
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    this.root.remove();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  private _build(): void {
    let html = '';
    for (const entry of ENTRIES) {
      html += `
        <button class="sm-btn" data-panel="${entry.id}" title="${entry.label} (${entry.keybind})">
          <span class="sm-cursor">▸</span>
          <span class="sm-icon">${entry.icon}</span>
          <span class="sm-label">${entry.label}</span>
          <span class="sm-key">${entry.keybind}</span>
        </button>
      `;
    }
    this.root.innerHTML = html;

    // Wire click handlers
    this.root.querySelectorAll<HTMLButtonElement>('.sm-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.panel as keyof SystemMenuCallbacks;
        // Click also drops nav mode so the user doesn't end up with a stale cursor.
        if (this._navMode) this.exitNavMode();
        this._cursor = i;
        this.callbacks[id]?.();
      });
    });
  }

  // ── Keyboard (only handles while in nav mode — silent otherwise) ────────

  private _onKey(e: KeyboardEvent): void {
    if (!this._navMode) return;
    // Don't steal keys when typing in chat.
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault(); e.stopPropagation();
        this._cursor = (this._cursor - 1 + ENTRIES.length) % ENTRIES.length;
        this._updateCursor();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault(); e.stopPropagation();
        this._cursor = (this._cursor + 1) % ENTRIES.length;
        this._updateCursor();
        break;
      case 'Enter':
      case 'NumpadEnter': {
        e.preventDefault(); e.stopPropagation();
        const entry = ENTRIES[this._cursor];
        if (!entry) break;
        this.exitNavMode();           // exit before invoking so the new panel takes over modal duty cleanly
        this.callbacks[entry.id]?.();
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        this.exitNavMode();
        break;
    }
  }

  private _updateCursor(): void {
    const buttons = this.root.querySelectorAll<HTMLElement>('.sm-btn');
    buttons.forEach((btn, i) => {
      btn.classList.toggle('sm-nav-active', this._navMode && i === this._cursor);
    });
    this.root.classList.toggle('sm-nav-mode', this._navMode);
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
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      /* Nav-mode framing — subtle outline so the player knows the bar is
       * "live" and listening for d-pad input. */
      #system-menu.sm-nav-mode {
        border-color: rgba(220, 165, 80, 0.75);
        box-shadow: 0 0 12px rgba(220, 165, 80, 0.35);
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

      /* Gamepad cursor selection — distinct from hover so a mouseover doesn't
       * mask the d-pad position. */
      .sm-btn.sm-nav-active {
        background: rgba(70, 45, 10, 0.95);
        border-color: rgba(220, 165, 80, 0.85);
        box-shadow: inset 0 0 0 1px rgba(220, 165, 80, 0.4);
      }

      .sm-cursor {
        width: 8px;
        font-size: 10px;
        color: var(--ember, #c86a2a);
        line-height: 1;
        opacity: 0;
        flex-shrink: 0;
      }

      .sm-btn.sm-nav-active .sm-cursor { opacity: 1; }

      .sm-icon {
        font-size: 16px;
        color: rgba(212, 201, 184, 0.75);
        line-height: 1;
      }

      .sm-btn:hover .sm-icon,
      .sm-btn.sm-nav-active .sm-icon {
        color: var(--ember, #c86a2a);
      }

      .sm-label {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.55);
        letter-spacing: 0.04em;
        flex: 1;
      }

      .sm-btn.sm-nav-active .sm-label {
        color: #e8cc88;
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
