/**
 * SettingsWindow — tabbed settings panel (Display / Camera / Audio).
 *
 * Replaces the old FpsWidget and UIScaleWidget with a single, proper modal.
 * Opened via SystemMenu "Settings" button or the O key.
 *
 * All values persist to localStorage with the `aa_` prefix and apply
 * immediately — no "Apply" button needed. Camera sensitivities are written
 * directly to ClientConfig; other values fire callbacks so app.ts can wire
 * them to the renderer / frame limiter.
 */

import { ClientConfig } from '@/config/ClientConfig';

// ── Callback interface ──────────────────────────────────────────────────────

export interface SettingsCallbacks {
  onFpsLimitChange:     (limit: number) => void;
  onUiScaleChange:      (scale: number) => void;
  onDrawDistanceChange: (meters: number) => void;
}

// ── localStorage keys ───────────────────────────────────────────────────────

const KEY_FPS          = 'aa_fps_limit';
const KEY_UI_SCALE     = 'aa_ui_scale';
const KEY_DRAW_DIST    = 'aa_draw_distance';
const KEY_YAW_SENS     = 'aa_camera_yaw_sens';
const KEY_PITCH_SENS   = 'aa_camera_pitch_sens';
const KEY_MASTER_VOL   = 'aa_master_volume';
const KEY_SFX_VOL      = 'aa_sfx_volume';

// ── Defaults ────────────────────────────────────────────────────────────────

const FPS_PRESETS: readonly number[] = [30, 60, 120, 144, 0]; // 0 = unlimited

const DEF_FPS          = 0;
const DEF_UI_SCALE     = 1.0;
const DEF_DRAW_DIST    = 200;
const DEF_YAW_SENS     = 0.005;
const DEF_PITCH_SENS   = 0.15;
const DEF_MASTER_VOL   = 100;
const DEF_SFX_VOL      = 100;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadNum(key: string, def: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return def;
  const v = parseFloat(raw);
  return isFinite(v) ? v : def;
}

function saveNum(key: string, v: number): void {
  localStorage.setItem(key, String(v));
}

// ── Tabs ────────────────────────────────────────────────────────────────────

type TabId = 'display' | 'camera' | 'audio';

const TABS: { id: TabId; label: string }[] = [
  { id: 'display', label: 'Display' },
  { id: 'camera',  label: 'Camera' },
  { id: 'audio',   label: 'Audio' },
];

// ── Component ───────────────────────────────────────────────────────────────

export class SettingsWindow {
  private root: HTMLElement;
  private _visible = false;
  private activeTab: TabId = 'display';
  private pages = new Map<TabId, HTMLElement>();
  private tabButtons = new Map<TabId, HTMLButtonElement>();

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly callbacks: SettingsCallbacks,
  ) {
    this._injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'settings-window';
    this.root.style.display = 'none';
    this._build();
    uiRoot.appendChild(this.root);

    // Escape closes the window (capture phase — fires before other handlers)
    window.addEventListener('keydown', this._onKeyDown, true);

    // ── Restore saved values & fire initial callbacks ──────────────────
    this._restoreAll();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._visible = true;
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('visible'));
  }

  hide(): void {
    this._visible = false;
    this.root.classList.remove('visible');
    this.root.style.display = 'none';
  }

  toggle(): void {
    if (this._visible) this.hide(); else this.show();
  }

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown, true);
    this.root.remove();
  }

  // ── Escape handler ──────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this._visible) {
      e.stopPropagation();
      e.preventDefault();
      this.hide();
    }
  };

  // ── Restore ─────────────────────────────────────────────────────────────

  private _restoreAll(): void {
    // FPS
    const fps = loadNum(KEY_FPS, DEF_FPS);
    this.callbacks.onFpsLimitChange(fps);

    // UI Scale
    const scale = Math.min(1.6, Math.max(0.6, loadNum(KEY_UI_SCALE, DEF_UI_SCALE)));
    this.callbacks.onUiScaleChange(scale);

    // Draw distance
    const dd = Math.min(500, Math.max(50, loadNum(KEY_DRAW_DIST, DEF_DRAW_DIST)));
    ClientConfig.drawDistance = dd;
    this.callbacks.onDrawDistanceChange(dd);

    // Camera sensitivity
    ClientConfig.cameraYawSensitivity  = loadNum(KEY_YAW_SENS, DEF_YAW_SENS);
    ClientConfig.cameraPitchSensitivity = loadNum(KEY_PITCH_SENS, DEF_PITCH_SENS);

    // Audio (localStorage only, no runtime effect yet)
  }

  // ── Build DOM ───────────────────────────────────────────────────────────

  private _build(): void {
    // Backdrop — clicking it closes the window
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide();
    });

    // Panel
    const panel = document.createElement('div');
    panel.className = 'sw-panel';

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'sw-header';
    header.innerHTML = '<span class="sw-title">Settings</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sw-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => this.hide());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // ── Body (tabs + content) ──
    const body = document.createElement('div');
    body.className = 'sw-body';

    // Tab column
    const tabCol = document.createElement('div');
    tabCol.className = 'sw-tabs';
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = 'sw-tab';
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      if (tab.id === this.activeTab) btn.classList.add('active');
      btn.addEventListener('click', () => this._switchTab(tab.id));
      this.tabButtons.set(tab.id, btn);
      tabCol.appendChild(btn);
    }
    body.appendChild(tabCol);

    // Content area
    const content = document.createElement('div');
    content.className = 'sw-content';
    this._buildDisplayPage(content);
    this._buildCameraPage(content);
    this._buildAudioPage(content);
    body.appendChild(content);

    panel.appendChild(body);
    this.root.appendChild(panel);

    // Show default tab
    this._switchTab(this.activeTab);
  }

  // ── Tab switching ───────────────────────────────────────────────────────

  private _switchTab(id: TabId): void {
    this.activeTab = id;
    for (const [tid, btn] of this.tabButtons) {
      btn.classList.toggle('active', tid === id);
    }
    for (const [pid, page] of this.pages) {
      page.style.display = pid === id ? 'flex' : 'none';
    }
  }

  // ── Display tab ─────────────────────────────────────────────────────────

  private _buildDisplayPage(container: HTMLElement): void {
    const page = this._makePage('display');

    // UI Scale slider
    page.appendChild(this._buildSlider({
      label: 'UI Scale',
      min: 0.6, max: 1.6, step: 0.05,
      initial: loadNum(KEY_UI_SCALE, DEF_UI_SCALE),
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => {
        saveNum(KEY_UI_SCALE, v);
        this.callbacks.onUiScaleChange(v);
      },
    }));

    // FPS Limit presets
    page.appendChild(this._buildPresetRow({
      label: 'FPS Limit',
      presets: FPS_PRESETS as unknown as number[],
      initial: loadNum(KEY_FPS, DEF_FPS),
      format: (v) => v === 0 ? '\u221E' : String(v),
      onChange: (v) => {
        saveNum(KEY_FPS, v);
        this.callbacks.onFpsLimitChange(v);
      },
    }));

    // Draw Distance slider
    page.appendChild(this._buildSlider({
      label: 'Draw Distance',
      min: 50, max: 500, step: 10,
      initial: loadNum(KEY_DRAW_DIST, DEF_DRAW_DIST),
      format: (v) => `${v}m`,
      onChange: (v) => {
        saveNum(KEY_DRAW_DIST, v);
        ClientConfig.drawDistance = v;
        this.callbacks.onDrawDistanceChange(v);
      },
    }));

    container.appendChild(page);
  }

  // ── Camera tab ──────────────────────────────────────────────────────────

  private _buildCameraPage(container: HTMLElement): void {
    const page = this._makePage('camera');

    page.appendChild(this._buildSlider({
      label: 'Yaw Sensitivity',
      min: 0.001, max: 0.01, step: 0.001,
      initial: loadNum(KEY_YAW_SENS, DEF_YAW_SENS),
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        saveNum(KEY_YAW_SENS, v);
        ClientConfig.cameraYawSensitivity = v;
      },
    }));

    page.appendChild(this._buildSlider({
      label: 'Pitch Sensitivity',
      min: 0.05, max: 0.30, step: 0.01,
      initial: loadNum(KEY_PITCH_SENS, DEF_PITCH_SENS),
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        saveNum(KEY_PITCH_SENS, v);
        ClientConfig.cameraPitchSensitivity = v;
      },
    }));

    container.appendChild(page);
  }

  // ── Audio tab ───────────────────────────────────────────────────────────

  private _buildAudioPage(container: HTMLElement): void {
    const page = this._makePage('audio');

    page.appendChild(this._buildSlider({
      label: 'Master Volume',
      min: 0, max: 100, step: 1,
      initial: loadNum(KEY_MASTER_VOL, DEF_MASTER_VOL),
      format: (v) => `${Math.round(v)}%`,
      onChange: (v) => { saveNum(KEY_MASTER_VOL, v); },
    }));

    page.appendChild(this._buildSlider({
      label: 'Sound Effects',
      min: 0, max: 100, step: 1,
      initial: loadNum(KEY_SFX_VOL, DEF_SFX_VOL),
      format: (v) => `${Math.round(v)}%`,
      onChange: (v) => { saveNum(KEY_SFX_VOL, v); },
    }));

    container.appendChild(page);
  }

  // ── Builders ────────────────────────────────────────────────────────────

  private _makePage(id: TabId): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sw-page';
    el.dataset.page = id;
    this.pages.set(id, el);
    return el;
  }

  private _buildSlider(opts: {
    label: string;
    min: number; max: number; step: number;
    initial: number;
    format: (v: number) => string;
    onChange: (v: number) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = opts.label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sw-slider';
    slider.min   = String(opts.min);
    slider.max   = String(opts.max);
    slider.step  = String(opts.step);
    slider.value = String(opts.initial);

    const val = document.createElement('span');
    val.className = 'sw-val';
    val.textContent = opts.format(opts.initial);

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      val.textContent = opts.format(v);
      opts.onChange(v);
    });

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(val);
    return row;
  }

  private _buildPresetRow(opts: {
    label: string;
    presets: number[];
    initial: number;
    format: (v: number) => string;
    onChange: (v: number) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = opts.label;
    row.appendChild(lbl);

    const group = document.createElement('div');
    group.className = 'sw-preset-group';

    const buttons: HTMLButtonElement[] = [];
    for (const preset of opts.presets) {
      const btn = document.createElement('button');
      btn.className = 'sw-preset';
      btn.textContent = opts.format(preset);
      if (preset === opts.initial) btn.classList.add('active');

      btn.addEventListener('click', () => {
        for (const b of buttons) b.classList.remove('active');
        btn.classList.add('active');
        opts.onChange(preset);
      });

      buttons.push(btn);
      group.appendChild(btn);
    }

    row.appendChild(group);
    return row;
  }

  // ── Styles ──────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('settings-window-styles')) return;
    const style = document.createElement('style');
    style.id = 'settings-window-styles';
    style.textContent = `
      /* ── Backdrop ─────────────────────────────────────────────── */
      #settings-window {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        z-index: 950;
        pointer-events: auto;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      #settings-window.visible { opacity: 1; }

      /* ── Panel ────────────────────────────────────────────────── */
      .sw-panel {
        width: 520px;
        max-height: 420px;
        background: rgba(8, 6, 4, 0.96);
        border: 1px solid rgba(200, 145, 60, 0.25);
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
      }

      /* ── Header ───────────────────────────────────────────────── */
      .sw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(200, 145, 60, 0.15);
      }
      .sw-title {
        font-family: var(--font-body, serif);
        font-size: 14px;
        color: rgba(212, 201, 184, 0.8);
        letter-spacing: 0.06em;
      }
      .sw-close {
        background: none;
        border: none;
        color: rgba(212, 201, 184, 0.4);
        font-size: 16px;
        cursor: pointer;
        padding: 2px 6px;
        line-height: 1;
        transition: color 0.12s;
      }
      .sw-close:hover { color: var(--ember, #c86a2a); }

      /* ── Body (tabs + content) ────────────────────────────────── */
      .sw-body {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      /* ── Tab column ───────────────────────────────────────────── */
      .sw-tabs {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 6px;
        border-right: 1px solid rgba(200, 145, 60, 0.12);
        min-width: 100px;
      }
      .sw-tab {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.5);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        padding: 7px 12px;
        text-align: left;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
        letter-spacing: 0.04em;
      }
      .sw-tab:hover {
        background: rgba(200, 145, 60, 0.08);
        color: rgba(212, 201, 184, 0.75);
      }
      .sw-tab.active {
        background: rgba(200, 145, 60, 0.14);
        color: rgba(212, 201, 184, 0.9);
        border-color: rgba(200, 145, 60, 0.3);
      }

      /* ── Content area ─────────────────────────────────────────── */
      .sw-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
      }
      .sw-page {
        display: none;
        flex-direction: column;
        gap: 14px;
      }

      /* ── Setting row ──────────────────────────────────────────── */
      .sw-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .sw-lbl {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.6);
        letter-spacing: 0.04em;
        min-width: 110px;
        flex-shrink: 0;
      }

      /* ── Slider ───────────────────────────────────────────────── */
      .sw-slider {
        -webkit-appearance: none;
        appearance: none;
        flex: 1;
        height: 3px;
        background: rgba(200, 145, 60, 0.2);
        outline: none;
        cursor: pointer;
        border-radius: 2px;
      }
      .sw-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(200, 145, 60, 0.75);
        cursor: pointer;
        transition: background 0.12s;
      }
      .sw-slider::-webkit-slider-thumb:hover {
        background: rgba(200, 145, 60, 1);
      }
      .sw-slider::-moz-range-thumb {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(200, 145, 60, 0.75);
        border: none;
        cursor: pointer;
      }

      /* ── Value readout ────────────────────────────────────────── */
      .sw-val {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.55);
        min-width: 48px;
        text-align: right;
        letter-spacing: 0.04em;
        flex-shrink: 0;
      }

      /* ── Preset buttons ───────────────────────────────────────── */
      .sw-preset-group {
        display: flex;
        gap: 4px;
        flex: 1;
      }
      .sw-preset {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.5);
        background: rgba(200, 145, 60, 0.08);
        border: 1px solid rgba(200, 145, 60, 0.15);
        padding: 3px 8px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
        line-height: 1.2;
        border-radius: 2px;
      }
      .sw-preset:hover {
        background: rgba(200, 145, 60, 0.18);
        color: rgba(212, 201, 184, 0.75);
      }
      .sw-preset.active {
        background: rgba(200, 145, 60, 0.28);
        color: rgba(212, 201, 184, 0.9);
        border-color: rgba(200, 145, 60, 0.45);
      }
    `;
    document.head.appendChild(style);
  }
}
