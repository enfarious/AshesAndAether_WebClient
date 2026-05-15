import type { OrbitCamera }  from '@/camera/OrbitCamera';
import type { SocketClient } from '@/network/SocketClient';
import type { PlayerState }  from '@/state/PlayerState';
import type { PlayerEntity } from '@/entities/PlayerEntity';
import type { GamepadBindings, GamepadAction } from '@/input/GamepadBindings';
import { SPEED_MULTIPLIERS } from '@/network/Protocol';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * GamepadController — Xbox / PS / Switch Pro controller input.
 *
 * Dual-mode:
 *   - **Browser**: uses the standard Gamepad API (navigator.getGamepads)
 *   - **Tauri**:   receives native gilrs state via Tauri events (WebView2
 *                  doesn't expose the Gamepad API)
 *
 * Input state machine (Phase 2):
 *   ┌──────────┬─────────────────────────────┬─────────────────────────┐
 *   │  state   │  d-pad                      │  fb2 / fb3              │
 *   ├──────────┼─────────────────────────────┼─────────────────────────┤
 *   │  modal   │  arrow-key events to top    │  Esc / Enter            │
 *   │  targeted│  U/D = TargetWindow cursor  │  fb2 unlocks            │
 *   │          │  L/R = ActionBar slot focus │  fb3 activates cursor   │
 *   │          │        (Phase 3)            │        (Phase 3 fires)  │
 *   │  idle    │  L/R hostile cycle          │  fb3 locks current      │
 *   │          │  U/D party cycle            │  fb2 no-op              │
 *   └──────────┴─────────────────────────────┴─────────────────────────┘
 *
 * Face buttons (always):
 *   fb1 = jump     (synthesizes Space keydown — WASDController owns the path)
 *   fb4 = interact (synthesizes F keydown      — WASDController owns the path)
 */

// ── Toast helper ─────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
    padding: '8px 18px', background: 'rgba(30,24,16,0.92)', color: '#c8a46e',
    border: '1px solid #c8a46e44', borderRadius: '4px', fontFamily: 'serif',
    fontSize: '14px', zIndex: '9999', opacity: '0',
    transition: 'opacity 0.3s ease',
    pointerEvents: 'none',
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

// ── Constants ────────────────────────────────────────────────────────────────

const STICK_DEADZONE      = 0.15;
/** Magnitude above which the stick sends 'jog' instead of 'walk'. The range
 *  below this (between deadzone and threshold) maps to walk so the player can
 *  sneak / position deliberately with a partial stick tilt. */
const JOG_THRESHOLD       = 0.75;
/** Time after rest→motion during which the tier is clamped to walk regardless
 *  of stick magnitude. Filters the transient peak in the physical stick swing
 *  so pushing forward doesn't flash jog → walk as the stick settles. Sprint
 *  button bypasses (explicit player intent). */
const STARTUP_SETTLE_MS   = 120;
const SEND_INTERVAL_MS    = 100;   // 10 Hz heartbeat
const HEADING_RESEND      = 3;     // degrees
const FALLBACK_SPEED_MPS  = 17.5;
const CAM_YAW_SPEED       = 2.5;   // rad/s at full deflection
const CAM_PITCH_SPEED     = 60;    // deg/s at full deflection
const DPAD_REPEAT_DELAY   = 400;   // ms before first repeat
const DPAD_REPEAT_RATE    = 150;   // ms between subsequent repeats

// Standard-mapping d-pad indices (state-routed, never user-rebindable).
const DPAD_UP    = 12;
const DPAD_DOWN  = 13;
const DPAD_LEFT  = 14;
const DPAD_RIGHT = 15;

// ── Snapshot shape (common to both sources) ──────────────────────────────────

interface GamepadSnapshot {
  axes: readonly number[];       // [leftX, leftY, rightX, rightY]
  buttons: readonly boolean[];   // standard 16-button layout
}

// ── State ────────────────────────────────────────────────────────────────────

type InputState = 'idle' | 'modal' | 'targeted' | 'arming';

// ── Class ────────────────────────────────────────────────────────────────────

export class GamepadController {
  // Browser-mode state
  private _gamepadIndex: number | null = null;

  // Tauri-mode state
  private _useTauri    = false;
  private _tauriState: GamepadSnapshot | null = null;
  private _tauriCleanup: (() => void)[] = [];

  // Movement state (mirrors WASDController)
  private _isMoving        = false;
  private _lastSendAt      = 0;
  private _lastSentHeading = -999;
  private _lastSentTier: 'walk' | 'jog' | 'sprint' = 'jog';
  private _lastSentMagnitude = 1;

  // Sprint-as-toggle state. Only consulted when ClientConfig.sprintToggleMode
  // is true; press flips, movement-stop / out-of-stamina clears.
  private _sprintToggleOn = false;
  // Wall-clock time of the most recent rest→motion transition. Used to gate
  // the walk-only settle window so transient stick peaks don't flash jog.
  private _moveStartedAt = 0;
  private _localX: number | null = null;
  private _localY: number | null = null;
  private _localZ: number | null = null;
  private _playerEntity: PlayerEntity | null = null;

  // D-pad edge-detection + repeat
  private _prevDpad:      [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private _dpadHeldSince: [number, number, number, number]     = [0, 0, 0, 0];
  private _dpadLastFire:  [number, number, number, number]     = [0, 0, 0, 0];

  // Edge-detection for ALL bindable button indices (no repeat — single-shot
  // per press). Tracked by raw index so action rebinds don't lose state.
  private _prevButtonState: boolean[] = new Array(20).fill(false);

  // Callbacks — d-pad (idle state)
  private _isMenuOpen:       (() => boolean) | null = null;
  private _layoutEditActive: (() => boolean) | null = null;
  private _tabTargetNext:    (() => void) | null = null;
  private _tabTargetPrev:    (() => void) | null = null;
  private _partyTargetNext:  (() => void) | null = null;
  private _partyTargetPrev:  (() => void) | null = null;

  // Callbacks — d-pad (targeted state)
  private _targetCursorUp:    (() => void) | null = null;
  private _targetCursorDown:  (() => void) | null = null;
  private _actionSlotPrev:    (() => void) | null = null;  // Phase 3 stub
  private _actionSlotNext:    (() => void) | null = null;  // Phase 3 stub

  // Callbacks — face buttons (state-routed inside the controller).
  // Lock and unlock live on the dedicated `lock_toggle` action. confirm in
  // idle still fires the TargetWindow selection (e.g. Attack) so the player
  // can engage without committing to a lock first.
  private _onConfirmTargetWindow: (() => void) | null = null;  // confirm: targeted U/D OR idle
  private _onConfirmActionBar:    (() => void) | null = null;  // confirm: targeted L/R
  private _onLockToggle:          (() => void) | null = null;  // dedicated lock/unlock
  private _onConfirmArming:       (() => void) | null = null;  // fb3 while armed
  private _onCancelArming:        (() => void) | null = null;  // fb2 while armed
  private _isArming:              (() => boolean) | null = null;
  private _onSlotShortcut:        ((slotIdx: number) => void) | null = null;
  private _onDash:                ((direction: 'forward' | 'back') => void) | null = null;

  // Fired once on the rising edge into `targeted` state. App layer uses this
  // to reset surface visuals (show TargetWindow cursor, clear ActionBar focus)
  // so the player starts on a clean default each lock cycle.
  private _onEnterTargeted:       (() => void) | null = null;

  // Tracks which axis the player most-recently moved in the `targeted` state.
  // fb3 fires on whichever surface had focus last (TargetWindow vs. ActionBar).
  // Resets to 'ud' on lock so the first fb3 always hits the TargetWindow action.
  private _lastTargetedAxis: 'ud' | 'lr' = 'ud';
  private _wasTargeted = false;

  // ── Setters ──────────────────────────────────────────────────────────────

  setPlayerEntity(pe: PlayerEntity | null): void { this._playerEntity = pe; }
  setIsMenuOpen(fn: () => boolean): void          { this._isMenuOpen = fn; }
  setLayoutEditActive(fn: () => boolean): void    { this._layoutEditActive = fn; }

  // d-pad (idle)
  setTabTargetNext(fn: () => void): void   { this._tabTargetNext = fn; }
  setTabTargetPrev(fn: () => void): void   { this._tabTargetPrev = fn; }
  setPartyTargetNext(fn: () => void): void { this._partyTargetNext = fn; }
  setPartyTargetPrev(fn: () => void): void { this._partyTargetPrev = fn; }

  // d-pad (targeted)
  setTargetCursorUp(fn: () => void): void   { this._targetCursorUp = fn; }
  setTargetCursorDown(fn: () => void): void { this._targetCursorDown = fn; }
  setActionSlotPrev(fn: () => void): void   { this._actionSlotPrev = fn; }
  setActionSlotNext(fn: () => void): void   { this._actionSlotNext = fn; }

  // face buttons (state-routed)
  setOnConfirmTargetWindow(fn: () => void): void { this._onConfirmTargetWindow = fn; }
  setOnConfirmActionBar(fn: () => void): void    { this._onConfirmActionBar = fn; }
  setOnLockToggle(fn: () => void): void          { this._onLockToggle = fn; }

  // arming state — highest priority, overrides any other state read
  setIsArming(fn: () => boolean): void           { this._isArming = fn; }
  setOnConfirmArming(fn: () => void): void       { this._onConfirmArming = fn; }
  setOnCancelArming(fn: () => void): void        { this._onCancelArming = fn; }

  // ARPG-shortcut: L2 / R2 held + fb[1-4] = direct slot fire, bypassing arming.
  setOnSlotShortcut(fn: (slotIdx: number) => void): void { this._onSlotShortcut = fn; }

  // Fires once on the rising edge into `targeted` state.
  setOnEnterTargeted(fn: () => void): void { this._onEnterTargeted = fn; }

  // Dash — gamepad can't synthesize V because WASD's V handler reads the
  // `held` set for direction, which the stick doesn't populate. Route through
  // a direct callback so we can pass 'forward' (stick deflected) vs 'back'
  // (stick idle, retreat-from-heading).
  setOnDash(fn: (direction: 'forward' | 'back') => void): void { this._onDash = fn; }

  constructor(
    private readonly camera: OrbitCamera,
    private readonly socket: SocketClient,
    private readonly player: PlayerState,
    private readonly bindings: GamepadBindings,
  ) {
    // Detect Tauri — if present, use native gilrs events instead of browser API
    if ((window as any).__TAURI_INTERNALS__) {
      this._initTauri();
    } else {
      window.addEventListener('gamepadconnected',    this._onBrowserConnect);
      window.addEventListener('gamepaddisconnected', this._onBrowserDisconnect);
      // Pick up controllers already connected before page load
      this._scanExisting();
    }
  }

  // ── State derivation ─────────────────────────────────────────────────────

  private _state(): InputState {
    // Arming wins over everything — once the player fb3'd a slot, all input
    // routes through the confirm/abort flow until they fire or cancel.
    if (this._isArming?.()) return 'arming';
    if (this._isMenuOpen?.()) return 'modal';
    if (this.player.targetLocked) return 'targeted';
    return 'idle';
  }

  // ── Called once per frame from App._loop ─────────────────────────────────

  tick(dt: number): void {
    if (this._layoutEditActive?.()) return;

    const snap = this._readGamepad();
    if (!snap) return;

    // ── Right stick → camera ──────────────────────────────────────────────
    const rx = snap.axes[2] ?? 0;
    const ry = snap.axes[3] ?? 0;
    const rMag = Math.hypot(rx, ry);
    if (rMag > STICK_DEADZONE) {
      this.camera.addYaw(-rx * CAM_YAW_SPEED * dt);
      this.camera.addPitch(-ry * CAM_PITCH_SPEED * dt);
    }

    // Rebind capture intercepts the next bindable press and suppresses all
    // other input for the duration. Lives at the top of the tick so settings
    // UI gets first crack before any state-routed handler can react.
    if (this.bindings.capturingAction() !== null) {
      for (let i = 0; i < snap.buttons.length; i++) {
        const cur = snap.buttons[i] ?? false;
        const prev = this._prevButtonState[i] ?? false;
        if (cur && !prev) {
          if (this.bindings.applyCapture(i)) break;
        }
      }
      this._updateAllPrev(snap);
      return;
    }

    // Snapshot state once — buttons read in this frame all resolve against it.
    const state = this._state();

    // Reset last-touched axis on entry to `targeted` so the first fb3 fires
    // the TargetWindow action (Attack/Talk by default). Subsequent L/R will
    // flip it to ActionBar focus. App layer also resets surface visuals via
    // _onEnterTargeted.
    if (state === 'targeted' && !this._wasTargeted) {
      this._lastTargetedAxis = 'ud';
      this._onEnterTargeted?.();
    }
    this._wasTargeted = state === 'targeted';

    // ── D-pad + face buttons ──────────────────────────────────────────────
    this._tickDpad(snap, state);
    this._tickFaceButtons(snap, state);

    // ── Rotation-locked gate (stunned / mid-cast) ───────────────────────
    if (!this.player.isAlive || this.player.isRotationLocked) {
      this._stopMovement();
      return;
    }

    // ── Left stick → movement ─────────────────────────────────────────────
    const lx = snap.axes[0] ?? 0;
    const ly = snap.axes[1] ?? 0;
    const lMag = Math.hypot(lx, ly);

    if (lMag < STICK_DEADZONE) {
      this._stopMovement();
      return;
    }

    // Normalize and invert Y (stick up = -1, but we want forward = +Z input)
    const nx = lx / lMag;
    const nz = -ly / lMag;

    // Rotate by camera yaw → world-space (identical to WASDController)
    const yaw    = this.camera.getYaw();
    const worldX =  nx * Math.cos(yaw) - nz * Math.sin(yaw);
    const worldZ = -nx * Math.sin(yaw) - nz * Math.cos(yaw);

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    // ── Tier resolution (must precede prediction so local speed matches sent tier) ──
    // Sprint button overrides stick magnitude; otherwise partial deflection
    // (deadzone..JOG_THRESHOLD) = walk, deeper = jog. Settle window clamps
    // walk for STARTUP_SETTLE_MS after rest→motion so the stick's physical
    // swing peak doesn't flash jog.
    //
    // Sprint mode: hold = live button state; toggle = latched _sprintToggleOn.
    // Toggle auto-releases on stamina depletion so a regen doesn't auto-sprint.
    if (this._sprintToggleOn && this.player.stamina.current <= 0) {
      this._sprintToggleOn = false;
    }
    const sprintHeld = snap.buttons[this.bindings.get('sprint')] ?? false;
    const sprintRequested = ClientConfig.sprintToggleMode
      ? this._sprintToggleOn
      : sprintHeld;

    const now = Date.now();

    if (!this._isMoving) this._moveStartedAt = now;
    const inSettleWindow = now - this._moveStartedAt < STARTUP_SETTLE_MS;

    const tier: 'walk' | 'jog' | 'sprint' =
      sprintRequested                            ? 'sprint' :
      inSettleWindow || lMag < JOG_THRESHOLD     ? 'walk'   :
                                                   'jog';

    // Analog magnitude in the jog band — server interpolates speed from walk
    // up to jog. Below JOG_THRESHOLD we're already in walk tier (flat speed);
    // sprint is a button (always 1.0). Result: smooth speed ramp through the
    // top quarter of the stick range without a discrete walk→jog step.
    const jogBand = Math.max(0, (lMag - JOG_THRESHOLD) / (1 - JOG_THRESHOLD));
    const magnitude = tier === 'jog' ? Math.min(1, jogBand) : 1;

    // ── Client-side prediction ────────────────────────────────────────────
    // Compute predicted speed from tier + magnitude directly. Using
    // player.movementSpeedMPS here would lag by RTT — the server echoes the
    // new speed only after we send the tier — so the local entity would keep
    // gliding at the prior tier's speed until then. Mirrors WASDController's
    // jump-velocity capture.
    const baseSpeed = this.player.baseMovementSpeed || (FALLBACK_SPEED_MPS / SPEED_MULTIPLIERS['sprint']);
    const walkMult  = SPEED_MULTIPLIERS['walk'];
    const tierMult  = SPEED_MULTIPLIERS[tier];
    const effectiveMult = tier === 'jog'
      ? walkMult + magnitude * (tierMult - walkMult)
      : tierMult;
    const speedMPS  = baseSpeed * effectiveMult;

    if (this._localX === null && this._playerEntity) {
      const p = this._playerEntity.object3d.position;
      this._localX = p.x;
      this._localY = p.y;
      this._localZ = p.z;
    }

    if (this._localX !== null && this._localY !== null && this._localZ !== null) {
      this._localX += normX * speedMPS * dt;
      this._localZ += normZ * speedMPS * dt;
      this._localY  = this.player.position.y;
      this._playerEntity?.drivePosition(this._localX, this._localY, this._localZ);
    }

    // ── Continuous server send ─────────────────────────────────────────────
    let headingDeg = Math.atan2(normX, normZ) * (180 / Math.PI);
    if (headingDeg < 0) headingDeg += 360;

    // Local rotation prediction — same fix WASDController applied at
    // line 280. Without this, the model only rotates when the server's
    // 10Hz state_update echoes back, so the visible facing snaps on stop
    // instead of tracking the stick.
    this._playerEntity?.setHeading(headingDeg);

    const headingDelta = Math.abs(headingDeg - this._lastSentHeading);
    const wrappedDelta = Math.min(headingDelta, 360 - headingDelta);

    const shouldSend = !this._isMoving
      || wrappedDelta > HEADING_RESEND
      || tier !== this._lastSentTier
      || Math.abs(magnitude - this._lastSentMagnitude) > 0.05
      || now - this._lastSendAt >= SEND_INTERVAL_MS;

    if (shouldSend) {
      this.socket.sendMoveContinuous(headingDeg, tier, magnitude);
      this._lastSentHeading   = headingDeg;
      this._lastSentTier      = tier;
      this._lastSentMagnitude = magnitude;
      this._lastSendAt        = now;
      this._isMoving          = true;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    window.removeEventListener('gamepadconnected',    this._onBrowserConnect);
    window.removeEventListener('gamepaddisconnected', this._onBrowserDisconnect);
    this._tauriCleanup.forEach(fn => fn());
    this._tauriCleanup = [];
    this._stopMovement();
  }

  // ── Read abstraction ──────────────────────────────────────────────────

  /** Returns a snapshot of the active gamepad, or null if none connected. */
  private _readGamepad(): GamepadSnapshot | null {
    if (this._useTauri) {
      return this._tauriState;
    }
    if (this._gamepadIndex === null) return null;
    const gp = navigator.getGamepads()[this._gamepadIndex];
    if (!gp) return null;
    return {
      axes: gp.axes,
      buttons: Array.from(gp.buttons, b => b.pressed),
    };
  }

  // ── Tauri (native gilrs) ──────────────────────────────────────────────

  private _initTauri(): void {
    this._useTauri = true;
    // Dynamic import so the browser build doesn't bundle @tauri-apps/api
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ axes: number[]; buttons: boolean[] }>('gamepad-state', (ev) => {
        this._tauriState = ev.payload;
      }).then(unlisten => this._tauriCleanup.push(unlisten));

      listen<{ id: string }>('gamepad-connected', (ev) => {
        console.log(`[Gamepad] Connected (native): ${ev.payload.id}`);
        showToast(`🎮 ${ev.payload.id}`);
      }).then(unlisten => this._tauriCleanup.push(unlisten));

      listen('gamepad-disconnected', () => {
        console.log('[Gamepad] Disconnected (native)');
        showToast('🎮 Controller disconnected');
        this._tauriState = null;
        this._stopMovement();
        this._prevDpad = [false, false, false, false];
        this._prevButtonState.fill(false);
      }).then(unlisten => this._tauriCleanup.push(unlisten));
    });
  }

  // ── Browser (standard Gamepad API) ────────────────────────────────────

  private _scanExisting(): void {
    const gamepads = navigator.getGamepads();
    for (const gp of gamepads) {
      if (gp) {
        this._gamepadIndex = gp.index;
        if (gp.mapping !== 'standard') {
          console.warn(`[Gamepad] Non-standard mapping — buttons may be misaligned: ${gp.id}`);
        }
        console.log(`[Gamepad] Already connected: ${gp.id} (index ${gp.index})`);
        showToast(`🎮 ${gp.id}`);
        break;
      }
    }
  }

  private _onBrowserConnect = (e: GamepadEvent): void => {
    if (this._gamepadIndex !== null) return;
    this._gamepadIndex = e.gamepad.index;
    if (e.gamepad.mapping !== 'standard') {
      console.warn(`[Gamepad] Non-standard mapping — buttons may be misaligned: ${e.gamepad.id}`);
    }
    console.log(`[Gamepad] Connected: ${e.gamepad.id} (index ${e.gamepad.index})`);
    showToast(`🎮 ${e.gamepad.id}`);
  };

  private _onBrowserDisconnect = (e: GamepadEvent): void => {
    if (e.gamepad.index !== this._gamepadIndex) return;
    console.log(`[Gamepad] Disconnected: ${e.gamepad.id}`);
    showToast('🎮 Controller disconnected');
    this._stopMovement();
    this._gamepadIndex = null;
    this._prevDpad = [false, false, false, false];
    this._prevButtonState.fill(false);
  };

  // ── Movement ──────────────────────────────────────────────────────────

  private _stopMovement(): void {
    if (this._isMoving) {
      // Pass the locally-predicted final position so the server can absorb
      // it as authoritative within tolerance — kills the RTT-snap-back when
      // IDLE mode takes over. Mirrors WASDController.
      const finalPos = (this._localX !== null && this._localY !== null && this._localZ !== null)
        ? { x: this._localX, y: this._localY, z: this._localZ }
        : undefined;
      this.socket.sendMoveStop(finalPos);
      this._isMoving = false;
      this._lastSentHeading = -999;
      this._lastSentTier = 'jog';
      this._lastSentMagnitude = 1;
      // Drop the sprint latch — next sprint must be re-pressed.
      this._sprintToggleOn = false;
    }
    if (this._localX !== null) {
      this._localX = this._localY = this._localZ = null;
      this._playerEntity?.stopWASD();
    }
  }

  // ── D-pad ─────────────────────────────────────────────────────────────

  private _tickDpad(snap: GamepadSnapshot, state: InputState): void {
    const pressed: [boolean, boolean, boolean, boolean] = [
      snap.buttons[DPAD_UP]    ?? false,
      snap.buttons[DPAD_DOWN]  ?? false,
      snap.buttons[DPAD_LEFT]  ?? false,
      snap.buttons[DPAD_RIGHT] ?? false,
    ];


    if (state === 'arming') {
      // No cycling yet (Phase 4 ships self-cast confirm only). d-pad ignored.
    } else if (state === 'modal') {
      this._dpadButton(0, pressed[0], () => this._dispatchKey('ArrowUp'));
      this._dpadButton(1, pressed[1], () => this._dispatchKey('ArrowDown'));
      this._dpadButton(2, pressed[2], () => this._dispatchKey('ArrowLeft'));
      this._dpadButton(3, pressed[3], () => this._dispatchKey('ArrowRight'));
    } else if (state === 'targeted') {
      this._dpadButton(0, pressed[0], () => { this._lastTargetedAxis = 'ud'; this._targetCursorUp?.(); });
      this._dpadButton(1, pressed[1], () => { this._lastTargetedAxis = 'ud'; this._targetCursorDown?.(); });
      this._dpadButton(2, pressed[2], () => { this._lastTargetedAxis = 'lr'; this._actionSlotPrev?.(); });
      this._dpadButton(3, pressed[3], () => { this._lastTargetedAxis = 'lr'; this._actionSlotNext?.(); });
    } else {
      // idle
      this._dpadButton(0, pressed[0], () => this._partyTargetPrev?.());
      this._dpadButton(1, pressed[1], () => this._partyTargetNext?.());
      this._dpadButton(2, pressed[2], () => this._tabTargetPrev?.());
      this._dpadButton(3, pressed[3], () => this._tabTargetNext?.());
    }

    this._prevDpad = pressed;
  }

  private _dpadButton(index: 0 | 1 | 2 | 3, pressed: boolean, action: () => void): void {
    const now = performance.now();
    const wasPressed = this._prevDpad[index];

    if (pressed && !wasPressed) {
      action();
      this._dpadHeldSince[index] = now;
      this._dpadLastFire[index]  = now;
    } else if (pressed && wasPressed) {
      const heldMs = now - this._dpadHeldSince[index];
      if (heldMs > DPAD_REPEAT_DELAY) {
        const sinceLast = now - this._dpadLastFire[index];
        if (sinceLast >= DPAD_REPEAT_RATE) {
          action();
          this._dpadLastFire[index] = now;
        }
      }
    }
  }

  // ── Face buttons ──────────────────────────────────────────────────────

  private _tickFaceButtons(snap: GamepadSnapshot, state: InputState): void {
    const b = this.bindings;

    // L2 / R2 modifier check first. While either is held, face buttons 0-3
    // become slot shortcuts and all other bound actions are suppressed for
    // those four indices so the user doesn't double-fire jump on L2+A, etc.
    const l2Idx = b.get('slot_modifier_low');
    const r2Idx = b.get('slot_modifier_high');
    const l2 = snap.buttons[l2Idx] ?? false;
    const r2 = snap.buttons[r2Idx] ?? false;

    if (l2 || r2) {
      const slotBase = l2 ? 0 : 4;
      // Slot shortcuts are tied to the FOUR PHYSICAL FACE BUTTONS (indices
      // 0-3), not to bound action names — A/B/X/Y positions are ergonomically
      // stable even if the user remaps jump/etc.
      for (let i = 0; i < 4; i++) {
        if (this._firedIndex(snap, i)) this._onSlotShortcut?.(slotBase + i);
      }
      this._updateAllPrev(snap);
      return;
    }

    // jump / interact — pure key synthesizers, state-independent.
    if (this._firedAction('jump',     snap)) this._dispatchKey(' ', 'Space');
    if (this._firedAction('interact', snap)) this._dispatchKey('f', 'KeyF');

    // Dash — routes through WASDController.triggerDash so the stamina gate
    // and local snap come along. Direction = forward when the left stick is
    // deflected (mirrors WASD's "any held → forward"), else back (retreat).
    if (this._firedAction('dash', snap)) {
      const lx = snap.axes[0] ?? 0;
      const ly = snap.axes[1] ?? 0;
      const dashing = Math.hypot(lx, ly) > STICK_DEADZONE ? 'forward' : 'back';
      this._onDash?.(dashing);
    }

    // lock_toggle — works in idle (lock current target) and targeted (unlock).
    if (this._firedAction('lock_toggle', snap)) this._onLockToggle?.();

    // sprint as toggle — press once to latch, again to release. In hold mode
    // this branch is a no-op and the tier resolver reads the live button state.
    if (this._firedAction('sprint', snap) && ClientConfig.sprintToggleMode) {
      this._sprintToggleOn = !this._sprintToggleOn;
    }

    // cancel — state-routed:
    //   arming → abort arming
    //   modal  → Escape
    //   else   → no-op (lock_toggle owns unlock now)
    if (this._firedAction('cancel', snap)) {
      if (state === 'arming')     this._onCancelArming?.();
      else if (state === 'modal') this._dispatchKey('Escape');
    }

    // confirm — state-routed:
    //   arming   → execute armed slot
    //   modal    → Enter
    //   targeted → activate last-touched surface (TargetWindow vs ActionBar)
    //   idle     → fire the TargetWindow selection (Attack/Talk/etc) when a
    //              soft target exists; Attack auto-locks via ClientConfig.
    if (this._firedAction('confirm', snap)) {
      if (state === 'arming') {
        this._onConfirmArming?.();
      } else if (state === 'modal') {
        this._dispatchKey('Enter');
      } else if (state === 'targeted') {
        if (this._lastTargetedAxis === 'lr') this._onConfirmActionBar?.();
        else                                 this._onConfirmTargetWindow?.();
      } else {
        // idle — only the TargetWindow can be acted on (no slot focus exists
        // outside `targeted`). No-op when there's no target.
        this._onConfirmTargetWindow?.();
      }
    }

    this._updateAllPrev(snap);
  }

  /** Edge-press check for a bound action — true on the rising edge. */
  private _firedAction(action: GamepadAction, snap: GamepadSnapshot): boolean {
    const idx = this.bindings.get(action);
    return this._firedIndex(snap, idx);
  }

  /** Edge-press check for a raw button index. */
  private _firedIndex(snap: GamepadSnapshot, idx: number): boolean {
    const cur  = snap.buttons[idx] ?? false;
    const prev = this._prevButtonState[idx] ?? false;
    return cur && !prev;
  }

  /** Mirror current button state into _prevButtonState for next-frame edge
   *  detection across every bindable index. */
  private _updateAllPrev(snap: GamepadSnapshot): void {
    for (let i = 0; i < this._prevButtonState.length; i++) {
      this._prevButtonState[i] = snap.buttons[i] ?? false;
    }
  }

  private _dispatchKey(key: string, code?: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: code ?? key,
      bubbles: true,
      cancelable: true,
    }));
  }
}
