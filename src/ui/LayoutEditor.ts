/**
 * LayoutEditor — drag-to-reposition system for HUD widgets.
 *
 * Press F10 (or click the SystemMenu "Layout" button) to enter edit mode.
 * Movable widgets get a dashed amber outline and a name label; drag them
 * to a new position.  Positions are stored in localStorage as CSS-pixel
 * translate offsets so the original CSS layout serves as the default.
 *
 * Individual widget files require NO modifications — the LayoutEditor finds
 * them by element ID and manages everything externally via inline
 * `transform: translate(…)` styles.
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface WidgetDef {
  id:    string;
  label: string;
}

interface WidgetPos {
  dx: number;
  dy: number;
}

type SavedLayout = Record<string, WidgetPos>;

// ── Config ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'aa_layout_positions';

const DRAGGABLE: WidgetDef[] = [
  { id: 'hud',                  label: 'Vitals' },
  { id: 'action-bar',           label: 'Action Bar' },
  { id: 'chat-panel',           label: 'Chat' },
  { id: 'minimap',              label: 'Minimap' },
  { id: 'target-window',        label: 'Target' },
  { id: 'enmity-panel',         label: 'Threat' },
  { id: 'system-menu',          label: 'Menu' },
  { id: 'hud-clock',            label: 'Clock' },
  { id: 'hud-fps',              label: 'FPS' },
  { id: 'hud-effects-wrapper',  label: 'Effects' },
];

/** Minimum fraction of the widget that must remain on-screen after a drag. */
const ON_SCREEN_FRACTION = 0.2;

// ── LayoutEditor ─────────────────────────────────────────────────────────────

export class LayoutEditor {
  private _active  = false;
  private _saved:    SavedLayout = {};
  private _uiRoot:   HTMLElement;
  private _overlay:  HTMLElement | null = null;
  private _labels:   HTMLElement[] = [];

  /** Currently dragging? */
  private _drag: {
    el:     HTMLElement;
    id:     string;
    startX: number;
    startY: number;
    origDx: number;
    origDy: number;
  } | null = null;

  constructor(uiRoot: HTMLElement) {
    this._uiRoot = uiRoot;
    this._load();
    // Styles injected once into <head>
    this._injectStyles();
    window.addEventListener('resize', this._onResize);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isActive(): boolean { return this._active; }

  /** Apply saved offsets to every registered widget that currently exists. */
  applyAll(): void {
    for (const def of DRAGGABLE) this._applyOne(def.id);
  }

  toggle(): void {
    if (this._active) this._exit();
    else              this._enter();
  }

  resetAll(): void {
    for (const def of DRAGGABLE) {
      const el = document.getElementById(def.id);
      if (el) el.style.transform = '';
    }
    this._saved = {};
    this._save();
  }

  dispose(): void {
    if (this._active) this._exit();
    window.removeEventListener('resize', this._onResize);
  }

  // ── Enter / Exit ───────────────────────────────────────────────────────────

  private _enter(): void {
    this._active = true;
    this._showOverlay();
    // Mark each existing widget as editable
    for (const def of DRAGGABLE) {
      const el = document.getElementById(def.id);
      if (!el || el.offsetParent === null && el.style.display === 'none') continue;
      el.classList.add('layout-editable');
      el.setAttribute('data-layout-id', def.id);
      // Inject a name label
      const lbl = document.createElement('span');
      lbl.className = 'layout-label';
      lbl.textContent = def.label;
      el.appendChild(lbl);
      this._labels.push(lbl);
    }
    // Listeners (capture so we beat game click handlers)
    document.addEventListener('mousedown', this._onDown, true);
    document.addEventListener('keydown',   this._onKey,  true);
  }

  private _exit(): void {
    this._active = false;
    this._drag   = null;
    document.removeEventListener('mousedown', this._onDown, true);
    document.removeEventListener('mousemove', this._onMove, true);
    document.removeEventListener('mouseup',   this._onUp,   true);
    document.removeEventListener('keydown',   this._onKey,  true);
    // Remove visual indicators
    for (const def of DRAGGABLE) {
      const el = document.getElementById(def.id);
      if (el) {
        el.classList.remove('layout-editable');
        el.removeAttribute('data-layout-id');
      }
    }
    for (const lbl of this._labels) lbl.remove();
    this._labels = [];
    this._hideOverlay();
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  private _showOverlay(): void {
    if (this._overlay) return;
    const ov = document.createElement('div');
    ov.id = 'layout-edit-overlay';
    ov.innerHTML = `
      <div id="layout-edit-banner">
        <span>Layout Edit Mode — drag widgets to reposition · <b>F10</b> to exit</span>
        <button class="layout-reset-btn" id="layout-reset-btn">Reset All</button>
      </div>
    `;
    document.body.appendChild(ov);
    this._overlay = ov;
    ov.querySelector('#layout-reset-btn')!.addEventListener('click', () => {
      this.resetAll();
    });
  }

  private _hideOverlay(): void {
    this._overlay?.remove();
    this._overlay = null;
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────

  private _onDown = (e: MouseEvent): void => {
    // Only left button
    if (e.button !== 0) return;
    // Walk up from target to find a layout-editable element
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-layout-id]');
    if (!target) return;
    const id = target.getAttribute('data-layout-id')!;

    e.preventDefault();
    e.stopPropagation();

    const pos = this._saved[id] ?? { dx: 0, dy: 0 };
    this._drag = {
      el:     target,
      id,
      startX: e.clientX,
      startY: e.clientY,
      origDx: pos.dx,
      origDy: pos.dy,
    };

    document.addEventListener('mousemove', this._onMove, true);
    document.addEventListener('mouseup',   this._onUp,   true);
  };

  private _onMove = (e: MouseEvent): void => {
    if (!this._drag) return;
    e.preventDefault();
    e.stopPropagation();

    const zoom = this._getZoom();
    const dx = this._drag.origDx + (e.clientX - this._drag.startX) / zoom;
    const dy = this._drag.origDy + (e.clientY - this._drag.startY) / zoom;
    this._drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  private _onUp = (e: MouseEvent): void => {
    if (!this._drag) return;
    e.preventDefault();
    e.stopPropagation();

    const zoom = this._getZoom();
    let dx = this._drag.origDx + (e.clientX - this._drag.startX) / zoom;
    let dy = this._drag.origDy + (e.clientY - this._drag.startY) / zoom;

    // Clamp so the widget stays partially on-screen
    const clamped = this._clamp(this._drag.el, dx, dy);
    dx = clamped.dx;
    dy = clamped.dy;

    this._drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
    this._saved[this._drag.id] = { dx, dy };
    this._save();

    document.removeEventListener('mousemove', this._onMove, true);
    document.removeEventListener('mouseup',   this._onUp,   true);
    this._drag = null;
  };

  private _onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'F10') {
      e.preventDefault();
      e.stopPropagation();
      this._exit();
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this._saved = JSON.parse(raw) as SavedLayout;
    } catch { /* ignore corrupt data */ }
  }

  private _save(): void {
    // Strip entries with zero offset to keep storage lean
    const clean: SavedLayout = {};
    for (const [id, pos] of Object.entries(this._saved)) {
      if (Math.abs(pos.dx) > 0.5 || Math.abs(pos.dy) > 0.5) {
        clean[id] = pos;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  }

  private _applyOne(id: string): void {
    const pos = this._saved[id];
    const el  = document.getElementById(id);
    if (!el || !pos) return;
    el.style.transform = `translate(${pos.dx}px, ${pos.dy}px)`;
  }

  private _getZoom(): number {
    const raw = (this._uiRoot.style as unknown as Record<string, unknown>)['zoom'];
    const v = parseFloat(String(raw));
    return isFinite(v) && v > 0 ? v : 1;
  }

  /** Clamp dx/dy so at least ON_SCREEN_FRACTION of the widget stays visible. */
  private _clamp(el: HTMLElement, dx: number, dy: number): WidgetPos {
    const rect = el.getBoundingClientRect();
    const zoom = this._getZoom();
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const minW = rect.width  * ON_SCREEN_FRACTION;
    const minH = rect.height * ON_SCREEN_FRACTION;

    // Compute where the widget's default position would be (remove current translate)
    const curDx = this._saved[el.id]?.dx ?? 0;
    const curDy = this._saved[el.id]?.dy ?? 0;
    const baseLeft = rect.left / zoom - curDx;
    const baseTop  = rect.top  / zoom - curDy;

    // New position
    const newLeft = baseLeft + dx;
    const newTop  = baseTop  + dy;
    const w       = rect.width / zoom;
    const h       = rect.height / zoom;

    // Keep at least minW visible horizontally
    if (newLeft + w < minW)       dx += (minW - (newLeft + w));
    if (newLeft > vw / zoom - minW) dx -= (newLeft - (vw / zoom - minW));

    // Keep at least minH visible vertically
    if (newTop + h < minH)        dy += (minH - (newTop + h));
    if (newTop > vh / zoom - minH) dy -= (newTop - (vh / zoom - minH));

    return { dx, dy };
  }

  private _onResize = (): void => {
    // Re-clamp all saved positions so nothing is off-screen after resize
    let changed = false;
    for (const def of DRAGGABLE) {
      const pos = this._saved[def.id];
      if (!pos) continue;
      const el = document.getElementById(def.id);
      if (!el) continue;
      const clamped = this._clamp(el, pos.dx, pos.dy);
      if (Math.abs(clamped.dx - pos.dx) > 0.5 || Math.abs(clamped.dy - pos.dy) > 0.5) {
        this._saved[def.id] = clamped;
        el.style.transform = `translate(${clamped.dx}px, ${clamped.dy}px)`;
        changed = true;
      }
    }
    if (changed) this._save();
  };

  // ── Styles (injected once) ─────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('layout-editor-styles')) return;
    const style = document.createElement('style');
    style.id = 'layout-editor-styles';
    style.textContent = `
      /* ── Edit-mode overlay ──────────────────────────────────────── */
      #layout-edit-overlay {
        position: fixed;
        inset: 0;
        background: rgba(14, 12, 10, 0.25);
        z-index: 9999;
        pointer-events: none;
      }

      #layout-edit-banner {
        position: fixed;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(8, 6, 4, 0.92);
        border: 1px solid rgba(200, 145, 60, 0.4);
        border-top: none;
        border-radius: 0 0 6px 6px;
        padding: 8px 24px;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(212, 201, 184, 0.85);
        letter-spacing: 0.06em;
        z-index: 10001;
        pointer-events: auto;
        display: flex;
        gap: 20px;
        align-items: center;
        white-space: nowrap;
      }

      .layout-reset-btn {
        background: rgba(200, 60, 60, 0.25);
        border: 1px solid rgba(200, 60, 60, 0.35);
        border-radius: 3px;
        color: rgba(212, 201, 184, 0.8);
        padding: 3px 14px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.06em;
        transition: background 0.12s, border-color 0.12s;
      }

      .layout-reset-btn:hover {
        background: rgba(200, 60, 60, 0.45);
        border-color: rgba(200, 60, 60, 0.6);
      }

      /* ── Editable widget decorations ────────────────────────────── */
      .layout-editable {
        outline: 1px dashed rgba(200, 145, 60, 0.5) !important;
        outline-offset: 3px;
        cursor: grab !important;
        pointer-events: auto !important;
        z-index: 10000 !important;
      }

      .layout-editable:active {
        cursor: grabbing !important;
      }

      .layout-label {
        position: absolute;
        top: -18px;
        left: 0;
        background: rgba(200, 145, 60, 0.85);
        color: #0e0c0a;
        font-family: var(--font-mono, monospace);
        font-size: 9px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 2px;
        letter-spacing: 0.06em;
        pointer-events: none;
        white-space: nowrap;
        z-index: 10002;
        line-height: 14px;
      }
    `;
    document.head.appendChild(style);
  }
}
