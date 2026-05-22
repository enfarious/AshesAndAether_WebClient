import type { SocketClient } from '@/network/SocketClient';
import type { VaultCompletePayload, VaultSummaryPayload } from '@/network/Protocol';

/**
 * InstanceResultsWindow — the deliberate-leave surface for a cleared vault.
 *
 * Vault completion is a loot + gold result, not a boss-fight scoreboard, so
 * it gets its own window rather than the PostFightScoreboardModal. Like the
 * scoreboard's instanced mode, this window is:
 *   - persistent — stays up until the player chooses to leave (or the
 *     server's 3-minute auto-leave backstop pulls them out),
 *   - non-blocking — no full-screen backdrop; only the panel itself is
 *     interactive, so the player can see + walk around the cleared vault,
 *   - non-dismissible — no Close / X, and it does NOT consume Esc. The only
 *     way out is the single "Leave" button → `/vault leave`.
 *
 * Row styling is borrowed from PostFightScoreboardModal for visual
 * consistency across the two instanced result surfaces.
 */

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000)    return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000)      return `${(n / 1000).toFixed(2)}K`;
  return Math.round(n).toString();
}

function fmtDurationSec(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r.toString().padStart(2, '0')}s`;
}

export class InstanceResultsWindow {
  private root:    HTMLElement;
  private titleEl: HTMLElement;
  private subEl:   HTMLElement;
  private bodyEl:  HTMLElement;
  private _open    = false;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root    = document.createElement('div');
    this.titleEl = document.createElement('h2');
    this.subEl   = document.createElement('div');
    this.bodyEl  = document.createElement('div');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);
  }

  /** Open the window for a completed vault. */
  show(payload: VaultCompletePayload): void {
    this._open = true;
    this._render(payload);
    this.root.style.display = 'flex';
  }

  /** Hide the window — called when the player leaves (the zone transfer
   *  lands them back in the overworld). Not bound to Esc / any close
   *  affordance: leaving is deliberate (the Leave button) only. */
  hide(): void {
    this._open = false;
    this.root.style.display = 'none';
  }

  get isVisible(): boolean { return this._open; }

  dispose(): void {
    this.root.remove();
  }

  private _build(): void {
    this.root.id = 'instance-results';
    const style = document.createElement('style');
    style.textContent = `
      /* Non-blocking: no full-screen backdrop, clicks fall through to the
         world. Only the panel box is interactive. */
      #instance-results {
        position: fixed;
        inset: 0;
        background: transparent;
        z-index: 855;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      #ir-box {
        background: var(--ui-bg, #1a140d);
        border: 1px solid var(--ui-border, #5a4226);
        width: clamp(480px, 52vw, 720px);
        max-height: 80vh;
        padding: 22px 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 0 28px rgba(0,0,0,0.7);
        pointer-events: auto;
      }
      #ir-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: var(--ember, #ffb060);
        letter-spacing: 0.04em;
      }
      #ir-box .ir-sub {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(220,205,180,0.7);
        letter-spacing: 0.04em;
      }
      #ir-box .ir-gold {
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        color: #ffe6a8;
        letter-spacing: 0.04em;
      }
      .ir-body {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-right: 4px;
      }
      /* Row styling mirrors PostFightScoreboardModal's .fs-row for a
         consistent look across the two instanced result surfaces. */
      .ir-row {
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
      .ir-row::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        background: rgba(255,170,80,0.10);
        width: var(--bar, 0%);
        z-index: 0;
        transition: width 200ms ease;
      }
      .ir-row > * { position: relative; z-index: 1; }
      .ir-row.rank-1::before { background: rgba(255,170,80,0.22); }
      .ir-row.rank-2::before { background: rgba(255,170,80,0.16); }
      .ir-row.rank-3::before { background: rgba(255,170,80,0.12); }
      .ir-rank {
        color: rgba(255,200,140,0.85);
        text-align: right;
      }
      .ir-name {
        color: rgba(255,225,195,0.96);
        letter-spacing: 0.02em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ir-total {
        color: rgba(255,225,195,0.96);
        min-width: 80px;
        text-align: right;
      }
      .ir-rate {
        color: rgba(200,185,160,0.78);
        min-width: 90px;
        text-align: right;
        font-size: 11px;
      }
      .ir-empty {
        padding: 24px;
        text-align: center;
        color: rgba(200,185,160,0.55);
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.04em;
      }
      .ir-footer {
        display: flex;
        justify-content: flex-end;
        padding-top: 8px;
        border-top: 1px solid rgba(120, 90, 55, 0.3);
      }
      .ir-footer button {
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
      .ir-footer button:hover {
        background: rgba(160, 105, 50, 0.85);
      }
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'ir-box';

    box.appendChild(this.titleEl);
    this.subEl.className = 'ir-sub';
    box.appendChild(this.subEl);

    this.bodyEl.className = 'ir-body';
    box.appendChild(this.bodyEl);

    const footer = document.createElement('div');
    footer.className = 'ir-footer';
    const leaveBtn = document.createElement('button');
    leaveBtn.textContent = 'Leave';
    leaveBtn.addEventListener('click', () => {
      this.socket.sendCommand('/vault leave');
    });
    footer.appendChild(leaveBtn);
    box.appendChild(footer);

    this.root.appendChild(box);
  }

  private _render(payload: VaultCompletePayload): void {
    const summary: VaultSummaryPayload | undefined = payload.summary;

    this.titleEl.textContent = summary
      ? `${summary.vaultName} — Cleared`
      : 'Vault Cleared';

    const subParts: string[] = [];
    if (summary) {
      subParts.push(fmtDurationSec(summary.duration));
      subParts.push(`${summary.roomsCleared}/${summary.totalRooms} rooms`);
    }
    if (payload.goldAwarded > 0) {
      subParts.push(`+${payload.goldAwarded.toLocaleString()} gold each`);
    }
    this.subEl.textContent = subParts.join('  ·  ');

    // Per-participant damage rows — sorted high → low, ranked bars like the
    // post-fight scoreboard.
    this.bodyEl.innerHTML = '';
    const participants = (summary?.participants ?? [])
      .slice()
      .sort((a, b) => b.damageDealt - a.damageDealt);

    if (participants.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ir-empty';
      empty.textContent = 'No combat recorded.';
      this.bodyEl.appendChild(empty);
      return;
    }

    const max = participants[0]?.damageDealt ?? 1;
    participants.forEach((part, i) => {
      const row = document.createElement('div');
      row.className = `ir-row${i < 3 ? ` rank-${i + 1}` : ''}`;
      const barPct = max > 0 ? Math.min(100, (part.damageDealt / max) * 100) : 0;
      row.style.setProperty('--bar', `${barPct}%`);

      const rank = document.createElement('div');
      rank.className = 'ir-rank';
      rank.textContent = `${i + 1}.`;
      row.appendChild(rank);

      const name = document.createElement('div');
      name.className = 'ir-name';
      name.textContent = part.name;
      row.appendChild(name);

      const total = document.createElement('div');
      total.className = 'ir-total';
      total.textContent = fmtNum(part.damageDealt);
      row.appendChild(total);

      const rate = document.createElement('div');
      rate.className = 'ir-rate';
      rate.textContent = `${part.hitsLanded} hit${part.hitsLanded === 1 ? '' : 's'}`;
      row.appendChild(rate);

      this.bodyEl.appendChild(row);
    });
  }
}
