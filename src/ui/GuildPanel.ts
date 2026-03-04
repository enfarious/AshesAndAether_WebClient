import type { PlayerState }   from '@/state/PlayerState';
import type { SocketClient }  from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type { GuildFoundingNarrativePayload } from '@/network/Protocol';

/**
 * GuildPanel — toggleable guild info / member roster.
 *
 * 'G' key opens/closes.
 *
 * When the player has no guild, shows a brief help message.
 * When in a guild, shows name [TAG], motto, bonuses, member list,
 * and Leave / Disband button.
 *
 * Also displays the founding ceremony narrative overlay when the
 * server pushes `guild_founding_narrative` steps.
 */
export class GuildPanel {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _visible = false;

  // Founding narrative overlay
  private narrativeOverlay: HTMLElement | null = null;
  private narrativeSteps:   string[] = [];
  private narrativeTotal    = 0;

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'guild-panel';
    this._injectStyles();
    uiRoot.appendChild(this.root);

    const unsub = player.onChange(() => { if (this._visible) this._render(); });
    this.cleanup.push(unsub);

    const unsubNarrative = router.onGuildFoundingNarrative(p => this._onNarrative(p));
    this.cleanup.push(unsubNarrative);

    this.root.style.display = 'none';
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._visible = true;
    this.root.style.display = '';
    this._render();
  }

  hide(): void {
    this._visible = false;
    this.root.style.display = 'none';
  }

  toggle(): void {
    if (this._visible) this.hide();
    else               this.show();
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.narrativeOverlay?.remove();
    this.root.remove();
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('guild-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'guild-panel-styles';
    style.textContent = `
      #guild-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(320px, 30vw, 420px);
        max-height: 70vh;
        background: var(--ui-bg, rgba(8,6,4,0.92));
        border: 1px solid var(--ui-border, rgba(200,145,60,0.18));
        box-shadow: 0 4px 24px rgba(0,0,0,0.7);
        z-index: 700;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .gp-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px 8px;
        border-bottom: 1px solid rgba(200,145,60,0.12);
      }

      .gp-title {
        font-family: var(--font-display, serif);
        font-size: 15px;
        color: rgba(212,201,184,0.85);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .gp-close {
        background: none;
        border: none;
        color: rgba(212,201,184,0.5);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .gp-close:hover { color: var(--ember, #c86a2a); }

      .gp-body {
        padding: 10px 14px;
        overflow-y: auto;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 10px;
        scrollbar-width: thin;
        scrollbar-color: var(--ember, #c86a2a) transparent;
      }

      .gp-no-guild {
        font-family: var(--font-body, serif);
        font-size: 13px;
        color: rgba(212,201,184,0.55);
        text-align: center;
        padding: 24px 0;
        line-height: 1.6;
      }

      .gp-guild-name {
        font-family: var(--font-display, serif);
        font-size: 17px;
        color: #60c890;
        letter-spacing: 0.06em;
        text-align: center;
      }

      .gp-tag {
        color: rgba(212,201,184,0.5);
        font-size: 13px;
      }

      .gp-motto {
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.6);
        font-style: italic;
        text-align: center;
      }

      .gp-info-row {
        display: flex;
        justify-content: space-between;
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.65);
      }

      .gp-info-label { color: rgba(212,201,184,0.45); }
      .gp-info-value { color: rgba(212,201,184,0.8); }

      .gp-section-title {
        font-family: var(--font-display, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.5);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-top: 4px;
        border-bottom: 1px solid rgba(200,145,60,0.08);
        padding-bottom: 3px;
      }

      .gp-member {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--font-body, serif);
        font-size: 12px;
        color: rgba(212,201,184,0.75);
        padding: 2px 0;
      }

      .gp-member-online {
        width: 6px; height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .gp-member-online.on  { background: #60c890; }
      .gp-member-online.off { background: rgba(100,80,60,0.4); }

      .gp-member-name { flex: 1; }
      .gp-member-gm {
        font-size: 10px;
        color: rgba(220,180,60,0.8);
      }

      .gp-actions {
        display: flex;
        gap: 8px;
        justify-content: center;
        padding-top: 6px;
        border-top: 1px solid rgba(200,145,60,0.08);
      }

      .gp-btn {
        font-family: var(--font-body, serif);
        font-size: 12px;
        padding: 5px 16px;
        border: 1px solid rgba(200,145,60,0.25);
        background: rgba(30,20,8,0.7);
        color: rgba(212,201,184,0.8);
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .gp-btn:hover {
        background: rgba(60,40,10,0.8);
        border-color: var(--ember, #c86a2a);
      }
      .gp-btn.danger {
        color: rgba(210,130,130,0.9);
        border-color: rgba(160,60,60,0.3);
      }
      .gp-btn.danger:hover {
        background: rgba(50,15,15,0.7);
        border-color: rgba(160,60,60,0.55);
      }

      /* ── Founding narrative overlay ─────────────────────────────── */
      #guild-narrative-overlay {
        position: fixed;
        inset: 0;
        background: rgba(4,2,0,0.85);
        z-index: 900;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }

      .gn-box {
        max-width: 520px;
        padding: 32px 36px;
        background: rgba(12,8,4,0.95);
        border: 1px solid rgba(200,145,60,0.25);
        box-shadow: 0 6px 40px rgba(0,0,0,0.8);
        text-align: center;
      }

      .gn-text {
        font-family: var(--font-body, serif);
        font-size: 15px;
        color: rgba(212,201,184,0.9);
        line-height: 1.7;
        margin-bottom: 16px;
        white-space: pre-wrap;
      }

      .gn-step {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        color: rgba(212,201,184,0.35);
      }
    `;
    document.head.appendChild(style);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private _render(): void {
    const p = this.player;

    if (!p.guildId) {
      this.root.innerHTML = `
        <div class="gp-header">
          <span class="gp-title">Guild</span>
          <button class="gp-close" id="gp-close">&times;</button>
        </div>
        <div class="gp-body">
          <div class="gp-no-guild">
            You are not in a guild.<br>
            Use <strong>/guild create &lt;name&gt; &lt;TAG&gt;</strong> to found one,<br>
            or ask a guildmaster for an invitation.
          </div>
        </div>
      `;
      this._wireClose();
      return;
    }

    // ── Build member list ──────────────────────────────────────────────────
    const members = p.guildMembers;
    let membersHtml = '';
    if (members.length > 0) {
      // Sort: online first, then alpha
      const sorted = [...members].sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return a.characterName.localeCompare(b.characterName);
      });
      for (const m of sorted) {
        membersHtml += `
          <div class="gp-member">
            <span class="gp-member-online ${m.isOnline ? 'on' : 'off'}"></span>
            <span class="gp-member-name">${this._esc(m.characterName)}</span>
            ${m.isGuildmaster ? '<span class="gp-member-gm" title="Guildmaster">&#9733;</span>' : ''}
          </div>
        `;
      }
    } else {
      membersHtml = '<div style="font-size:11px;color:rgba(212,201,184,0.35);padding:4px 0;">Member list not yet loaded.</div>';
    }

    // ── Bonuses ─────────────────────────────────────────────────────────────
    const bonuses = p.guildBonuses;
    let bonusHtml = '';
    if (bonuses) {
      if (bonuses.corruptionResistPercent > 0) {
        bonusHtml += `<div class="gp-info-row"><span class="gp-info-label">Corruption Resist</span><span class="gp-info-value">+${bonuses.corruptionResistPercent}%</span></div>`;
      }
      if (bonuses.xpBonusPercent > 0) {
        bonusHtml += `<div class="gp-info-row"><span class="gp-info-label">XP Bonus</span><span class="gp-info-value">+${bonuses.xpBonusPercent}%</span></div>`;
      }
    }

    // ── Actions ──────────────────────────────────────────────────────────────
    let actionsHtml = '';
    if (p.isGuildmaster) {
      actionsHtml = `<button class="gp-btn danger" data-action="disband">Disband Guild</button>`;
    } else {
      actionsHtml = `<button class="gp-btn danger" data-action="leave">Leave Guild</button>`;
    }

    this.root.innerHTML = `
      <div class="gp-header">
        <span class="gp-title">Guild</span>
        <button class="gp-close" id="gp-close">&times;</button>
      </div>
      <div class="gp-body">
        <div class="gp-guild-name">${this._esc(p.guildName ?? '')} <span class="gp-tag">[${this._esc(p.guildTag ?? '')}]</span></div>
        ${p.guildMotto ? `<div class="gp-motto">"${this._esc(p.guildMotto)}"</div>` : ''}

        <div class="gp-info-row">
          <span class="gp-info-label">Members</span>
          <span class="gp-info-value">${p.guildMemberCount}</span>
        </div>
        <div class="gp-info-row">
          <span class="gp-info-label">Beacons</span>
          <span class="gp-info-value">${p.guildLitBeacons} / ${p.guildMaxBeacons}</span>
        </div>
        ${bonusHtml}

        <div class="gp-section-title">Roster</div>
        ${membersHtml}

        <div class="gp-actions">
          ${actionsHtml}
        </div>
      </div>
    `;

    this._wireClose();

    // Action buttons
    this.root.querySelector('[data-action="leave"]')?.addEventListener('click', () => {
      this.socket.sendCommand('/guild leave');
    });
    this.root.querySelector('[data-action="disband"]')?.addEventListener('click', () => {
      this.socket.sendCommand('/guild disband');
    });
  }

  private _wireClose(): void {
    this.root.querySelector('#gp-close')?.addEventListener('click', () => this.hide());
  }

  // ── Founding narrative ──────────────────────────────────────────────────────

  private _onNarrative(payload: GuildFoundingNarrativePayload): void {
    this.narrativeTotal = payload.totalSteps;

    if (!this.narrativeOverlay) {
      this.narrativeOverlay = document.createElement('div');
      this.narrativeOverlay.id = 'guild-narrative-overlay';
      this.narrativeOverlay.innerHTML = `
        <div class="gn-box">
          <div class="gn-text" id="gn-text"></div>
          <div class="gn-step" id="gn-step"></div>
        </div>
      `;
      document.body.appendChild(this.narrativeOverlay);
    }

    this.narrativeSteps.push(payload.narrative);
    const textEl = this.narrativeOverlay.querySelector<HTMLElement>('#gn-text')!;
    const stepEl = this.narrativeOverlay.querySelector<HTMLElement>('#gn-step')!;
    textEl.textContent = payload.narrative;
    stepEl.textContent = `${payload.step} / ${payload.totalSteps}`;

    // Auto-dismiss after the final step
    if (payload.step >= payload.totalSteps) {
      setTimeout(() => {
        this.narrativeOverlay?.remove();
        this.narrativeOverlay = null;
        this.narrativeSteps = [];
        // Refresh guild panel if visible
        if (this._visible) this._render();
      }, 4000);
    }
  }

  // ── Util ───────────────────────────────────────────────────────────────────

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
