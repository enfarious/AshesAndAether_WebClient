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

// XP curve — must match @ashes/core Progression.xpForNextLevel.
// Banded linear, returns XP needed to advance from `currentLevel` to next.
const LEVEL_CAP = 50;
function xpForLevel(currentLevel: number): number {
  if (currentLevel >= LEVEL_CAP) return 0;
  const t = currentLevel;
  if (t === 1) return 300;
  if (t <= 10) return 300 + (t - 1) * 100;
  if (t <= 20) return 1500 + Math.round((t - 11) * 333.33);
  if (t <= 40) return 4800 + Math.round((t - 21) * 126.32);
  return 9600 + Math.round((t - 41) * 600);
}

// ── Component ───────────────────────────────────────────────────────────────

export class CharacterSheet {
  private root:    HTMLElement;
  private visible  = false;
  private cleanup: (() => void)[] = [];
  private rangePoll: ReturnType<typeof setInterval> | null = null;

  // Dirty-check cache — only rebuild when stat-relevant data changes
  private _lastCoreKey    = '';
  private _lastDerivedKey = '';
  private _lastAxisKey    = '';

  /** Callback that returns whether the player is currently inside a civic
   *  ward (beacon range). Polled while the sheet is visible to enable/disable
   *  the respec button without a server round-trip. */
  private inBeaconRange: () => boolean = () => true;

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

  /** Wire the beacon-range check from app.ts post-construction (the beacon
   *  manager isn't available when the sheet is built). Safe to call again
   *  on zone change. */
  setBeaconRangeCheck(check: () => boolean): void {
    this.inBeaconRange = check;
    if (this.visible) this._refreshRespecButton();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isVisible(): boolean { return this.visible; }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('cs-visible'));
    this.visible = true;
    this._refresh();
    // 1 Hz beacon-range poll — covers the case where the player walks in/out
    // of range while the sheet is open. Player-position updates don't fire
    // PlayerState.onChange, so a poll is the simplest reliable option.
    this.rangePoll = setInterval(() => this._refreshRespecButton(), 1000);
  }

  hide(): void {
    this.root.classList.remove('cs-visible');
    this.root.style.display = 'none';
    this.visible = false;
    if (this.rangePoll) { clearInterval(this.rangePoll); this.rangePoll = null; }
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

        /* Axis web */
        #cs-axis {
          margin: 4px 0 8px;
        }
        #cs-axis-row {
          display: flex;
          gap: 14px;
          align-items: center;
        }
        #cs-axis svg {
          flex: 0 0 200px;
          width: 200px;
          height: 200px;
          display: block;
        }
        #cs-axis-tiers {
          flex: 1;
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(180,160,130,0.85);
          line-height: 1.4;
          min-height: 60px;
        }
        #cs-axis-tiers .cs-axis-tier-line {
          color: rgba(212,201,184,0.95);
        }
        #cs-axis-tiers .cs-axis-tier-line.cs-axis-suppressed {
          color: rgba(180,140,100,0.65);
          font-style: italic;
        }
        #cs-axis-tiers .cs-axis-empty {
          color: rgba(150,120,80,0.55);
          font-style: italic;
        }
        .cs-axis-grid    { fill: none; stroke: rgba(200,98,42,0.18); stroke-width: 1; }
        .cs-axis-grid-3  { stroke: rgba(150,120,80,0.30); }
        .cs-axis-spoke   { stroke: rgba(120,100,80,0.45); stroke-width: 1; }
        .cs-axis-shape   { fill: rgba(200,145,60,0.22); stroke: rgba(230,170,80,0.85); stroke-width: 1.5; stroke-linejoin: round; }
        .cs-axis-label   { fill: rgba(180,160,130,0.80); font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
        .cs-axis-count   { fill: rgba(212,201,184,0.95); font-family: var(--font-mono, monospace); font-size: 9px; }
        .cs-axis-tier-bg { fill: rgba(8,6,4,0.85); stroke: rgba(200,98,42,0.30); stroke-width: 1; }
        .cs-axis-tier-num { fill: rgba(230,170,80,0.95); font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 700; text-anchor: middle; }

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
        .cs-core-bonus {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(120, 200, 120, 0.85);
          margin-left: 4px;
          min-width: 24px;
          text-align: right;
        }
        .cs-core-bonus-neg {
          color: rgba(200, 100, 90, 0.85);
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
        .cs-respec-btn:hover:not(:disabled) {
          color: rgba(200, 98, 42, 0.9);
          border-color: rgba(200, 98, 42, 0.5);
        }
        .cs-respec-btn:disabled {
          color: rgba(150, 120, 100, 0.35);
          border-color: rgba(150, 120, 100, 0.18);
          cursor: not-allowed;
        }
        .cs-respec-btn[title]:disabled:hover::after {
          content: attr(title);
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
        .cs-derived-bonus {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(120, 200, 120, 0.85);
          margin-left: 6px;
          min-width: 40px;
          text-align: right;
        }
        .cs-derived-bonus-neg {
          color: rgba(200, 100, 90, 0.85);
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

          <!-- Build identity (axis web) -->
          <div class="cs-section-label">Build Identity</div>
          <div id="cs-axis">
            <div id="cs-axis-row">
              <svg id="cs-axis-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"></svg>
              <div id="cs-axis-tiers"></div>
            </div>
          </div>

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
      if (!this.inBeaconRange()) return;  // visually disabled, defensive guard
      if (confirm('Reset all stats to base values? (Free at any civic ward.)')) {
        this.socket.sendCommand('/respec stats');
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
    const atCap     = p.level >= LEVEL_CAP;
    const pct       = atCap ? 100 : (xpNeeded > 0 ? Math.min(100, (xpCurrent / xpNeeded) * 100) : 0);
    const fill = this.root.querySelector<HTMLElement>('#cs-xp-fill');
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    this._setText('#cs-xp-label',
      atCap
        ? `Level ${LEVEL_CAP} (cap reached)`
        : `${xpCurrent.toLocaleString()} / ${xpNeeded.toLocaleString()} XP`);

    // Core stats — only rebuild when stat values, bonuses, or statPoints change
    const coreKey = JSON.stringify(p.coreStats) + '|' + JSON.stringify(p.coreStatsBonuses) + '|' + p.statPoints;
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

    // Respec button — always visible; enabled only when inside a civic ward.
    this._refreshRespecButton();
    const respecEl = this.root.querySelector<HTMLElement>('#cs-respec-stats');
    if (respecEl) respecEl.style.display = '';

    // Build identity — re-renders only when axis snapshot composition
    // changes (server pushes a fresh snapshot on slot/unslot via
    // PASSIVE_LOADOUT_CHANGED, so this stays cheap).
    const axisSnap = p.axisSnapshot;
    const axisKey = axisSnap
      ? JSON.stringify(axisSnap.counts) + '|' + JSON.stringify(axisSnap.tiers)
      : '';
    if (axisKey !== this._lastAxisKey) {
      this._lastAxisKey = axisKey;
      this._renderAxisWeb();
    }

    // Derived stats — rebuild when derived stats, passive bonuses, or
    // active-buff statMods change. Effect signature is just (id, statMods)
    // pairs — duration ticks and counts that don't shift the magnitudes
    // shouldn't trigger a re-render.
    const buffSig = JSON.stringify(
      p.effects.map(e => [e.id, e.statMods ?? null]),
    );
    const derivedKey = JSON.stringify(p.derivedStats) + '|' + JSON.stringify(p.derivedStatsBonuses) + '|' + buffSig;
    if (derivedKey !== this._lastDerivedKey) {
      this._lastDerivedKey = derivedKey;
      this._renderDerivedStats();
    }
  }

  /** Render the 6-spoke axis web — phys/magical/melee/ranged/offense/defense
   *  arranged radially with phys at the top, paired axes (phys↔magical,
   *  melee↔ranged, offense↔defense) on opposite spokes. Each spoke length
   *  is proportional to the slotted-node count pulling that direction.
   *  Threshold rings at 3/5/7 nodes mark the T1/T2/T3 ladder breakpoints.
   *  The filled polygon connecting the spoke tips is the build's silhouette
   *  — a glance reveals "where does this build pull?" */
  private _renderAxisWeb(): void {
    const svg = this.root.querySelector<SVGSVGElement>('#cs-axis-svg');
    const tiersEl = this.root.querySelector<HTMLElement>('#cs-axis-tiers');
    if (!svg || !tiersEl) return;
    svg.innerHTML = '';

    const snap = this.player.axisSnapshot;
    if (!snap) {
      tiersEl.innerHTML = '<span class="cs-axis-empty">No build slotted yet.</span>';
      // Render an empty grid so the panel doesn't flash on join.
      this._buildAxisGrid(svg, { phys: 0, magical: 0, melee: 0, ranged: 0, offense: 0, defense: 0 });
      return;
    }

    this._buildAxisGrid(svg, snap.counts);

    // Tier readout to the right of the wheel — server-supplied summaries
    // mirror what /stats prints. With the melee-gate removed, all active
    // tiers display unconditionally; healer-sector axes are zero on
    // offense so a healer build never trips the defense ladder in the
    // first place.
    if (snap.active.length === 0) {
      tiersEl.innerHTML = '<span class="cs-axis-empty">Slot 3+ nodes pulling one direction to unlock tier bonuses.</span>';
    } else {
      tiersEl.innerHTML = snap.active
        .map((t) => `<div class="cs-axis-tier-line">${this._escapeHtml(t.summary)}</div>`)
        .join('');
    }
  }

  /** Compose the SVG grid + spokes + filled silhouette + labels. Pulled out
   *  so the empty-state path can render the same backdrop. */
  private _buildAxisGrid(
    svg: SVGSVGElement,
    counts: import('@/network/Protocol').AxisSnapshot['counts'],
  ): void {
    const NS = 'http://www.w3.org/2000/svg';
    const cx = 100, cy = 100;
    const maxRadius = 70;        // 8 nodes = max
    const maxNodes  = 8;
    // Clockwise from top: phys / offense / melee / magical / defense / ranged.
    // Pairs (phys↔magical, offense↔defense, melee↔ranged) sit on opposite
    // spokes so the wheel reads as three diameters.
    const directions: Array<{
      key:   import('@/network/Protocol').AxisDirection;
      label: string;
      angle: number;  // radians, 0 = up
    }> = [
      { key: 'phys',    label: 'PHYS',    angle: -Math.PI / 2 },                  // top
      { key: 'offense', label: 'OFFENSE', angle: -Math.PI / 2 + Math.PI / 3 },     // upper-right
      { key: 'melee',   label: 'MELEE',   angle: -Math.PI / 2 + 2 * Math.PI / 3 }, // lower-right
      { key: 'magical', label: 'MAGICAL', angle:  Math.PI / 2 },                   // bottom
      { key: 'defense', label: 'DEFENSE', angle:  Math.PI / 2 + Math.PI / 3 },     // lower-left
      { key: 'ranged',  label: 'RANGED',  angle:  Math.PI / 2 + 2 * Math.PI / 3 }, // upper-left
    ];

    const at = (radius: number, angle: number): [number, number] =>
      [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];

    // Threshold rings at counts 3 / 5 / 7. The 3-ring is highlighted as
    // the "first tier" line so players can read at-a-glance whether any
    // direction has crossed the T1 threshold.
    [3, 5, 7].forEach((threshold, idx) => {
      const r = (threshold / maxNodes) * maxRadius;
      const points = directions
        .map((d) => at(r, d.angle))
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ');
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', points);
      poly.setAttribute('class', idx === 0 ? 'cs-axis-grid cs-axis-grid-3' : 'cs-axis-grid');
      svg.appendChild(poly);
    });

    // Spokes (out to max radius)
    directions.forEach((d) => {
      const [x, y] = at(maxRadius, d.angle);
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', x.toFixed(1));
      line.setAttribute('y2', y.toFixed(1));
      line.setAttribute('class', 'cs-axis-spoke');
      svg.appendChild(line);
    });

    // Filled silhouette polygon connecting per-direction counts.
    const shapePoints = directions
      .map((d) => {
        const c = counts[d.key] ?? 0;
        const r = Math.min(c, maxNodes) / maxNodes * maxRadius;
        const [x, y] = at(r, d.angle);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const shape = document.createElementNS(NS, 'polygon');
    shape.setAttribute('points', shapePoints);
    shape.setAttribute('class', 'cs-axis-shape');
    svg.appendChild(shape);

    // Labels at each spoke tip + node count.
    directions.forEach((d) => {
      const c = counts[d.key] ?? 0;
      const labelRadius = maxRadius + 16;
      const [lx, ly] = at(labelRadius, d.angle);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', lx.toFixed(1));
      label.setAttribute('y', ly.toFixed(1));
      label.setAttribute('class', 'cs-axis-label');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = d.label;
      svg.appendChild(label);

      const countLabel = document.createElementNS(NS, 'text');
      countLabel.setAttribute('x', lx.toFixed(1));
      countLabel.setAttribute('y', (ly + 11).toFixed(1));
      countLabel.setAttribute('class', 'cs-axis-count');
      countLabel.setAttribute('text-anchor', 'middle');
      countLabel.setAttribute('dominant-baseline', 'middle');
      countLabel.textContent = String(c);
      svg.appendChild(countLabel);
    });
  }

  private _escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':  return '&amp;';
        case '<':  return '&lt;';
        case '>':  return '&gt;';
        case '"':  return '&quot;';
        default:   return '&#39;';
      }
    });
  }

  private _refreshRespecButton(): void {
    const btn = this.root.querySelector<HTMLButtonElement>('#cs-respec-stats');
    if (!btn) return;
    const enabled = this.inBeaconRange();
    btn.disabled = !enabled;
    btn.title = enabled ? 'Reset all stats — free at any civic ward.'
                        : 'Out of range — stand within a civic ward (townhall, hospital, etc.) to respec.';
  }

  private _renderCoreStats(): void {
    const grid = this.root.querySelector<HTMLElement>('#cs-core-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const core    = this.player.coreStats;
    const bonuses = this.player.coreStatsBonuses;
    const hasPoints = this.player.statPoints > 0;
    const order: (keyof typeof CORE_STAT_ABBR)[] = [
      'strength', 'vitality', 'dexterity', 'agility', 'intelligence', 'wisdom',
    ];

    for (const key of order) {
      const row = document.createElement('div');
      row.className = 'cs-core-row';
      const value = core ? (core as unknown as Record<string, number>)[key] ?? 0 : 0;
      const bonus = bonuses ? (bonuses as unknown as Record<string, number>)[key] ?? 0 : 0;
      const bonusHtml = bonus > 0
        ? `<span class="cs-core-bonus" title="From passive abilities">+${bonus}</span>`
        : bonus < 0
          ? `<span class="cs-core-bonus cs-core-bonus-neg">${bonus}</span>`
          : '';
      row.innerHTML = `
        <span class="cs-core-label">
          <span class="cs-core-abbr">${CORE_STAT_ABBR[key]}</span>${key}
        </span>
        <span class="cs-core-value">${value}</span>
        ${bonusHtml}
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
    const passiveBonuses = this.player.derivedStatsBonuses ?? {};
    // Aggregate active-buff statMods so the +nn column shows passive +
    // buff in one place. Each effect carries its own (already-flat) mods
    // from the server — sum across to handle multi-buff overlap.
    const buffBonuses: Record<string, number> = {};
    for (const effect of this.player.effects) {
      if (!effect.statMods) continue;
      for (const [k, v] of Object.entries(effect.statMods)) {
        if (typeof v === 'number') {
          buffBonuses[k] = (buffBonuses[k] ?? 0) + v;
        }
      }
    }

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
        const passive = (passiveBonuses as Record<string, number>)[key] ?? 0;
        const buff    = buffBonuses[key] ?? 0;
        const total   = passive + buff;
        // Effective value for the centre column = base derived + the bonus
        // we're displaying. The server's `derivedStats` already folds in
        // passives; we add buff mods on top so the value matches the +nn.
        const baseValue = derived ? (derived[key] ?? 0) : 0;
        const value     = baseValue + buff;
        const tooltip   = buff !== 0 && passive !== 0 ? `From passives +${passive}, buffs ${buff > 0 ? '+' : ''}${buff}`
                        : buff !== 0                  ? `From active buffs`
                        :                                `From passive abilities`;
        const bonusHtml = total !== 0
          ? `<span class="cs-derived-bonus${total < 0 ? ' cs-derived-bonus-neg' : ''}" title="${tooltip}">${total > 0 ? '+' : ''}${formatStat(key, total)}</span>`
          : '';
        row.innerHTML = `
          <span class="cs-derived-label">${STAT_LABELS[key] ?? key}</span>
          <span class="cs-derived-value">${formatStat(key, value)}</span>
          ${bonusHtml}
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
