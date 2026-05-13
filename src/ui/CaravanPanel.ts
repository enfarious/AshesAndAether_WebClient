import type { SocketClient } from '@/network/SocketClient';

/**
 * CaravanPanel — modal destination picker for in-zone caravan terminals.
 *
 * Opened by the server (`open_caravan_panel`) when the player F-keys a
 * caravan terminal. Lists every other terminal in the zone with its
 * straight-line distance + computed coin cost. "Hail" on a row books
 * the ride via `/caravan <terminalId>`.
 *
 * v0 displays cost only — server does not deduct coins yet (wallet
 * plumbing into world_entry is its own ticket). Buttons still fire and
 * the server-side handler will eventually start the ride; until Phase
 * C lands, the server acks the booking with a chat-style notice and
 * the panel closes.
 */

export interface CaravanDestination {
  id:        string;
  name:      string;
  /** Straight-line distance in metres from the origin terminal. */
  distance:  number;
  /** Display cost in coins. */
  costCoins: number;
}

export interface CaravanPanelPayload {
  fromTerminalId:   string;
  fromTerminalName: string;
  destinations:     CaravanDestination[];
}

export class CaravanPanel {
  private root:    HTMLElement;
  private bodyEl:  HTMLElement;
  private titleEl: HTMLElement;
  private subEl:   HTMLElement;
  private cleanup: (() => void)[] = [];
  private _open = false;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root    = document.createElement('div');
    this.bodyEl  = document.createElement('div');
    this.titleEl = document.createElement('h2');
    this.subEl   = document.createElement('div');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    this.socket.on('open_caravan_panel', (payload: unknown) => {
      this.show(payload as CaravanPanelPayload);
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this._open) {
        e.preventDefault();
        this.hide();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  show(payload: CaravanPanelPayload): void {
    this._open = true;
    this._render(payload);
    this.root.style.display = 'flex';
  }

  hide(): void {
    this._open = false;
    this.root.style.display = 'none';
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build (one-time) ────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'caravan-panel';
    const style = document.createElement('style');
    style.textContent = `
      #caravan-panel {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 850;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      #cp-box {
        background: var(--ui-bg, #0e1622);
        border: 1px solid #2d4860;
        width: clamp(420px, 50vw, 640px);
        max-height: 78vh;
        padding: 22px 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        box-shadow: 0 0 24px rgba(0,0,0,0.6);
      }
      #cp-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: #6fc6f0;
        letter-spacing: 0.04em;
      }
      #cp-box .cp-sub {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(200,220,235,0.7);
        letter-spacing: 0.04em;
      }
      .cp-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 58vh;
        overflow-y: auto;
      }
      .cp-row {
        display: grid;
        grid-template-columns: 1fr 90px 90px 100px;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        background: rgba(18, 30, 44, 0.65);
        border: 1px solid rgba(70, 110, 150, 0.35);
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        color: rgba(220,235,245,0.92);
      }
      .cp-row-name {
        font-weight: 600;
        letter-spacing: 0.02em;
        color: rgba(230,240,250,0.98);
      }
      .cp-row-dist,
      .cp-row-cost {
        text-align: right;
        color: rgba(180,210,230,0.85);
      }
      .cp-row-cost::after {
        content: ' c';
        opacity: 0.6;
      }
      .cp-row button {
        background: rgba(45, 90, 130, 0.6);
        color: rgba(225,240,250,0.96);
        border: 1px solid rgba(100, 160, 200, 0.55);
        padding: 5px 12px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .cp-row button:hover {
        background: rgba(70, 130, 180, 0.75);
      }
      .cp-empty {
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        color: rgba(180,200,220,0.7);
        padding: 18px 0;
        text-align: center;
      }
      #cp-close {
        align-self: flex-end;
        background: transparent;
        color: rgba(200,220,235,0.7);
        border: 1px solid rgba(100, 130, 160, 0.4);
        padding: 4px 12px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      #cp-close:hover {
        color: rgba(230,240,250,0.95);
        border-color: rgba(140, 170, 200, 0.6);
      }
    `;
    this.root.appendChild(style);

    const box = document.createElement('div');
    box.id = 'cp-box';
    this.titleEl.textContent = 'Hail a Caravan';
    this.subEl.className     = 'cp-sub';
    this.bodyEl.className    = 'cp-list';

    const close = document.createElement('button');
    close.id = 'cp-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.hide());

    box.appendChild(this.titleEl);
    box.appendChild(this.subEl);
    box.appendChild(this.bodyEl);
    box.appendChild(close);
    this.root.appendChild(box);
  }

  // ── Render (re-runs on each open / refresh) ─────────────────────────────

  private _render(p: CaravanPanelPayload): void {
    this.titleEl.textContent = `Hail a Caravan — ${p.fromTerminalName}`;
    this.subEl.textContent   = p.destinations.length === 0
      ? 'No other terminals in this zone.'
      : `${p.destinations.length} destination${p.destinations.length === 1 ? '' : 's'}. Cost shown is the future fare — coins are NOT deducted yet.`;

    this.bodyEl.innerHTML = '';
    if (p.destinations.length === 0) {
      const empty = document.createElement('div');
      empty.className   = 'cp-empty';
      empty.textContent = 'Nothing to hail to from here.';
      this.bodyEl.appendChild(empty);
      return;
    }

    for (const d of p.destinations) {
      const row = document.createElement('div');
      row.className = 'cp-row';

      const name = document.createElement('div');
      name.className   = 'cp-row-name';
      name.textContent = d.name;

      const dist = document.createElement('div');
      dist.className   = 'cp-row-dist';
      dist.textContent = d.distance >= 1000
        ? `${(d.distance / 1000).toFixed(2)} km`
        : `${Math.round(d.distance)} m`;

      const cost = document.createElement('div');
      cost.className   = 'cp-row-cost';
      cost.textContent = String(d.costCoins);

      const btn = document.createElement('button');
      btn.textContent = 'Hail';
      btn.addEventListener('click', () => {
        this.socket.sendCommand(`/caravan ${d.id}`);
        this.hide();
      });

      row.appendChild(name);
      row.appendChild(dist);
      row.appendChild(cost);
      row.appendChild(btn);
      this.bodyEl.appendChild(row);
    }
  }
}
