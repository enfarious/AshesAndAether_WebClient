import type { SocketClient }  from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type { CombatHitData } from '@/network/Protocol';

/**
 * DummyPanel — empirical hit-rate readout for the training dummy.
 *
 * Opened by F-key on a /dummy-spawned mob. Shows the dummy's combat stats
 * (so the user can see what they're hitting against), and renders a live
 * combat log + rolling counters filtered to events where the dummy is
 * either attacker or target — the actual "deeps info" the user wants
 * before tuning the hit-rate formula.
 *
 * /dummycfg from chat (acc=N eva=N crit=N ...) mutates the dummy in
 * place; the server re-emits open_dummy_panel and this re-renders.
 *
 * Dummy-attacks-back is a v1 follow-up — for now only the dummy's
 * incoming (player → dummy) swings populate the log. Toggling that flag
 * from the panel is wired to /dummycfg attack=on once the server-side
 * swing loop lands.
 */

interface CoreStats {
  strength: number; vitality: number; dexterity: number;
  agility: number; intelligence: number; wisdom: number;
}

interface CombatStats {
  attackRating:          number;
  defenseRating:         number;
  physicalAccuracy:      number;
  evasion:               number;
  damageAbsorption:      number;
  glancingBlowChance:    number;
  magicAttack:           number;
  magicDefense:          number;
  magicAccuracy:         number;
  magicEvasion:          number;
  magicAbsorption:       number;
  criticalHitChance:     number;
  penetratingBlowChance: number;
  deflectedBlowChance:   number;
  attackSpeedBonus:      number;
  castStability:         number;
}

export interface DummyPanelPayload {
  dummyId:     string;
  name:        string;
  level:       number;
  health:      { current: number; max: number };
  coreStats:   CoreStats;
  combatStats: CombatStats;
}

interface SwingLog {
  t:        number;
  outcome:  string;     // 'hit' | 'crit' | 'glance' | 'penetrating' | 'deflected' | 'miss'
  amount:   number;
  abilityId: string;
}

const LOG_WINDOW_MS = 30_000;
const LOG_KEEP      = 20;

export class DummyPanel {
  private root:        HTMLElement;
  private titleEl:     HTMLElement;
  private statsBoxEl:  HTMLElement;
  private countersEl:  HTMLElement;
  private logEl:       HTMLElement;
  private cleanup:     (() => void)[] = [];
  private _open      = false;
  private _dummyId   = '';
  private _swings:    SwingLog[] = [];
  /** Counter cells in DOM, keyed by outcome name. */
  private _counterCells = new Map<string, HTMLElement>();
  private _dpsCell:     HTMLElement | null = null;
  private _accCell:     HTMLElement | null = null;
  private _totalCell:   HTMLElement | null = null;
  private _avgCell:     HTMLElement | null = null;
  private _maxCell:     HTMLElement | null = null;
  private _critCell:    HTMLElement | null = null;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root       = document.createElement('div');
    this.titleEl    = document.createElement('h2');
    this.statsBoxEl = document.createElement('div');
    this.countersEl = document.createElement('div');
    this.logEl      = document.createElement('div');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    this.socket.on('open_dummy_panel', (payload: unknown) => {
      this.show(payload as DummyPanelPayload);
    });
    const unsub = this.router.onCombatOutcome((p) => this._onCombatEvent(p));
    this.cleanup.push(unsub);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._open) {
        e.preventDefault();
        this.hide();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  show(payload: DummyPanelPayload): void {
    if (payload.dummyId !== this._dummyId) {
      // Different dummy — reset the log so counters reflect this one only.
      this._swings = [];
    }
    this._dummyId = payload.dummyId;
    this._open    = true;
    this._renderStats(payload);
    this._renderCounters();
    this._renderLog();
    this.root.style.display = 'flex';
  }

  hide(): void {
    this._open    = false;
    this.root.style.display = 'none';
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build (one-time) ──────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'dummy-panel';
    const style = document.createElement('style');
    style.textContent = `
      #dummy-panel {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 850;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      #dp-box {
        background: var(--ui-bg, #1a140d);
        border: 1px solid var(--ui-border, #5a4226);
        width: clamp(540px, 64vw, 880px);
        max-height: 88vh;
        padding: 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-family: var(--font-sans, sans-serif);
        color: rgba(230,215,190,0.9);
        box-shadow: 0 0 24px rgba(0,0,0,0.6);
      }
      #dp-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: var(--ember, #ffb060);
        letter-spacing: 0.04em;
      }
      .dp-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
      .dp-stats {
        background: rgba(20, 14, 8, 0.6);
        border: 1px solid rgba(120, 90, 55, 0.35);
        padding: 10px 14px;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        line-height: 1.55;
      }
      .dp-stats h3 {
        margin: 0 0 6px;
        font-family: var(--font-display, serif);
        font-size: 13px;
        color: rgba(255,200,140,0.85);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .dp-stats .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
      .dp-stats .row .v { color: rgba(255,225,195,0.96); font-weight: 600; }

      /* Knob row — label, value, and stacked up/down chevrons that fire
       * /dummycfg <key>=<v±1>. Wide enough that mis-clicking from up to
       * down is hard but compact enough that the readout box stays readable. */
      .dp-stats .knob {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .dp-stats .knob .v {
        min-width: 28px;
        text-align: right;
      }
      .dp-stats .knob button {
        width: 18px;
        height: 14px;
        padding: 0;
        background: rgba(60, 42, 22, 0.65);
        color: rgba(255,220,180,0.85);
        border: 1px solid rgba(180,140,80,0.45);
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 9px;
        line-height: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .dp-stats .knob button:hover { background: rgba(110, 75, 35, 0.85); }
      .dp-stats .knob .knob-arrows {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .dp-counters {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
      }
      .dp-counter {
        background: rgba(20, 14, 8, 0.6);
        border: 1px solid rgba(120, 90, 55, 0.35);
        padding: 8px 6px;
        text-align: center;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.04em;
      }
      .dp-counter .v {
        display: block;
        font-size: 18px;
        color: rgba(255,225,195,0.96);
        font-weight: 600;
        margin-top: 2px;
      }
      .dp-counter.miss .v    { color: rgba(220,160,80,0.95); }
      .dp-counter.crit .v    { color: rgba(255,220,120,1); }
      .dp-counter.glance .v  { color: rgba(190,180,160,0.95); }
      .dp-counter.pen .v     { color: rgba(255,180,120,0.95); }
      .dp-counter.deflect .v { color: rgba(180,180,200,0.95); }
      .dp-summary {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
      .dp-summary > div {
        background: rgba(30, 22, 14, 0.6);
        border: 1px solid rgba(120, 90, 55, 0.3);
        padding: 8px 12px;
        display: flex;
        justify-content: space-between;
      }
      .dp-summary .v {
        color: rgba(255,225,195,1);
        font-weight: 600;
      }
      .dp-log {
        background: rgba(15, 10, 5, 0.7);
        border: 1px solid rgba(120, 90, 55, 0.3);
        padding: 6px 8px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        max-height: 240px;
        overflow-y: auto;
      }
      .dp-log .line { padding: 1px 0; }
      .dp-log .o-hit         { color: rgba(220,205,180,0.92); }
      .dp-log .o-crit        { color: rgba(255,220,120,1); font-weight: 700; }
      .dp-log .o-glance      { color: rgba(180,180,170,0.85); }
      .dp-log .o-penetrating { color: rgba(255,180,120,0.95); }
      .dp-log .o-deflected   { color: rgba(180,180,210,0.85); }
      .dp-log .o-miss        { color: rgba(220,160,80,0.7); font-style: italic; }
      .dp-hint {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(180,165,140,0.65);
        letter-spacing: 0.04em;
      }
      .dp-footer {
        display: flex;
        justify-content: flex-end;
        padding-top: 6px;
        border-top: 1px solid rgba(120, 90, 55, 0.25);
      }
      .dp-footer button {
        background: transparent;
        border: 1px solid rgba(180,140,90,0.4);
        color: rgba(220,205,180,0.85);
        padding: 5px 14px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .dp-footer button:hover { background: rgba(100, 75, 50, 0.4); }
    `;
    this.root.appendChild(style);

    const box = document.createElement('div');
    box.id = 'dp-box';

    this.titleEl.textContent = 'Training Dummy';
    box.appendChild(this.titleEl);

    box.appendChild(this.statsBoxEl);
    box.appendChild(this.countersEl);

    const hint = document.createElement('div');
    hint.className = 'dp-hint';
    hint.textContent = 'Tweak with /dummycfg acc=N eva=N crit=N pen=N glance=N deflect=N. ' +
                       'Counters cover the rolling 30s window.';
    box.appendChild(hint);

    box.appendChild(this.logEl);
    this.logEl.className = 'dp-log';

    const footer = document.createElement('div');
    footer.className = 'dp-footer';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    footer.appendChild(closeBtn);
    box.appendChild(footer);

    this.root.appendChild(box);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private _renderStats(p: DummyPanelPayload): void {
    this.titleEl.textContent = `${p.name}  —  L${p.level}  —  ${p.health.current}/${p.health.max} HP`;
    this.statsBoxEl.innerHTML = '';
    this.statsBoxEl.className = 'dp-row';

    // ── Combat stats (read-only readout) ──────────────────────────────
    const dummyBox = document.createElement('div');
    dummyBox.className = 'dp-stats';
    const h1 = document.createElement('h3');
    h1.textContent = 'Dummy Combat Stats';
    dummyBox.appendChild(h1);
    const rows: Array<[string, number]> = [
      ['Phys Accuracy',  p.combatStats.physicalAccuracy],
      ['Evasion',        p.combatStats.evasion],
      ['Magic Accuracy', p.combatStats.magicAccuracy],
      ['Magic Evasion',  p.combatStats.magicEvasion],
      ['Crit %',         p.combatStats.criticalHitChance],
      ['Penetrating %',  p.combatStats.penetratingBlowChance],
      ['Glancing %',     p.combatStats.glancingBlowChance],
      ['Deflected %',    p.combatStats.deflectedBlowChance],
      ['Atk Speed Δ',    p.combatStats.attackSpeedBonus],
      ['Cast Stab',      p.combatStats.castStability],
    ];
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = `<span>${k}</span><span class="v">${v}</span>`;
      dummyBox.appendChild(r);
    }

    // ── Core stats + level (interactive knobs) ────────────────────────
    const coreBox = document.createElement('div');
    coreBox.className = 'dp-stats';
    const h2 = document.createElement('h3');
    h2.textContent = 'Core Stats — knobs';
    coreBox.appendChild(h2);

    coreBox.appendChild(this._buildKnobRow('LVL', p.level,                 'lvl', 1));
    coreBox.appendChild(this._buildKnobRow('STR', p.coreStats.strength,    'str', 1));
    coreBox.appendChild(this._buildKnobRow('VIT', p.coreStats.vitality,    'vit', 1));
    coreBox.appendChild(this._buildKnobRow('DEX', p.coreStats.dexterity,   'dex', 1));
    coreBox.appendChild(this._buildKnobRow('AGI', p.coreStats.agility,     'agi', 1));
    coreBox.appendChild(this._buildKnobRow('INT', p.coreStats.intelligence, 'int', 1));
    coreBox.appendChild(this._buildKnobRow('WIS', p.coreStats.wisdom,      'wis', 1));

    this.statsBoxEl.appendChild(dummyBox);
    this.statsBoxEl.appendChild(coreBox);
  }

  /** Build a label / value / up-down-chevron row. Clicks fire /dummycfg
   *  <key>=<currentValue ± step>. Min-clamped at 1 (matches server). */
  private _buildKnobRow(label: string, current: number, key: string, step: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row knob';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    row.appendChild(lbl);

    const wrap = document.createElement('span');
    wrap.style.display    = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap        = '6px';

    const v = document.createElement('span');
    v.className   = 'v';
    v.textContent = String(current);
    wrap.appendChild(v);

    const arrows = document.createElement('span');
    arrows.className = 'knob-arrows';
    const up = document.createElement('button');
    up.textContent = '▲';
    up.title       = `${label} +${step}`;
    up.addEventListener('click', () => {
      this.socket.sendCommand(`/dummycfg ${key}=${Math.max(1, current + step)}`);
    });
    const down = document.createElement('button');
    down.textContent = '▼';
    down.title       = `${label} -${step}`;
    down.addEventListener('click', () => {
      this.socket.sendCommand(`/dummycfg ${key}=${Math.max(1, current - step)}`);
    });
    arrows.appendChild(up);
    arrows.appendChild(down);
    wrap.appendChild(arrows);

    row.appendChild(wrap);
    return row;
  }

  private _renderCounters(): void {
    this.countersEl.innerHTML = '';
    this._counterCells.clear();

    const grid = document.createElement('div');
    grid.className = 'dp-counters';
    const buckets: Array<[string, string]> = [
      ['hit',         'Hits'],
      ['crit',        'Crits'],
      ['pen',         'Penetrating'],
      ['glance',      'Glancing'],
      ['deflect',     'Deflected'],
      ['miss',        'Misses'],
    ];
    for (const [key, label] of buckets) {
      const cell = document.createElement('div');
      cell.className = `dp-counter ${key}`;
      cell.innerHTML = `<div>${label}</div><span class="v">0</span>`;
      grid.appendChild(cell);
      this._counterCells.set(key, cell.querySelector('.v') as HTMLElement);
    }
    this.countersEl.appendChild(grid);

    const summary = document.createElement('div');
    summary.className = 'dp-summary';
    const dpsRow   = document.createElement('div');
    dpsRow.innerHTML   = `<span>Rolling DPS</span><span class="v">0.0</span>`;
    const accRow   = document.createElement('div');
    accRow.innerHTML   = `<span>Connect %</span><span class="v">0%</span>`;
    const critRow  = document.createElement('div');
    critRow.innerHTML  = `<span>Crit % (of connects)</span><span class="v">0%</span>`;
    const totalRow = document.createElement('div');
    totalRow.innerHTML = `<span>Total dmg (window)</span><span class="v">0</span>`;
    const avgRow   = document.createElement('div');
    avgRow.innerHTML   = `<span>Avg dmg / connect</span><span class="v">0</span>`;
    const maxRow   = document.createElement('div');
    maxRow.innerHTML   = `<span>Biggest hit</span><span class="v">0</span>`;
    summary.appendChild(dpsRow);
    summary.appendChild(accRow);
    summary.appendChild(critRow);
    summary.appendChild(totalRow);
    summary.appendChild(avgRow);
    summary.appendChild(maxRow);
    this.countersEl.appendChild(summary);

    this._dpsCell   = dpsRow.querySelector('.v');
    this._accCell   = accRow.querySelector('.v');
    this._critCell  = critRow.querySelector('.v');
    this._totalCell = totalRow.querySelector('.v');
    this._avgCell   = avgRow.querySelector('.v');
    this._maxCell   = maxRow.querySelector('.v');
  }

  private _renderLog(): void {
    this.logEl.innerHTML = '';
    const recent = this._swings.slice(-LOG_KEEP).reverse();
    for (const s of recent) {
      const div = document.createElement('div');
      const outcomeClass = `o-${s.outcome}`;
      div.className = `line ${outcomeClass}`;
      const ts = new Date(s.t).toLocaleTimeString();
      const ability = s.abilityId.replace(/^ability\//, '').replace(/_/g, ' ');
      const tag = s.outcome === 'miss' ? 'MISS' : s.outcome.toUpperCase();
      div.textContent = `[${ts}] ${ability.padEnd(20)} → ${tag.padEnd(11)} ${s.amount > 0 ? s.amount : ''}`;
      this.logEl.appendChild(div);
    }
  }

  // ── Combat event subscription ─────────────────────────────────────────────

  private _onCombatEvent(p: CombatHitData): void {
    if (!this._open) return;
    if (p.targetId !== this._dummyId) return; // only player → dummy for v0

    const outcome = (p as { outcome?: string }).outcome ?? 'hit';
    // Server miss event has no `outcome`; CombatHitData defaults outcome
    // to 'hit'. Detect the miss case by zero amount + miss-flagged ability
    // path: the router synthesises an outcome of 'miss' for combat_miss.
    const isMiss = outcome === 'miss';

    this._swings.push({
      t:         Date.now(),
      outcome,
      amount:    isMiss ? 0 : p.amount,
      abilityId: p.abilityId,
    });
    this._trimWindow();
    this._refreshCountersOnly();
    this._renderLog();
  }

  /** Drop entries older than LOG_WINDOW_MS so rolling DPS / counters
   *  reflect only the recent window. */
  private _trimWindow(): void {
    const cutoff = Date.now() - LOG_WINDOW_MS;
    while (this._swings.length > 0 && this._swings[0]!.t < cutoff) {
      this._swings.shift();
    }
  }

  private _refreshCountersOnly(): void {
    const counts = {
      hit: 0, crit: 0, pen: 0, glance: 0, deflect: 0, miss: 0,
    };
    let totalDmg = 0;
    let maxHit   = 0;
    for (const s of this._swings) {
      switch (s.outcome) {
        case 'crit':        counts.crit++;    break;
        case 'penetrating': counts.pen++;     break;
        case 'glance':      counts.glance++;  break;
        case 'deflected':   counts.deflect++; break;
        case 'miss':        counts.miss++;    break;
        default:            counts.hit++;     break;
      }
      totalDmg += s.amount;
      if (s.amount > maxHit) maxHit = s.amount;
    }
    for (const [key, cell] of this._counterCells) {
      cell.textContent = String(counts[key as keyof typeof counts] ?? 0);
    }
    const windowSec = Math.max(1, Math.min(LOG_WINDOW_MS / 1000,
      this._swings.length > 0 ? (Date.now() - this._swings[0]!.t) / 1000 : 1));
    const total    = this._swings.length;
    const connects = total - counts.miss;

    if (this._dpsCell)   this._dpsCell.textContent   = (totalDmg / windowSec).toFixed(1);
    if (this._accCell)   this._accCell.textContent   = total    > 0 ? `${(((total - counts.miss) / total) * 100).toFixed(0)}%` : '0%';
    if (this._critCell)  this._critCell.textContent  = connects > 0 ? `${((counts.crit / connects) * 100).toFixed(0)}%`        : '0%';
    if (this._totalCell) this._totalCell.textContent = String(totalDmg);
    if (this._avgCell)   this._avgCell.textContent   = connects > 0 ? (totalDmg / connects).toFixed(1) : '0';
    if (this._maxCell)   this._maxCell.textContent   = String(maxHit);
  }
}
