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
 *  - Engagement mode (AGR / DEF / PAS)
 *  - Behavior tree state (color-coded dot + label)
 *  - Last ability used (with "Xs ago" timer)
 *  - LLM "Thinking..." indicator
 *
 * HP/MP/Stamina moved to the party panel — keeping them here was redundant
 * once the panel renders the companion as a row. Freed-up space lets the
 * remaining lines breathe with larger type.
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
          font-size: 15px;
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
          font-size: 11px;
          color: rgba(212, 190, 160, 0.55);
          flex-shrink: 0;
          text-shadow: 0 1px 2px #000;
        }

        /* ── Last ability ── */

        .chud-ability {
          padding: 5px 10px 3px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .chud-ability.chud-ability-hidden {
          display: none;
        }

        .chud-ability-icon {
          font-size: 11px;
          color: rgba(200,145,60,0.7);
          flex-shrink: 0;
        }

        .chud-ability-name {
          font-family: var(--font-mono);
          font-size: 11px;
          color: rgba(212,190,160,0.78);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 0 1px 2px #000;
          flex: 1;
        }

        .chud-ability-ago {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212,190,160,0.45);
          flex-shrink: 0;
          text-shadow: 0 1px 2px #000;
        }

        /* ── Status row (mode + BT state) ── */

        .chud-status {
          padding: 5px 10px 6px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chud-mode {
          font-family: var(--font-mono);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.1em;
          padding: 2px 6px;
          border-radius: 2px;
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
          flex-shrink: 0;
        }

        .chud-bt {
          display: flex;
          align-items: center;
          gap: 5px;
          flex: 1;
          min-width: 0;
        }

        .chud-bt-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 4px currentColor;
        }

        .chud-bt-label {
          font-family: var(--font-mono);
          font-size: 12px;
          color: rgba(212,190,160,0.78);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 0 1px 2px #000;
        }

        /* ── LLM indicator ── */

        .chud-llm {
          padding: 0 10px 5px;
          font-family: var(--font-mono);
          font-size: 11px;
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

        <div class="chud-status">
          <span class="chud-mode" data-chud="mode"></span>
          <div class="chud-bt">
            <span class="chud-bt-dot" data-chud="bt-dot"></span>
            <span class="chud-bt-label" data-chud="bt-label"></span>
          </div>
        </div>

        <!-- Last ability used -->
        <div class="chud-ability chud-ability-hidden" data-chud="ability-row">
          <span class="chud-ability-icon">\u2726</span>
          <span class="chud-ability-name" data-chud="ability-name"></span>
          <span class="chud-ability-ago" data-chud="ability-ago"></span>
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

    // Vitals (HP/MP/Stamina) live in the party panel now — companion is a
    // first-class row there. Keeping them here too made the HUD redundant
    // and crowded the more interesting fields (mode, BT, last ability).

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
