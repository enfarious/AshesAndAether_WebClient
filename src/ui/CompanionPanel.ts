import type { PlayerState }   from '@/state/PlayerState';
import type { SocketClient }  from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type {
  CompanionConfigPayload,
  CompanionArchetype,
  PreferredRange,
  TargetPriority,
  CombatStance,
} from '@/network/Protocol';

/**
 * CompanionPanel — manual companion management for when LLM is unavailable.
 *
 * 'N' key opens/closes.
 *
 * Sections:
 *   - Status: name, level, HP, behavior state
 *   - Archetype selector (4 types)
 *   - Combat settings: stance, priority, range, retreat, ability weights
 *   - Abilities: toggle T1 abilities on/off
 *   - Mode controls: follow / detach / recall
 */
export class CompanionPanel {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _visible = false;
  private _configRequested = false;

  /** Debounce timer for slider changes. */
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

    const unsub = player.onChange(() => { if (this._visible) this._render(); });
    this.cleanup.push(unsub);

    const unsubConfig = router.onCompanionConfig(() => {
      if (this._visible) this._render();
    });
    this.cleanup.push(unsubConfig);

    this.root.style.display = 'none';
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._visible = true;
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
    this.root.remove();
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
        width: clamp(340px, 32vw, 480px);
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

      /* ── Body ──────────────────────────────────────────── */
      .cp-body {
        padding: 10px 14px;
        overflow-y: auto;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 10px;
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

      /* ── Status bar ──────────────────────────────────────── */
      .cp-status {
        display: flex;
        align-items: center;
        gap: 8px;
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
        min-width: 52px;
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

      /* ── Mode controls ───────────────────────────────────── */
      .cp-modes {
        display: flex;
        gap: 8px;
        justify-content: center;
        padding-top: 6px;
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
    `;
    document.head.appendChild(style);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  private _render(): void {
    const c = this.player.companion;

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
      { id: 'cautious_healer', name: 'Cautious Healer', desc: 'Mid-range support, heals allies' },
      { id: 'opportunist',     name: 'Opportunist',     desc: 'Balanced, targets the weak' },
      { id: 'tank',            name: 'Tank',             desc: 'Melee defender, CC-focused' },
    ];

    const settings = c.combatSettings;

    this.root.innerHTML = `
      <div class="cp-header">
        <span class="cp-title">Companion</span>
        <button class="cp-close" id="cp-close">&times;</button>
      </div>
      <div class="cp-body">
        <!-- Status -->
        <div class="cp-status">
          <span class="cp-name">${this._esc(c.name)}</span>
          <span class="cp-level">Lv ${c.level}</span>
          <span class="cp-state-badge ${stateClass}">${c.behaviorState}</span>
        </div>
        <div class="cp-hp-bar"><div class="cp-hp-fill" style="width:${hpPct}%"></div></div>

        <!-- Archetype -->
        <div class="cp-section">Archetype</div>
        <div class="cp-archetypes">
          ${archetypes.map(a => `
            <div class="cp-arch ${c.archetype === a.id ? 'selected' : ''}" data-arch="${a.id}">
              <div class="cp-arch-name">${a.name}</div>
              <div class="cp-arch-desc">${a.desc}</div>
            </div>
          `).join('')}
        </div>

        <!-- Combat Settings -->
        <div class="cp-section">Combat Settings</div>

        ${this._segRow('Stance', 'stance', ['aggressive', 'cautious', 'support'], settings.stance)}
        ${this._segRow('Priority', 'priority', ['weakest', 'nearest', 'threatening_player'], settings.priority, ['Weakest', 'Nearest', 'Protect'])}
        ${this._segRow('Range', 'range', ['melee', 'close', 'mid', 'far'], settings.preferredRange)}

        ${this._sliderRow('Retreat', 'retreat', Math.round(settings.retreatThreshold * 100), 0, 100, '%')}
        ${this._sliderRow('Damage', 'damage', Math.round((settings.abilityWeights.damage ?? 0) * 100), 0, 100)}
        ${this._sliderRow('CC', 'cc', Math.round((settings.abilityWeights.cc ?? 0) * 100), 0, 100)}
        ${this._sliderRow('Heal', 'heal', Math.round((settings.abilityWeights.heal ?? 0) * 100), 0, 100)}

        <!-- Abilities -->
        <div class="cp-section">Abilities</div>
        ${c.abilities.map(a => `
          <div class="cp-ability">
            <input type="checkbox" class="cp-ability-check" data-ability="${a.id}" ${a.enabled ? 'checked' : ''} />
            <span class="cp-ability-name">${this._esc(a.name)}</span>
            <span class="cp-ability-desc">${this._esc(a.description)}</span>
          </div>
        `).join('')}

        <!-- Mode controls -->
        <div class="cp-modes">
          <button class="cp-btn ${c.behaviorState === 'active' ? 'active' : ''}" data-mode="follow">Follow</button>
          <button class="cp-btn ${c.behaviorState === 'detached' ? 'active' : ''}" data-mode="detach">Detach</button>
          <button class="cp-btn" data-mode="recall">Recall</button>
        </div>
      </div>
    `;

    this._wireClose();
    this._wireArchetypes(c);
    this._wireSegments();
    this._wireSliders();
    this._wireAbilities(c);
    this._wireModes();
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

  // ── Event wiring ──────────────────────────────────────────────────────────────

  private _wireClose(): void {
    this.root.querySelector('#cp-close')?.addEventListener('click', () => this.hide());
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
        // Map key to settings field
        const settings: Record<string, unknown> = {};
        if (key === 'stance')   settings.stance = val as CombatStance;
        if (key === 'priority') settings.priority = val as TargetPriority;
        if (key === 'range')    settings.preferredRange = val as PreferredRange;
        this.socket.sendCompanionConfigure(settings);
      });
    });
  }

  private _wireSliders(): void {
    this.root.querySelectorAll<HTMLInputElement>('.cp-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.slider!;
        const num = parseInt(slider.value, 10);
        // Update display immediately
        const valEl = this.root.querySelector(`[data-slider-val="${key}"]`);
        if (valEl) valEl.textContent = key === 'retreat' ? `${num}%` : `${num}`;
        // Debounce the server send
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const settings: Record<string, unknown> = {};
          if (key === 'retreat') {
            settings.retreatThreshold = num / 100;
          } else {
            settings.abilityWeights = { [key]: num / 100 };
          }
          this.socket.sendCompanionConfigure(settings);
        }, 200);
      });
    });
  }

  private _wireAbilities(c: CompanionConfigPayload): void {
    this.root.querySelectorAll<HTMLInputElement>('.cp-ability-check').forEach(cb => {
      cb.addEventListener('change', () => {
        // Collect all checked ability IDs
        const enabled: string[] = [];
        this.root.querySelectorAll<HTMLInputElement>('.cp-ability-check').forEach(el => {
          if (el.checked && el.dataset.ability) enabled.push(el.dataset.ability);
        });
        this.socket.sendCompanionSetAbilities(enabled);
      });
    });
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

  // ── Util ──────────────────────────────────────────────────────────────────────

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
