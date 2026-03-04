import type { PlayerState }  from '@/state/PlayerState';
import type { DerivedStats } from '@/network/Protocol';
import type { SocketClient } from '@/network/SocketClient';

/**
 * CharacterSheet — display-only panel showing core attributes, derived stats,
 * level, XP progress, and available stat points.
 *
 * Press C (or call toggle()) to open/close.
 * Pure HTML/CSS over the canvas — Three.js not involved.
 */

// ── Stat display helpers ────────────────────────────────────────────────────

const CORE_STAT_ABBR: Record<string, string> = {
  strength: 'STR', vitality: 'VIT', dexterity: 'DEX',
  agility: 'AGI', intelligence: 'INT', wisdom: 'WIS',
};

const DERIVED_SECTIONS: { label: string; keys: (keyof DerivedStats)[] }[] = [
  {
    label: 'Resources',
    keys: ['maxHp', 'maxStamina', 'maxMana', 'carryingCapacity'],
  },
  {
    label: 'Physical Combat',
    keys: [
      'attackRating', 'defenseRating', 'physicalAccuracy', 'evasion',
      'damageAbsorption', 'glancingBlowChance', 'criticalHitChance',
      'penetratingBlowChance', 'deflectedBlowChance',
    ],
  },
  {
    label: 'Magic Combat',
    keys: ['magicAttack', 'magicDefense', 'magicAccuracy', 'magicEvasion', 'magicAbsorption'],
  },
  {
    label: 'Speed & Timing',
    keys: ['initiative', 'movementSpeed', 'attackSpeedBonus'],
  },
];

const STAT_LABELS: Record<string, string> = {
  maxHp: 'Max HP', maxStamina: 'Max Stamina', maxMana: 'Max Mana',
  carryingCapacity: 'Carrying Capacity',
  attackRating: 'Attack Rating', defenseRating: 'Defense Rating',
  physicalAccuracy: 'Physical Accuracy', evasion: 'Evasion',
  damageAbsorption: 'Damage Absorption', glancingBlowChance: 'Glancing Blow',
  criticalHitChance: 'Critical Hit', penetratingBlowChance: 'Penetrating Blow',
  deflectedBlowChance: 'Deflected Blow',
  magicAttack: 'Magic Attack', magicDefense: 'Magic Defense',
  magicAccuracy: 'Magic Accuracy', magicEvasion: 'Magic Evasion',
  magicAbsorption: 'Magic Absorption',
  initiative: 'Initiative', movementSpeed: 'Movement Speed',
  attackSpeedBonus: 'Attack Speed',
};

const PERCENT_STATS = new Set<string>([
  'glancingBlowChance', 'criticalHitChance',
  'penetratingBlowChance', 'deflectedBlowChance', 'attackSpeedBonus',
]);

const SPEED_STATS = new Set<string>(['movementSpeed']);

function formatStat(key: string, value: number): string {
  if (PERCENT_STATS.has(key))  return `${value.toFixed(1)}%`;
  if (SPEED_STATS.has(key))    return `${value.toFixed(1)} m/s`;
  return String(Math.round(value));
}

function xpForLevel(level: number): number {
  return Math.floor(1000 * Math.pow(level, 1.5));
}

// ── Component ───────────────────────────────────────────────────────────────

export class CharacterSheet {
  private root:    HTMLElement;
  private visible  = false;
  private cleanup: (() => void)[] = [];

  // Dirty-check cache — only rebuild when stat-relevant data changes
  private _lastCoreKey    = '';
  private _lastDerivedKey = '';

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsub = player.onChange(() => {
      if (this.visible) this._refresh();
    });
    this.cleanup.push(unsub);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('cs-visible'));
    this.visible = true;
    this._refresh();
  }

  hide(): void {
    this.root.classList.remove('cs-visible');
    this.root.style.display = 'none';
    this.visible = false;
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'character-sheet';
    el.innerHTML = `
      <style>
        #character-sheet {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 200;
          pointer-events: none;
        }
        #character-sheet.cs-visible {
          pointer-events: auto;
        }

        /* Backdrop */
        #cs-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.55);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #character-sheet.cs-visible #cs-backdrop { opacity: 1; }

        /* Panel */
        #cs-panel {
          position: relative;
          width: min(500px, 94vw);
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: rgba(8,6,4,0.96);
          border: 1px solid rgba(200,98,42,0.30);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8),
                      inset 0 0 60px rgba(30,15,5,0.5);
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #character-sheet.cs-visible #cs-panel {
          transform: translateY(0);
          opacity: 1;
        }

        /* Header */
        #cs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px 8px;
          border-bottom: 1px solid rgba(200,98,42,0.25);
        }
        #cs-title {
          font-family: var(--font-display, serif);
          font-size: 16px;
          color: rgba(200,145,60,0.90);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        #cs-close-btn {
          font-family: var(--font-mono, monospace);
          font-size: 14px;
          background: none;
          border: none;
          color: rgba(200,145,60,0.50);
          cursor: pointer;
          padding: 0 2px;
          line-height: 1;
          transition: color 0.12s;
        }
        #cs-close-btn:hover { color: rgba(230,180,80,0.95); }

        /* Scrollable body */
        #cs-body {
          overflow-y: auto;
          flex: 1;
          min-height: 0;
          padding: 12px 16px 16px;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.3) transparent;
        }

        /* Identity */
        #cs-identity {
          display: flex;
          align-items: baseline;
          gap: 10px;
          margin-bottom: 6px;
        }
        #cs-name {
          font-family: var(--font-display, serif);
          font-size: 18px;
          color: rgba(212,201,184,0.95);
          letter-spacing: 0.06em;
        }
        #cs-level {
          font-family: var(--font-mono, monospace);
          font-size: 13px;
          color: rgba(200,145,60,0.70);
        }

        /* XP bar */
        #cs-xp-wrap {
          height: 4px;
          background: rgba(14,10,6,0.8);
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 3px;
        }
        #cs-xp-fill {
          height: 100%;
          width: 0%;
          background: rgba(200,145,60,0.70);
          transition: width 0.3s ease;
        }
        #cs-xp-label {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(180,160,130,0.65);
          margin-bottom: 14px;
        }

        /* Section divider */
        .cs-divider {
          height: 1px;
          background: rgba(200,98,42,0.22);
          margin: 12px 0;
        }

        /* Section label */
        .cs-section-label {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(150,120,80,0.80);
          letter-spacing: 0.14em;
          text-transform: uppercase;
          margin-bottom: 6px;
        }

        /* Core stats grid */
        #cs-core-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 3px 20px;
          margin-bottom: 4px;
        }
        .cs-core-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 2px 0;
        }
        .cs-core-label {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          color: rgba(180,160,130,0.80);
        }
        .cs-core-abbr {
          color: rgba(200,145,60,0.80);
          margin-right: 4px;
        }
        .cs-core-value {
          font-family: var(--font-mono, monospace);
          font-size: 14px;
          color: rgba(230,200,140,0.95);
          min-width: 24px;
          text-align: right;
        }

        /* Core stat allocation button */
        .cs-core-btn {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          background: rgba(200, 145, 60, 0.15);
          border: 1px solid rgba(200, 145, 60, 0.35);
          color: rgba(200, 145, 60, 0.85);
          cursor: pointer;
          padding: 0 5px;
          line-height: 1.4;
          margin-left: 6px;
          transition: background 0.12s;
        }
        .cs-core-btn:hover {
          background: rgba(200, 145, 60, 0.3);
        }

        /* Stat points */
        #cs-stat-points {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          color: rgba(150,120,80,0.60);
          margin-bottom: 2px;
        }
        #cs-stat-points.cs-has-points {
          color: rgba(200,145,60,0.85);
        }

        /* Respec button */
        .cs-respec-btn {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          background: none;
          border: 1px solid rgba(200, 98, 42, 0.25);
          color: rgba(200, 98, 42, 0.65);
          cursor: pointer;
          padding: 3px 10px;
          margin-top: 4px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          transition: color 0.12s, border-color 0.12s;
        }
        .cs-respec-btn:hover {
          color: rgba(200, 98, 42, 0.9);
          border-color: rgba(200, 98, 42, 0.5);
        }

        /* Derived stat rows */
        .cs-derived-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 1px 0;
        }
        .cs-derived-label {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          color: rgba(180,160,130,0.78);
        }
        .cs-derived-value {
          font-family: var(--font-mono, monospace);
          font-size: 13px;
          color: rgba(212,201,184,0.85);
          min-width: 50px;
          text-align: right;
        }
      </style>

      <div id="cs-backdrop"></div>
      <div id="cs-panel">
        <div id="cs-header">
          <span id="cs-title">Character Sheet</span>
          <button id="cs-close-btn">\u2715</button>
        </div>
        <div id="cs-body">
          <!-- Identity -->
          <div id="cs-identity">
            <span id="cs-name"></span>
            <span id="cs-level"></span>
          </div>

          <!-- XP bar -->
          <div id="cs-xp-wrap"><div id="cs-xp-fill"></div></div>
          <div id="cs-xp-label"></div>

          <!-- Core stats -->
          <div class="cs-section-label">Core Attributes</div>
          <div id="cs-core-grid"></div>
          <div id="cs-stat-points"></div>
          <button id="cs-respec-stats" class="cs-respec-btn" style="display:none;">Respec Stats</button>

          <div class="cs-divider"></div>

          <!-- Derived stats -->
          <div id="cs-derived"></div>
        </div>
      </div>
    `;

    // Event listeners
    el.querySelector('#cs-backdrop')?.addEventListener('click', () => this.hide());
    el.querySelector('#cs-close-btn')?.addEventListener('click', () => this.hide());
    el.querySelector('#cs-respec-stats')?.addEventListener('click', () => {
      if (confirm('Reset all stats to base values? (1 hour cooldown)')) {
        this.socket.sendRespecStats();
      }
    });

    return el;
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _refresh(): void {
    const p = this.player;

    // Identity
    this._setText('#cs-name', p.name);
    this._setText('#cs-level', `Level ${p.level}`);

    // XP
    const xpNeeded  = xpForLevel(p.level);
    const xpCurrent = p.experience;
    const pct       = xpNeeded > 0 ? Math.min(100, (xpCurrent / xpNeeded) * 100) : 0;
    const fill = this.root.querySelector<HTMLElement>('#cs-xp-fill');
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    this._setText('#cs-xp-label',
      `${xpCurrent.toLocaleString()} / ${xpNeeded.toLocaleString()} XP`);

    // Core stats — only rebuild when stat values or statPoints change
    const coreKey = JSON.stringify(p.coreStats) + '|' + p.statPoints;
    if (coreKey !== this._lastCoreKey) {
      this._lastCoreKey = coreKey;
      this._renderCoreStats();
    }

    // Stat points
    const sp = p.statPoints;
    const spEl = this.root.querySelector<HTMLElement>('#cs-stat-points');
    if (spEl) {
      spEl.textContent = sp > 0 ? `${sp} stat point${sp !== 1 ? 's' : ''} available` : '0 stat points available';
      spEl.classList.toggle('cs-has-points', sp > 0);
    }

    // Respec button — always visible (server enforces cooldown)
    const respecEl = this.root.querySelector<HTMLElement>('#cs-respec-stats');
    if (respecEl) {
      respecEl.style.display = '';
    }

    // Derived stats — only rebuild when derivedStats change
    const derivedKey = JSON.stringify(p.derivedStats);
    if (derivedKey !== this._lastDerivedKey) {
      this._lastDerivedKey = derivedKey;
      this._renderDerivedStats();
    }
  }

  private _renderCoreStats(): void {
    const grid = this.root.querySelector<HTMLElement>('#cs-core-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const core = this.player.coreStats;
    const hasPoints = this.player.statPoints > 0;
    const order: (keyof typeof CORE_STAT_ABBR)[] = [
      'strength', 'vitality', 'dexterity', 'agility', 'intelligence', 'wisdom',
    ];

    for (const key of order) {
      const row = document.createElement('div');
      row.className = 'cs-core-row';
      const value = core ? (core as unknown as Record<string, number>)[key] ?? 0 : 0;
      row.innerHTML = `
        <span class="cs-core-label">
          <span class="cs-core-abbr">${CORE_STAT_ABBR[key]}</span>${key}
        </span>
        <span class="cs-core-value">${value}</span>
      `;

      if (hasPoints) {
        const btn = document.createElement('button');
        btn.className = 'cs-core-btn';
        btn.textContent = '+';
        btn.addEventListener('click', () => {
          this.socket.sendAllocateStat(key);
        });
        row.appendChild(btn);
      }

      grid.appendChild(row);
    }
  }

  private _renderDerivedStats(): void {
    const container = this.root.querySelector<HTMLElement>('#cs-derived');
    if (!container) return;
    container.innerHTML = '';

    const derived = this.player.derivedStats;

    for (const section of DERIVED_SECTIONS) {
      // Section label
      const label = document.createElement('div');
      label.className = 'cs-section-label';
      label.textContent = section.label;
      container.appendChild(label);

      // Stat rows
      for (const key of section.keys) {
        const row = document.createElement('div');
        row.className = 'cs-derived-row';
        const value = derived ? derived[key] ?? 0 : 0;
        row.innerHTML = `
          <span class="cs-derived-label">${STAT_LABELS[key] ?? key}</span>
          <span class="cs-derived-value">${formatStat(key, value)}</span>
        `;
        container.appendChild(row);
      }

      // Divider between sections (skip after last)
      if (section !== DERIVED_SECTIONS[DERIVED_SECTIONS.length - 1]) {
        const div = document.createElement('div');
        div.className = 'cs-divider';
        container.appendChild(div);
      }
    }
  }

  private _setText(sel: string, text: string): void {
    const el = this.root.querySelector<HTMLElement>(sel);
    if (el) el.textContent = text;
  }
}
