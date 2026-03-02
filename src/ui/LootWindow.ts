import type { SocketClient } from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type {
  LootSessionStartPayload,
  LootItemResultPayload,
  LootSessionEndPayload,
  LootSessionItem,
} from '@/network/Protocol';

interface ActiveSession {
  payload:   LootSessionStartPayload;
  panel:     HTMLElement;
  voted:     Set<string>;          // itemIds the player has voted on
  results:   LootItemResultPayload[];
  dismissed: boolean;
}

/**
 * LootWindow — displays loot results.
 *
 * Solo:  auto-dismiss toast (5 s after session_end).
 * Party: NWP panel with countdown, per-item vote buttons, live results.
 */
export class LootWindow {
  private root:     HTMLElement;
  private sessions = new Map<string, ActiveSession>();
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);

    this.cleanup.push(
      router.onLootSessionStart(p => this._onSessionStart(p)),
      router.onLootItemResult(p  => this._onItemResult(p)),
      router.onLootSessionEnd(p  => this._onSessionEnd(p)),
    );
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'loot-window-stack';
    el.innerHTML = `
      <style>
        #loot-window-stack {
          position: fixed;
          bottom: 120px;
          right: 18px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: flex-end;
          pointer-events: none;
          z-index: 300;
        }

        .loot-panel {
          background: rgba(8, 6, 4, 0.88);
          border: 1px solid rgba(200, 145, 60, 0.35);
          box-shadow: 0 4px 18px rgba(0,0,0,0.7);
          width: min(340px, 90vw);
          font-family: var(--font-body, serif);
          pointer-events: auto;
          opacity: 0;
          transform: translateX(12px);
          transition: opacity 0.25s ease, transform 0.25s ease;
        }

        .loot-panel.loot-visible {
          opacity: 1;
          transform: translateX(0);
        }

        .loot-panel.loot-hiding {
          opacity: 0;
          transform: translateX(12px);
        }

        .loot-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 7px 12px 6px;
          border-bottom: 1px solid rgba(200,145,60,0.2);
        }

        .loot-title {
          font-size: 11px;
          color: rgba(200,145,60,0.9);
          letter-spacing: 0.14em;
          text-transform: uppercase;
          font-family: var(--font-mono, monospace);
        }

        .loot-countdown {
          font-size: 10px;
          color: rgba(200,145,60,0.55);
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.08em;
        }

        .loot-body {
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .loot-gold {
          font-size: 11px;
          color: rgba(212,201,184,0.7);
          letter-spacing: 0.06em;
          font-style: italic;
          padding-bottom: 4px;
          border-bottom: 1px solid rgba(200,145,60,0.1);
        }

        .loot-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .loot-item-name {
          font-size: 12px;
          color: rgba(212,201,184,0.92);
          letter-spacing: 0.04em;
        }

        .loot-item-buttons {
          display: flex;
          gap: 5px;
        }

        .loot-roll-btn {
          font-family: var(--font-body, serif);
          font-size: 10px;
          padding: 3px 10px;
          background: rgba(40,28,18,0.8);
          border: 1px solid rgba(200,145,60,0.25);
          color: rgba(212,201,184,0.8);
          cursor: pointer;
          letter-spacing: 0.08em;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
        }

        .loot-roll-btn:hover {
          background: rgba(80,50,20,0.8);
          border-color: rgba(200,145,60,0.55);
          color: rgba(212,201,184,1);
        }

        .loot-roll-btn.loot-need   { border-color: rgba(160,80,200,0.45); }
        .loot-roll-btn.loot-need:hover { background: rgba(60,20,80,0.7); border-color: rgba(200,80,255,0.6); }
        .loot-roll-btn.loot-want   { border-color: rgba(60,100,180,0.45); }
        .loot-roll-btn.loot-want:hover { background: rgba(20,40,80,0.7); border-color: rgba(80,140,255,0.6); }

        .loot-voted-label {
          font-size: 10px;
          color: rgba(212,201,184,0.5);
          font-style: italic;
          letter-spacing: 0.06em;
        }

        .loot-result-line {
          font-size: 10px;
          color: rgba(200,145,60,0.7);
          letter-spacing: 0.05em;
          font-style: italic;
          border-top: 1px solid rgba(200,145,60,0.1);
          padding-top: 4px;
          margin-top: 2px;
        }

        .loot-result-line.loot-winner {
          color: rgba(180,220,120,0.85);
        }
      </style>
    `;
    return el;
  }

  private _onSessionStart(payload: LootSessionStartPayload): void {
    const panel = document.createElement('div');
    panel.className = 'loot-panel';

    const session: ActiveSession = {
      payload,
      panel,
      voted:     new Set(),
      results:   [],
      dismissed: false,
    };
    this.sessions.set(payload.sessionId, session);
    this.root.appendChild(panel);

    this._renderPanel(session);

    requestAnimationFrame(() => panel.classList.add('loot-visible'));

    // Solo: auto-dismiss after a short display (session_end arrives immediately from server)
    // Party: timer is driven by session_end
  }

  private _renderPanel(session: ActiveSession): void {
    const { payload, voted, results } = session;
    const isSolo  = payload.mode === 'solo';
    const hasGold = (payload.gold ?? 0) > 0;

    const goldLabel = isSolo
      ? `+ ${payload.gold} gold`
      : `+ ${payload.goldPerMember} gold each`;

    const titleText = isSolo ? 'Loot Received' : `Loot — ${payload.mobName}`;

    let itemsHtml = '';
    for (const item of payload.items) {
      const result = results.find(r => r.itemId === item.id);
      const hasVoted = voted.has(item.id);

      let buttonsHtml = '';
      if (!isSolo && !result) {
        if (hasVoted) {
          buttonsHtml = `<div class="loot-voted-label">Voted</div>`;
        } else {
          buttonsHtml = `
            <button class="loot-roll-btn loot-need" data-session="${payload.sessionId}" data-item="${item.id}" data-roll="need">Need</button>
            <button class="loot-roll-btn loot-want" data-session="${payload.sessionId}" data-item="${item.id}" data-roll="want">Want</button>
            <button class="loot-roll-btn"           data-session="${payload.sessionId}" data-item="${item.id}" data-roll="pass">Pass</button>
          `;
        }
      }

      let resultHtml = '';
      if (result) {
        if (result.winnerId) {
          resultHtml = `<div class="loot-result-line loot-winner">${result.winnerName} won (${result.winRoll} · ${result.rollValue})</div>`;
        } else {
          resultHtml = `<div class="loot-result-line">No one claimed this item</div>`;
        }
      }

      itemsHtml += `
        <div class="loot-item" id="loot-item-${payload.sessionId}-${item.id}">
          <div class="loot-item-name">${item.name} × ${item.quantity}</div>
          <div class="loot-item-buttons" id="loot-btns-${payload.sessionId}-${item.id}">${buttonsHtml}</div>
          ${resultHtml}
        </div>
      `;
    }

    session.panel.innerHTML = `
      <div class="loot-header">
        <div class="loot-title">${titleText}</div>
        ${!isSolo ? `<div class="loot-countdown" id="loot-cd-${payload.sessionId}"></div>` : ''}
      </div>
      <div class="loot-body">
        ${hasGold ? `<div class="loot-gold">${goldLabel}</div>` : ''}
        ${itemsHtml}
      </div>
    `;

    // Wire up vote buttons
    session.panel.querySelectorAll<HTMLButtonElement>('.loot-roll-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid  = btn.dataset['session']!;
        const iid  = btn.dataset['item']!;
        const roll = btn.dataset['roll'] as 'need' | 'want' | 'pass';
        this._vote(sid, iid, roll);
      });
    });

    // Start countdown for party mode
    if (!isSolo && payload.expiresAt) {
      this._tickCountdown(payload.sessionId, payload.expiresAt);
    }
  }

  private _vote(sessionId: string, itemId: string, roll: 'need' | 'want' | 'pass'): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.voted.has(itemId)) return;

    session.voted.add(itemId);
    this.socket.sendLootRoll(sessionId, itemId, roll);

    const btnsEl = session.panel.querySelector<HTMLElement>(`#loot-btns-${sessionId}-${itemId}`);
    if (btnsEl) {
      btnsEl.innerHTML = `<div class="loot-voted-label">Voted: ${roll.charAt(0).toUpperCase() + roll.slice(1)}</div>`;
    }
  }

  private _onItemResult(payload: LootItemResultPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) return;

    session.results.push(payload);

    const btnsEl = session.panel.querySelector<HTMLElement>(`#loot-btns-${payload.sessionId}-${payload.itemId}`);
    if (btnsEl) btnsEl.innerHTML = '';

    const itemEl = session.panel.querySelector<HTMLElement>(`#loot-item-${payload.sessionId}-${payload.itemId}`);
    if (itemEl) {
      const resultLine = document.createElement('div');
      if (payload.winnerId) {
        resultLine.className = 'loot-result-line loot-winner';
        resultLine.textContent = `${payload.winnerName} won (${payload.winRoll} · ${payload.rollValue})`;
      } else {
        resultLine.className = 'loot-result-line';
        resultLine.textContent = 'No one claimed this item';
      }
      itemEl.appendChild(resultLine);
    }
  }

  private _onSessionEnd(payload: LootSessionEndPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session || session.dismissed) return;

    session.dismissed = true;
    // Keep the panel visible for a moment, then fade out
    setTimeout(() => this._dismissPanel(payload.sessionId), 4000);
  }

  private _dismissPanel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.panel.classList.remove('loot-visible');
    session.panel.classList.add('loot-hiding');

    session.panel.addEventListener('transitionend', () => {
      session.panel.remove();
      this.sessions.delete(sessionId);
    }, { once: true });
  }

  private _tickCountdown(sessionId: string, expiresAt: number): void {
    const cdEl = this.root.querySelector<HTMLElement>(`#loot-cd-${sessionId}`);
    if (!cdEl) return;

    const session = this.sessions.get(sessionId);

    const tick = (): void => {
      if (!session || session.dismissed) return;
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      cdEl.textContent = `${remaining}s`;
      if (remaining > 0) setTimeout(tick, 500);
    };
    tick();
  }
}
