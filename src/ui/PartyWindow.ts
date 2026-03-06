import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { SocketClient }   from '@/network/SocketClient';

/**
 * PartyWindow — compact party roster, bottom-right corner.
 *
 * Shows party members with HP / stamina / mana bars.
 * Auto-shows when the player joins a party, auto-hides when party dissolves.
 * 'P' key toggles visibility.
 */
export class PartyWindow {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _visible = false;
  private _userHidden = false;   // player manually toggled off with 'P'
  private _lastMemberCount = -1; // force first rebuild

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly socket:   SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubPlayer = player.onChange(() => this._refresh());
    const unsubEntity = entities.onUpdate(e => {
      // Refresh if an updated entity is a party member (HP changed)
      if (this.player.partyMembers.some(m => m.id === e.id)) this._refresh();
    });
    this.cleanup.push(unsubPlayer, unsubEntity);

    this._refresh();
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._userHidden = false;
    this._refresh();
  }

  hide(): void {
    this.root.style.display = 'none';
    this._visible = false;
  }

  toggle(): void {
    if (this.player.partyMembers.length === 0 && !this.player.pendingInvite) return;
    this._userHidden = !this._userHidden;
    this._refresh();
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'party-window';
    el.innerHTML = `
      <style>
        #party-window {
          position: fixed;
          bottom: 80px;
          right: 18px;
          width: 200px;
          pointer-events: none;
          z-index: 60;
        }

        .pw-panel {
          background: rgba(8, 6, 4, 0.78);
          border: 1px solid rgba(200, 145, 60, 0.18);
          box-shadow: 0 2px 12px rgba(0,0,0,0.6);
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          pointer-events: auto;
        }

        .pw-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 4px;
          border-bottom: 1px solid rgba(200,145,60,0.12);
        }

        .pw-title {
          font-family: var(--font-display, serif);
          font-size: 13px;
          color: rgba(212,201,184,0.7);
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .pw-count {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(212,201,184,0.4);
        }

        /* ── Invite banner ────────────────────────────────────────────── */
        .pw-invite {
          background: rgba(60,40,10,0.6);
          border: 1px solid rgba(200,145,60,0.3);
          padding: 6px 8px;
          font-family: var(--font-body, serif);
          font-size: 11px;
          color: rgba(220,190,140,0.9);
          line-height: 1.4;
          text-align: center;
        }

        .pw-invite-name {
          color: var(--ember, #c86a2a);
          font-style: italic;
        }

        .pw-invite-btns {
          display: flex;
          gap: 6px;
          margin-top: 5px;
          justify-content: center;
        }

        .pw-invite-btn {
          font-family: var(--font-body, serif);
          font-size: 11px;
          padding: 3px 12px;
          border: 1px solid rgba(200,145,60,0.3);
          background: rgba(30,20,8,0.7);
          color: rgba(212,201,184,0.85);
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
        }
        .pw-invite-btn:hover {
          background: rgba(60,40,10,0.8);
          border-color: var(--ember, #c86a2a);
        }
        .pw-invite-btn.accept {
          color: rgba(160,210,130,0.95);
          border-color: rgba(100,160,60,0.35);
        }
        .pw-invite-btn.accept:hover {
          background: rgba(30,50,15,0.7);
          border-color: rgba(100,160,60,0.6);
        }
        .pw-invite-btn.decline {
          color: rgba(210,130,130,0.85);
          border-color: rgba(160,60,60,0.3);
        }
        .pw-invite-btn.decline:hover {
          background: rgba(50,15,15,0.7);
          border-color: rgba(160,60,60,0.55);
        }

        /* ── Member card ──────────────────────────────────────────────── */
        .pw-member {
          display: flex;
          flex-direction: column;
          gap: 2px;
          cursor: pointer;
          padding: 3px 0;
        }
        .pw-member:hover .pw-name {
          color: var(--ember, #c86a2a);
        }

        .pw-name-row {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .pw-crown {
          font-size: 11px;
          color: rgba(220,180,60,0.8);
        }

        .pw-name {
          flex: 1;
          font-family: var(--font-body, serif);
          font-size: 12px;
          color: rgba(212,201,184,0.85);
          letter-spacing: 0.04em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          transition: color 0.15s;
        }

        .pw-hp-pct {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(212,201,184,0.55);
          min-width: 32px;
          text-align: right;
        }

        /* ── Bars ─────────────────────────────────────────────────────── */
        .pw-bars {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .pw-bar {
          height: 5px;
          background: rgba(10,8,6,0.6);
          position: relative;
          overflow: hidden;
        }

        .pw-bar-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          transition: transform 0.25s ease;
        }

        .pw-bar-fill.hp   { background: linear-gradient(90deg, #5a0f0f, #8b2020); }
        .pw-bar-fill.st   { background: linear-gradient(90deg, #152e0a, #2d5a1e); }
        .pw-bar-fill.mp   { background: linear-gradient(90deg, #0d2e4d, #1e4d7a); }

        .pw-bar-row {
          display: flex;
          gap: 2px;
        }

        .pw-bar-row .pw-bar {
          flex: 1;
        }

        .pw-member.dead .pw-name {
          color: rgba(120,80,80,0.6);
          text-decoration: line-through;
        }
        .pw-member.dead .pw-hp-pct {
          color: rgba(120,80,80,0.5);
        }
      </style>

      <div class="pw-panel">
        <div class="pw-header">
          <span class="pw-title">Party</span>
          <span class="pw-count" id="pw-count"></span>
        </div>
        <div id="pw-invite"></div>
        <div id="pw-roster"></div>
      </div>
    `;

    return el;
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _refresh(): void {
    const members = this.player.partyMembers;
    const hasParty = members.length > 0;
    const hasInvite = this.player.pendingInvite !== null;

    // Auto-show / auto-hide
    if ((hasParty || hasInvite) && !this._userHidden) {
      this.root.style.display = 'block';
      this._visible = true;
    } else {
      this.root.style.display = 'none';
      this._visible = false;
      // If party dissolved, reset user toggle
      if (!hasParty && !hasInvite) this._userHidden = false;
      if (!hasParty && !hasInvite) { this._lastMemberCount = -1; return; }
      return;
    }

    // ── Invite banner ──────────────────────────────────────────────────────
    const inviteEl = this.root.querySelector<HTMLElement>('#pw-invite')!;
    const invite = this.player.pendingInvite;
    if (invite) {
      inviteEl.innerHTML = `
        <div class="pw-invite">
          <span class="pw-invite-name">${this._esc(invite.fromName)}</span> invites you
          <div class="pw-invite-btns">
            <button class="pw-invite-btn accept" data-action="accept">Accept</button>
            <button class="pw-invite-btn decline" data-action="decline">Decline</button>
          </div>
        </div>
      `;
      inviteEl.querySelector('[data-action="accept"]')!.addEventListener('click', () => {
        this.socket.sendCommand('/party accept');
      });
      inviteEl.querySelector('[data-action="decline"]')!.addEventListener('click', () => {
        this.socket.sendCommand('/party decline');
      });
    } else {
      inviteEl.innerHTML = '';
    }

    // ── Count ────────────────────────────────────────────────────────────────
    const countEl = this.root.querySelector<HTMLElement>('#pw-count')!;
    countEl.textContent = members.length > 0 ? `${members.length}` : '';

    // ── Roster ───────────────────────────────────────────────────────────────
    const roster = this.root.querySelector<HTMLElement>('#pw-roster')!;
    const needsRebuild = members.length !== this._lastMemberCount;
    this._lastMemberCount = members.length;

    if (members.length === 0) {
      roster.innerHTML = '';
      return;
    }

    const allies = this.player.partyAllies;
    const leaderId = this.player.partyLeaderId;

    if (needsRebuild) {
      roster.innerHTML = '';
      for (const m of members) {
        const card = this._buildMemberCard(m.id, m.name, leaderId);
        // Click to target party member (skip self-targeting)
        if (m.id !== this.player.id) {
          card.addEventListener('click', () => {
            this.player.setTarget(m.id, m.name);
          });
        }
        roster.appendChild(card);
      }
    }

    // Update bars in-place
    const cards = roster.querySelectorAll<HTMLElement>('.pw-member');
    cards.forEach(card => {
      const id = card.dataset['memberId']!;
      const entity = this.entities.get(id);
      const ally = allies.find(a => a.entityId === id);

      // HP from entity registry (same zone)
      const hp = entity?.health;
      const hpPct = hp && hp.max > 0 ? hp.current / hp.max : null;
      const isAlive = entity?.isAlive !== false;

      // Toggle dead class
      card.classList.toggle('dead', !isAlive);

      // HP % text
      const hpPctEl = card.querySelector<HTMLElement>('.pw-hp-pct');
      if (hpPctEl) {
        hpPctEl.textContent = hpPct !== null ? `${Math.round(hpPct * 100)}%` : '';
      }

      // HP bar fill
      const hpFill = card.querySelector<HTMLElement>('.pw-bar-fill.hp');
      if (hpFill) {
        if (hpPct !== null) {
          hpFill.style.transform = `scaleX(${Math.max(0, Math.min(1, hpPct))})`;
          (hpFill.parentElement as HTMLElement).style.display = '';
        } else {
          (hpFill.parentElement as HTMLElement).style.display = 'none';
        }
      }

      // ST / MP bars from allies data
      const stFill = card.querySelector<HTMLElement>('.pw-bar-fill.st');
      const mpFill = card.querySelector<HTMLElement>('.pw-bar-fill.mp');
      if (stFill) {
        stFill.style.transform = `scaleX(${(ally?.staminaPct ?? 0) / 100})`;
      }
      if (mpFill) {
        mpFill.style.transform = `scaleX(${(ally?.manaPct ?? 0) / 100})`;
      }
    });
  }

  private _buildMemberCard(id: string, name: string, leaderId: string | null): HTMLElement {
    const card = document.createElement('div');
    card.className = 'pw-member';
    card.dataset['memberId'] = id;
    const isLeader = id === leaderId;

    card.innerHTML = `
      <div class="pw-name-row">
        ${isLeader ? '<span class="pw-crown" title="Party Leader">&#9733;</span>' : ''}
        <span class="pw-name">${this._esc(name)}</span>
        <span class="pw-hp-pct"></span>
      </div>
      <div class="pw-bars">
        <div class="pw-bar" style="display:none"><div class="pw-bar-fill hp"></div></div>
        <div class="pw-bar-row">
          <div class="pw-bar" title="Stamina"><div class="pw-bar-fill st"></div></div>
          <div class="pw-bar" title="Mana"><div class="pw-bar-fill mp"></div></div>
        </div>
      </div>
    `;

    return card;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
