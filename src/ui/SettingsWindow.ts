/**
 * SettingsWindow — tabbed settings panel (Display / Camera / Audio / Companion).
 *
 * Replaces the old FpsWidget and UIScaleWidget with a single, proper modal.
 * Opened via SystemMenu "Settings" button or the O key.
 *
 * All values persist to localStorage with the `aa_` prefix and apply
 * immediately — no "Apply" button needed. Camera sensitivities are written
 * directly to ClientConfig; other values fire callbacks so app.ts can wire
 * them to the renderer / frame limiter.
 *
 * The Companion tab exposes BYOLLM configuration:
 *   - LLM provider (Anthropic, OpenAI, Ollama, custom), endpoint, key, model
 *   - Test Connection button
 *   - Social actions toggle
 *   - Chat history channel selection & lookback settings
 */

import { ClientConfig, type SelfPlateMode } from '@/config/ClientConfig';
import {
  loadSettings, saveSettings, getDefaultEndpoint, getDefaultModel,
  type CompanionLLMConfig, type LLMProvider, type CompanionFullSettings,
} from '@/companion/CompanionSettings';
import type { CommunicationChannel } from '@/network/Protocol';
import {
  GAMEPAD_ACTIONS, ACTION_LABELS, ACTION_DESCRIPTIONS,
  buttonLabel, type GamepadAction, type GamepadBindings,
} from '@/input/GamepadBindings';

// ── Callback interface ──────────────────────────────────────────────────────

export interface SettingsCallbacks {
  onFpsLimitChange:     (limit: number) => void;
  onUiScaleChange:      (scale: number) => void;
  onDrawDistanceChange: (meters: number) => void;
  /** Fired when the user picks a new Beacon Detail tier — app.ts asks
   *  the GuildBeacon manager to rebuild existing auras at the new
   *  subdivision count. */
  onBeaconDetailChange: () => void;
  /** Fired when the user picks a new Miasma fog quality. app.ts disposes
   *  any existing fog plane and (if quality !== 'off') constructs a new
   *  one at the new subdivision count. */
  onMiasmaQualityChange: () => void;
  /** Fired when the user picks a new Miasma fog view distance. Also
   *  triggers a fog rebuild because plane size is a constructor param. */
  onMiasmaRangeChange: () => void;
}

// ── localStorage keys ───────────────────────────────────────────────────────

const KEY_FPS          = 'aa_fps_limit';
const KEY_UI_SCALE     = 'aa_ui_scale';
const KEY_DRAW_DIST    = 'aa_draw_distance';
const KEY_YAW_SENS     = 'aa_camera_yaw_sens';
const KEY_PITCH_SENS   = 'aa_camera_pitch_sens';
const KEY_MASTER_VOL   = 'aa_master_volume';
const KEY_SFX_VOL      = 'aa_sfx_volume';
const KEY_TREE_RANGE   = 'aa_tree_visible_range';
const KEY_BEACON_DETAIL = 'aa_beacon_detail';
const KEY_MIASMA_QUALITY = 'aa_miasma_quality';
const KEY_MIASMA_SUBDIVISIONS = 'aa_miasma_subdivisions';
const KEY_MIASMA_RANGE   = 'aa_miasma_range';
// Nameplate keys
const KEY_NP_SELF_MODE   = 'aa_np_self_mode';
const KEY_NP_MOBS        = 'aa_np_mobs';
const KEY_NP_NPCS        = 'aa_np_npcs';
const KEY_NP_PLAYERS     = 'aa_np_players';
const KEY_NP_GUILD_TAG   = 'aa_np_guild_tag';
const KEY_NP_TGT_HP      = 'aa_np_target_hp';
const KEY_NP_TGT_CAST    = 'aa_np_target_cast';
const KEY_NP_ALLY_CAST   = 'aa_np_ally_cast';
const KEY_NP_MAX_RANGE   = 'aa_np_max_range';
const KEY_NP_FADE_START  = 'aa_np_fade_start';
const KEY_NP_MAX_COUNT   = 'aa_np_max_count';
const KEY_NP_SCALE       = 'aa_np_scale';
// Controls
const KEY_ATTACK_AUTO_LOCK    = 'aa_attack_auto_lock';
const KEY_AUTO_FACE_ACTION    = 'aa_auto_face_on_action';
const KEY_SPRINT_TOGGLE_MODE  = 'aa_sprint_toggle_mode';
const KEY_GAMEPAD_DEADZONE    = 'aa_gamepad_deadzone';
const KEY_LOCK_ON_MOVEMENT    = 'aa_lock_on_movement';
const KEY_LOCK_ON_CAMERA      = 'aa_lock_on_camera';

// ── Defaults ────────────────────────────────────────────────────────────────

const FPS_PRESETS: readonly number[] = [30, 60, 120, 144, 0]; // 0 = unlimited

const DEF_FPS          = 0;
const DEF_UI_SCALE     = 1.0;
const DEF_DRAW_DIST    = 200;
const DEF_YAW_SENS     = 0.005;
const DEF_PITCH_SENS   = 0.15;
const DEF_MASTER_VOL   = 100;
const DEF_SFX_VOL      = 100;
const DEF_TREE_RANGE   = 1000;

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

function loadBool(key: string, def: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return def;
  return raw === '1' || raw === 'true';
}

function saveBool(key: string, v: boolean): void {
  localStorage.setItem(key, v ? '1' : '0');
}

// ── Tabs ────────────────────────────────────────────────────────────────────

type TabId = 'display' | 'camera' | 'audio' | 'nameplates' | 'controls' | 'companion';

const TABS: { id: TabId; label: string }[] = [
  { id: 'display',    label: 'Display' },
  { id: 'camera',     label: 'Camera' },
  { id: 'audio',      label: 'Audio' },
  { id: 'nameplates', label: 'Nameplates' },
  { id: 'controls',   label: 'Controls' },
  { id: 'companion',  label: 'Companion' },
];

const SELF_PLATE_OPTIONS: { value: SelfPlateMode; label: string }[] = [
  { value: 'off',     label: 'Off' },
  { value: 'name',    label: 'Name only' },
  { value: 'name_hp', label: 'Name + HP' },
  { value: 'full',    label: 'Full' },
];

// ── Channel display names ─────────────────────────────────────────────────

const CHANNEL_OPTIONS: { id: CommunicationChannel; label: string }[] = [
  { id: 'say',       label: 'Say' },
  { id: 'emote',     label: 'Emote' },
  { id: 'companion', label: 'Companion' },
  { id: 'shout',     label: 'Shout' },
  { id: 'party',     label: 'Party' },
  { id: 'guild',     label: 'Guild' },
];

// ── Component ───────────────────────────────────────────────────────────────

export class SettingsWindow {
  private root: HTMLElement;
  private _visible = false;
  private activeTab: TabId = 'display';
  private pages = new Map<TabId, HTMLElement>();
  private tabButtons = new Map<TabId, HTMLButtonElement>();

  // ── Companion tab state ──
  private _testLLMCallback: ((config: CompanionLLMConfig) => Promise<{ ok: boolean; message?: string; error?: string }>) | null = null;
  private _companionSettings: CompanionFullSettings = loadSettings();

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly callbacks: SettingsCallbacks,
    private readonly gamepadBindings: GamepadBindings | null = null,
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
    // Drop any pending rebind so the next-press doesn't apply after close.
    this.gamepadBindings?.cancelCapture();
  }

  toggle(): void {
    if (this._visible) this.hide(); else this.show();
  }

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown, true);
    this.root.remove();
  }

  /**
   * Set the LLM test callback — called from app.ts after CompanionLLMService is created.
   */
  setTestLLMCallback(fn: (config: CompanionLLMConfig) => Promise<{ ok: boolean; message?: string; error?: string }>): void {
    this._testLLMCallback = fn;
  }

  // ── Escape handler ──────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this._visible) {
      // While rebinding, Esc cancels the capture instead of closing.
      if (this.gamepadBindings?.capturingAction()) {
        e.stopPropagation();
        e.preventDefault();
        this.gamepadBindings.cancelCapture();
        return;
      }
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

    // Tree visibility
    ClientConfig.treeVisibleRange = Math.min(8000, Math.max(100, loadNum(KEY_TREE_RANGE, DEF_TREE_RANGE)));

    // Audio (localStorage only, no runtime effect yet)

    // ── Nameplates ──
    const selfMode = (localStorage.getItem(KEY_NP_SELF_MODE) ?? 'name') as SelfPlateMode;
    if (SELF_PLATE_OPTIONS.some(o => o.value === selfMode)) {
      ClientConfig.nameplateSelfMode = selfMode;
    }
    ClientConfig.nameplateShowMobs     = loadBool(KEY_NP_MOBS,      true);
    ClientConfig.nameplateShowNpcs     = loadBool(KEY_NP_NPCS,      true);
    ClientConfig.nameplateShowPlayers  = loadBool(KEY_NP_PLAYERS,   true);
    ClientConfig.nameplateShowGuildTag = loadBool(KEY_NP_GUILD_TAG, true);
    ClientConfig.nameplateTargetShowHp = loadBool(KEY_NP_TGT_HP,    true);
    ClientConfig.nameplateTargetShowCast = loadBool(KEY_NP_TGT_CAST, true);
    ClientConfig.nameplateAllyShowCast   = loadBool(KEY_NP_ALLY_CAST, false);
    ClientConfig.nameplateMaxRange   = Math.min(200, Math.max(10,  loadNum(KEY_NP_MAX_RANGE,  60)));
    ClientConfig.nameplateFadeStart  = Math.min(ClientConfig.nameplateMaxRange,
                                         Math.max(5, loadNum(KEY_NP_FADE_START, 35)));
    ClientConfig.nameplateMaxCount   = Math.min(150, Math.max(5,   loadNum(KEY_NP_MAX_COUNT, 30)));
    ClientConfig.nameplateScale      = Math.min(2.5, Math.max(0.6, loadNum(KEY_NP_SCALE,     1.0)));

    // Controls
    ClientConfig.attackAutoLock   = loadBool(KEY_ATTACK_AUTO_LOCK,   true);
    ClientConfig.autoFaceOnAction = loadBool(KEY_AUTO_FACE_ACTION,   true);
    ClientConfig.sprintToggleMode = loadBool(KEY_SPRINT_TOGGLE_MODE, false);
    ClientConfig.gamepadDeadzone  = Math.min(0.40, Math.max(0.05,
                                       loadNum(KEY_GAMEPAD_DEADZONE, 0.15)));
    ClientConfig.lockOnMovement   = loadBool(KEY_LOCK_ON_MOVEMENT, false);
    ClientConfig.lockOnCamera     = loadBool(KEY_LOCK_ON_CAMERA, false);
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
    this._buildNameplatesPage(content);
    this._buildControlsPage(content);
    this._buildCompanionPage(content);
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

    // Tree visibility — plants beyond this distance are culled each frame.
    page.appendChild(this._buildSlider({
      label: 'Tree Visibility',
      min: 100, max: 8000, step: 100,
      initial: loadNum(KEY_TREE_RANGE, DEF_TREE_RANGE),
      format: (v) => `${v >= 1000 ? (v / 1000).toFixed(1) + 'km' : v + 'm'}`,
      onChange: (v) => {
        saveNum(KEY_TREE_RANGE, v);
        ClientConfig.treeVisibleRange = v;
      },
    }));

    // Beacon Detail — controls the subdivision count of guild beacon
    // aura discs/domes. Higher tiers conform to terrain more tightly at
    // the cost of vertex count (still trivial — 'high' is ~768 verts
    // per beacon). Existing auras rebuild on change.
    const detailLevels: Array<{ id: 'low' | 'med' | 'high'; label: string }> = [
      { id: 'low',  label: 'Low' },
      { id: 'med',  label: 'Med' },
      { id: 'high', label: 'High' },
    ];
    const initialDetail = (localStorage.getItem(KEY_BEACON_DETAIL) ?? 'med') as 'low' | 'med' | 'high';
    if (detailLevels.some((d) => d.id === initialDetail)) {
      ClientConfig.beaconDetail = initialDetail;
    }
    page.appendChild(this._buildPresetRow({
      label: 'Beacon Detail',
      presets: [0, 1, 2],
      initial: detailLevels.findIndex((d) => d.id === ClientConfig.beaconDetail),
      format: (v) => detailLevels[v]?.label ?? '?',
      onChange: (v) => {
        const tier = detailLevels[v]?.id;
        if (!tier) return;
        localStorage.setItem(KEY_BEACON_DETAIL, tier);
        ClientConfig.beaconDetail = tier;
        this.callbacks.onBeaconDetailChange();
      },
    }));

    // Miasma Fog — per-axis subdivisions for the ground-fog plane. 0 =
    // off (no plane constructed). Total verts = (n+1)². Named tiers were:
    // Low 64, Med 128, High 192, Ultra 256 — slider keeps continuous
    // access INCLUDING absurd values (1024+ = millions of verts) for
    // visual testing. App.ts disposes/recreates the fog on change.
    //
    // On boot: prefer the numeric override saved by the slider; fall
    // back to the old enum tier from the pre-slider settings store, so
    // existing users don't get reset to default.
    const savedSubdiv = localStorage.getItem(KEY_MIASMA_SUBDIVISIONS);
    let initialSubdiv: number;
    if (savedSubdiv !== null && !Number.isNaN(Number(savedSubdiv))) {
      initialSubdiv = Math.max(0, Math.min(2048, Math.floor(Number(savedSubdiv))));
      ClientConfig.miasmaSubdivisionsOverride = initialSubdiv;
    } else {
      const legacyTier = (localStorage.getItem(KEY_MIASMA_QUALITY) ?? 'med') as
        'off' | 'low' | 'med' | 'high' | 'ultra';
      ClientConfig.miasmaQuality = legacyTier;
      initialSubdiv = ClientConfig.miasmaSubdivisions();
    }
    page.appendChild(this._buildSlider({
      label: 'Miasma Fog',
      min: 0, max: 2048, step: 8,
      initial: initialSubdiv,
      format: (v) => {
        if (v <= 0) return 'Off';
        // Label hints at the named tiers + flags the absurd zone for
        // anyone yanking the slider all the way over.
        const tier = v < 32 ? ' (sparse)'
                   : v < 96 ? ' (low)'
                   : v < 160 ? ' (med)'
                   : v < 224 ? ' (high)'
                   : v < 320 ? ' (ultra)'
                   : v < 768 ? ' (testing)'
                   : ' (absurd)';
        return `${v}²${tier}`;
      },
      onChange: (v) => {
        const n = Math.max(0, Math.min(2048, Math.floor(v)));
        localStorage.setItem(KEY_MIASMA_SUBDIVISIONS, String(n));
        ClientConfig.miasmaSubdivisionsOverride = n;
        this.callbacks.onMiasmaQualityChange();
      },
    }));

    // Miasma Range — view distance for the fog plane. Independent from
    // quality (subdivisions). Bigger = see fog further out, but vertex
    // spacing widens unless quality is bumped to compensate.
    const miasmaRanges: Array<{ id: 'short' | 'med' | 'long' | 'far' | 'ultra'; label: string }> = [
      { id: 'short', label: '250m' },
      { id: 'med',   label: '500m' },
      { id: 'long',  label: '1km'  },
      { id: 'far',   label: '2km'  },
      { id: 'ultra', label: '4km'  },
    ];
    const initialRange = (localStorage.getItem(KEY_MIASMA_RANGE) ?? 'long') as typeof miasmaRanges[number]['id'];
    if (miasmaRanges.some((m) => m.id === initialRange)) {
      ClientConfig.miasmaRange = initialRange;
    }
    page.appendChild(this._buildPresetRow({
      label: 'Miasma Range',
      presets: [0, 1, 2, 3, 4],
      initial: miasmaRanges.findIndex((m) => m.id === ClientConfig.miasmaRange),
      format: (v) => miasmaRanges[v]?.label ?? '?',
      onChange: (v) => {
        const tier = miasmaRanges[v]?.id;
        if (!tier) return;
        localStorage.setItem(KEY_MIASMA_RANGE, tier);
        ClientConfig.miasmaRange = tier;
        this.callbacks.onMiasmaRangeChange();
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

  // ── Nameplates tab ──────────────────────────────────────────────────────

  private _buildNameplatesPage(container: HTMLElement): void {
    const page = this._makePage('nameplates');

    page.appendChild(this._buildSectionLabel('Size'));
    page.appendChild(this._buildSlider({
      label: 'Plate Scale',
      min: 0.6, max: 2.5, step: 0.05,
      initial: ClientConfig.nameplateScale,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => {
        saveNum(KEY_NP_SCALE, v);
        ClientConfig.nameplateScale = v;
      },
    }));

    page.appendChild(this._buildDivider());
    page.appendChild(this._buildSectionLabel('Visibility'));

    page.appendChild(this._buildSelect({
      label: 'Self Plate',
      options: SELF_PLATE_OPTIONS.map(o => ({ value: o.value, label: o.label })),
      initial: ClientConfig.nameplateSelfMode,
      onChange: (v) => {
        const mode = v as SelfPlateMode;
        localStorage.setItem(KEY_NP_SELF_MODE, mode);
        ClientConfig.nameplateSelfMode = mode;
      },
    }));

    page.appendChild(this._buildToggle({
      label: 'Show Mob Plates',
      initial: ClientConfig.nameplateShowMobs,
      onChange: (v) => { saveBool(KEY_NP_MOBS, v); ClientConfig.nameplateShowMobs = v; },
    }));
    page.appendChild(this._buildToggle({
      label: 'Show NPC Plates',
      initial: ClientConfig.nameplateShowNpcs,
      onChange: (v) => { saveBool(KEY_NP_NPCS, v); ClientConfig.nameplateShowNpcs = v; },
    }));
    page.appendChild(this._buildToggle({
      label: 'Show Player Plates',
      initial: ClientConfig.nameplateShowPlayers,
      onChange: (v) => { saveBool(KEY_NP_PLAYERS, v); ClientConfig.nameplateShowPlayers = v; },
    }));
    page.appendChild(this._buildToggle({
      label: 'Show Guild Tags',
      sublabel: 'Non-party players show [TAG] before their name',
      initial: ClientConfig.nameplateShowGuildTag,
      onChange: (v) => { saveBool(KEY_NP_GUILD_TAG, v); ClientConfig.nameplateShowGuildTag = v; },
    }));

    page.appendChild(this._buildDivider());
    page.appendChild(this._buildSectionLabel('Target'));

    page.appendChild(this._buildToggle({
      label: 'Show HP on Target Plate',
      sublabel: 'Target frame still shows full HP details',
      initial: ClientConfig.nameplateTargetShowHp,
      onChange: (v) => { saveBool(KEY_NP_TGT_HP, v); ClientConfig.nameplateTargetShowHp = v; },
    }));
    page.appendChild(this._buildToggle({
      label: 'Show Cast Bar on Target Plate',
      sublabel: 'Floating cast bar over your current target — on by default',
      initial: ClientConfig.nameplateTargetShowCast,
      onChange: (v) => { saveBool(KEY_NP_TGT_CAST, v); ClientConfig.nameplateTargetShowCast = v; },
    }));
    page.appendChild(this._buildToggle({
      label: 'Show Ally Cast Bars in World',
      sublabel: 'Floating cast bars on party + companions + hirelings — off by default (party window shows them inline)',
      initial: ClientConfig.nameplateAllyShowCast,
      onChange: (v) => { saveBool(KEY_NP_ALLY_CAST, v); ClientConfig.nameplateAllyShowCast = v; },
    }));

    page.appendChild(this._buildDivider());
    page.appendChild(this._buildSectionLabel('Performance'));

    page.appendChild(this._buildSlider({
      label: 'Visible Range',
      min: 10, max: 200, step: 5,
      initial: ClientConfig.nameplateMaxRange,
      format: (v) => `${v}m`,
      onChange: (v) => {
        saveNum(KEY_NP_MAX_RANGE, v);
        ClientConfig.nameplateMaxRange = v;
        if (ClientConfig.nameplateFadeStart > v) {
          ClientConfig.nameplateFadeStart = v;
          saveNum(KEY_NP_FADE_START, v);
        }
      },
    }));
    page.appendChild(this._buildSlider({
      label: 'Fade Start',
      min: 5, max: 200, step: 5,
      initial: ClientConfig.nameplateFadeStart,
      format: (v) => `${v}m`,
      onChange: (v) => {
        const clamped = Math.min(v, ClientConfig.nameplateMaxRange);
        saveNum(KEY_NP_FADE_START, clamped);
        ClientConfig.nameplateFadeStart = clamped;
      },
    }));
    page.appendChild(this._buildSlider({
      label: 'Max Plates',
      min: 5, max: 150, step: 5,
      initial: ClientConfig.nameplateMaxCount,
      format: (v) => `${v}`,
      onChange: (v) => {
        saveNum(KEY_NP_MAX_COUNT, v);
        ClientConfig.nameplateMaxCount = v;
      },
    }));

    container.appendChild(page);
  }

  // ── Controls tab ──────────────────────────────────────────────────────

  private _buildControlsPage(container: HTMLElement): void {
    const page = this._makePage('controls');

    page.appendChild(this._buildSectionLabel('Behavior'));
    page.appendChild(this._buildToggle({
      label:    'Auto-lock on Attack',
      sublabel: 'Picking Attack also locks the target so cycling doesn\'t drop the engagement',
      initial:  ClientConfig.attackAutoLock,
      onChange: (v) => {
        saveBool(KEY_ATTACK_AUTO_LOCK, v);
        ClientConfig.attackAutoLock = v;
      },
    }));
    page.appendChild(this._buildToggle({
      label:    'Auto-face on Action',
      sublabel: 'Server rotates you toward your target on Attack and on each cast start',
      initial:  ClientConfig.autoFaceOnAction,
      onChange: (v) => {
        saveBool(KEY_AUTO_FACE_ACTION, v);
        ClientConfig.autoFaceOnAction = v;
      },
    }));
    page.appendChild(this._buildToggle({
      label:    'Sprint as Toggle',
      sublabel: 'Press once to sprint; auto-stops on out-of-stamina or movement stop. Off = hold-to-sprint',
      initial:  ClientConfig.sprintToggleMode,
      onChange: (v) => {
        saveBool(KEY_SPRINT_TOGGLE_MODE, v);
        ClientConfig.sprintToggleMode = v;
      },
    }));

    page.appendChild(this._buildToggle({
      label:    'Lock-on Movement',
      sublabel: 'With a locked target: forward approaches (stops at 1.5m), back retreats, A/D strafe. Body faces target.',
      initial:  ClientConfig.lockOnMovement,
      onChange: (v) => {
        saveBool(KEY_LOCK_ON_MOVEMENT, v);
        ClientConfig.lockOnMovement = v;
      },
    }));

    page.appendChild(this._buildToggle({
      label:    'Lock-on Camera',
      sublabel: 'Camera follows the locked target. Right-stick yaw still works but elastically pulls back.',
      initial:  ClientConfig.lockOnCamera,
      onChange: (v) => {
        saveBool(KEY_LOCK_ON_CAMERA, v);
        ClientConfig.lockOnCamera = v;
      },
    }));

    page.appendChild(this._buildDivider());

    if (!this.gamepadBindings) {
      const msg = document.createElement('div');
      msg.className = 'sw-section-label';
      msg.textContent = 'Gamepad bindings unavailable.';
      page.appendChild(msg);
      container.appendChild(page);
      return;
    }

    page.appendChild(this._buildSectionLabel('Gamepad'));

    // Stick deadzone — varies per controller (worn sticks drift; fresh ones
    // very little). Sourced fresh by GamepadController on every tick, so the
    // slider applies live without a reconnect.
    page.appendChild(this._buildSlider({
      label:   'Stick Deadzone',
      min:     0.05,
      max:     0.40,
      step:    0.01,
      initial: ClientConfig.gamepadDeadzone,
      format:  (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => {
        saveNum(KEY_GAMEPAD_DEADZONE, v);
        ClientConfig.gamepadDeadzone = v;
      },
    }));

    const help = document.createElement('div');
    help.style.cssText = 'color:rgba(212,201,184,0.55);font-size:11px;margin:-4px 0 8px 0;';
    help.textContent = 'Click Rebind, then press the gamepad button you want. Esc cancels.';
    page.appendChild(help);

    // Track each row's elements so we can refresh them after a rebind.
    const rowRefs: { action: GamepadAction; valueEl: HTMLElement; btnEl: HTMLButtonElement }[] = [];

    const refreshAll = (): void => {
      for (const r of rowRefs) {
        r.valueEl.textContent = buttonLabel(this.gamepadBindings!.get(r.action));
      }
    };

    const bindings = this.gamepadBindings;

    for (const action of GAMEPAD_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'sw-row';
      row.style.cssText = 'flex-wrap: wrap;';

      const lbl = document.createElement('span');
      lbl.className = 'sw-lbl';
      lbl.textContent = ACTION_LABELS[action];
      lbl.title = ACTION_DESCRIPTIONS[action];

      const value = document.createElement('span');
      value.className = 'sw-val';
      value.style.cssText = 'min-width: 120px; text-align: right;';
      value.textContent = buttonLabel(bindings.get(action));

      const btn = document.createElement('button');
      btn.className = 'sw-preset';
      btn.textContent = 'Rebind';
      btn.style.cssText = 'min-width: 80px; margin-left: 8px;';

      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) {
          // Already listening — cancel.
          bindings.cancelCapture();
          return;
        }
        btn.classList.add('active');
        btn.textContent = 'Press a button…';
        bindings.captureNext(action).then((idx) => {
          btn.classList.remove('active');
          btn.textContent = 'Rebind';
          if (idx !== null) value.textContent = buttonLabel(idx);
        });
      });

      row.appendChild(lbl);
      row.appendChild(value);
      row.appendChild(btn);
      page.appendChild(row);

      rowRefs.push({ action, valueEl: value, btnEl: btn });
    }

    page.appendChild(this._buildDivider());

    const resetRow = document.createElement('div');
    resetRow.className = 'sw-row';
    resetRow.style.cssText = 'justify-content: flex-end;';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'sw-preset';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => {
      bindings.reset();
      refreshAll();
    });
    resetRow.appendChild(resetBtn);
    page.appendChild(resetRow);

    // Cancel an in-flight capture if the page is left / settings closed.
    page.addEventListener('blur', () => bindings.cancelCapture(), true);

    container.appendChild(page);
  }

  // ── Companion tab ─────────────────────────────────────────────────────

  private _buildCompanionPage(container: HTMLElement): void {
    const page = this._makePage('companion');
    const s = this._companionSettings;

    // ── Section: LLM Provider ────────────────────────────────────────
    page.appendChild(this._buildSectionLabel('LLM Provider'));

    // Provider dropdown
    const providerRow = this._buildSelect({
      label: 'Provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai',    label: 'OpenAI-compatible' },
        { value: 'lmstudio',  label: 'LM Studio (local)' },
        { value: 'ollama',    label: 'Ollama (local)' },
        { value: 'custom',    label: 'Custom' },
      ],
      initial: s.llm.provider,
      onChange: (v) => {
        const provider = v as LLMProvider;
        s.llm.provider = provider;
        // Auto-fill endpoint + model for non-custom providers
        const ep = getDefaultEndpoint(provider);
        const model = getDefaultModel(provider);
        if (ep) {
          s.llm.apiEndpoint = ep;
          endpointInput.value = ep;
        }
        if (model) {
          s.llm.modelName = model;
          modelInput.value = model;
        }
        this._saveCompanion();
      },
    });
    page.appendChild(providerRow);

    // API Endpoint
    const endpointRow = this._buildTextInput({
      label: 'API Endpoint',
      initial: s.llm.apiEndpoint,
      placeholder: 'https://api.example.com/v1/...',
      onChange: (v) => { s.llm.apiEndpoint = v; this._saveCompanion(); },
    });
    const endpointInput = endpointRow.querySelector('input')!;
    page.appendChild(endpointRow);

    // API Key
    page.appendChild(this._buildTextInput({
      label: 'API Key',
      initial: s.llm.apiKey,
      placeholder: 'sk-...',
      isPassword: true,
      onChange: (v) => { s.llm.apiKey = v; this._saveCompanion(); },
    }));

    // Model Name
    const modelRow = this._buildTextInput({
      label: 'Model',
      initial: s.llm.modelName,
      placeholder: 'model-name',
      onChange: (v) => { s.llm.modelName = v; this._saveCompanion(); },
    });
    const modelInput = modelRow.querySelector('input')!;
    page.appendChild(modelRow);

    // Test Connection button
    page.appendChild(this._buildTestButton());

    // ── Section: Behavior ────────────────────────────────────────────
    page.appendChild(this._buildDivider());
    page.appendChild(this._buildSectionLabel('Behavior'));

    page.appendChild(this._buildToggle({
      label: 'Social Actions',
      sublabel: 'Companion can speak and emote via LLM',
      initial: s.behavior.socialActionsEnabled,
      onChange: (v) => { s.behavior.socialActionsEnabled = v; this._saveCompanion(); },
    }));

    // ── Section: Chat History ────────────────────────────────────────
    page.appendChild(this._buildDivider());
    page.appendChild(this._buildSectionLabel('Chat History (LLM context)'));

    page.appendChild(this._buildSlider({
      label: 'Lookback',
      min: 5, max: 60, step: 5,
      initial: s.chatHistory.lookbackMinutes,
      format: (v) => `${v} min`,
      onChange: (v) => { s.chatHistory.lookbackMinutes = v; this._saveCompanion(); },
    }));

    page.appendChild(this._buildSlider({
      label: 'Max Lines',
      min: 10, max: 200, step: 10,
      initial: s.chatHistory.maxLines,
      format: (v) => String(v),
      onChange: (v) => { s.chatHistory.maxLines = v; this._saveCompanion(); },
    }));

    // Channel checkboxes
    page.appendChild(this._buildChannelCheckboxes(s));

    container.appendChild(page);
  }

  private _saveCompanion(): void {
    saveSettings(this._companionSettings);
  }

  private _buildTestButton(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row sw-test-row';

    // Spacer for label column alignment
    const spacer = document.createElement('span');
    spacer.className = 'sw-lbl';
    row.appendChild(spacer);

    const btn = document.createElement('button');
    btn.className = 'sw-test-btn';
    btn.textContent = 'Test Connection';

    const status = document.createElement('span');
    status.className = 'sw-test-status';

    btn.addEventListener('click', async () => {
      if (!this._testLLMCallback) {
        status.textContent = 'Not available yet';
        status.className = 'sw-test-status sw-test-fail';
        return;
      }
      btn.disabled = true;
      status.textContent = 'Testing\u2026';
      status.className = 'sw-test-status';

      try {
        const result = await this._testLLMCallback(this._companionSettings.llm);
        if (result.ok) {
          status.textContent = result.message ?? '\u2713 Connected';
          status.className = 'sw-test-status sw-test-ok';
        } else {
          status.textContent = result.error ?? 'Failed';
          status.className = 'sw-test-status sw-test-fail';
        }
      } catch (err) {
        status.textContent = String(err);
        status.className = 'sw-test-status sw-test-fail';
      } finally {
        btn.disabled = false;
      }
    });

    row.appendChild(btn);
    row.appendChild(status);
    return row;
  }

  private _buildChannelCheckboxes(s: CompanionFullSettings): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'sw-row sw-channels';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = 'Channels';
    wrap.appendChild(lbl);

    const grid = document.createElement('div');
    grid.className = 'sw-channel-grid';

    for (const ch of CHANNEL_OPTIONS) {
      const label = document.createElement('label');
      label.className = 'sw-ch-label';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.chatHistory.enabledChannels.includes(ch.id);

      // 'companion' always enabled
      if (ch.id === 'companion') {
        cb.disabled = true;
        cb.checked = true;
      }

      cb.addEventListener('change', () => {
        const set = new Set(s.chatHistory.enabledChannels);
        if (cb.checked) set.add(ch.id);
        else set.delete(ch.id);
        set.add('companion'); // always
        s.chatHistory.enabledChannels = [...set];
        this._saveCompanion();
      });

      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${ch.label}`));
      grid.appendChild(label);
    }

    wrap.appendChild(grid);
    return wrap;
  }

  // ── Generic input builders ──────────────────────────────────────────────

  private _buildSelect(opts: {
    label: string;
    options: { value: string; label: string }[];
    initial: string;
    onChange: (v: string) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = opts.label;

    const select = document.createElement('select');
    select.className = 'sw-select';
    for (const opt of opts.options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === opts.initial) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => opts.onChange(select.value));

    row.appendChild(lbl);
    row.appendChild(select);
    return row;
  }

  private _buildTextInput(opts: {
    label: string;
    initial: string;
    placeholder?: string;
    isPassword?: boolean;
    onChange: (v: string) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = opts.label;

    const input = document.createElement('input');
    input.type = opts.isPassword ? 'password' : 'text';
    input.className = 'sw-input';
    input.value = opts.initial;
    if (opts.placeholder) input.placeholder = opts.placeholder;

    input.addEventListener('change', () => opts.onChange(input.value));
    input.addEventListener('blur', () => opts.onChange(input.value));

    row.appendChild(lbl);
    row.appendChild(input);
    return row;
  }

  private _buildToggle(opts: {
    label: string;
    sublabel?: string;
    initial: boolean;
    onChange: (v: boolean) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sw-row sw-toggle-row';

    const textWrap = document.createElement('div');
    textWrap.className = 'sw-toggle-text';

    const lbl = document.createElement('span');
    lbl.className = 'sw-lbl';
    lbl.textContent = opts.label;
    textWrap.appendChild(lbl);

    if (opts.sublabel) {
      const sub = document.createElement('span');
      sub.className = 'sw-sublabel';
      sub.textContent = opts.sublabel;
      textWrap.appendChild(sub);
    }

    const toggle = document.createElement('label');
    toggle.className = 'sw-toggle';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = opts.initial;
    cb.addEventListener('change', () => opts.onChange(cb.checked));

    const track = document.createElement('span');
    track.className = 'sw-toggle-track';

    toggle.appendChild(cb);
    toggle.appendChild(track);

    row.appendChild(textWrap);
    row.appendChild(toggle);
    return row;
  }

  private _buildSectionLabel(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sw-section-label';
    el.textContent = text;
    return el;
  }

  private _buildDivider(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sw-divider';
    return el;
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
        width: 560px;
        max-height: 520px;
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

      /* ── Companion tab — inputs ─────────────────────────────── */
      .sw-select, .sw-input {
        flex: 1;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.85);
        background: rgba(200, 145, 60, 0.06);
        border: 1px solid rgba(200, 145, 60, 0.2);
        border-radius: 3px;
        padding: 5px 8px;
        outline: none;
        transition: border-color 0.12s;
        letter-spacing: 0.02em;
      }
      .sw-select:focus, .sw-input:focus {
        border-color: rgba(200, 145, 60, 0.45);
      }
      .sw-input::placeholder {
        color: rgba(212, 201, 184, 0.25);
      }
      .sw-select option {
        background: #0a0806;
        color: rgba(212, 201, 184, 0.85);
      }

      /* ── Section label ─────────────────────────────────────── */
      .sw-section-label {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(200, 145, 60, 0.6);
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }

      /* ── Divider ───────────────────────────────────────────── */
      .sw-divider {
        height: 1px;
        background: rgba(200, 145, 60, 0.12);
        margin: 4px 0;
      }

      /* ── Toggle switch ─────────────────────────────────────── */
      .sw-toggle-row {
        justify-content: space-between;
      }
      .sw-toggle-text {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .sw-toggle-text .sw-lbl { min-width: 0; }
      .sw-sublabel {
        font-family: var(--font-body, serif);
        font-size: 9px;
        color: rgba(212, 201, 184, 0.35);
        letter-spacing: 0.03em;
      }
      .sw-toggle {
        position: relative;
        display: inline-block;
        width: 32px;
        height: 16px;
        flex-shrink: 0;
        cursor: pointer;
      }
      .sw-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
      .sw-toggle-track {
        position: absolute;
        inset: 0;
        background: rgba(200, 145, 60, 0.15);
        border-radius: 8px;
        transition: background 0.2s;
      }
      .sw-toggle-track::after {
        content: '';
        position: absolute;
        left: 2px;
        top: 2px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(212, 201, 184, 0.5);
        transition: transform 0.2s, background 0.2s;
      }
      .sw-toggle input:checked + .sw-toggle-track {
        background: rgba(200, 145, 60, 0.45);
      }
      .sw-toggle input:checked + .sw-toggle-track::after {
        transform: translateX(16px);
        background: rgba(212, 201, 184, 0.9);
      }

      /* ── Test button ───────────────────────────────────────── */
      .sw-test-row { gap: 8px; }
      .sw-test-btn {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.7);
        background: rgba(200, 145, 60, 0.12);
        border: 1px solid rgba(200, 145, 60, 0.25);
        border-radius: 3px;
        padding: 4px 12px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: background 0.12s, color 0.12s;
      }
      .sw-test-btn:hover {
        background: rgba(200, 145, 60, 0.22);
        color: rgba(212, 201, 184, 0.9);
      }
      .sw-test-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .sw-test-status {
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.4);
        letter-spacing: 0.02em;
      }
      .sw-test-ok   { color: rgba(120, 200, 80, 0.85); }
      .sw-test-fail { color: rgba(220, 80, 80, 0.85); }

      /* ── Channel checkboxes ────────────────────────────────── */
      .sw-channels { align-items: flex-start; }
      .sw-channel-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px 12px;
        flex: 1;
      }
      .sw-ch-label {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212, 201, 184, 0.55);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        letter-spacing: 0.03em;
      }
      .sw-ch-label input[type="checkbox"] {
        accent-color: rgba(200, 145, 60, 0.7);
        width: 12px;
        height: 12px;
        cursor: pointer;
      }
      .sw-ch-label input[type="checkbox"]:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `;
    document.head.appendChild(style);
  }
}
