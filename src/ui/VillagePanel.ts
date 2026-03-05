import type { WorldState } from '@/state/WorldState';
import type { PlayerState } from '@/state/PlayerState';
import type { SocketClient } from '@/network/SocketClient';

/**
 * VillagePanel — HUD overlay shown when inside a village zone.
 *
 * Displays: village name, structure count, leave button, place button (owner only).
 * Uses the same dark semi-transparent aesthetic as the other UI panels.
 */
export class VillagePanel {
  private root: HTMLElement;
  private nameEl: HTMLElement | null = null;
  private visible = false;
  private cleanup: (() => void)[] = [];
  private onPlaceClick: (() => void) | null = null;

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly world:  WorldState,
    private readonly player: PlayerState,
    private readonly socket: SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubZone = world.onZoneChange(() => this._refresh());
    this.cleanup.push(unsubZone);
  }

  show(): void {
    if (!this.world.isVillage) return;
    this.visible = true;
    this.root.style.display = '';
    requestAnimationFrame(() => this.root.classList.add('vp-visible'));
    this._refresh();
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('vp-visible');
    this.root.style.display = 'none';
  }

  setPlaceCallback(fn: () => void): void {
    this.onPlaceClick = fn;
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  private _refresh(): void {
    if (!this.visible || !this.world.isVillage) {
      this.hide();
      return;
    }
    const zone = this.world.zone;
    if (this.nameEl && zone) {
      this.nameEl.textContent = zone.name || 'Village';
    }

    const isOwner = this.world.villageOwnerId === this.player.id;
    const placeBtn = this.root.querySelector('.vp-place-btn') as HTMLElement | null;
    if (placeBtn) {
      placeBtn.style.display = isOwner ? '' : 'none';
    }
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'village-panel';
    el.innerHTML = `
      <style>
        #village-panel {
          position: fixed;
          top: 60px;
          left: 50%;
          transform: translateX(-50%);
          display: none;
          opacity: 0;
          transition: opacity 0.3s ease;
          z-index: 250;
          pointer-events: none;
        }
        #village-panel.vp-visible { opacity: 1; }

        .vp-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          background: rgba(8, 6, 4, 0.82);
          border: 1px solid rgba(200, 145, 60, 0.30);
          border-radius: 4px;
          padding: 6px 16px;
          font-family: var(--font-body, serif);
          color: rgba(210, 185, 140, 0.95);
          font-size: 13px;
          pointer-events: auto;
          box-shadow: 0 2px 12px rgba(0,0,0,0.5);
        }

        .vp-name {
          font-size: 14px;
          font-weight: 600;
          color: rgba(240, 210, 150, 0.95);
          letter-spacing: 0.5px;
        }

        .vp-divider {
          width: 1px;
          height: 16px;
          background: rgba(200, 145, 60, 0.25);
        }

        .vp-btn {
          background: rgba(200, 145, 60, 0.15);
          border: 1px solid rgba(200, 145, 60, 0.30);
          border-radius: 3px;
          color: rgba(210, 185, 140, 0.90);
          padding: 3px 10px;
          font-size: 12px;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s, border-color 0.15s;
        }
        .vp-btn:hover {
          background: rgba(200, 145, 60, 0.30);
          border-color: rgba(200, 145, 60, 0.50);
        }
      </style>
      <div class="vp-bar">
        <span class="vp-name">Village</span>
        <div class="vp-divider"></div>
        <button class="vp-btn vp-place-btn" style="display:none">Place</button>
        <button class="vp-btn vp-leave-btn">Leave</button>
      </div>
    `;

    this.nameEl = el.querySelector('.vp-name');

    el.querySelector('.vp-leave-btn')?.addEventListener('click', () => {
      this.socket.sendCommand('/village leave');
    });

    el.querySelector('.vp-place-btn')?.addEventListener('click', () => {
      if (this.onPlaceClick) {
        this.onPlaceClick();
      } else {
        this.socket.sendCommand('/village catalog');
      }
    });

    return el;
  }
}
