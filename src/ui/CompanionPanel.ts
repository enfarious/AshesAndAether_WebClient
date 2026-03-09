import type { PlayerState }   from '@/state/PlayerState';
import type { SocketClient }  from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type {
  CompanionConfigPayload,
  CompanionArchetype,
  CompanionLoadoutPayload,
  PreferredRange,
  TargetPriority,
  CombatStance,
  EngagementMode,
  HealPriorityMode,
} from '@/network/Protocol';
import { loadSettings, saveSettings } from '@/companion/CompanionSettings';

/**
 * CompanionPanel — tabbed companion management panel.
 *
 * 'N' key opens/closes.
 *
 * Tabs:
 *   General — archetype, engagement mode, abilities
 *   Combat  — stance/priority/range, retreat/recovery, ability weights
 *   Rules   — healing rules, buff/CD rules, resource mgmt, engagement filters
 *
 * Always-visible:
 *   Status bar + HP (above tabs)
 *   Mode controls: follow / detach / recall (below tabs)
 */
export class CompanionPanel {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _visible = false;
  private _configRequested = false;
  private activeTab: 'general' | 'actives' | 'passives' | 'combat' | 'rules' = 'general';

  /** Loadout data received from server. */
  private _activeLoadout:  CompanionLoadoutPayload | null = null;
  private _passiveLoadout: CompanionLoadoutPayload | null = null;
  private _selectedLoadoutSlot: number | null = null;

  /** Debounce timer for slider changes. */
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce timer for chip (engagement list) changes. */
  private _chipDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** RAF coalescing — prevents DOM thrashing from rapid state updates. */
  private _rafId: number | null = null;
  /** When true, the next render does a full innerHTML rebuild.
   *  When false, only the HP bar and state badge update in-place. */
  private _structureDirty = true;
  /** Last companion ID rendered — forces full rebuild on companion swap. */
  private _lastCompanionId: string | null = null;

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'companion-panel';
    this._injectStyles();
    uiRoot.appendChild(this.root);

    const unsub = player.onChange(() => { if (this._visible) this._scheduleRender(); });
    this.cleanup.push(unsub);

    const unsubConfig = router.onCompanionConfig(() => {
      this._structureDirty = true;
      if (this._visible) this._scheduleRender();
    });
    this.cleanup.push(unsubConfig);

    const unsubLoadout = router.onCompanionLoadout((p) => {
      if (p.web === 'active')  this._activeLoadout  = p;
      else                     this._passiveLoadout = p;
      this._structureDirty = true;
      if (this._visible) this._scheduleRender();
    });
    this.cleanup.push(unsubLoadout);

    this.root.style.display = 'none';
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._visible = true;
    this._structureDirty = true;
    this.root.style.display = '';
    // Request config from server on first open
    if (!this._configRequested || !this.player.companion) {
      this.socket.sendCompanionRequestConfig();
      this._configRequested = true;
    }
    this._render();
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
    this.cleanup.forEach(fn => fn());
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._chipDebounceTimer) clearTimeout(this._chipDebounceTimer);
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.root.remove();
  }

  /** Coalesce rapid state updates into a single render per frame. */
  private _scheduleRender(): void {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('companion-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'companion-panel-styles';
    style.textContent = `
      #companion-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(480px, 40vw, 600px);
        max-height: 80vh;
        background: var(--ui-bg, rgba(8,6,4,0.92));
        border: 1px solid var(--ui-border, rgba(200,145,60,0.18));
        box-shadow: 0 4px 24px rgba(0,0,0,0.7);
        z-index: 700;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* ── Header ──────────────────────────────────────────── */
      .cp-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px 8px;
        border-bottom: 1px solid rgba(200,145,60,0.12);
      }
      .cp-title {
        font-family: var(--font-display, serif);
        font-size: 15px;
        color: rgba(212,201,184,0.85);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .cp-close {
        background: none; border: none;
        color: rgba(212,201,184,0.5);
        font-size: 18px; cursor: pointer;
        padding: 0 4px; line-height: 1;
      }
      .cp-close:hover { color: var(--ember, #c86a2a); }

      /* ── Status (always visible, above tabs) ─────────────── */
      .cp-status-area {
        padding: 8px 14px 6px;
      }
      .cp-status {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 5px;
      }
      .cp-name {
        font-family: var(--font-display, serif);
        font-size: 15px;
        color: #44cc66;
        flex: 1;
      }
      .cp-level {
        font-size: 11px;
        color: rgba(212,201,184,0.5);
      }
      .cp-state-badge {
        font-size: 10px;
        padding: 2px 8px;
        border: 1px solid rgba(200,145,60,0.25);
        color: rgba(212,201,184,0.7);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .cp-state-badge.active  { border-color: #44cc66; color: #44cc66; }
      .cp-state-badge.tasked  { border-color: #c8a84e; color: #c8a84e; }
      .cp-state-badge.detached { border-color: rgba(212,201,184,0.3); }

      .cp-hp-bar {
        height: 6px;
        background: rgba(40,30,20,0.6);
        border: 1px solid rgba(200,145,60,0.1);
        position: relative;
      }
      .cp-hp-fill {
        height: 100%;
        background: #44cc66;
        transition: width 0.3s ease;
      }

      /* ── Tab bar ─────────────────────────────────────────── */
      .cp-tab-bar {
        display: flex;
        gap: 0;
        padding: 0 14px;
        border-bottom: 1px solid rgba(200,145,60,0.08);
      }
      .cp-tab {
        flex: 1;
        font-family: var(--font-display, serif);
        font-size: 11px;
        padding: 6px 2px;
        border: 1px solid rgba(200,145,60,0.15);
        border-bottom: 2px solid transparent;
        background: rgba(20,14,6,0.5);
        color: rgba(212,201,184,0.5);
        cursor: pointer;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      .cp-tab:hover { background: rgba(40,28,10,0.6); }
      .cp-tab.active {
        border-bottom-color: var(--ember, #c86a2a);
        background: rgba(60,35,8,0.3);
        color: rgba(212,201,184,0.95);
      }
      .cp-tab + .cp-tab { border-left: none; }

      /* ── Tab pages ───────────────────────────────────────── */
      .cp-tab-page {
        display: none;
        flex-direction: column;
        gap: 10px;
      }
      .cp-tab-page.active { display: flex; }

      /* ── Body (scrollable tab content) ───────────────────── */
      .cp-body {
        padding: 10px 14px;
        overflow-y: auto;
        flex: 1;
        scrollbar-width: thin;
        scrollbar-color: var(--ember, #c86a2a) transparent;
      }

      .cp-empty {
        font-family: var(--font-body, serif);
        font-size: 13px;
        color: rgba(212,201,184,0.55);
        text-align: center;
        padding: 24px 0;
        line-height: 1.6;
      }

      /* ── Section titles ──────────────────────────────────── */
      .cp-section {
        font-family: var(--font-display, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.5);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-top: 2px;
        border-bottom: 1px solid rgba(200,145,60,0.08);
        padding-bottom: 3px;
      }

      /* ── Archetype selector ─────────────────────────────── */
      .cp-archetypes {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .cp-arch {
        padding: 6px 8px;
        border: 1px solid rgba(200,145,60,0.15);
        background: rgba(20,14,6,0.6);
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .cp-arch:hover {
        background: rgba(40,28,10,0.7);
        border-color: rgba(200,145,60,0.35);
      }
      .cp-arch.selected {
        border-color: var(--ember, #c86a2a);
        background: rgba(60,35,8,0.5);
      }
      .cp-arch-name {
        font-family: var(--font-display, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.85);
      }
      .cp-arch-desc {
        font-size: 10px;
        color: rgba(212,201,184,0.45);
        margin-top: 2px;
      }

      /* ── Segmented buttons ───────────────────────────────── */
      .cp-seg-row {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 4px;
      }
      .cp-seg-label {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.5);
        min-width: 52px;
      }
      .cp-seg-group { display: flex; gap: 0; flex: 1; }
      .cp-seg {
        flex: 1;
        font-family: var(--font-body, serif);
        font-size: 11px;
        padding: 4px 2px;
        border: 1px solid rgba(200,145,60,0.15);
        background: rgba(20,14,6,0.5);
        color: rgba(212,201,184,0.6);
        cursor: pointer;
        text-align: center;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      .cp-seg:hover { background: rgba(40,28,10,0.6); }
      .cp-seg.active {
        border-color: var(--ember, #c86a2a);
        background: rgba(60,35,8,0.5);
        color: rgba(212,201,184,0.95);
      }
      .cp-seg + .cp-seg { border-left: none; }

      /* ── Sliders ─────────────────────────────────────────── */
      .cp-slider-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 2px;
      }
      .cp-slider-label {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.5);
        min-width: 66px;
      }
      .cp-slider-val {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212,201,184,0.7);
        min-width: 32px;
        text-align: right;
      }
      .cp-slider {
        flex: 1;
        -webkit-appearance: none;
        appearance: none;
        height: 4px;
        background: rgba(40,30,20,0.6);
        border: 1px solid rgba(200,145,60,0.1);
        outline: none;
      }
      .cp-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px; height: 12px;
        background: var(--ember, #c86a2a);
        border: none; cursor: pointer;
      }
      .cp-slider::-moz-range-thumb {
        width: 12px; height: 12px;
        background: var(--ember, #c86a2a);
        border: none; cursor: pointer;
      }

      /* ── Abilities ───────────────────────────────────────── */
      .cp-ability {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 0;
      }
      .cp-ability-check {
        width: 14px; height: 14px;
        accent-color: var(--ember, #c86a2a);
        cursor: pointer;
      }
      .cp-ability-name {
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.8);
        flex-shrink: 0;
      }
      .cp-ability-desc {
        font-size: 10px;
        color: rgba(212,201,184,0.4);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Checkbox rows ───────────────────────────────────── */
      .cp-check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: 2px 0;
      }
      .cp-check-row input[type="checkbox"] {
        width: 14px; height: 14px;
        accent-color: var(--ember, #c86a2a);
        cursor: pointer;
      }
      .cp-check-row span {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.7);
      }

      /* ── Chip groups (engagement filters) ────────────────── */
      .cp-chip-section {
        margin-bottom: 6px;
      }
      .cp-chip-label {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212,201,184,0.45);
        margin-bottom: 3px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cp-chip-group {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
      }
      .cp-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid rgba(200,145,60,0.2);
        background: rgba(30,20,8,0.6);
        color: rgba(212,201,184,0.7);
      }
      .cp-chip-x {
        background: none;
        border: none;
        color: rgba(212,201,184,0.4);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        line-height: 1;
      }
      .cp-chip-x:hover { color: var(--ember, #c86a2a); }
      .cp-chip-input {
        width: 72px;
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid rgba(200,145,60,0.15);
        background: rgba(20,14,6,0.6);
        color: rgba(212,201,184,0.7);
        outline: none;
      }
      .cp-chip-input::placeholder {
        color: rgba(212,201,184,0.3);
      }
      .cp-chip-input:focus {
        border-color: var(--ember, #c86a2a);
      }

      /* ── Mode controls (always visible, below tabs) ──────── */
      .cp-modes {
        display: flex;
        gap: 8px;
        justify-content: center;
        padding: 6px 14px 10px;
        border-top: 1px solid rgba(200,145,60,0.08);
      }
      .cp-btn {
        font-family: var(--font-body, serif);
        font-size: 12px;
        padding: 5px 16px;
        border: 1px solid rgba(200,145,60,0.25);
        background: rgba(30,20,8,0.7);
        color: rgba(212,201,184,0.8);
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .cp-btn:hover {
        background: rgba(60,40,10,0.8);
        border-color: var(--ember, #c86a2a);
      }
      .cp-btn.active {
        border-color: var(--ember, #c86a2a);
        background: rgba(60,35,8,0.5);
      }

      /* ── Loadout slots ─────────────────────────────────────── */
      .cp-loadout-slots {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .cp-slot {
        width: 56px;
        height: 48px;
        border: 1px solid rgba(200,145,60,0.2);
        background: rgba(20,14,6,0.6);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
        position: relative;
      }
      .cp-slot:hover {
        background: rgba(40,28,10,0.7);
        border-color: rgba(200,145,60,0.4);
      }
      .cp-slot.selected {
        border-color: var(--ember, #c86a2a);
        box-shadow: 0 0 8px rgba(200,106,42,0.35);
        background: rgba(60,35,8,0.4);
      }
      .cp-slot.filled {
        border-color: rgba(68,204,102,0.35);
      }
      .cp-slot-idx {
        font-family: var(--font-mono, monospace);
        font-size: 8px;
        color: rgba(212,201,184,0.3);
        position: absolute;
        top: 2px;
        left: 4px;
      }
      .cp-slot-name {
        font-family: var(--font-body, serif);
        font-size: 9px;
        color: rgba(212,201,184,0.7);
        text-align: center;
        line-height: 1.15;
        padding: 0 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
      .cp-slot-empty {
        font-size: 9px;
        color: rgba(212,201,184,0.25);
        font-style: italic;
      }

      /* ── Available abilities list ──────────────────────────── */
      .cp-avail-group-title {
        font-family: var(--font-body, serif);
        font-size: 10px;
        color: rgba(212,201,184,0.45);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-top: 4px;
        margin-bottom: 2px;
      }
      .cp-avail-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 4px;
        cursor: pointer;
        transition: background 0.12s;
      }
      .cp-avail-item:hover {
        background: rgba(40,28,10,0.5);
      }
      .cp-avail-name {
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.8);
        flex: 1;
      }
      .cp-tier-badge {
        font-family: var(--font-mono, monospace);
        font-size: 9px;
        padding: 1px 5px;
        border: 1px solid rgba(200,145,60,0.2);
        color: rgba(212,201,184,0.55);
      }
      .cp-tier-badge.t1 { border-color: rgba(68,204,102,0.3); color: #44cc66; }
      .cp-tier-badge.t2 { border-color: rgba(100,160,220,0.3); color: #64a0dc; }
      .cp-tier-badge.t3 { border-color: rgba(180,120,220,0.3); color: #b478dc; }

      /* ── Archetype modifier box ────────────────────────────── */
      .cp-arch-mods {
        margin-top: 6px;
        padding: 6px 8px;
        border: 1px solid rgba(200,145,60,0.1);
        background: rgba(15,10,4,0.5);
      }
      .cp-arch-mod-title {
        font-family: var(--font-display, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.65);
        letter-spacing: 0.06em;
        margin-bottom: 3px;
      }
      .cp-arch-mod-buff {
        font-size: 11px;
        color: #44cc66;
        line-height: 1.5;
      }
      .cp-arch-mod-debuff {
        font-size: 11px;
        color: #cc4444;
        line-height: 1.5;
      }
      .cp-arch-growth {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 4px;
        font-size: 11px;
      }
      .cp-growth-label {
        color: rgba(212,201,184,0.5);
        margin-right: 2px;
      }
      .cp-growth-chip {
        background: rgba(200,145,60,0.15);
        border: 1px solid rgba(200,145,60,0.25);
        border-radius: 3px;
        padding: 1px 5px;
        color: #d4c9b8;
        font-size: 10px;
        font-family: var(--font-mono, monospace);
      }

      /* ── Identity editor ─────────────────────────────────────── */
      .cp-identity {
        margin-top: 4px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cp-id-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .cp-id-label {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.5);
        min-width: 72px;
        padding-top: 3px;
      }
      .cp-id-input {
        flex: 1;
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        padding: 3px 6px;
        border: 1px solid rgba(200,145,60,0.15);
        background: rgba(20,14,6,0.6);
        color: rgba(212,201,184,0.7);
        outline: none;
      }
      .cp-id-input::placeholder {
        color: rgba(212,201,184,0.25);
      }
      .cp-id-input:focus {
        border-color: var(--ember, #c86a2a);
      }
      .cp-id-textarea {
        resize: vertical;
        min-height: 32px;
      }

      /* ── Core stats grid ───────────────────────────────────── */
      .cp-core-stats {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px;
        margin-top: 4px;
      }
      .cp-core-stat {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        background: rgba(15,10,4,0.5);
        border: 1px solid rgba(200,145,60,0.08);
      }
      .cp-core-stat-abbr {
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        color: rgba(212,201,184,0.45);
        text-transform: uppercase;
        min-width: 26px;
      }
      .cp-core-stat-val {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(212,201,184,0.85);
      }

      /* ── Derived stats block ───────────────────────────────── */
      .cp-derived-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px 12px;
        margin-top: 4px;
      }
      .cp-derived-stat {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
      }
      .cp-derived-label {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.5);
      }
      .cp-derived-val {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212,201,184,0.8);
      }
      .cp-derived-val.modified {
        color: #c8a84e;
      }

      /* ── Activity summary ──────────────────────────────────── */
      .cp-activity {
        display: flex;
        gap: 16px;
        margin-top: 4px;
        padding: 4px 0;
      }
      .cp-activity-item {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212,201,184,0.5);
      }
      .cp-activity-val {
        font-family: var(--font-mono, monospace);
        color: rgba(212,201,184,0.75);
      }
    `;
    document.head.appendChild(style);
  }

  // ── Live in-place update (HP bar + state badge only) ────────────────────────

  private _updateLive(): void {
    const c = this.player.companion;
    if (!c) return;

    const hpPct = c.maxHealth > 0 ? Math.round((c.currentHealth / c.maxHealth) * 100) : 0;
    const fillEl = this.root.querySelector<HTMLElement>('.cp-hp-fill');
    if (fillEl) fillEl.style.width = `${hpPct}%`;

    const badge = this.root.querySelector<HTMLElement>('.cp-state-badge');
    if (badge) {
      const cls = c.behaviorState === 'active' ? 'active'
                : c.behaviorState === 'tasked' ? 'tasked'
                : 'detached';
      badge.className = `cp-state-badge ${cls}`;
      badge.textContent = c.behaviorState;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  private _render(): void {
    const c = this.player.companion;
    const companionId = c?.name ?? null;

    // Detect companion swap (appeared / disappeared / different companion)
    if (companionId !== this._lastCompanionId) {
      this._structureDirty = true;
      this._lastCompanionId = companionId;
    }

    // Fast path: if structure hasn't changed, just update HP + state badge in-place
    if (!this._structureDirty) {
      this._updateLive();
      return;
    }
    this._structureDirty = false;

    if (!c) {
      this.root.innerHTML = `
        <div class="cp-header">
          <span class="cp-title">Companion</span>
          <button class="cp-close" id="cp-close">&times;</button>
        </div>
        <div class="cp-body">
          <div class="cp-empty">No companion found.</div>
        </div>
      `;
      this._wireClose();
      return;
    }

    const hpPct = c.maxHealth > 0 ? Math.round((c.currentHealth / c.maxHealth) * 100) : 0;
    const stateClass = c.behaviorState === 'active' ? 'active'
                     : c.behaviorState === 'tasked' ? 'tasked'
                     : 'detached';

    const archetypes: { id: CompanionArchetype; name: string; desc: string }[] = [
      { id: 'scrappy_fighter', name: 'Scrappy Fighter', desc: 'Aggressive melee, high damage' },
      { id: 'cautious_healer', name: 'Cautious Healer', desc: 'Long-range support, heals allies' },
      { id: 'opportunist',     name: 'Opportunist',     desc: 'Balanced, targets the weak' },
      { id: 'tank',            name: 'Tank',             desc: 'Melee defender, CC-focused' },
    ];

    const s = c.combatSettings;

    this.root.innerHTML = `
      <div class="cp-header">
        <span class="cp-title">Companion</span>
        <button class="cp-close" id="cp-close">&times;</button>
      </div>

      <!-- Status (always visible) -->
      <div class="cp-status-area">
        <div class="cp-status">
          <span class="cp-name">${this._esc(c.name)}</span>
          <span class="cp-level">Lv ${c.level}</span>
          <span class="cp-state-badge ${stateClass}">${c.behaviorState}</span>
        </div>
        <div class="cp-hp-bar"><div class="cp-hp-fill" style="width:${hpPct}%"></div></div>
      </div>

      <!-- Tab bar -->
      <div class="cp-tab-bar">
        <button class="cp-tab ${this.activeTab === 'general' ? 'active' : ''}" data-tab="general">General</button>
        <button class="cp-tab ${this.activeTab === 'actives' ? 'active' : ''}" data-tab="actives">Actives</button>
        <button class="cp-tab ${this.activeTab === 'passives' ? 'active' : ''}" data-tab="passives">Passives</button>
        <button class="cp-tab ${this.activeTab === 'combat' ? 'active' : ''}" data-tab="combat">Combat</button>
        <button class="cp-tab ${this.activeTab === 'rules' ? 'active' : ''}" data-tab="rules">Rules</button>
      </div>

      <!-- Tab content -->
      <div class="cp-body">

        <!-- ═══ GENERAL TAB ═══ -->
        <div class="cp-tab-page ${this.activeTab === 'general' ? 'active' : ''}" data-tab-page="general">
          <div class="cp-section">Archetype</div>
          <div class="cp-archetypes">
            ${archetypes.map(a => `
              <div class="cp-arch ${c.archetype === a.id ? 'selected' : ''}" data-arch="${a.id}">
                <div class="cp-arch-name">${a.name}</div>
                <div class="cp-arch-desc">${a.desc}</div>
              </div>
            `).join('')}
          </div>

          ${this._renderArchetypeModifiers(c.archetype)}

          ${this._renderIdentityEditor(c)}

          ${this._renderCoreStats(c)}
          ${this._renderDerivedStats(c)}
          ${this._renderActivity(c)}
        </div>

        <!-- ═══ ACTIVES TAB ═══ -->
        <div class="cp-tab-page ${this.activeTab === 'actives' ? 'active' : ''}" data-tab-page="actives">
          ${this._renderLoadoutTab('active')}
        </div>

        <!-- ═══ PASSIVES TAB ═══ -->
        <div class="cp-tab-page ${this.activeTab === 'passives' ? 'active' : ''}" data-tab-page="passives">
          ${this._renderLoadoutTab('passive')}
        </div>

        <!-- ═══ COMBAT TAB ═══ -->
        <div class="cp-tab-page ${this.activeTab === 'combat' ? 'active' : ''}" data-tab-page="combat">
          <div class="cp-section">Stance &amp; Positioning</div>
          ${this._segRow('Stance', 'stance', ['aggressive', 'cautious', 'support'], s.stance)}
          ${this._segRow('Priority', 'priority', ['weakest', 'nearest', 'threatening_player'], s.priority, ['Weakest', 'Nearest', 'Protect'])}
          ${this._segRow('Range', 'range', ['close', 'mid', 'long'], s.preferredRange, ['Close', 'Mid', 'Long'])}

          <div class="cp-section">Retreat &amp; Recovery</div>
          ${this._sliderRow('Retreat', 'retreat', Math.round(s.retreatThreshold * 100), 0, 100, '%')}
          ${this._sliderRow('Defensive', 'defensiveThreshold', Math.round((s.defensiveThreshold ?? 0.4) * 100), 0, 100, '%')}
          ${this._sliderRow('Heal Allies', 'healAllyThreshold', Math.round((s.healAllyThreshold ?? 0.6) * 100), 0, 100, '%')}

          <div class="cp-section">Ability Weights</div>
          ${this._sliderRow('Damage', 'damage', Math.round((s.abilityWeights.damage ?? 0) * 100), 0, 100)}
          ${this._sliderRow('CC', 'cc', Math.round((s.abilityWeights.cc ?? 0) * 100), 0, 100)}
          ${this._sliderRow('Heal', 'heal', Math.round((s.abilityWeights.heal ?? 0) * 100), 0, 100)}
        </div>

        <!-- ═══ RULES TAB ═══ -->
        <div class="cp-tab-page ${this.activeTab === 'rules' ? 'active' : ''}" data-tab-page="rules">
          <div class="cp-section">Healing Rules</div>
          ${this._sliderRow('Max HP% to heal', 'minHealTarget', Math.round((s.minHealTarget ?? 0.85) * 100), 0, 100, '%')}
          ${this._segRow('Heal Priority', 'healPriorityMode',
              ['lowest_hp', 'most_damage_taken', 'tank_first'],
              s.healPriorityMode ?? 'lowest_hp',
              ['Lowest HP', 'Most Dmg', 'Tank First'])}

          <div class="cp-section">Buff &amp; Cooldown Rules</div>
          <label class="cp-check-row">
            <input type="checkbox" data-setting="saveCooldownsForElites" ${s.saveCooldownsForElites ? 'checked' : ''} />
            <span>Save big cooldowns for elites</span>
          </label>
          ${this._sliderRow('Min mob HP%', 'minEnemyHpForBuffs', Math.round((s.minEnemyHpForBuffs ?? 0.2) * 100), 0, 100, '%')}

          <div class="cp-section">Resource Management</div>
          ${this._sliderRow('Reserve %', 'resourceReserve', Math.round(s.resourceReservePercent ?? 15), 0, 100)}

          <div class="cp-section">Engagement Filters</div>
          ${this._chipSection('Ignore Family', 'ignoreFamily', s.ignoreFamily ?? [])}
          ${this._chipSection('Always Engage Family', 'alwaysEngageFamily', s.alwaysEngageFamily ?? [])}
          ${this._chipSection('Ignore Species', 'ignoreSpecies', s.ignoreSpecies ?? [])}
          ${this._chipSection('Always Engage Species', 'alwaysEngageSpecies', s.alwaysEngageSpecies ?? [])}
        </div>

      </div>

      <!-- Mode controls (always visible) -->
      <div class="cp-modes">
        <button class="cp-btn ${c.behaviorState === 'active' ? 'active' : ''}" data-mode="follow">Follow</button>
        <button class="cp-btn ${c.behaviorState === 'detached' ? 'active' : ''}" data-mode="detach">Detach</button>
        <button class="cp-btn" data-mode="recall">Recall</button>
      </div>
    `;

    this._wireClose();
    this._wireTabs();
    this._wireArchetypes(c);
    this._wireIdentityInputs();
    this._wireSegments();
    this._wireSliders();
    this._wireCheckboxes();
    this._wireChips();
    this._wireModes();
    this._wireLoadoutSlots();
  }

  // ── HTML helpers ──────────────────────────────────────────────────────────────

  private _segRow(
    label: string, key: string,
    values: string[], current: string,
    labels?: string[],
  ): string {
    return `
      <div class="cp-seg-row">
        <span class="cp-seg-label">${label}</span>
        <div class="cp-seg-group">
          ${values.map((v, i) => `
            <button class="cp-seg ${v === current ? 'active' : ''}" data-seg-key="${key}" data-seg-val="${v}">
              ${labels?.[i] ?? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ')}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  private _sliderRow(
    label: string, key: string,
    value: number, min: number, max: number,
    suffix = '',
  ): string {
    return `
      <div class="cp-slider-row">
        <span class="cp-slider-label">${label}</span>
        <input type="range" class="cp-slider" data-slider="${key}" min="${min}" max="${max}" value="${value}" />
        <span class="cp-slider-val" data-slider-val="${key}">${value}${suffix}</span>
      </div>
    `;
  }

  private _chipSection(label: string, listKey: string, values: string[]): string {
    return `
      <div class="cp-chip-section">
        <div class="cp-chip-label">${label}</div>
        <div class="cp-chip-group" data-chip-list="${listKey}">
          ${values.map(v => `
            <span class="cp-chip" data-chip-val="${this._esc(v)}">${this._esc(v)}<button class="cp-chip-x">&times;</button></span>
          `).join('')}
          <input class="cp-chip-input" placeholder="+ add" data-chip-add="${listKey}" />
        </div>
      </div>
    `;
  }

  // ── Event wiring ──────────────────────────────────────────────────────────────

  private _wireClose(): void {
    this.root.querySelector('#cp-close')?.addEventListener('click', () => this.hide());
  }

  private _wireTabs(): void {
    this.root.querySelectorAll<HTMLElement>('.cp-tab').forEach(el => {
      el.addEventListener('click', () => {
        const tab = el.dataset.tab as typeof this.activeTab;
        if (tab) this._switchTab(tab);
      });
    });
  }

  private _switchTab(tab: typeof this.activeTab): void {
    this.activeTab = tab;
    this._selectedLoadoutSlot = null;
    // Update tab buttons
    this.root.querySelectorAll<HTMLElement>('.cp-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    // Update tab pages
    this.root.querySelectorAll<HTMLElement>('.cp-tab-page').forEach(el => {
      el.classList.toggle('active', el.dataset.tabPage === tab);
    });
    // Fetch loadout data when switching to Actives/Passives
    if (tab === 'actives')  this.socket.sendCompanionViewActiveLoadout();
    if (tab === 'passives') this.socket.sendCompanionViewPassiveLoadout();
  }

  private _wireArchetypes(c: CompanionConfigPayload): void {
    this.root.querySelectorAll<HTMLElement>('.cp-arch').forEach(el => {
      el.addEventListener('click', () => {
        const arch = el.dataset.arch;
        if (arch && arch !== c.archetype) {
          this.socket.sendCompanionSetArchetype(arch);
        }
      });
    });
  }

  private _wireSegments(): void {
    this.root.querySelectorAll<HTMLElement>('.cp-seg').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.segKey;
        const val = el.dataset.segVal;
        if (!key || !val) return;
        const settings: Record<string, unknown> = {};
        if (key === 'stance')           settings.stance = val as CombatStance;
        if (key === 'priority')         settings.priority = val as TargetPriority;
        if (key === 'range')            settings.preferredRange = val as PreferredRange;
        if (key === 'engagementMode')   settings.engagementMode = val as EngagementMode;
        if (key === 'healPriorityMode') settings.healPriorityMode = val as HealPriorityMode;
        this.socket.sendCompanionConfigure(settings);
      });
    });
  }

  private _wireSliders(): void {
    this.root.querySelectorAll<HTMLInputElement>('.cp-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.slider!;
        const num = parseInt(slider.value, 10);
        // Determine suffix for display
        const hasPct = ['retreat', 'defensiveThreshold', 'healAllyThreshold', 'minHealTarget', 'minEnemyHpForBuffs'].includes(key);
        const valEl = this.root.querySelector(`[data-slider-val="${key}"]`);
        if (valEl) valEl.textContent = hasPct ? `${num}%` : `${num}`;
        // Debounce the server send
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const settings: Record<string, unknown> = {};
          switch (key) {
            case 'retreat':              settings.retreatThreshold = num / 100; break;
            case 'defensiveThreshold':   settings.defensiveThreshold = num / 100; break;
            case 'healAllyThreshold':    settings.healAllyThreshold = num / 100; break;
            case 'minHealTarget':        settings.minHealTarget = num / 100; break;
            case 'minEnemyHpForBuffs':   settings.minEnemyHpForBuffs = num / 100; break;
            case 'resourceReserve':      settings.resourceReservePercent = num; break;
            default:
              // Ability weight keys: damage, cc, heal
              settings.abilityWeights = { [key]: num / 100 };
          }
          this.socket.sendCompanionConfigure(settings);
        }, 200);
      });
    });
  }

  private _wireCheckboxes(): void {
    this.root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.setting!;
        const settings: Record<string, unknown> = { [key]: cb.checked };
        this.socket.sendCompanionConfigure(settings);
      });
    });
  }

  private _wireChips(): void {
    // Add chip on Enter
    this.root.querySelectorAll<HTMLInputElement>('.cp-chip-input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const val = input.value.trim();
        if (!val) return;
        const listKey = input.dataset.chipAdd!;
        // Create new chip element
        const chip = document.createElement('span');
        chip.className = 'cp-chip';
        chip.dataset.chipVal = val;
        chip.innerHTML = `${this._esc(val)}<button class="cp-chip-x">&times;</button>`;
        // Wire remove on the new chip
        chip.querySelector('.cp-chip-x')?.addEventListener('click', () => {
          chip.remove();
          this._sendChipList(listKey);
        });
        // Insert before the input
        input.parentElement!.insertBefore(chip, input);
        input.value = '';
        this._sendChipList(listKey);
      });
    });

    // Remove chip on X click (for initial chips)
    this.root.querySelectorAll<HTMLElement>('.cp-chip').forEach(chip => {
      const x = chip.querySelector('.cp-chip-x');
      x?.addEventListener('click', () => {
        const group = chip.closest('[data-chip-list]') as HTMLElement | null;
        const listKey = group?.dataset.chipList;
        chip.remove();
        if (listKey) this._sendChipList(listKey);
      });
    });
  }

  private _sendChipList(listKey: string): void {
    // Debounce chip sends
    if (this._chipDebounceTimer) clearTimeout(this._chipDebounceTimer);
    this._chipDebounceTimer = setTimeout(() => {
      const group = this.root.querySelector(`[data-chip-list="${listKey}"]`);
      if (!group) return;
      const values: string[] = [];
      group.querySelectorAll<HTMLElement>('.cp-chip').forEach(chip => {
        if (chip.dataset.chipVal) values.push(chip.dataset.chipVal);
      });
      const settings: Record<string, unknown> = { [listKey]: values };
      this.socket.sendCompanionConfigure(settings);
    }, 500);
  }

  private _wireModes(): void {
    this.root.querySelector('[data-mode="follow"]')?.addEventListener('click', () => {
      this.socket.sendCompanionFollow();
    });
    this.root.querySelector('[data-mode="detach"]')?.addEventListener('click', () => {
      this.socket.sendCompanionDetach();
    });
    this.root.querySelector('[data-mode="recall"]')?.addEventListener('click', () => {
      this.socket.sendCompanionRecall();
    });
  }

  // ── Archetype modifiers ──────────────────────────────────────────────────────

  private static readonly ARCHETYPE_MODIFIERS: Record<CompanionArchetype, {
    label: string;
    buffs: string[];
    debuffs: string[];
    /** Stat growth per level — displayed so players see what each archetype prioritises. */
    growth: { stat: string; value: number }[];
  }> = {
    cautious_healer: {
      label: "Healer's Attunement",
      buffs: ['+15% Heal Potency', '+1 Mana Regen'], debuffs: [],
      growth: [{ stat: 'VIT', value: 1 }, { stat: 'AGI', value: 1 }, { stat: 'INT', value: 1 }, { stat: 'WIS', value: 2 }],
    },
    opportunist: {
      label: "Exploiter's Edge",
      buffs: ['+5% Critical Hit'], debuffs: ['-4 Defense'],
      growth: [{ stat: 'STR', value: 1 }, { stat: 'VIT', value: 1 }, { stat: 'DEX', value: 1 }, { stat: 'AGI', value: 2 }],
    },
    scrappy_fighter: {
      label: "Brawler's Tenacity",
      buffs: ['+6 Attack', '+15 Max HP'], debuffs: ['-20% Healing Received'],
      growth: [{ stat: 'STR', value: 2 }, { stat: 'VIT', value: 1 }, { stat: 'DEX', value: 1 }, { stat: 'AGI', value: 1 }],
    },
    tank: {
      label: "Guardian's Resolve",
      buffs: ['+8 Defense', '+20 Max HP', '+50% Threat'], debuffs: ['-4 Attack', '-15% Healing Received'],
      growth: [{ stat: 'STR', value: 1 }, { stat: 'VIT', value: 2 }, { stat: 'AGI', value: 1 }, { stat: 'WIS', value: 1 }],
    },
  };

  private _renderArchetypeModifiers(archetype: CompanionArchetype): string {
    const mod = CompanionPanel.ARCHETYPE_MODIFIERS[archetype];
    if (!mod) return '';
    const growthChips = mod.growth
      .map(g => `<span class="cp-growth-chip">+${g.value} ${g.stat}</span>`)
      .join(' ');
    return `
      <div class="cp-arch-mods">
        <div class="cp-arch-mod-title">${this._esc(mod.label)}</div>
        <div class="cp-arch-growth"><span class="cp-growth-label">Per Level:</span> ${growthChips}</div>
        ${mod.buffs.map(b => `<div class="cp-arch-mod-buff">▲ ${this._esc(b)}</div>`).join('')}
        ${mod.debuffs.map(d => `<div class="cp-arch-mod-debuff">▼ ${this._esc(d)}</div>`).join('')}
      </div>
    `;
  }

  // ── Identity editor ─────────────────────────────────────────────────────────

  private _renderIdentityEditor(c: CompanionConfigPayload): string {
    const id = loadSettings().identity;
    // Client-side overrides take priority; fall back to server-provided data
    const personality = id.personalityType || c.personalityType || '';
    const traits      = id.traits          || (c.traits ?? []).join(', ');
    const description = id.description     || c.description || '';

    return `
      <div class="cp-section">Identity</div>
      <div class="cp-identity">
        <label class="cp-id-row">
          <span class="cp-id-label">Personality</span>
          <input type="text" class="cp-id-input" data-id-field="personalityType"
            value="${this._esc(personality)}" placeholder="e.g. sarcastic and witty" />
        </label>
        <label class="cp-id-row">
          <span class="cp-id-label">Traits</span>
          <input type="text" class="cp-id-input" data-id-field="traits"
            value="${this._esc(traits)}" placeholder="e.g. brave, curious, protective" />
        </label>
        <label class="cp-id-row">
          <span class="cp-id-label">Description</span>
          <textarea class="cp-id-input cp-id-textarea" data-id-field="description"
            rows="2" placeholder="e.g. a battle-scarred wolf companion">${this._esc(description)}</textarea>
        </label>
      </div>
    `;
  }

  private _wireIdentityInputs(): void {
    this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.cp-id-input').forEach(el => {
      el.addEventListener('change', () => {
        const field = el.dataset.idField;
        if (!field) return;
        const settings = loadSettings();
        if (field === 'personalityType') settings.identity.personalityType = el.value.trim();
        if (field === 'traits')          settings.identity.traits          = el.value.trim();
        if (field === 'description')     settings.identity.description     = el.value.trim();
        saveSettings(settings);
      });
    });
  }

  // ── Stats rendering ─────────────────────────────────────────────────────────

  private _renderCoreStats(c: CompanionConfigPayload): string {
    const cs = c.coreStats;
    if (!cs) return '';
    const stats: [string, number][] = [
      ['STR', cs.strength], ['VIT', cs.vitality], ['DEX', cs.dexterity],
      ['AGI', cs.agility],  ['INT', cs.intelligence], ['WIS', cs.wisdom],
    ];
    return `
      <div class="cp-section">Attributes</div>
      <div class="cp-core-stats">
        ${stats.map(([abbr, val]) => `
          <div class="cp-core-stat">
            <span class="cp-core-stat-abbr">${abbr}</span>
            <span class="cp-core-stat-val">${val}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private _renderDerivedStats(c: CompanionConfigPayload): string {
    const d = c.derivedStats;
    if (!d) return '';

    const rows: [string, string, boolean][] = [
      ['Attack',     String(d.attackRating),                        (d.attackRating !== 26)],
      ['Defense',    d.defenseRating.toFixed(1),                    (d.defenseRating !== 5)],
      ['Magic Atk',  String(d.magicAttack),                        false],
      ['Magic Def',  d.magicDefense.toFixed(1),                    false],
      ['Crit %',     d.criticalHitChance.toFixed(1) + '%',         (d.criticalHitChance !== 10.9)],
      ['Evasion',    String(d.evasion),                             false],
      ['Move Spd',   d.movementSpeed.toFixed(1) + ' m/s',         false],
    ];

    // Only show heal potency / threat if archetype modifies them
    if (d.healPotencyMult !== 1.0) {
      const pct = Math.round((d.healPotencyMult - 1) * 100);
      const sign = pct >= 0 ? '+' : '';
      rows.push(['Heal Potency', `${sign}${pct}%`, true]);
    }
    if (d.threatMultiplier !== 1.0) {
      const pct = Math.round((d.threatMultiplier - 1) * 100);
      const sign = pct >= 0 ? '+' : '';
      rows.push(['Threat', `${sign}${pct}%`, true]);
    }

    return `
      <div class="cp-section">Combat Stats</div>
      <div class="cp-derived-stats">
        ${rows.map(([label, val, mod]) => `
          <div class="cp-derived-stat">
            <span class="cp-derived-label">${label}</span>
            <span class="cp-derived-val${mod ? ' modified' : ''}">${val}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private _renderActivity(c: CompanionConfigPayload): string {
    if (!c.harvestsCompleted && !c.itemsGathered) return '';
    return `
      <div class="cp-section">Activity</div>
      <div class="cp-activity">
        <span class="cp-activity-item">Harvests: <span class="cp-activity-val">${c.harvestsCompleted}</span></span>
        <span class="cp-activity-item">Items gathered: <span class="cp-activity-val">${c.itemsGathered}</span></span>
      </div>
    `;
  }

  // ── Loadout tab rendering ──────────────────────────────────────────────────

  private _renderLoadoutTab(web: 'active' | 'passive'): string {
    const loadout = web === 'active' ? this._activeLoadout : this._passiveLoadout;

    if (!loadout) {
      return `
        <div class="cp-empty">
          Loading ${web} loadout…<br/>
          <span style="font-size:11px;color:rgba(212,201,184,0.35)">
            Switch to this tab to fetch data from server.
          </span>
        </div>
      `;
    }

    const SLOT_COUNT = 8;
    const slots: string[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = loadout.slots.find(sl => sl.slot === i);
      const filled = s && s.nodeId;
      const selected = this._selectedLoadoutSlot === i;
      const cls = `cp-slot${filled ? ' filled' : ''}${selected ? ' selected' : ''}`;
      slots.push(`
        <div class="${cls}" data-loadout-slot="${i}" data-loadout-web="${web}">
          <span class="cp-slot-idx">${i + 1}</span>
          ${filled
            ? `<span class="cp-slot-name">${this._esc(s!.name)}</span>`
            : `<span class="cp-slot-empty">—</span>`
          }
        </div>
      `);
    }

    // Group available abilities by sector
    const bySector = new Map<string, typeof loadout.available>();
    for (const a of loadout.available) {
      const arr = bySector.get(a.sector) || [];
      arr.push(a);
      bySector.set(a.sector, arr);
    }

    let availHtml = '';
    for (const [sector, abilities] of bySector) {
      availHtml += `<div class="cp-avail-group-title">${this._esc(sector)}</div>`;
      for (const a of abilities) {
        const tierClass = a.tier <= 3 ? `t${a.tier}` : '';
        availHtml += `
          <div class="cp-avail-item" data-avail-node="${a.nodeId}" data-avail-web="${web}">
            <span class="cp-avail-name">${this._esc(a.name)}</span>
            <span class="cp-tier-badge ${tierClass}">T${a.tier}</span>
          </div>
        `;
      }
    }

    return `
      <div class="cp-section">${web === 'active' ? 'Active' : 'Passive'} Slots</div>
      <div class="cp-loadout-slots">${slots.join('')}</div>
      <div class="cp-section">Available ${web === 'active' ? 'Abilities' : 'Passives'}</div>
      ${availHtml || '<div class="cp-empty" style="padding:8px 0">No abilities available.</div>'}
    `;
  }

  // ── Loadout wiring ─────────────────────────────────────────────────────────

  private _wireLoadoutSlots(): void {
    // Slot click → select slot for assignment
    this.root.querySelectorAll<HTMLElement>('.cp-slot').forEach(el => {
      el.addEventListener('click', () => {
        const slot = parseInt(el.dataset.loadoutSlot ?? '', 10);
        if (isNaN(slot)) return;
        this._selectedLoadoutSlot = this._selectedLoadoutSlot === slot ? null : slot;
        // Update selection visuals without full rebuild
        this.root.querySelectorAll<HTMLElement>('.cp-slot').forEach(s => {
          s.classList.toggle('selected', parseInt(s.dataset.loadoutSlot ?? '', 10) === this._selectedLoadoutSlot);
        });
      });

      // Right-click → unslot
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const slot = parseInt(el.dataset.loadoutSlot ?? '', 10);
        const web = el.dataset.loadoutWeb as 'active' | 'passive';
        if (isNaN(slot) || !web) return;
        this.socket.sendCompanionUnslotAbility(web, slot);
      });
    });

    // Available ability click → assign to selected (or first empty) slot
    this.root.querySelectorAll<HTMLElement>('.cp-avail-item').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.availNode;
        const web = el.dataset.availWeb as 'active' | 'passive';
        if (!nodeId || !web) return;

        const loadout = web === 'active' ? this._activeLoadout : this._passiveLoadout;
        let targetSlot = this._selectedLoadoutSlot;

        // If no slot selected, find first empty
        if (targetSlot === null && loadout) {
          for (let i = 0; i < 8; i++) {
            const s = loadout.slots.find(sl => sl.slot === i);
            if (!s || !s.nodeId) { targetSlot = i; break; }
          }
        }
        if (targetSlot === null) targetSlot = 0;

        this.socket.sendCompanionSlotAbility(web, targetSlot, nodeId);
        this._selectedLoadoutSlot = null;
      });
    });
  }

  // ── Util ──────────────────────────────────────────────────────────────────────

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
