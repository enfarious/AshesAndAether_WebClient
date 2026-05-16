import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { SocketClient }   from '@/network/SocketClient';
import type { Entity }         from '@/network/Protocol';
import { ClientConfig }        from '@/config/ClientConfig';

/** How close the Approach button stops short of the target, in metres.
 *  Tuned for a melee-weapon-length gap — close enough to swing, not face-to-face. */
const APPROACH_STOP_DISTANCE = 1.5;

/** Interact button: outside this range the button is disabled.  Prevents
 *  cross-map exploit clicks while leaving plenty of room for normal play. */
const INTERACT_MAX_DISTANCE = 10;
/** Interact button: stop-and-fire distance after auto-approach. */
const INTERACT_FIRE_DISTANCE = 2;
/** Slack added to fire distance to tolerate path imperfections. */
const INTERACT_FIRE_SLACK = 0.5;
/** Cancel the pending interact if we haven't arrived in this long. */
const INTERACT_APPROACH_TIMEOUT_MS = 6000;
/** Polling cadence for the post-approach arrival check. */
const INTERACT_POLL_MS = 150;

interface MenuItem {
  label:    string;
  visible:  (e: Entity) => boolean;
  disabled?: (e: Entity) => boolean;
  execute:  (e: Entity) => void;
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
  /** When false, no item shows the ▸ / tw-active highlight. Used by the
   *  gamepad's targeted state so the cursor doesn't conflict with the
   *  ActionBar's slot-focus ring — only one is visible at a time. */
  private _cursorVisible = true;
  private _rafId: number | null = null;

  // Track which entity state last drove a menu build, so we skip it on HP/distance ticks
  private _menuKey: string = '';

  // Last target ID seen by _onTargetChange, so we only reset on an actual target swap
  private _lastTargetId: string | null = null;

  // Pending auto-approach-then-interact action.  Cleared on target swap, dispose,
  // arrival, or timeout.  Only one can be active at a time.
  private _pendingInteract: { targetId: string; intervalId: number } | null = null;

  // ── Action definitions ────────────────────────────────────────────────────

  private _marketToggle: (() => void) | null = null;
  setMarketToggle(fn: () => void): void { this._marketToggle = fn; }

  /** Bail out of the window-level arrow-key handler when a modal panel is
   *  open — otherwise the gamepad's modal-mode arrow-key dispatch moves both
   *  the modal cursor AND the TargetWindow cursor at the same time. */
  private _isModalOpen: (() => boolean) | null = null;
  setModalOpenCheck(fn: () => boolean): void { this._isModalOpen = fn; }

  /** Brief client-side spam guard after clicking Harvest. */
  private _harvestCooldown = false;

  private readonly _menu: MenuItem[] = [
    {
      // Attack — mobs, wildlife, and any entity explicitly flagged hostile.
      // Hidden when this entity is already our auto-attack target; the
      // Disengage item below takes its place so the same row toggles between
      // engage/disengage based on combat state.
      label:   'Attack',
      visible: e => (
        !!(e.hostile || e.type === 'mob' || e.type === 'wildlife')
        && this.player.combat.autoAttackTarget !== e.id
      ),
      execute: e => {
        this.socket.sendCombatAction('basic_attack', e.id);
        // Committing to attack also commits to the target — lock it so the
        // auto-attack loop survives accidental d-pad cycling / misclicks.
        // Gated by ClientConfig.attackAutoLock (Settings → Controls).
        if (ClientConfig.attackAutoLock && !this.player.targetLocked) {
          this.player.toggleTargetLock();
        }
      },
    },
    {
      // Disengage — appears in place of Attack when we're auto-attacking this
      // entity. Sends a synthetic 'disengage' abilityId that the server's
      // handleCombatAction handles by clearing autoAttackTarget.
      label:   'Disengage',
      visible: e => (
        !!(e.hostile || e.type === 'mob' || e.type === 'wildlife')
        && this.player.combat.autoAttackTarget === e.id
      ),
      execute: e => this.socket.sendCombatAction('disengage', e.id),
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
      // Tell — whisper to a player.
      label:   'Tell',
      visible: e => e.type === 'player',
      execute: e => {
        const input = document.getElementById('chat-input') as HTMLInputElement | null;
        if (input) {
          input.value = `/tell ${e.name} `;
          input.focus();
          // Move caret to end so the player can start typing immediately.
          input.setSelectionRange(input.value.length, input.value.length);
        }
      },
    },
    {
      // Invite — invite a player to your party.
      label:    'Invite',
      visible:  e => e.type === 'player',
      disabled: e => this.player.partyMembers.some(m => m.id === e.id),
      execute:  e => this.socket.sendCommand(`/party invite ${e.name}`),
    },
    {
      // Enter Dungeon — scripted_object dungeon entrances.
      // Sends /vault enter which triggers key consumption + zone transfer.
      label:   'Enter Dungeon',
      visible: e => e.type === 'scripted_object' && e.interactive !== false && /dungeon/i.test(e.name),
      execute: _e => this.socket.sendCommand('/vault enter'),
    },
    {
      // Leave Vault — exit portal spawned on vault completion.
      label:   'Leave Vault',
      visible: e => e.tag === 'vault_exit_portal',
      execute: _e => this.socket.sendCommand('/vault leave'),
    },
    {
      // Market — opens market panel when targeting a market stall structure.
      label:   'Market',
      visible: e => e.type === 'structure' && /market\s*stall/i.test(e.name),
      execute: _e => this._marketToggle?.(),
    },
    {
      // Harvest — plants only (interactive + alive).
      label:    'Harvest',
      visible:  e => e.type === 'plant' && e.interactive !== false && e.isAlive !== false,
      disabled: () => this._harvestCooldown,
      execute:  e => {
        this.socket.sendCommand(`/harvest ${e.id}`);
        this._harvestCooldown = true;
        setTimeout(() => {
          this._harvestCooldown = false;
          this._menuKey = '';  // force rebuild to re-enable
          this._refresh();
        }, 2000);
      },
    },
    {
      // Interact — generic fallback for interactive entities (structures,
      // scripted objects, items, etc.). Mirrors the F-key proximity-interact
      // socket call ('use'). Disabled past 10 m so the button can't be used
      // to fire interactions across the map. Within 10 m, auto-approaches to
      // 2 m and fires the interact on arrival.
      label:   'Interact',
      visible: e => (
        e.interactive !== false
        && e.type !== 'mob'
        && e.type !== 'wildlife'
        && e.type !== 'player'
      ),
      disabled: e => this._distanceTo(e) > INTERACT_MAX_DISTANCE,
      execute: e => {
        const dist = this._distanceTo(e);
        if (dist > INTERACT_MAX_DISTANCE) return;  // belt & suspenders past the disabled gate

        if (dist <= INTERACT_FIRE_DISTANCE + INTERACT_FIRE_SLACK) {
          // Already in range — fire directly.
          this.socket.sendInteract(e.id, 'use');
          return;
        }

        // Mid-range: send a move command toward a point INTERACT_FIRE_DISTANCE
        // short of the target, then poll for arrival and fire the interact.
        this._cancelPendingInteract();

        const pp = this.player.position;
        const ep = e.position;
        const dx = ep.x - pp.x;
        const dz = ep.z - pp.z;
        const t = (dist - INTERACT_FIRE_DISTANCE) / dist;
        this.socket.sendMovePosition({
          x: pp.x + dx * t,
          y: ep.y,
          z: pp.z + dz * t,
        }, 'jog');

        const targetId = e.id;
        const startedAt = Date.now();
        const intervalId = window.setInterval(() => {
          // Bail if the player switched targets or it was cleared.
          if (this.player.targetId !== targetId) {
            this._cancelPendingInteract();
            return;
          }
          // Bail if the entity vanished (died, despawned, OOR).
          const tgt = this.entities.get(targetId);
          if (!tgt?.position) {
            this._cancelPendingInteract();
            return;
          }
          // Bail on timeout — player got stuck or path is taking too long.
          if (Date.now() - startedAt > INTERACT_APPROACH_TIMEOUT_MS) {
            this._cancelPendingInteract();
            return;
          }
          // Fire when in range.
          const ddx = tgt.position.x - this.player.position.x;
          const ddz = tgt.position.z - this.player.position.z;
          if (Math.hypot(ddx, ddz) <= INTERACT_FIRE_DISTANCE + INTERACT_FIRE_SLACK) {
            this.socket.sendInteract(targetId, 'use');
            this._cancelPendingInteract();
          }
        }, INTERACT_POLL_MS);

        this._pendingInteract = { targetId, intervalId };
      },
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
      execute: e => {
        const pp = this.player.position;
        const ep = e.position;
        const dx = ep.x - pp.x;
        const dz = ep.z - pp.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= APPROACH_STOP_DISTANCE) return;  // already close enough
        const t = (dist - APPROACH_STOP_DISTANCE) / dist;
        this.socket.sendMovePosition({
          x: pp.x + dx * t,
          y: ep.y,
          z: pp.z + dz * t,
        }, 'jog');
      },
    },
    {
      label:   'Retreat',
      visible: () => true,
      // Routes through the canonical /retreat back slash command — server
      // does the burst dash with stamina + cast cancel + collision resolve.
      // Same path the spacebar double-tap takes; one source of truth.
      execute: _e => this.socket.sendCommand('/retreat back'),
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

    this.root.querySelector('#tw-lock')!.addEventListener('click', () => {
      this.player.toggleTargetLock();
    });

    const unsubPlayer = player.onChange(() => this._scheduleRefresh());
    const unsubUpdate = entities.onUpdate(e => {
      if (e.id === player.targetId) {
        // Auto-clear target when the targeted entity dies
        if (e.isAlive === false) { player.clearTarget(); return; }
        this._scheduleRefresh();
      }
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
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._cancelPendingInteract();
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

        /* AbilityArming sub-target picker — pulse the panel border so the
         * player sees which entity their D-pad is walking through. Colour
         * tracks kind: amber for enemy, green for ally. */
        @keyframes tw-pick-pulse-enemy {
          0%, 100% { box-shadow: 0 0 0 1px rgba(220, 80, 60, 0.55), 0 0 14px rgba(220, 80, 60, 0.45); }
          50%      { box-shadow: 0 0 0 1px rgba(220, 80, 60, 0.95), 0 0 22px rgba(220, 80, 60, 0.75); }
        }
        @keyframes tw-pick-pulse-ally {
          0%, 100% { box-shadow: 0 0 0 1px rgba(110, 200, 130, 0.55), 0 0 14px rgba(110, 200, 130, 0.45); }
          50%      { box-shadow: 0 0 0 1px rgba(110, 200, 130, 0.95), 0 0 22px rgba(110, 200, 130, 0.75); }
        }
        body.aa-picking-enemy #target-window .tw-panel {
          animation: tw-pick-pulse-enemy 0.9s ease-in-out infinite;
          border-color: rgba(220, 80, 60, 0.85);
        }
        body.aa-picking-ally  #target-window .tw-panel {
          animation: tw-pick-pulse-ally  0.9s ease-in-out infinite;
          border-color: rgba(110, 200, 130, 0.85);
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

        .tw-lock {
          flex-shrink: 0;
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          cursor: pointer;
          color: rgba(212, 190, 160, 0.35);
          border: 1px solid rgba(200, 145, 60, 0.15);
          border-radius: 3px;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
          background: transparent;
          line-height: 1;
        }

        .tw-lock:hover {
          color: rgba(212, 190, 160, 0.65);
          border-color: rgba(200, 145, 60, 0.35);
        }

        .tw-lock.tw-locked {
          color: var(--ember, #c8823a);
          border-color: rgba(200, 145, 60, 0.5);
          background: rgba(200, 145, 60, 0.1);
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

        .tw-item.tw-disabled {
          color: rgba(212, 201, 184, 0.28);
          cursor: default;
          pointer-events: none;
        }
      </style>

      <div class="tw-panel">
        <div class="tw-header">
          <div class="tw-name-row">
            <div class="tw-name" id="tw-name"></div>
            <div class="tw-dist" id="tw-dist"></div>
            <div class="tw-lock" id="tw-lock" title="Target lock (L)">&#x1f513;</div>
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

  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._onTargetChange();
    });
  }

  private _onTargetChange(): void {
    const newId = this.player.targetId;

    // Any target swap (or clear) cancels an in-flight auto-approach interact.
    if (newId !== this._pendingInteract?.targetId) {
      this._cancelPendingInteract();
    }

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

    // Lock icon
    const lockEl = this.root.querySelector<HTMLElement>('#tw-lock')!;
    const locked = this.player.targetLocked;
    lockEl.classList.toggle('tw-locked', locked);
    lockEl.innerHTML = locked ? '&#x1f512;' : '&#x1f513;';

    // Menu — only rebuild when the set of visible actions could have changed
    // (target swap, type change, hostile flag change, crossing the Interact
    // range threshold, or engaging/disengaging auto-attack on this entity).
    // HP/distance-within-band ticks skip this.
    const inParty = entity ? this.player.partyMembers.some(m => m.id === entity.id) : false;
    const inInteractRange = entity ? this._distanceTo(entity) <= INTERACT_MAX_DISTANCE : false;
    const isAutoAttackTarget = entity ? this.player.combat.autoAttackTarget === entity.id : false;
    const newKey = `${id}|${entity?.type ?? ''}|${entity?.hostile ?? false}|${entity?.isAlive ?? true}|${entity?.interactive ?? ''}|${inParty}|${inInteractRange}|${isAutoAttackTarget}`;
    if (newKey !== this._menuKey) {
      this._menuKey = newKey;
      this._rebuildMenu(entity ?? null);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _distanceTo(e: Entity): number {
    if (!e.position) return Infinity;
    const dx = e.position.x - this.player.position.x;
    const dz = e.position.z - this.player.position.z;
    return Math.hypot(dx, dz);
  }

  private _cancelPendingInteract(): void {
    if (!this._pendingInteract) return;
    clearInterval(this._pendingInteract.intervalId);
    this._pendingInteract = null;
  }

  private _rebuildMenu(entity: Entity | null): void {
    const menuEl = this.root.querySelector<HTMLElement>('#tw-menu')!;
    menuEl.innerHTML = '';

    const visible = entity
      ? this._menu.filter(m => m.visible(entity))
      : [this._menu.find(m => m.label === 'Examine')!];

    this._cursor = Math.min(this._cursor, Math.max(0, visible.length - 1));

    visible.forEach((item, i) => {
      const isActive  = this._cursorVisible && i === this._cursor;
      const isDisabled = entity ? (item.disabled?.(entity) ?? false) : false;
      const row = document.createElement('div');
      row.className = 'tw-item'
        + (isActive ? ' tw-active' : '')
        + (isDisabled ? ' tw-disabled' : '');

      const glyph = document.createElement('span');
      glyph.className = 'tw-glyph';
      glyph.textContent = isActive ? '▸' : '';

      const label = document.createElement('span');
      label.textContent = item.label;

      row.appendChild(glyph);
      row.appendChild(label);

      if (!isDisabled) {
        row.addEventListener('mouseenter', () => {
          this._cursorVisible = true;
          this._cursor = i;
          this._updateCursor();
        });

        row.addEventListener('click', () => {
          const liveEntity = this.entities.get(this.player.targetId ?? '');
          if (liveEntity) item.execute(liveEntity);
        });
      }

      menuEl.appendChild(row);
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  private _onKey(ev: KeyboardEvent): void {
    if (!this.player.targetId) return;
    // Don't steal keys when typing in the chat box
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Yield to modals — when the gamepad dispatches arrow keys to drive a
    // panel cursor, this handler must not also move the target-action cursor.
    if (this._isModalOpen?.()) return;

    switch (ev.key) {
      case 'ArrowUp':    ev.preventDefault(); this.cursorUp();    break;
      case 'ArrowDown':  ev.preventDefault(); this.cursorDown();  break;
      case 'Enter':
      case 'NumpadEnter': ev.preventDefault(); this.activate();   break;
      case 'Escape':     ev.preventDefault(); this.player.clearTarget(); break;
    }
  }

  // ── Public cursor API ─────────────────────────────────────────────────────
  // Wraps the keyboard-handler logic so gamepad / state-machine layers can
  // drive the cursor without faking key events. Wired in via the gamepad
  // controller's `targeted` state (d-pad U/D + fb3 activate).

  cursorUp(): void {
    const visible = this._visibleMenu();
    if (visible.length === 0) return;
    this._cursorVisible = true;
    this._cursor = (this._cursor - 1 + visible.length) % visible.length;
    this._updateCursor();
  }

  cursorDown(): void {
    const visible = this._visibleMenu();
    if (visible.length === 0) return;
    this._cursorVisible = true;
    this._cursor = (this._cursor + 1) % visible.length;
    this._updateCursor();
  }

  /** Hide the cursor highlight without losing the cursor position. Used when
   *  the gamepad d-pad shifts to the ActionBar so only one focus is visible. */
  hideCursor(): void {
    if (!this._cursorVisible) return;
    this._cursorVisible = false;
    this._updateCursor();
  }

  /** Restore the cursor highlight at its current position. */
  showCursor(): void {
    if (this._cursorVisible) return;
    this._cursorVisible = true;
    this._updateCursor();
  }

  activate(): void {
    const tid = this.player.targetId;
    if (!tid) return;
    const entity = this.entities.get(tid);
    if (!entity) return;
    const visible = this._menu.filter(m => m.visible(entity));
    const item = visible[this._cursor];
    if (item && !(item.disabled?.(entity))) item.execute(entity);
  }

  private _visibleMenu(): MenuItem[] {
    if (!this.player.targetId) return [];
    const entity = this.entities.get(this.player.targetId);
    return entity ? this._menu.filter(m => m.visible(entity)) : [];
  }

  private _updateCursor(): void {
    const items = this.root.querySelectorAll<HTMLElement>('.tw-item');
    items.forEach((el, i) => {
      const active = this._cursorVisible && i === this._cursor;
      el.classList.toggle('tw-active', active);
      const glyph = el.querySelector<HTMLElement>('.tw-glyph');
      if (glyph) glyph.textContent = active ? '▸' : '';
    });
  }
}
