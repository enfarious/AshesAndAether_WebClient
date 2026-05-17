import type { OrbitCamera }    from '@/camera/OrbitCamera';
import type { SocketClient }   from '@/network/SocketClient';
import type { PlayerState }    from '@/state/PlayerState';
import type { PlayerEntity }   from '@/entities/PlayerEntity';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { EntityFactory }  from '@/entities/EntityFactory';
import { SPEED_MULTIPLIERS }   from '@/network/Protocol';
import { resolveMovement as resolveLockOnMovement } from '@/input/LockOnMovement';

/** F-key proximity-interact range, metres. */
const F_INTERACT_RANGE = 5;
const F_INTERACT_RANGE_SQ = F_INTERACT_RANGE * F_INTERACT_RANGE;

/**
 * WASDController — keyboard movement + camera rotation.
 *
 * W / S   — move forward / backward (relative to camera heading)
 * A / D   — strafe left / right     (relative to camera heading)
 * Q / E   — rotate camera left / right
 *
 * Movement uses **continuous** server commands: the first press sends a
 * heading + speed to start the server moving; subsequent updates at ~10 Hz
 * act as heading changes + heartbeats.  The server keeps walking until it
 * receives an explicit stop or the heartbeat times out (~300 ms).
 *
 * The client runs parallel prediction by calling PlayerEntity.drivePosition()
 * directly each frame.  When keys are released, stopWASD() is called and the
 * entity smoothly reconciles to the server position.
 *
 * Camera rotation runs every frame (dt-scaled) for fluid response.
 */

const QE_SPEED         = 1.8;   // camera yaw speed, radians / second
const PITCH_SPEED      = 50;    // camera pitch speed, degrees / second
const ZOOM_SPEED       = 30;    // camera zoom speed, units / second
const FALLBACK_SPEED_MPS = 12.95; // conservative default: 7 m/s base x 1.85 sprint multiplier
const HEADING_RESEND   = 3;     // degrees — resend heading if direction changed more than this
const SEND_INTERVAL_MS = 100;   // min gap between heading sends (10 Hz)
/** Local-prediction "moment of inertia" ramp. Each fresh movement burst
 *  starts at INERTIA_RAMP_FROM × predicted speed and linearly ramps to 1.0
 *  over INERTIA_RAMP_MS. Animation feel: takes a beat to get up to speed.
 *  Side benefit: closes most of the client-prediction-ahead-of-server gap
 *  during the first frame after movement starts. */
const INERTIA_RAMP_MS   = 150;
const INERTIA_RAMP_FROM = 0.5;
/** Mirrors server `DASH_DISTANCE_M` in Zone.ts. Used for the local snap
 *  prediction so the leap-dash visual lands instantly on second-tap. */
const DASH_DISTANCE_M = 5;
/** Mirrors server `JUMP_STAMINA_COST` and `DASH_STAMINA_COST` in Zone.ts.
 *  Used to gate the local jump arc + dash-snap so we don't visually teleport
 *  on actions the server will reject for stamina reasons. */
const JUMP_STAMINA_COST = 5;
const DASH_STAMINA_COST = 20;

export class WASDController {
  private held              = new Set<string>();
  private lastSendAt        = 0;
  private lastSentHeading   = -999; // impossible heading -> forces first send
  private isMoving          = false;

  /** Walk-mode toggle (z key / `/walk`). When true, default WASD speed is
   *  `walk` instead of `jog`. Shift-hold still overrides to `sprint`. */
  private walkMode          = false;
  /** Last sent speed tier — used to force a resend when the tier changes
   *  (e.g. release Shift mid-run, or toggle walk-mode). */
  private lastSentTier: 'walk' | 'jog' | 'sprint' = 'jog';
  /** Wall-clock when the current movement burst started. Resets every time
   *  `_localX` gets seeded fresh (i.e. after stop / jump-end). Used to
   *  compute the inertia-ramp factor. */
  private _movementStartedAt = 0;

  /** Client-predicted local position while movement keys are held. */
  private _localX: number | null = null;
  private _localY: number | null = null;
  private _localZ: number | null = null;

  /** Direct reference to the player entity for driving position. */
  private _playerEntity: PlayerEntity | null = null;

  private inventoryToggle:      (() => void) | null = null;
  private abilityToggle:        (() => void) | null = null;
  private characterSheetToggle: (() => void) | null = null;
  private activitiesToggle:     (() => void) | null = null;
  /** Returns true if a harvestable glint is within range of the player.
   *  Used by F-key as a fallback action when no interactable entity is
   *  nearby — keeps F as the universal "do the contextual thing" key. */
  private getHarvestableInRange: (() => boolean) | null = null;
  /** Returns true if a lootable own-corpse is within 3 m. Higher priority
   *  than harvest in the F-key fallback so /loot beats /harvest when both
   *  are in range. */
  private getLootableCorpseInRange: (() => boolean) | null = null;
  /** Returns true while the local player is mid-caravan-ride. Used to
   *  suppress all proximity-based F-key behaviour — the player's
   *  PlayerState.position is frozen at ride start (server suppresses
   *  per-tick broadcasts during the ride), so any proximity scan would
   *  report stale "near terminal" / "near corpse" / etc. and surface
   *  prompts for things the player can't actually interact with. */
  private getCaravanRiding:    (() => boolean) | null = null;
  private partyToggle:          (() => void) | null = null;
  private abilitySlotCallback:  ((slotIndex: number) => void) | null = null;
  private marketToggle:         (() => void) | null = null;
  private worldMapToggle:       (() => void) | null = null;
  private guildToggle:          (() => void) | null = null;
  private travelToggle:         (() => void) | null = null;
  private companionToggle:      (() => void) | null = null;
  private buildToggle:              (() => void) | null = null;
  private settingsToggle:           (() => void) | null = null;
  private tabTargetNext:            (() => void) | null = null;
  private tabTargetPrev:            (() => void) | null = null;
  private partyTargetSlotCallback:  ((slot: number) => void) | null = null;
  private partyTargetNext:          (() => void) | null = null;
  private partyTargetPrev:          (() => void) | null = null;
  private layoutEditToggle:         (() => void) | null = null;
  private layoutEditActive:         (() => boolean) | null = null;
  private toggleFocusOnTarget:      (() => void) | null = null;

  setInventoryToggle(fn: () => void):      void { this.inventoryToggle      = fn; }
  setAbilityToggle(fn: () => void):        void { this.abilityToggle        = fn; }
  setCharacterSheetToggle(fn: () => void): void { this.characterSheetToggle = fn; }
  setActivitiesToggle(fn: () => void):     void { this.activitiesToggle     = fn; }

  /** Wire the harvest-in-range probe so F-key can fall back to /harvest. */
  setHarvestableProbe(fn: () => boolean): void { this.getHarvestableInRange = fn; }
  /** Wire the lootable-corpse probe so F-key can fall back to /loot. */
  setLootableCorpseProbe(fn: () => boolean): void { this.getLootableCorpseInRange = fn; }
  /** Wire the caravan-riding probe so F-key + prompts can suppress
   *  while the player is on a ride (their position is stale). */
  setCaravanRidingProbe(fn: () => boolean): void { this.getCaravanRiding = fn; }
  setPartyToggle(fn: () => void):          void { this.partyToggle          = fn; }
  setAbilitySlotCallback(fn: (slotIndex: number) => void): void { this.abilitySlotCallback = fn; }
  setMarketToggle(fn: () => void):         void { this.marketToggle         = fn; }
  setWorldMapToggle(fn: () => void):       void { this.worldMapToggle       = fn; }
  setGuildToggle(fn: () => void):          void { this.guildToggle          = fn; }
  setTravelToggle(fn: () => void):         void { this.travelToggle         = fn; }
  setCompanionToggle(fn: () => void):    void { this.companionToggle      = fn; }
  setBuildToggle(fn: () => void):       void { this.buildToggle          = fn; }
  setSettingsToggle(fn: () => void):   void { this.settingsToggle       = fn; }
  setTabTargetNext(fn: () => void):        void { this.tabTargetNext        = fn; }
  setTabTargetPrev(fn: () => void):        void { this.tabTargetPrev        = fn; }
  setPartyTargetSlotCallback(fn: (slot: number) => void): void { this.partyTargetSlotCallback = fn; }
  setPartyTargetNext(fn: () => void):      void { this.partyTargetNext      = fn; }
  setPartyTargetPrev(fn: () => void):      void { this.partyTargetPrev      = fn; }
  setLayoutEditToggle(fn: () => void):     void { this.layoutEditToggle     = fn; }
  setLayoutEditActive(fn: () => boolean):  void { this.layoutEditActive     = fn; }
  setToggleFocusOnTarget(fn: () => void):  void { this.toggleFocusOnTarget  = fn; }

  /** Wire the player entity after EntityFactory creates it. */
  setPlayerEntity(pe: PlayerEntity | null): void { this._playerEntity = pe; }

  constructor(
    private readonly camera:   OrbitCamera,
    private readonly socket:   SocketClient,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly factory:  EntityFactory,
  ) {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  // ── Called once per frame from App._loop ───────────────────────────────────

  tick(dt: number): void {
    // Suppress all movement / camera input while layout edit mode is active.
    if (this.layoutEditActive?.()) return;

    // Q / E — smooth camera yaw (every frame, dt-scaled). Arrow keys are
    // reserved for TargetWindow menu navigation — use Q/E for camera or the
    // mouse for free look.
    if (this.held.has('q')) this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('e')) this.camera.addYaw(-QE_SPEED * dt);

    // +/- — keyboard zoom
    if (this.held.has('=') || this.held.has('+')) this.camera.addZoom(+ZOOM_SPEED * dt);
    if (this.held.has('-'))                       this.camera.addZoom(-ZOOM_SPEED * dt);

    // Gate on isAlive / isRotationLocked — stunned or mid-cast bails
    // entirely (no input registered). Rooted alone is handled below: input
    // accepted but only the rotation half is applied locally.
    if (!this.player.isAlive || this.player.isRotationLocked) {
      if (this.isMoving) {
        this.socket.sendMoveStop(this._predictedFinalPosition());
        this.isMoving = false;
        this.lastSentHeading = -999;
      }
      if (this._localX !== null) {
        this._localX = this._localY = this._localZ = null;
        this._playerEntity?.stopWASD();
      }
      return;
    }

    // Build a [-1..1] input vector from held keys
    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);

    if (inputX === 0 && inputZ === 0) {
      // No movement keys — stop server movement and clear prediction. Pass
      // the locally-predicted final position so the server can absorb it as
      // authoritative within tolerance, killing the RTT-snap-back when IDLE
      // mode takes over and lerps to a stale server position.
      if (this.isMoving) {
        this.socket.sendMoveStop(this._predictedFinalPosition());
        this.isMoving = false;
        this.lastSentHeading = -999;
      }
      if (this._localX !== null) {
        this._localX = this._localY = this._localZ = null;
        this._playerEntity?.stopWASD();
      }
      return;
    }

    // Resolve input → world-space direction. Lock-on mode flips this from
    // camera-relative to target-relative when the player has a locked target
    // (see LockOnMovement). `lockFacing` is non-null only in lock-on; it's
    // the heading the body should face independent of movement direction.
    const yaw = this.camera.getYaw();
    const resolved = resolveLockOnMovement(inputX, inputZ, this.player, this.factory, yaw);
    const { worldX, worldZ } = resolved;
    const lockFacing = resolved.facingHeadingDeg;

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    // ── Client-side prediction ───────────────────────────────────────────────
    // During a jump the entity is in JUMPING mode (set by playJump) which
    // runs its own captured-velocity prediction. We must NOT call drivePosition
    // here — that would flip the mode back to WASD and clobber the arc.
    // Just clear our prediction state so the next post-jump frame re-seeds
    // cleanly from wherever the entity actually landed.
    //
    // Rooted (without stun/cast — those return above) skips position
    // prediction too. Heading prediction still runs below so the model can
    // pivot in place even though server won't move it.
    const movementLocked = this.player.isMovementLocked;
    if (this._playerEntity?.isJumping || movementLocked) {
      if (this._localX !== null) {
        this._localX = this._localY = this._localZ = null;
      }
      if (movementLocked && !this._playerEntity?.isJumping) {
        // Tell the entity we're no longer driving WASD position so it
        // returns to IDLE-mode lerp from whatever the server says.
        this._playerEntity?.stopWASD();
      }
    } else {
      // Seed from entity position on the first frame of each movement burst.
      if (this._localX === null && this._playerEntity) {
        const p = this._playerEntity.object3d.position;
        this._localX = p.x;
        this._localY = p.y;
        this._localZ = p.z;
        this._movementStartedAt = performance.now();
      }

      if (this._localX !== null && this._localY !== null && this._localZ !== null) {
        // Advance local position at the server's actual speed this frame,
        // scaled by the inertia ramp during the first INERTIA_RAMP_MS of
        // each fresh burst. Linear from INERTIA_RAMP_FROM → 1.0.
        const elapsedMs = performance.now() - this._movementStartedAt;
        const ramp = elapsedMs >= INERTIA_RAMP_MS
          ? 1.0
          : INERTIA_RAMP_FROM + (1 - INERTIA_RAMP_FROM) * (elapsedMs / INERTIA_RAMP_MS);
        const speedMPS = (this.player.movementSpeedMPS || FALLBACK_SPEED_MPS) * ramp;
        this._localX += normX * speedMPS * dt;
        this._localZ += normZ * speedMPS * dt;
        // Y tracks server for terrain height
        this._localY = this.player.position.y;

        // Drive the entity directly — no intermediary
        this._playerEntity?.drivePosition(this._localX, this._localY, this._localZ);
      }
    }

    // ── Continuous server send ──────────────────────────────────────────────────
    // Convert world direction to heading (degrees).  Server convention:
    //   heading 0 = +Z (south), increases clockwise -> atan2(X, Z).
    let headingDeg = Math.atan2(normX, normZ) * (180 / Math.PI);
    if (headingDeg < 0) headingDeg += 360;

    // Local rotation prediction — apply heading every frame the player has
    // an input direction. The model otherwise only rotates when the server's
    // state_update lands (~10Hz, async, sometimes dropped for own player),
    // so the visible facing lagged or stuck mid-strafe. With prediction the
    // forward arrow tracks camera+input at full framerate.
    //
    // Lock-on: facing decouples from movement direction. Body always points
    // at the locked target while WASD strafes/backpedals. Server still gets
    // the movement-direction heading (it uses heading as the velocity
    // vector), so other players currently see facing = movement direction.
    // A proper fix would split movement + facing on the wire; until then,
    // local override is the cheapest path to the right feel.
    this._playerEntity?.setHeading(lockFacing ?? headingDeg);

    // Tier resolution (priority: sprint hold > walk mode > jog default).
    // Shift-hold also keeps the cap rolling — when stamina hits 0 the server
    // clamps back to jog automatically; we keep sending 'sprint' so it
    // resumes as soon as stamina regens.
    const wantSprint: boolean = this.held.has('shift');
    const tier: 'walk' | 'jog' | 'sprint' =
      wantSprint        ? 'sprint' :
      this.walkMode     ? 'walk'   :
                          'jog';

    const now = Date.now();
    const headingDelta = Math.abs(headingDeg - this.lastSentHeading);
    // Wrap-around-safe delta (e.g. 359 -> 1 = 2, not 358)
    const wrappedDelta = Math.min(headingDelta, 360 - headingDelta);

    // Send immediately on start, on heading change, on tier change, or every
    // 100 ms as heartbeat.
    const shouldSend = !this.isMoving
      || wrappedDelta > HEADING_RESEND
      || tier !== this.lastSentTier
      || now - this.lastSendAt >= SEND_INTERVAL_MS;

    if (shouldSend) {
      this.socket.sendMoveContinuous(headingDeg, tier);
      this.lastSentHeading = headingDeg;
      this.lastSentTier    = tier;
      this.lastSendAt      = now;
      this.isMoving        = true;
    }
  }

  /** Toggle walk mode (z key / `/walk`). Default WASD becomes `walk` instead of
   *  `jog`; Shift-hold still overrides to `sprint`. Public so app-layer slash
   *  command handlers can flip it from chat input. */
  toggleWalkMode(): boolean {
    this.walkMode = !this.walkMode;
    // Force an immediate resend on next tick so the tier change is reflected.
    this.lastSentTier = this.walkMode ? 'jog' : 'walk';
    return this.walkMode;
  }

  /** Read-only walkMode flag — used by HUD indicators and `/sprint` command. */
  get isWalkMode(): boolean { return this.walkMode; }

  /** Force walkMode off (called by `/sprint` slash command). */
  clearWalkMode(): void {
    if (this.walkMode) {
      this.walkMode = false;
      this.lastSentTier = 'walk'; // force resend
    }
  }

  /** Reset client-side WASD prediction state. Called after a server-driven
   *  position teleport (dash, /retreat) so the next tick re-seeds `_localX`
   *  from the entity's new position rather than continuing to drive forward
   *  from the pre-dash _localX. Without this, drivePosition would yank the
   *  entity back to where it was before the dash. */
  clearPrediction(): void {
    this._localX = this._localY = this._localZ = null;
    this.lastSentHeading = -999;  // force a fresh heading send next tick
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this.held.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent): void => {
    // Don't steal keys from text inputs / chat
    if (this._isTyping(e.target)) return;
    // Guard against synthetic or non-standard events with no key value
    if (!e.key) return;

    // Prevent browser scrolling for arrow keys and +/-
    const key = e.key.toLowerCase();
    if (key.startsWith('arrow') || key === '=' || key === '+' || key === '-') {
      e.preventDefault();
    }

    // F10 — toggle layout editor
    if (key === 'f10') {
      e.preventDefault();
      this.layoutEditToggle?.();
      return;
    }

    // While layout edit is active, swallow all other game keys
    if (this.layoutEditActive?.()) return;

    // Tab — cycle targets. Ctrl branch hits party/companion; default branch
    // walks hostile enemies. Shift reverses direction in either case.
    //
    // Caveat: Tauri (Edge WebView2) and many browsers swallow Ctrl+Tab for
    // tab/focus traversal — the modifier never reaches the page. The
    // backtick fallback below is the reliable ally-cycle keybind.
    if (key === 'tab') {
      e.preventDefault();
      if (e.ctrlKey) {
        if (e.shiftKey) this.partyTargetPrev?.();
        else            this.partyTargetNext?.();
      } else {
        if (e.shiftKey) this.tabTargetPrev?.();
        else            this.tabTargetNext?.();
      }
      return;
    }

    // ` / ~ — ally cycle (works in Tauri where Ctrl+Tab is swallowed).
    // Plain ` advances forward; Shift+` (~) goes backward. e.key reports
    // the literal char so we match both shifted and unshifted forms.
    if (key === '`' || key === '~') {
      e.preventDefault();
      if (e.shiftKey) this.partyTargetPrev?.();
      else            this.partyTargetNext?.();
      return;
    }

    // F1-F8 — target party member by slot
    if (key.startsWith('f') && key.length <= 2) {
      const fNum = parseInt(key.slice(1), 10);
      if (fNum >= 1 && fNum <= 8) {
        e.preventDefault();
        this.partyTargetSlotCallback?.(fNum - 1);
        return;
      }
    }

    // Ctrl+ArrowUp / Ctrl+ArrowDown — cycle party targets
    if (e.ctrlKey && (key === 'arrowup' || key === 'arrowdown')) {
      e.preventDefault();
      if (key === 'arrowup') this.partyTargetPrev?.();
      else                   this.partyTargetNext?.();
      return;
    }

    // Ctrl+F — toggle focus on the current main target (sticky sub-target).
    // App layer validates that the target is a friendly non-self entity;
    // this keybind is just a dispatcher.
    if (e.ctrlKey && key === 'f') {
      e.preventDefault();
      this.toggleFocusOnTarget?.();
      return;
    }

    // Spacebar — fire /jump immediately. Dash lives on V (see below) so the
    // jump path no longer waits on a double-tap window.
    if (key === ' ' && !e.repeat) {
      e.preventDefault();
      // Already mid-air — silently swallow so a second press doesn't fire
      // a fresh local arc or send /jump (which the server will reject too).
      if (this._playerEntity?.isJumping) return;
      // Capture from LOCAL INPUT, not round-tripped server state. Reading
      // `this.player.movementSpeedMPS` here would lag by RTT + tick (~150–
      // 300ms after movement starts) — pressing space within that window
      // would capture 0 and produce a straight-up arc while the server
      // (which has the WASD message processed by then) arcs forward,
      // resulting in the "vertical first, horizontal kicks in late" feel.
      // Computing from held keys + camera yaw + tier-speed mirrors what
      // the server captures from the same WASD message.
      const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
      const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);
      let velX = 0;
      let velZ = 0;
      if (inputX !== 0 || inputZ !== 0) {
        const yaw    = this.camera.getYaw();
        const { worldX, worldZ } = resolveLockOnMovement(inputX, inputZ, this.player, this.factory, yaw);
        const len    = Math.hypot(worldX, worldZ);
        if (len > 0) {
          const tier: 'walk' | 'jog' | 'sprint' =
            this.held.has('shift') ? 'sprint' :
            this.walkMode          ? 'walk'   :
                                     'jog';
          const speedMPS = this.player.baseMovementSpeed * SPEED_MULTIPLIERS[tier];
          velX = (worldX / len) * speedMPS;
          velZ = (worldZ / len) * speedMPS;
        }
      }
      // Only kick off the local Y arc + JUMPING-mode prediction when we
      // have the stamina the server will require. Without this, a no-
      // stamina jump triggers the visual but the server rejects, and
      // the prediction fights server's WASD-mode broadcasts until the
      // arc duration ends.
      if (this.player.stamina.current >= JUMP_STAMINA_COST) {
        this._playerEntity?.playJump(velX, velZ);
      }
      this.socket.sendCommand('/jump');
      return;
    }

    // V — dash (/retreat <dir>). Direction comes from currently-held WASD;
    // falls back to facing if idle. Decoupled from /jump so neither hitches
    // waiting on the other.
    if (key === 'v' && !e.repeat) {
      e.preventDefault();
      this.triggerDash(this._currentDirectionFromHeld());
      return;
    }

    // H — respawn when dead
    if (key === 'h' && !this.player.isAlive) {
      this.socket.sendRespawn();
      return;
    }

    // I — toggle inventory
    if (key === 'i') {
      this.inventoryToggle?.();
      return;
    }

    // K — toggle ability tree
    if (key === 'k') {
      this.abilityToggle?.();
      return;
    }

    // C — toggle character sheet
    if (key === 'c') {
      this.characterSheetToggle?.();
      return;
    }

    // O — toggle activities / social panel (current activities + future
    // social hub). 'J' is reserved for the future Journal panel
    // (missions, jobs, lore). Settings has been demoted to menu-only
    // access since it's not something players touch mid-session.
    if (key === 'o') {
      this.activitiesToggle?.();
      return;
    }

    // P — toggle party window
    if (key === 'p') {
      this.partyToggle?.();
      return;
    }

    // L — toggle target lock-on
    if (key === 'l') {
      this.player.toggleTargetLock();
      return;
    }

    // F — universal contextual interact. Priority order:
    //   1. Nearest interactive entity (door, NPC, dais, etc) within 5 m
    //   2. Harvestable glint within range → /harvest
    //   3. Promote current target → focus target
    if (key === 'f') {
      // F is a no-op while on a caravan ride. All proximity probes lie
      // (PlayerState position is frozen at ride start) so loot/harvest
      // fallbacks would also misfire. Player has /dismount, jump, and
      // WASD to leave the ride.
      if (this.getCaravanRiding?.()) return;
      const nearest = this.findNearestInteractable();
      if (nearest) {
        this.socket.sendInteract(nearest.id, 'use');
      } else if (this.getLootableCorpseInRange?.()) {
        this.socket.sendCommand('/loot');
      } else if (this.getHarvestableInRange?.()) {
        this.socket.sendCommand('/harvest');
      } else {
        this.player.focusCurrentTarget();
      }
      return;
    }

    // G — toggle guild panel
    if (key === 'g') {
      this.guildToggle?.();
      return;
    }

    // N — toggle companion panel
    if (key === 'n') {
      this.companionToggle?.();
      return;
    }

    // B — toggle build panel (village owner only — checked in app.ts callback)
    if (key === 'b') {
      this.buildToggle?.();
      return;
    }

    // Ctrl+M — toggle market panel
    if (e.ctrlKey && key === 'm') {
      e.preventDefault();
      this.marketToggle?.();
      return;
    }

    // M — toggle world map (plain M without Ctrl)
    if (key === 'm' && !e.ctrlKey) {
      this.worldMapToggle?.();
      return;
    }

    // R — travel routes panel
    if (key === 'r' && !e.ctrlKey && !e.shiftKey) {
      this.travelToggle?.();
      return;
    }

    // Settings has no global hotkey — accessible only via the SystemMenu
    // (◇ Settings) since it's not something players touch mid-session.
    // The setter remains wired for future use if we change our mind.

    // Z — toggle walk mode. Default WASD speed becomes 'walk' instead of
    // 'jog'; Shift-hold still overrides to 'sprint'. The slash command
    // mirror lets the server log/echo the toggle and keeps slash-commands-
    // first parity for future text clients.
    if (key === 'z' && !e.ctrlKey && !e.shiftKey) {
      this.toggleWalkMode();
      this.socket.sendCommand('/walk');
      return;
    }

    // Escape — cancel the in-flight cast. Server's /castcancel handler
    // breaks the cast (MP gone, GCD fires). No-op if not casting. Per the
    // slash-commands-first rule, this is a thin keybind around the
    // canonical /castcancel command.
    if (key === 'escape') {
      e.preventDefault();
      this.socket.sendCommand('/castcancel');
      return;
    }

    // 1-8 — action bar ability slots
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 8) {
      this.abilitySlotCallback?.(num - 1);
      return;
    }

    this.held.add(e.key.toLowerCase());
  };

  private _onKeyUp = (e: KeyboardEvent): void => {
    if (e.key) this.held.delete(e.key.toLowerCase());
  };

  private _isTyping(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return (
      el instanceof HTMLInputElement    ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable
    );
  }

  /** Build a Vector3 from the active local prediction, or undefined if we
   *  haven't predicted this burst yet. Used to ship the visually-final
   *  position with sendMoveStop so the server can absorb it as ground truth
   *  rather than reverting to its tick-quantized authoritative position. */
  private _predictedFinalPosition(): { x: number; y: number; z: number } | undefined {
    if (this._localX === null || this._localY === null || this._localZ === null) return undefined;
    return { x: this._localX, y: this._localY, z: this._localZ };
  }

  /** Locally snap the entity DASH_DISTANCE_M in `direction` ('forward' or
   *  'back') from current rendered position. World direction is computed
   *  from currently-held WASD + camera yaw — same math as the heading sent
   *  to the server, so the local snap lands at (or within RTT-tolerance of)
   *  where the server's dash will resolve. Server's confirming player_dash
   *  event re-snaps to the authoritative position; if it's within the
   *  settle filter's drift threshold, the correction is invisible. */
  private _localDashSnap(direction: string): void {
    if (!this._playerEntity) return;
    let dirX = 0;
    let dirZ = 0;

    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);

    if (inputX !== 0 || inputZ !== 0) {
      const yaw    = this.camera.getYaw();
      const { worldX, worldZ } = resolveLockOnMovement(inputX, inputZ, this.player, this.factory, yaw);
      const len    = Math.hypot(worldX, worldZ);
      if (len > 0) {
        dirX = worldX / len;
        dirZ = worldZ / len;
      }
    } else {
      // No keys held → 'back' relative to last facing.
      const headingRad = this.player.heading * Math.PI / 180;
      dirX = -Math.sin(headingRad);
      dirZ = -Math.cos(headingRad);
    }

    // Sign flips for 'back' even if WASD is held — keeps the keyword's
    // semantics intact for any future caller that might pass 'back'.
    const sign = direction === 'back' ? -1 : 1;
    const cur = this._playerEntity.object3d.position;
    this._playerEntity.snapTo(cur.x + dirX * DASH_DISTANCE_M * sign,
                              cur.z + dirZ * DASH_DISTANCE_M * sign);
  }

  /** Pick a /retreat direction from currently-held WASD. Returns 'forward'
   *  for any movement input, else 'back'.
   *
   *  Why not literal 'left'/'right'? Server's retreatDirectionVector reads
   *  arg names as **player-facing-relative** (left = perpendicular to
   *  player.heading). But the user's intent is **camera-relative** (A = my
   *  movement direction is left-of-camera). Since player.heading is updated
   *  on every WASD send to the player's current movement direction, the two
   *  conventions reconcile by always asking the server for 'forward' — that
   *  *is* the direction the player is currently moving in world coords.
   *
   *  Example with default camera (yaw 0, looking south):
   *    Hold A → heading 270° (player faces west) → /retreat forward = west ✓
   *    (Old code: /retreat left → server computes left-of-west = north,
   *     which happened to be camera-forward, hence the "all dashes bump
   *     toward W" symptom.) */
  private _currentDirectionFromHeld(): string {
    if (this.held.has('w') || this.held.has('a') || this.held.has('s') || this.held.has('d')) {
      return 'forward';
    }
    return 'back';
  }

  /** Public dash trigger so the gamepad path can share the local-snap + stamina
   *  gate with the V-key handler. Caller passes 'forward' or 'back'. */
  triggerDash(direction: string): void {
    this.socket.sendCommand(`/retreat ${direction}`);
    if (this.player.stamina.current >= DASH_STAMINA_COST) {
      this._localDashSnap(direction);
    }
  }

  /**
   * Find the nearest F-keyable entity within F_INTERACT_RANGE of the
   * player. Requires `interactionKind` — `interactive: true` alone is the
   * click-target flag (every mob has it) and is NOT enough to light up
   * the [F] prompt. Used by the F-key proximity-interact path AND the
   * HUD prompt — both read the same scan so they stay in sync.
   */
  findNearestInteractable(): import('@/network/Protocol').Entity | null {
    // Caravan rider's PlayerState.position is frozen at ride start because
    // the server suppresses per-tick broadcasts for the rider. Any
    // proximity scan against that stale position would surface bogus
    // prompts (the terminal we boarded at stays "in range" the whole
    // ride). Bail out entirely.
    if (this.getCaravanRiding?.()) return null;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    let best: import('@/network/Protocol').Entity | null = null;
    let bestDistSq = Infinity;
    for (const e of this.entities.getAll()) {
      if (!e.interactionKind) continue;
      if (e.id === this.player.id) continue;
      if (!e.position) continue;
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq > F_INTERACT_RANGE_SQ) continue;
      if (distSq < bestDistSq) {
        best = e;
        bestDistSq = distSq;
      }
    }
    return best;
  }
}
