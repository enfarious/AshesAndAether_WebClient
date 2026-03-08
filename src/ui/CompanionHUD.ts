import type { PlayerState } from '@/state/PlayerState';
import type { CompanionConfigPayload, EngagementMode } from '@/network/Protocol';

// ── Engagement mode display ──────────────────────────────────────────────────

const MODE_LABELS: Record<EngagementMode, string> = {
  aggressive: 'AGR',
  defensive:  'DEF',
  passive:    'PAS',
};

const MODE_COLORS: Record<EngagementMode, string> = {
  aggressive: '#c84040',   // red
  defensive:  '#c8a030',   // yellow
  passive:    '#888',      // gray
};

// ── BT state display ─────────────────────────────────────────────────────────

const STATE_COLORS: Record<string, string> = {
  idle:             '#888',     // gray
  following_player: '#4488cc',  // blue
  engaging:         '#cc4444',  // red
  retreating:       '#cc8833',  // orange
  supporting:       '#44aa55',  // green
};

const STATE_LABELS: Record<string, string> = {
  idle:             'Idle',
  following_player: 'Following',
  engaging:         'Engaging',
  retreating:       'Retreating',
  supporting:       'Supporting',
};

/**
 * CompanionHUD — compact real-time status widget.
 *
 * Positioned to the right of TargetWindow. Shows:
 *  - Name + level
 *  - HP bar
 *  - MP bar (mana)
 *  - STA bar (stamina)
 *  - Last ability used
 *  - Engagement mode (AGR / DEF / PAS)
 *  - Behavior tree state (color-coded dot + label)
 *  - LLM "Thinking..." indicator
 *
 * Visible whenever the player has a companion.
 * Data driven by player.onChange() → reads player.companion.
 */
export class CompanionHUD {
  private root: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly parent: HTMLElement,
    private readonly player: PlayerState,
  ) {
    this.root = this._build();
    parent.appendChild(this.root);

    const unsub = player.onChange(() => this._render());
    this.cleanup.push(unsub);

    this._render();
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.cleanup.length = 0;
    this.root.remove();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'companion-hud';
    el.innerHTML = `
      <style>
        #companion-hud {
          position: fixed;
          bottom: 24px;
          left: calc(50% + min(250px, 45vw) + 220px);
          width: 160px;
          pointer-events: none;
          user-select: none;
          transition: opacity 0.2s ease;
        }

        #companion-hud.chud-hidden {
          opacity: 0;
        }

        .chud-panel {
          background: rgba(8, 6, 4, 0.84);
          border: 1px solid rgba(200, 145, 60, 0.35);
          box-shadow:
            0 3px 14px rgba(0,0,0,0.65),
            inset 0 1px 0 rgba(255,200,100,0.04);
        }

        /* ── Header ── */

        .chud-header {
          padding: 5px 8px 4px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.18);
          display: flex;
          align-items: baseline;
          gap: 5px;
        }

        .chud-name {
          font-family: var(--font-body);
          font-size: 13px;
          color: var(--ember, #c8823a);
          letter-spacing: 0.06em;
          font-style: italic;
          text-shadow: 0 1px 5px rgba(0,0,0,0.9);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }

        .chud-level {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212, 190, 160, 0.55);
          flex-shrink: 0;
          text-shadow: 0 1px 2px #000;
        }

        /* ── Resource bars (HP / MP / STA) ── */

        .chud-bar-row {
          padding: 3px 8px 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .chud-bar-row:first-of-type {
          padding-top: 4px;
        }

        .chud-bar-label {
          font-family: var(--font-mono);
          font-size: 8px;
          color: rgba(212,190,160,0.45);
          min-width: 16px;
          text-shadow: 0 1px 2px #000;
          flex-shrink: 0;
        }

        .chud-bar-track {
          flex: 1;
          height: 4px;
          background: rgba(10,8,6,0.8);
          position: relative;
          overflow: hidden;
        }

        .chud-bar-track-hp {
          height: 5px;
          border: 1px solid rgba(60,140,60,0.25);
        }

        .chud-bar-track-mp {
          border: 1px solid rgba(60,80,160,0.25);
        }

        .chud-bar-track-sta {
          border: 1px solid rgba(160,130,40,0.25);
        }

        .chud-bar-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          transition: transform 0.3s ease;
        }

        .chud-bar-fill-hp {
          background: linear-gradient(90deg, #1a5a1a, #2a8a2a);
        }

        .chud-bar-fill-mp {
          background: linear-gradient(90deg, #1a3a7a, #2a5aba);
        }

        .chud-bar-fill-sta {
          background: linear-gradient(90deg, #7a6a1a, #baa030);
        }

        .chud-bar-pct {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,190,160,0.65);
          min-width: 26px;
          text-align: right;
          text-shadow: 0 1px 2px #000;
          flex-shrink: 0;
        }

        /* ── Last ability ── */

        .chud-ability {
          padding: 2px 8px 0;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .chud-ability.chud-ability-hidden {
          display: none;
        }

        .chud-ability-icon {
          font-size: 8px;
          color: rgba(200,145,60,0.5);
          flex-shrink: 0;
        }

        .chud-ability-name {
          font-family: var(--font-mono);
          font-size: 8px;
          color: rgba(212,190,160,0.55);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 0 1px 2px #000;
        }

        .chud-ability-ago {
          font-family: var(--font-mono);
          font-size: 7px;
          color: rgba(212,190,160,0.3);
          flex-shrink: 0;
          text-shadow: 0 1px 2px #000;
        }

        /* ── Status row (mode + BT state) ── */

        .chud-status {
          padding: 3px 8px 5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .chud-mode {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 1px 4px;
          border-radius: 2px;
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
          flex-shrink: 0;
        }

        .chud-bt {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 1;
          min-width: 0;
        }

        .chud-bt-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 3px currentColor;
        }

        .chud-bt-label {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,190,160,0.55);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 0 1px 2px #000;
        }

        /* ── LLM indicator ── */

        .chud-llm {
          padding: 0 8px 4px;
          font-family: var(--font-mono);
          font-size: 9px;
          color: #c8a030;
          letter-spacing: 0.04em;
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
        }

        .chud-llm.chud-llm-hidden {
          display: none;
        }

        @keyframes chud-think-pulse {
          0%, 100% { opacity: 0.5; }
          50%      { opacity: 1; }
        }

        .chud-llm-active {
          animation: chud-think-pulse 1.5s ease-in-out infinite;
        }
      </style>

      <div class="chud-panel">
        <div class="chud-header">
          <span class="chud-name" data-chud="name"></span>
          <span class="chud-level" data-chud="level"></span>
        </div>

        <!-- HP bar -->
        <div class="chud-bar-row">
          <span class="chud-bar-label">HP</span>
          <div class="chud-bar-track chud-bar-track-hp">
            <div class="chud-bar-fill chud-bar-fill-hp" data-chud="hp-fill"></div>
          </div>
          <span class="chud-bar-pct" data-chud="hp-pct"></span>
        </div>

        <!-- MP bar -->
        <div class="chud-bar-row" data-chud="mp-row">
          <span class="chud-bar-label">MP</span>
          <div class="chud-bar-track chud-bar-track-mp">
            <div class="chud-bar-fill chud-bar-fill-mp" data-chud="mp-fill"></div>
          </div>
          <span class="chud-bar-pct" data-chud="mp-pct"></span>
        </div>

        <!-- STA bar -->
        <div class="chud-bar-row" data-chud="sta-row">
          <span class="chud-bar-label">STA</span>
          <div class="chud-bar-track chud-bar-track-sta">
            <div class="chud-bar-fill chud-bar-fill-sta" data-chud="sta-fill"></div>
          </div>
          <span class="chud-bar-pct" data-chud="sta-pct"></span>
        </div>

        <!-- Last ability used -->
        <div class="chud-ability chud-ability-hidden" data-chud="ability-row">
          <span class="chud-ability-icon">\u2726</span>
          <span class="chud-ability-name" data-chud="ability-name"></span>
          <span class="chud-ability-ago" data-chud="ability-ago"></span>
        </div>

        <div class="chud-status">
          <span class="chud-mode" data-chud="mode"></span>
          <div class="chud-bt">
            <span class="chud-bt-dot" data-chud="bt-dot"></span>
            <span class="chud-bt-label" data-chud="bt-label"></span>
          </div>
        </div>
        <div class="chud-llm chud-llm-hidden" data-chud="llm">Thinking...</div>
      </div>
    `;
    return el;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private _render(): void {
    const companion = this.player.companion as (CompanionConfigPayload & { llmPending?: boolean }) | null;

    if (!companion) {
      this.root.classList.add('chud-hidden');
      return;
    }
    this.root.classList.remove('chud-hidden');

    // Name + level
    const nameEl = this.root.querySelector('[data-chud="name"]') as HTMLElement;
    const levelEl = this.root.querySelector('[data-chud="level"]') as HTMLElement;
    nameEl.textContent = companion.name;
    levelEl.textContent = `Lv${companion.level}`;

    // HP bar
    const hpPct = companion.maxHealth > 0
      ? Math.max(0, Math.min(1, companion.currentHealth / companion.maxHealth))
      : 0;
    const hpFill = this.root.querySelector('[data-chud="hp-fill"]') as HTMLElement;
    const hpPctEl = this.root.querySelector('[data-chud="hp-pct"]') as HTMLElement;
    hpFill.style.transform = `scaleX(${hpPct})`;
    hpPctEl.textContent = `${Math.round(hpPct * 100)}%`;

    // MP bar
    const maxMp = companion.maxMana ?? 0;
    const mpRow = this.root.querySelector('[data-chud="mp-row"]') as HTMLElement;
    if (maxMp > 0) {
      mpRow.style.display = '';
      const mpPct = Math.max(0, Math.min(1, (companion.currentMana ?? 0) / maxMp));
      const mpFill = this.root.querySelector('[data-chud="mp-fill"]') as HTMLElement;
      const mpPctEl = this.root.querySelector('[data-chud="mp-pct"]') as HTMLElement;
      mpFill.style.transform = `scaleX(${mpPct})`;
      mpPctEl.textContent = `${Math.round(mpPct * 100)}%`;
    } else {
      mpRow.style.display = 'none';
    }

    // STA bar
    const maxSta = companion.maxStamina ?? 0;
    const staRow = this.root.querySelector('[data-chud="sta-row"]') as HTMLElement;
    if (maxSta > 0) {
      staRow.style.display = '';
      const staPct = Math.max(0, Math.min(1, (companion.currentStamina ?? 0) / maxSta));
      const staFill = this.root.querySelector('[data-chud="sta-fill"]') as HTMLElement;
      const staPctEl = this.root.querySelector('[data-chud="sta-pct"]') as HTMLElement;
      staFill.style.transform = `scaleX(${staPct})`;
      staPctEl.textContent = `${Math.round(staPct * 100)}%`;
    } else {
      staRow.style.display = 'none';
    }

    // Last ability used
    const abilityRow = this.root.querySelector('[data-chud="ability-row"]') as HTMLElement;
    const lastAbility = companion.lastAbility;
    if (lastAbility) {
      abilityRow.classList.remove('chud-ability-hidden');
      const abilityNameEl = this.root.querySelector('[data-chud="ability-name"]') as HTMLElement;
      const abilityAgoEl = this.root.querySelector('[data-chud="ability-ago"]') as HTMLElement;
      abilityNameEl.textContent = lastAbility.abilityName;

      const ago = Math.floor((Date.now() - lastAbility.timestamp) / 1000);
      abilityAgoEl.textContent = ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`;
    } else {
      abilityRow.classList.add('chud-ability-hidden');
    }

    // Engagement mode
    const mode = companion.combatSettings?.engagementMode ?? 'defensive';
    const modeEl = this.root.querySelector('[data-chud="mode"]') as HTMLElement;
    modeEl.textContent = MODE_LABELS[mode] ?? mode.toUpperCase().slice(0, 3);
    modeEl.style.color = MODE_COLORS[mode] ?? '#888';
    modeEl.style.border = `1px solid ${MODE_COLORS[mode] ?? '#888'}44`;

    // BT state
    const state = companion.behaviorState ?? 'idle';
    const btDot = this.root.querySelector('[data-chud="bt-dot"]') as HTMLElement;
    const btLabel = this.root.querySelector('[data-chud="bt-label"]') as HTMLElement;
    const stateColor = STATE_COLORS[state] ?? '#888';
    btDot.style.color = stateColor;
    btDot.style.background = stateColor;
    btLabel.textContent = STATE_LABELS[state] ?? state.replace(/_/g, ' ');

    // LLM pending
    const llmEl = this.root.querySelector('[data-chud="llm"]') as HTMLElement;
    if (companion.llmPending) {
      llmEl.classList.remove('chud-llm-hidden');
      llmEl.classList.add('chud-llm-active');
    } else {
      llmEl.classList.add('chud-llm-hidden');
      llmEl.classList.remove('chud-llm-active');
    }
  }
}
