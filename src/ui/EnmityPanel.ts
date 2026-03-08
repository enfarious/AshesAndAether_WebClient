import type { PlayerState } from '@/state/PlayerState';
import type { EnmityEntry } from '@/network/Protocol';

/**
 * EnmityPanel — compact threat list showing mobs with enmity toward the player.
 *
 * Auto-shows when the player is in combat and enmityList is non-empty.
 * Auto-hides when combat ends or the list empties.
 * Each row shows a colored dot (red/yellow/blue) and the mob name.
 * Clicking a row targets that entity.
 */

const LEVEL_COLORS: Record<string, string> = {
  red:    '#e04040',
  yellow: '#e0c040',
  blue:   '#4090e0',
};

const LEVEL_ORDER: Record<string, number> = { red: 0, yellow: 1, blue: 2 };

export class EnmityPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private unsub: (() => void) | null = null;
  private _visible = false;
  private _rafId: number | null = null;
  private _lastEnmityKey = '';
  private onTargetClick: ((entityId: string) => void) | null = null;

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly player: PlayerState,
  ) {
    this._injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'enmity-panel';
    this.root.classList.add('enmity-hidden');

    const header = document.createElement('div');
    header.className = 'enmity-header';
    header.textContent = 'Threat';
    this.root.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'enmity-body';
    this.root.appendChild(this.body);

    uiRoot.appendChild(this.root);

    this.unsub = player.onChange(() => this._scheduleRefresh());
  }

  setTargetCallback(fn: (entityId: string) => void): void {
    this.onTargetClick = fn;
  }

  show(): void {
    this._visible = true;
    this._refresh();
  }

  hide(): void {
    this._visible = false;
    this.root.classList.add('enmity-hidden');
  }

  dispose(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.unsub?.();
    this.root.remove();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._refresh();
    });
  }

  private _refresh(): void {
    if (!this._visible) return;

    const list = this.player.enmityList;
    const inCombat = this.player.combat.inCombat;

    if (!inCombat || list.length === 0) {
      this.root.classList.add('enmity-hidden');
      this._lastEnmityKey = '';
      return;
    }

    this.root.classList.remove('enmity-hidden');

    // Sort: red first, then yellow, then blue
    const sorted = [...list].sort(
      (a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3),
    );

    // Skip DOM rebuild if the list hasn't changed
    const key = sorted.map(e => `${e.entityId}:${e.level}`).join('|');
    if (key === this._lastEnmityKey) return;
    this._lastEnmityKey = key;

    this.body.innerHTML = '';
    for (const entry of sorted) {
      const row = document.createElement('div');
      row.className = 'enmity-row';
      row.dataset.entityId = entry.entityId;

      const dot = document.createElement('span');
      dot.className = 'enmity-dot';
      dot.style.background = LEVEL_COLORS[entry.level] ?? '#888';

      const name = document.createElement('span');
      name.className = 'enmity-name';
      name.textContent = entry.name;

      row.appendChild(dot);
      row.appendChild(name);

      row.addEventListener('click', () => {
        this.onTargetClick?.(entry.entityId);
      });

      this.body.appendChild(row);
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('enmity-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'enmity-panel-styles';
    style.textContent = `
      #enmity-panel {
        position: fixed;
        top: 320px;
        right: 18px;
        width: 160px;
        background: rgba(8, 6, 4, 0.88);
        border: 1px solid rgba(200, 145, 60, 0.18);
        border-radius: 4px;
        z-index: 500;
        pointer-events: auto;
        transition: opacity 0.2s;
      }

      #enmity-panel.enmity-hidden {
        opacity: 0;
        pointer-events: none;
      }

      .enmity-header {
        padding: 4px 8px;
        font-family: var(--font-display, serif);
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(212, 201, 184, 0.45);
        border-bottom: 1px solid rgba(200, 145, 60, 0.1);
      }

      .enmity-body {
        padding: 2px 0;
        max-height: 200px;
        overflow-y: auto;
      }

      .enmity-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        cursor: pointer;
        transition: background 0.1s;
      }

      .enmity-row:hover {
        background: rgba(200, 145, 60, 0.12);
      }

      .enmity-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .enmity-name {
        font-family: var(--font-body, serif);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.8);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
    document.head.appendChild(style);
  }
}
