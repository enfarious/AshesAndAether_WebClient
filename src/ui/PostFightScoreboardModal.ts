import type { SocketClient } from '@/network/SocketClient';
import type { FightResultPayload } from '@/network/Protocol';

/**
 * PostFightScoreboardModal — opened on `open_fight_scoreboard` after any
 * boss (zone / region / world) resolves. Tabs for DPS / HPS / Tank /
 * Debuffs surface the per-participant contribution.
 *
 * Two modes, picked off `payload.instanced`:
 *   - Overworld zone boss (instanced absent/false): dismissible. Single
 *     "Return to World" button; Esc + backdrop click also close. The modal
 *     is purely informational ("stuff for nerds" per 2026-05-20).
 *   - Instanced encounter (deep dungeon, region/world arena — instanced
 *     true): the scoreboard IS the deliberate leave surface. The button
 *     becomes "Leave" and sends `payload.leaveCommand`; Esc + backdrop
 *     close are suppressed; the modal is non-blocking (the player can see
 *     and click the world behind it) but cannot be dismissed.
 *
 * Reward distribution is server-side and decoupled from this modal —
 * leaving doesn't affect what was already granted.
 */

export type { FightResultPayload };

type TabKey = 'dps' | 'hps' | 'tank' | 'debuffs';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'dps',     label: 'Damage'  },
  { key: 'hps',     label: 'Healing' },
  { key: 'tank',    label: 'Tanking' },
  { key: 'debuffs', label: 'Debuffs' },
];

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000)    return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000)      return `${(n / 1000).toFixed(2)}K`;
  return Math.round(n).toString();
}

function fmtRate(total: number, durationMs: number): string {
  if (durationMs <= 0) return '0';
  return fmtNum(total / (durationMs / 1000));
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r.toString().padStart(2, '0')}s`;
}

export class PostFightScoreboardModal {
  private root:      HTMLElement;
  private titleEl:   HTMLElement;
  private subEl:     HTMLElement;
  private tabsEl:    HTMLElement;
  private bodyEl:    HTMLElement;
  private actionBtn: HTMLButtonElement;
  private cleanup:   (() => void)[] = [];
  private _open     = false;
  private activeTab: TabKey = 'dps';
  private payload:   FightResultPayload | null = null;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root      = document.createElement('div');
    this.titleEl   = document.createElement('h2');
    this.subEl     = document.createElement('div');
    this.tabsEl    = document.createElement('div');
    this.bodyEl    = document.createElement('div');
    this.actionBtn = document.createElement('button');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    this.socket.on('open_fight_scoreboard', (payload: unknown) => {
      this.show(payload as FightResultPayload);
    });

    const onKey = (e: KeyboardEvent) => {
      // Esc only closes in the dismissible (non-instanced) overworld-boss
      // mode. Instanced encounters are non-dismissible — the player leaves
      // deliberately via the Leave button.
      if (e.key === 'Escape' && this._open && !this._instanced) {
        e.preventDefault();
        this.hide();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  /** True when the currently-shown result is an instanced encounter. */
  private get _instanced(): boolean {
    return !!this.payload?.instanced;
  }

  show(payload: FightResultPayload): void {
    this.payload   = payload;
    this.activeTab = 'dps';
    this._open     = true;
    this._render();
    this.root.style.display = 'flex';
  }

  hide(): void {
    // In instanced mode the modal is non-dismissible — guard against
    // ModalStack.closeTop() (gamepad menu button) duck-typing this away.
    // The only way out of an instanced encounter is the Leave button.
    if (this._instanced) return;
    this._open = false;
    this.root.style.display = 'none';
  }

  /** Force the modal closed regardless of mode. Used on world_entry —
   *  after an instanced Leave the zone transfer lands the player in the
   *  overworld, at which point the (now stale) scoreboard must come down
   *  even though `hide()` would otherwise refuse in instanced mode. */
  forceHide(): void {
    this._open = false;
    this.root.style.display = 'none';
    this.payload = null;
  }

  /** ModalStack contract. Instanced mode reports NOT visible on purpose:
   *  the instanced scoreboard is non-blocking (clicks fall through, the
   *  player walks around) and non-dismissible — it must not gate gamepad
   *  input via `ModalStack.anyOpen`, nor be picked by `closeTop()`. The
   *  dismissible overworld-boss mode reports visibility normally. */
  get isVisible(): boolean { return this._open && !this._instanced; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  private _build(): void {
    this.root.id = 'fight-scoreboard';
    const style = document.createElement('style');
    style.textContent = `
      #fight-scoreboard {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.7);
        z-index: 860;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      /* Instanced mode: non-blocking. Drop the dark overlay and let clicks
         fall through to the world — only the inner box is interactive — so
         the player can see + walk around while the (non-dismissible)
         scoreboard stays up. */
      #fight-scoreboard.fs-instanced {
        background: transparent;
        pointer-events: none;
      }
      #fight-scoreboard.fs-instanced #fs-box {
        pointer-events: auto;
      }
      #fs-box {
        background: var(--ui-bg, #1a140d);
        border: 1px solid var(--ui-border, #5a4226);
        width: clamp(520px, 60vw, 820px);
        max-height: 86vh;
        padding: 22px 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 0 28px rgba(0,0,0,0.7);
      }
      #fs-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: var(--ember, #ffb060);
        letter-spacing: 0.04em;
      }
      #fs-box .fs-sub {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(220,205,180,0.7);
        letter-spacing: 0.04em;
      }
      #fs-box.outcome-wipe h2 { color: #d97070; }
      .fs-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid rgba(120, 90, 55, 0.4);
      }
      .fs-tab {
        padding: 8px 16px;
        background: transparent;
        color: rgba(200,185,160,0.65);
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        transition: color 120ms ease, border-color 120ms ease;
      }
      .fs-tab:hover { color: rgba(255,225,195,0.9); }
      .fs-tab.active {
        color: var(--ember, #ffb060);
        border-bottom-color: var(--ember, #ffb060);
      }
      .fs-body {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-right: 4px;
      }
      .fs-row {
        display: grid;
        grid-template-columns: 28px 1fr auto auto;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        background: rgba(30, 22, 14, 0.55);
        border: 1px solid rgba(120, 90, 55, 0.25);
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(225,210,185,0.92);
        position: relative;
        overflow: hidden;
      }
      .fs-row::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        background: rgba(255,170,80,0.10);
        width: var(--bar, 0%);
        z-index: 0;
        transition: width 200ms ease;
      }
      .fs-row > * { position: relative; z-index: 1; }
      .fs-row.rank-1::before { background: rgba(255,170,80,0.22); }
      .fs-row.rank-2::before { background: rgba(255,170,80,0.16); }
      .fs-row.rank-3::before { background: rgba(255,170,80,0.12); }
      .fs-rank {
        color: rgba(255,200,140,0.85);
        text-align: right;
      }
      .fs-name {
        color: rgba(255,225,195,0.96);
        letter-spacing: 0.02em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fs-total {
        color: rgba(255,225,195,0.96);
        min-width: 80px;
        text-align: right;
      }
      .fs-rate {
        color: rgba(200,185,160,0.78);
        min-width: 90px;
        text-align: right;
        font-size: 11px;
      }
      .fs-empty {
        padding: 24px;
        text-align: center;
        color: rgba(200,185,160,0.55);
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.04em;
      }
      .fs-footer {
        display: flex;
        justify-content: flex-end;
        padding-top: 8px;
        border-top: 1px solid rgba(120, 90, 55, 0.3);
      }
      .fs-footer button {
        background: rgba(120, 80, 38, 0.7);
        color: rgba(255,235,210,0.95);
        border: 1px solid rgba(200,150,80,0.6);
        padding: 8px 22px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .fs-footer button:hover {
        background: rgba(160, 105, 50, 0.85);
      }
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'fs-box';

    box.appendChild(this.titleEl);
    this.subEl.className = 'fs-sub';
    box.appendChild(this.subEl);

    this.tabsEl.className = 'fs-tabs';
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = 'fs-tab';
      btn.dataset.tab = tab.key;
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        this.activeTab = tab.key;
        this._render();
      });
      this.tabsEl.appendChild(btn);
    }
    box.appendChild(this.tabsEl);

    this.bodyEl.className = 'fs-body';
    box.appendChild(this.bodyEl);

    const footer = document.createElement('div');
    footer.className = 'fs-footer';
    this.actionBtn.addEventListener('click', () => this._onActionButton());
    footer.appendChild(this.actionBtn);
    box.appendChild(footer);

    // Click outside the box (on the backdrop) closes — but ONLY in the
    // dismissible overworld-boss mode. Instanced encounters are
    // non-dismissible (and the backdrop is pointer-events:none anyway).
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root && !this._instanced) this.hide();
    });

    this.root.appendChild(box);
  }

  /** Footer button click. Dismissible mode → close the modal. Instanced
   *  mode → fire the server leave command (the modal stays up until the
   *  zone transfer pulls the player out). */
  private _onActionButton(): void {
    const p = this.payload;
    if (p?.instanced && p.leaveCommand) {
      this.socket.sendCommand(p.leaveCommand);
      return;
    }
    this.hide();
  }

  private _render(): void {
    const p = this.payload;
    const box = this.root.querySelector('#fs-box') as HTMLElement | null;
    if (!p || !box) return;

    box.classList.toggle('outcome-wipe', p.outcome === 'wipe');
    // Instanced encounters get the non-blocking, non-dismissible treatment
    // (no dark overlay, click-through backdrop) + a "Leave" action button.
    this.root.classList.toggle('fs-instanced', !!p.instanced);
    this.actionBtn.textContent = p.instanced ? 'Leave' : 'Return to World';

    const tierLabel = p.bossTier === 'world' ? 'WORLD BOSS'
                    : p.bossTier === 'region' ? 'REGION BOSS' : 'ZONE BOSS';
    this.titleEl.textContent = p.outcome === 'victory'
      ? `${p.bossName} — Felled`
      : `${p.bossName} — Stood`;
    this.subEl.textContent = `${tierLabel}  ·  ${fmtDuration(p.durationMs)}  ·  ${p.participants.length} contributor${p.participants.length === 1 ? '' : 's'}`;

    // Tab highlight
    for (const btn of Array.from(this.tabsEl.children) as HTMLButtonElement[]) {
      btn.classList.toggle('active', btn.dataset.tab === this.activeTab);
    }

    // Body rows for the active tab
    this.bodyEl.innerHTML = '';
    const rows = this._rowsForTab(p, this.activeTab);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fs-empty';
      empty.textContent = this._emptyMessageForTab(this.activeTab);
      this.bodyEl.appendChild(empty);
      return;
    }
    const max = rows[0]?.value ?? 1;
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `fs-row${i < 3 ? ` rank-${i + 1}` : ''}`;
      const barPct = max > 0 ? Math.min(100, (r.value / max) * 100) : 0;
      row.style.setProperty('--bar', `${barPct}%`);

      const rank = document.createElement('div');
      rank.className = 'fs-rank';
      rank.textContent = `${i + 1}.`;
      row.appendChild(rank);

      const name = document.createElement('div');
      name.className = 'fs-name';
      name.textContent = r.name;
      row.appendChild(name);

      const total = document.createElement('div');
      total.className = 'fs-total';
      total.textContent = r.totalLabel;
      row.appendChild(total);

      const rate = document.createElement('div');
      rate.className = 'fs-rate';
      rate.textContent = r.rateLabel;
      row.appendChild(rate);

      this.bodyEl.appendChild(row);
    });
  }

  private _rowsForTab(
    p: FightResultPayload,
    tab: TabKey,
  ): Array<{ name: string; value: number; totalLabel: string; rateLabel: string }> {
    const out: Array<{ name: string; value: number; totalLabel: string; rateLabel: string }> = [];
    for (const part of p.participants) {
      const s = part.stats;
      let value = 0;
      let totalLabel = '0';
      let rateLabel  = '';
      switch (tab) {
        case 'dps':
          value = s.damageDealt;
          totalLabel = fmtNum(s.damageDealt);
          rateLabel  = `${fmtRate(s.damageDealt, p.durationMs)} dps`;
          break;
        case 'hps':
          value = s.healingDone;
          totalLabel = fmtNum(s.healingDone);
          rateLabel  = `${fmtRate(s.healingDone, p.durationMs)} hps`;
          break;
        case 'tank':
          value = s.damageTaken;
          totalLabel = fmtNum(s.damageTaken);
          rateLabel  = `${fmtRate(s.damageTaken, p.durationMs)} dtps`;
          break;
        case 'debuffs':
          value = s.debuffSecondsTotal;
          totalLabel = `${s.debuffSecondsTotal.toFixed(1)}s`;
          rateLabel  = `${s.debuffsApplied} cast${s.debuffsApplied === 1 ? '' : 's'}`;
          break;
      }
      if (value > 0) out.push({ name: part.characterName, value, totalLabel, rateLabel });
    }
    out.sort((a, b) => b.value - a.value);
    return out;
  }

  private _emptyMessageForTab(tab: TabKey): string {
    switch (tab) {
      case 'dps':     return 'No damage dealt.';
      case 'hps':     return 'No healing landed.';
      case 'tank':    return 'No damage absorbed.';
      case 'debuffs': return 'No debuffs applied.';
    }
  }
}
