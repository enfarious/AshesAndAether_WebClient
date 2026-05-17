import type { SocketClient } from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';
import type {
  ActivitySnapshotPayload,
  ActivityBossRow,
  ActivityVaultTemplate,
} from '@/network/Protocol';

/**
 * ActivitiesPanel — top-level "what is there to do" menu.
 *
 * Two tabs:
 *   - Bosses : 8 US regions, status (idle / prep+countdown / fighting+tier /
 *              defeated), Join button when status === 'prep'.
 *   - Vaults : list of vault templates with an Enter button; header shows
 *              live count of vault instances running server-wide.
 *
 * Driven by a single push event (`activity_snapshot`) — fires on every boss
 * state transition + a 30s heartbeat. The panel replaces its local state on
 * receipt; no merging.
 */
export class ActivitiesPanel {
  readonly root: HTMLDivElement;
  private _isVisible = false;
  private activeTab: 'bosses' | 'vaults' = 'bosses';
  private snapshot: ActivitySnapshotPayload | null = null;
  private unsub: (() => void) | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    mountEl: HTMLElement,
    private readonly socket: SocketClient,
    private readonly router: MessageRouter,
  ) {
    this._injectStyles();
    this.root = document.createElement('div');
    this.root.id = 'activities-panel';
    // Hidden by default — `.ap-visible` class flips display + pointer-events
    // when show() runs. Pointer-events: none on the hidden root means clicks
    // pass through to the canvas (terrain interaction stays usable while
    // the panel is closed). Adding the class makes the backdrop catch
    // clicks and the inner frame respond to interactions.
    mountEl.appendChild(this.root);
    this._buildDOM();

    // Subscribe to live snapshots — panel updates even when hidden so it's
    // current the instant the player opens it (no first-open flicker).
    this.unsub = this.router.onActivitySnapshot((p) => {
      this.snapshot = p;
      if (this._isVisible) this._render();
    });

    // Escape closes the panel. Per-panel keydown listener mirrors the
    // pattern in AbilityWindow / InventoryWindow rather than going through
    // a central key router — keeps each panel's lifecycle self-contained.
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._isVisible) {
        this.hide();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  get isVisible(): boolean { return this._isVisible; }

  show(): void {
    this._isVisible = true;
    this.root.classList.add('ap-visible');
    this._render();
    // Tick once a second to update prep-window countdowns in-place. Bosses
    // tab only — vault tab has no per-row clock to advance.
    if (!this.countdownTimer) {
      this.countdownTimer = setInterval(() => {
        if (this.activeTab === 'bosses') this._renderRegionList();
      }, 1000);
    }
  }

  hide(): void {
    this._isVisible = false;
    this.root.classList.remove('ap-visible');
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  close(): void { this.hide(); }

  toggle(): void { this._isVisible ? this.hide() : this.show(); }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.root.remove();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private _buildDOM(): void {
    // Backdrop sits behind the frame and catches click-outside-to-close.
    // Frame is `position: relative` so its z-index stays above the
    // backdrop inside the same stacking context — clicks ON the frame
    // don't propagate to the backdrop (so click-outside only fires for
    // genuine outside-area clicks).
    this.root.innerHTML = `
      <div id="ap-backdrop"></div>
      <div class="ap-frame">
        <div class="ap-header">
          <span class="ap-title">Activities</span>
          <button class="ap-close" type="button">✕</button>
        </div>
        <div class="ap-tabs">
          <button class="ap-tab" data-tab="bosses">Bosses</button>
          <button class="ap-tab" data-tab="vaults">Vaults</button>
        </div>
        <div class="ap-body">
          <div class="ap-list" id="ap-list"></div>
          <div class="ap-footer" id="ap-footer"></div>
        </div>
      </div>
    `;

    this.root.querySelector<HTMLButtonElement>('.ap-close')?.addEventListener('click', () => this.hide());
    this.root.querySelector<HTMLDivElement>('#ap-backdrop')?.addEventListener('click', () => this.hide());
    this.root.querySelectorAll<HTMLButtonElement>('.ap-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tab as 'bosses' | 'vaults';
        if (t && t !== this.activeTab) {
          this.activeTab = t;
          this._render();
        }
      });
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private _render(): void {
    // Tab button active state
    this.root.querySelectorAll<HTMLButtonElement>('.ap-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === this.activeTab);
    });

    if (this.activeTab === 'bosses') {
      this._renderRegionList();
    } else {
      this._renderVaultList();
    }
  }

  private _renderRegionList(): void {
    const list   = this.root.querySelector<HTMLDivElement>('#ap-list');
    const footer = this.root.querySelector<HTMLDivElement>('#ap-footer');
    if (!list || !footer) return;

    footer.innerHTML = '';

    if (!this.snapshot) {
      list.innerHTML = '<div class="ap-empty">Awaiting server snapshot…</div>';
      return;
    }

    // Group by country (single country today, but the shape is ready for
    // when more come online).
    const byCountry = new Map<string, ActivityBossRow[]>();
    for (const row of this.snapshot.regions) {
      const arr = byCountry.get(row.country) ?? [];
      arr.push(row);
      byCountry.set(row.country, arr);
    }

    const html: string[] = [];
    for (const [country, rows] of byCountry) {
      html.push(`<div class="ap-group-head">${this._escape(country)}</div>`);
      for (const r of rows) {
        html.push(this._renderBossRow(r));
      }
    }
    list.innerHTML = html.join('');

    // Bind Join buttons after innerHTML replacement.
    list.querySelectorAll<HTMLButtonElement>('.ap-join').forEach((btn) => {
      btn.addEventListener('click', () => {
        // /join uses the caller's CURRENT region tag — they have to be
        // standing in a zone matching the target region. Documenting via
        // the button hover; here we just fire the command.
        this.socket.sendCommand('/join');
        // Close so the player can see the cast bar / teleport feedback
        // instead of the menu hanging open over the action.
        this.hide();
      });
    });
  }

  private _renderBossRow(r: ActivityBossRow): string {
    const statusInfo = this._bossStatusInfo(r);
    const action = r.status === 'prep'
      ? `<button class="ap-join" type="button" title="Travel to a ${this._escape(r.regionId)} zone first, then click">Join</button>`
      : '';
    return `
      <div class="ap-row ap-row-${r.status}">
        <div class="ap-row-main">
          <div class="ap-row-name">${this._escape(r.regionId)}</div>
          <div class="ap-row-sub">${this._escape(this._bossKindLabel(r.bossKind))}</div>
        </div>
        <div class="ap-row-status">
          <span class="ap-badge ap-badge-${r.status}">${statusInfo.label}</span>
          ${statusInfo.detail ? `<span class="ap-row-detail">${statusInfo.detail}</span>` : ''}
        </div>
        <div class="ap-row-action">${action}</div>
      </div>
    `;
  }

  private _renderVaultList(): void {
    const list   = this.root.querySelector<HTMLDivElement>('#ap-list');
    const footer = this.root.querySelector<HTMLDivElement>('#ap-footer');
    if (!list || !footer) return;

    if (!this.snapshot) {
      list.innerHTML = '<div class="ap-empty">Awaiting server snapshot…</div>';
      footer.innerHTML = '';
      return;
    }

    const v = this.snapshot.vaults;
    const html: string[] = [
      `<div class="ap-group-head">Vault Templates</div>`,
      `<div class="ap-note">Pre-formed parties only — form your party, then click Enter. The leader enters; the rest follow.</div>`,
    ];
    if (v.templates.length === 0) {
      html.push('<div class="ap-empty">No vault templates registered.</div>');
    } else {
      for (const t of v.templates) {
        html.push(this._renderVaultRow(t));
      }
    }
    list.innerHTML = html.join('');

    footer.innerHTML = `
      <div class="ap-row-stat">
        <span class="ap-stat-label">Active vault runs:</span>
        <span class="ap-stat-value">${v.activeCount}</span>
      </div>
    `;

    list.querySelectorAll<HTMLButtonElement>('.ap-vault-enter').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.socket.sendCommand('/vault enter');
        // Close so the staging-zone teleport + entry chat tells are visible.
        this.hide();
      });
    });
  }

  private _renderVaultRow(t: ActivityVaultTemplate): string {
    return `
      <div class="ap-row ap-row-vault">
        <div class="ap-row-main">
          <div class="ap-row-name">${this._escape(t.name)}</div>
          <div class="ap-row-sub">${this._escape(t.description)}</div>
          <div class="ap-row-meta">Base level: ${t.baseLevel}</div>
        </div>
        <div class="ap-row-action">
          <button class="ap-vault-enter" type="button">Enter</button>
        </div>
      </div>
    `;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _bossStatusInfo(r: ActivityBossRow): { label: string; detail: string } {
    switch (r.status) {
      case 'idle':
        return { label: 'Idle', detail: 'No active arena' };
      case 'prep': {
        const msLeft = (r.lobbyEndsAt ?? 0) - Date.now();
        const sec = Math.max(0, Math.ceil(msLeft / 1000));
        return { label: 'Lobby Open', detail: sec > 0 ? `Closes in ${sec}s` : 'Closing…' };
      }
      case 'fighting':
        return { label: `Fighting · T${r.tier ?? 1}`, detail: 'Engagement in progress' };
      case 'defeated':
        return { label: 'Defeated', detail: 'Cleanup in progress' };
    }
  }

  private _bossKindLabel(kind: string): string {
    switch (kind) {
      case 'husk':       return 'Aether Husk';
      case 'riftcaller': return 'Riftcaller';
      default:           return kind;
    }
  }

  private _escape(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]!));
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('activities-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'activities-panel-styles';
    style.textContent = ACTIVITIES_CSS;
    document.head.appendChild(style);
  }
}

const ACTIVITIES_CSS = `
/* Fullscreen overlay, no pointer events until visible. Clicks pass
   through to the canvas while the panel is hidden so terrain
   interaction stays usable. The ap-visible class flips both display
   and pointer-events at once. z-index baseline 200 matches
   CharacterSheet etc.; ModalStack bringToFront bumps past 1000. */
#activities-panel {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: none;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif;
}
#activities-panel.ap-visible {
  display: block;
  pointer-events: auto;
}
#activities-panel #ap-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
}
#activities-panel .ap-frame {
  position: relative;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 540px;
  max-height: 80vh;
  background: linear-gradient(180deg, rgba(20,16,12,0.97), rgba(12,8,6,0.97));
  border: 1px solid rgba(200,145,60,0.4);
  border-radius: 4px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  display: flex;
  flex-direction: column;
}
#activities-panel .ap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid rgba(200,145,60,0.25);
}
#activities-panel .ap-title {
  font-size: 16px;
  font-weight: 700;
  color: #f0c878;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
#activities-panel .ap-close {
  background: none; border: none; color: #c8c0b0; font-size: 16px;
  cursor: pointer; padding: 2px 6px; line-height: 1;
}
#activities-panel .ap-close:hover { color: #fff; }
#activities-panel .ap-tabs {
  display: flex;
  border-bottom: 1px solid rgba(200,145,60,0.25);
}
#activities-panel .ap-tab {
  flex: 1;
  background: none;
  border: none;
  color: rgba(212,201,184,0.7);
  padding: 8px;
  cursor: pointer;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 2px solid transparent;
}
#activities-panel .ap-tab:hover { color: #fff; }
#activities-panel .ap-tab.active {
  color: #f0c878;
  border-bottom-color: #c8912a;
}
#activities-panel .ap-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
#activities-panel .ap-list {
  overflow-y: auto;
  padding: 6px 0;
  max-height: 56vh;
}
#activities-panel .ap-footer {
  border-top: 1px solid rgba(200,145,60,0.18);
  padding: 8px 14px;
  font-size: 12px;
  color: rgba(212,201,184,0.85);
}
#activities-panel .ap-group-head {
  padding: 6px 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(200,145,60,0.85);
  background: rgba(200,145,60,0.06);
}
#activities-panel .ap-empty {
  padding: 14px;
  color: rgba(180,160,130,0.65);
  font-style: italic;
  text-align: center;
}
#activities-panel .ap-note {
  padding: 8px 14px;
  font-size: 11px;
  color: rgba(180,160,130,0.8);
  font-style: italic;
  background: rgba(0,0,0,0.25);
  border-bottom: 1px solid rgba(200,145,60,0.12);
}
#activities-panel .ap-row {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(200,145,60,0.08);
  gap: 12px;
}
#activities-panel .ap-row:last-child { border-bottom: none; }
#activities-panel .ap-row-main { flex: 1; min-width: 0; }
#activities-panel .ap-row-name { color: #e8dabc; font-size: 13px; font-weight: 600; }
#activities-panel .ap-row-sub  { color: rgba(180,160,130,0.85); font-size: 11px; margin-top: 2px; }
#activities-panel .ap-row-meta { color: rgba(140,124,100,0.85); font-size: 10px; margin-top: 2px; }
#activities-panel .ap-row-status {
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 2px; min-width: 140px;
}
#activities-panel .ap-row-detail {
  font-size: 10px;
  color: rgba(180,160,130,0.7);
}
#activities-panel .ap-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 2px;
  border: 1px solid;
  white-space: nowrap;
}
#activities-panel .ap-badge-idle     { color: #a09070; border-color: rgba(160,144,112,0.5); background: rgba(160,144,112,0.08); }
#activities-panel .ap-badge-prep     { color: #f0c878; border-color: rgba(240,200,120,0.7); background: rgba(240,200,120,0.12); }
#activities-panel .ap-badge-fighting { color: #e87060; border-color: rgba(232,112,96,0.7);  background: rgba(232,112,96,0.12); }
#activities-panel .ap-badge-defeated { color: #70d088; border-color: rgba(112,208,136,0.6); background: rgba(112,208,136,0.10); }
#activities-panel .ap-row-action button {
  background: rgba(200,145,60,0.18);
  color: #f0c878;
  border: 1px solid rgba(200,145,60,0.55);
  padding: 5px 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 2px;
}
#activities-panel .ap-row-action button:hover {
  background: rgba(200,145,60,0.32);
  color: #fff;
}
#activities-panel .ap-row-stat {
  display: flex; gap: 8px; align-items: baseline;
}
#activities-panel .ap-stat-label { color: rgba(180,160,130,0.7); }
#activities-panel .ap-stat-value { color: #f0c878; font-weight: 700; font-size: 14px; }
`;
