import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { SocketClient }   from '@/network/SocketClient';
import type { Entity }         from '@/network/Protocol';

// How far to move the player when retreating (in server world units).
// Server coordinates are in metres; 1 m steps the player back one pace.
const RETREAT_UNITS = 2;

interface MenuItem {
  label:   string;
  visible: (e: Entity) => boolean;
  execute: (e: Entity) => void;
}

/**
 * TargetWindow — FFXI-style contextual action panel.
 *
 * Slides in from the top-right whenever a target is selected.
 * Shows the target's name, HP bar (if available), and a navigable
 * action list. Arrow keys move the cursor; Enter / click fires the action.
 */
export class TargetWindow {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _cursor  = 0;

  // Track which entity state last drove a menu build, so we skip it on HP/distance ticks
  private _menuKey: string = '';

  // Last target ID seen by _onTargetChange, so we only reset on an actual target swap
  private _lastTargetId: string | null = null;

  // ── Action definitions ────────────────────────────────────────────────────

  private readonly _menu: MenuItem[] = [
    {
      // Attack — mobs, wildlife, and any entity explicitly flagged hostile.
      // Uses the direct combat_action socket event so the combat system picks
      // it up immediately without routing through the text command pipeline.
      label:   'Attack',
      visible: e => !!(e.hostile || e.type === 'mob' || e.type === 'wildlife'),
      execute: e => this.socket.sendCombatAction('basic_attack', e.id),
    },
    {
      // Talk — NPCs and companions only; never mobs or wildlife.
      // Pass the entity name as the positional arg (for display) and the
      // entity ID as a named --id flag so the server can do a targeted LLM /
      // airlock lookup.  Message defaults to "Hello." server-side.
      label:   'Talk',
      visible: e => e.type === 'npc' || e.type === 'companion',
      execute: e => this.socket.sendCommand(`/talk "${e.name}" --id=${e.id}`),
    },
    {
      // Examine — always available.
      // Routed as /look <id> (/examine and /exam are aliases).
      label:   'Examine',
      visible: () => true,
      execute: e => this.socket.sendCommand(`/look ${e.id}`),
    },
    {
      label:   'Approach',
      visible: () => true,
      execute: e => this.socket.sendMovePosition(e.position, 'jog'),
    },
    {
      label:   'Retreat',
      visible: () => true,
      execute: e => {
        const pp = this.player.position;
        const ep = e.position;

        // Vector pointing away from the entity (XZ plane).
        const dx = pp.x - ep.x;
        const dz = pp.z - ep.z;
        const awayLen = Math.hypot(dx, dz) || 1;
        const awayX = dx / awayLen;
        const awayZ = dz / awayLen;

        // Vector pointing backward relative to the player's facing direction.
        // Server convention: heading 0° = North (+Z), 90° = East (+X).
        // Forward = (sin(h), 0, cos(h)), so backward = (-sin(h), 0, -cos(h)).
        const h = (this.player.heading * Math.PI) / 180;
        const backX = -Math.sin(h);
        const backZ = -Math.cos(h);

        // Blend the two vectors and normalise.
        const blendX = awayX + backX;
        const blendZ = awayZ + backZ;
        const blendLen = Math.hypot(blendX, blendZ) || 1;

        this.socket.sendMovePosition(
          {
            x: pp.x + (blendX / blendLen) * RETREAT_UNITS,
            y: pp.y,
            z: pp.z + (blendZ / blendLen) * RETREAT_UNITS,
          },
          'run',
        );
      },
    },
  ];

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(
    private readonly uiRoot:    HTMLElement,
    private readonly player:    PlayerState,
    private readonly entities:  EntityRegistry,
    private readonly socket:    SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubPlayer = player.onChange(() => this._onTargetChange());
    const unsubUpdate = entities.onUpdate(e => {
      if (e.id === player.targetId) this._refresh();
    });
    const unsubRemove = entities.onRemove(id => {
      if (id === player.targetId) player.clearTarget();
    });

    const onKey = (ev: KeyboardEvent) => this._onKey(ev);
    window.addEventListener('keydown', onKey);

    this.cleanup.push(
      unsubPlayer, unsubUpdate, unsubRemove,
      () => window.removeEventListener('keydown', onKey),
    );

    this._onTargetChange();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  show():    void { this.root.style.display = ''; }
  hide():    void { this.root.style.display = 'none'; }
  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'target-window';
    el.innerHTML = `
      <style>
        #target-window {
          position: fixed;
          /* Anchor at the right edge of the HUD's MP bar, expand up */
          bottom: 24px;
          left: calc(50% + min(250px, 45vw) + 10px);
          width: 200px;
          pointer-events: auto;
          user-select: none;

          /* Slide in from right */
          transition: transform 0.16s ease, opacity 0.16s ease;
        }

        #target-window.tw-hidden {
          transform: translateX(calc(100% + 24px));
          opacity: 0;
          pointer-events: none;
        }

        .tw-panel {
          background: rgba(8, 6, 4, 0.84);
          border: 1px solid rgba(200, 145, 60, 0.35);
          box-shadow:
            0 3px 14px rgba(0,0,0,0.65),
            inset 0 1px 0 rgba(255,200,100,0.04);
        }

        /* ── Header: name + HP ── */

        .tw-header {
          padding: 7px 10px 6px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.18);
        }

        .tw-name-row {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }

        .tw-name {
          font-family: var(--font-body);
          font-size: 15px;
          color: var(--ember, #c8823a);
          letter-spacing: 0.08em;
          font-style: italic;
          text-shadow: 0 1px 5px rgba(0,0,0,0.9);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }

        .tw-dist {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212, 190, 160, 0.55);
          white-space: nowrap;
          flex-shrink: 0;
          text-shadow: 0 1px 2px #000;
        }

        .tw-hp-row {
          margin-top: 5px;
          display: flex;
          align-items: center;
          gap: 7px;
        }

        .tw-hp-track {
          flex: 1;
          height: 6px;
          background: rgba(10,8,6,0.8);
          border: 1px solid rgba(180,60,40,0.25);
          position: relative;
          overflow: hidden;
        }

        .tw-hp-fill {
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, #5a0f0f, #8b2020);
          transform-origin: left;
          transition: transform 0.3s ease;
        }

        .tw-hp-pct {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212,190,160,0.75);
          min-width: 30px;
          text-align: right;
          text-shadow: 0 1px 2px #000;
          flex-shrink: 0;
        }

        /* ── Action list ── */

        .tw-menu {
          padding: 3px 0 4px;
        }

        .tw-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          font-family: var(--font-body);
          font-size: 14px;
          color: rgba(212, 201, 184, 0.82);
          letter-spacing: 0.04em;
          cursor: pointer;
          transition: background 0.08s;
        }

        .tw-item:hover,
        .tw-item.tw-active {
          background: rgba(200, 145, 60, 0.13);
          color: #e8cc88;
        }

        .tw-glyph {
          width: 10px;
          flex-shrink: 0;
          font-size: 10px;
          color: var(--ember, #c8823a);
          line-height: 1;
        }
      </style>

      <div class="tw-panel">
        <div class="tw-header">
          <div class="tw-name-row">
            <div class="tw-name" id="tw-name"></div>
            <div class="tw-dist" id="tw-dist"></div>
          </div>
          <div class="tw-hp-row" id="tw-hp-row">
            <div class="tw-hp-track">
              <div class="tw-hp-fill" id="tw-hp-fill"></div>
            </div>
            <div class="tw-hp-pct" id="tw-hp-pct"></div>
          </div>
        </div>
        <div class="tw-menu" id="tw-menu"></div>
      </div>
    `;
    return el;
  }

  // ── State updates ─────────────────────────────────────────────────────────

  private _onTargetChange(): void {
    const newId = this.player.targetId;

    if (!newId) {
      this.root.classList.add('tw-hidden');
      this._menuKey     = '';
      this._lastTargetId = null;
      return;
    }

    // Only reset cursor + force a menu rebuild when the target itself swaps.
    // All other player-state changes (health ticks, ATB, position, etc.) also
    // fire player.onChange, but those should just update the HP bar / distance
    // text — not nuke the user's cursor position and rebuild the DOM.
    if (newId !== this._lastTargetId) {
      this._cursor       = 0;
      this._menuKey      = '';
      this._lastTargetId = newId;
    }

    this._refresh();
    this.root.classList.remove('tw-hidden');
  }

  private _refresh(): void {
    const id = this.player.targetId;
    if (!id) return;

    const entity = this.entities.get(id);

    // Name
    const nameEl = this.root.querySelector<HTMLElement>('#tw-name')!;
    nameEl.textContent = entity?.name ?? this.player.targetName ?? '—';

    // Distance
    const distEl = this.root.querySelector<HTMLElement>('#tw-dist')!;
    if (entity) {
      const pp = this.player.position;
      const ep = entity.position;
      const dist = Math.hypot(ep.x - pp.x, ep.z - pp.z);
      distEl.textContent = `${dist.toFixed(1)}m`;
    } else {
      distEl.textContent = '';
    }

    // HP bar — update in-place (no DOM rebuild)
    const hpRow  = this.root.querySelector<HTMLElement>('#tw-hp-row')!;
    const hp     = entity?.health;
    if (hp && hp.max > 0) {
      const pct = Math.max(0, Math.min(1, hp.current / hp.max));
      this.root.querySelector<HTMLElement>('#tw-hp-fill')!.style.transform = `scaleX(${pct})`;
      this.root.querySelector<HTMLElement>('#tw-hp-pct')!.textContent      = `${Math.round(pct * 100)}%`;
      hpRow.style.display = '';
    } else {
      hpRow.style.display = 'none';
    }

    // Menu — only rebuild when the set of visible actions could have changed
    // (target swap, type change, or hostile flag change). HP/distance ticks skip this.
    const newKey = `${id}|${entity?.type ?? ''}|${entity?.hostile ?? false}|${entity?.isAlive ?? true}`;
    if (newKey !== this._menuKey) {
      this._menuKey = newKey;
      this._rebuildMenu(entity ?? null);
    }
  }

  private _rebuildMenu(entity: Entity | null): void {
    const menuEl = this.root.querySelector<HTMLElement>('#tw-menu')!;
    menuEl.innerHTML = '';

    const visible = entity
      ? this._menu.filter(m => m.visible(entity))
      : [this._menu.find(m => m.label === 'Examine')!];

    this._cursor = Math.min(this._cursor, Math.max(0, visible.length - 1));

    visible.forEach((item, i) => {
      const isActive = i === this._cursor;
      const row = document.createElement('div');
      row.className = 'tw-item' + (isActive ? ' tw-active' : '');

      const glyph = document.createElement('span');
      glyph.className = 'tw-glyph';
      glyph.textContent = isActive ? '▸' : '';

      const label = document.createElement('span');
      label.textContent = item.label;

      row.appendChild(glyph);
      row.appendChild(label);

      row.addEventListener('mouseenter', () => {
        this._cursor = i;
        this._updateCursor();
      });

      row.addEventListener('click', () => {
        // Always fetch live entity from registry so Approach (and all other
        // actions) use the entity's current position, not its position at the
        // time _rebuildMenu was called.
        const liveEntity = this.entities.get(this.player.targetId ?? '');
        if (liveEntity) item.execute(liveEntity);
      });

      menuEl.appendChild(row);
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  private _onKey(ev: KeyboardEvent): void {
    if (!this.player.targetId) return;
    // Don't steal keys when typing in the chat box
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const entity  = this.entities.get(this.player.targetId);
    const visible = entity
      ? this._menu.filter(m => m.visible(entity))
      : [];

    switch (ev.key) {
      case 'ArrowUp':
        ev.preventDefault();
        this._cursor = (this._cursor - 1 + visible.length) % visible.length;
        this._updateCursor();
        break;

      case 'ArrowDown':
        ev.preventDefault();
        this._cursor = (this._cursor + 1) % visible.length;
        this._updateCursor();
        break;

      case 'Enter':
      case 'NumpadEnter': {
        ev.preventDefault();
        const item = visible[this._cursor];
        if (item && entity) item.execute(entity);
        break;
      }

      case 'Escape':
        ev.preventDefault();
        this.player.clearTarget();
        break;
    }
  }

  private _updateCursor(): void {
    const items = this.root.querySelectorAll<HTMLElement>('.tw-item');
    items.forEach((el, i) => {
      const active = i === this._cursor;
      el.classList.toggle('tw-active', active);
      const glyph = el.querySelector<HTMLElement>('.tw-glyph');
      if (glyph) glyph.textContent = active ? '▸' : '';
    });
  }
}
