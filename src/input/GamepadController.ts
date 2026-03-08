import type { OrbitCamera }  from '@/camera/OrbitCamera';
import type { SocketClient } from '@/network/SocketClient';
import type { PlayerState }  from '@/state/PlayerState';
import type { PlayerEntity } from '@/entities/PlayerEntity';

/**
 * GamepadController — Xbox / PS / Switch Pro controller input.
 *
 * Dual-mode:
 *   - **Browser**: uses the standard Gamepad API (navigator.getGamepads)
 *   - **Tauri**:   receives native gilrs state via Tauri events (WebView2
 *                  doesn't expose the Gamepad API)
 *
 * Phase 1:
 *   Left stick  — continuous movement (same model as WASDController)
 *   Right stick — camera orbit (yaw + pitch)
 *   D-pad       — target cycling (no menu) or arrow-key emulation (menu open)
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
const SEND_INTERVAL_MS    = 100;   // 10 Hz heartbeat
const HEADING_RESEND      = 3;     // degrees
const FALLBACK_SPEED_MPS  = 17.5;
const CAM_YAW_SPEED       = 2.5;   // rad/s at full deflection
const CAM_PITCH_SPEED     = 60;    // deg/s at full deflection
const DPAD_REPEAT_DELAY   = 400;   // ms before first repeat
const DPAD_REPEAT_RATE    = 150;   // ms between subsequent repeats

// Standard-mapping d-pad button indices
const DPAD_UP    = 12;
const DPAD_DOWN  = 13;
const DPAD_LEFT  = 14;
const DPAD_RIGHT = 15;

// ── Snapshot shape (common to both sources) ──────────────────────────────────

interface GamepadSnapshot {
  axes: readonly number[];       // [leftX, leftY, rightX, rightY]
  buttons: readonly boolean[];   // standard 16-button layout
}

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
  private _localX: number | null = null;
  private _localY: number | null = null;
  private _localZ: number | null = null;
  private _playerEntity: PlayerEntity | null = null;

  // D-pad edge-detection + repeat
  private _prevDpad:      [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private _dpadHeldSince: [number, number, number, number]     = [0, 0, 0, 0];
  private _dpadLastFire:  [number, number, number, number]     = [0, 0, 0, 0];

  // Callbacks
  private _isMenuOpen:       (() => boolean) | null = null;
  private _layoutEditActive: (() => boolean) | null = null;
  private _tabTargetNext:    (() => void) | null = null;
  private _tabTargetPrev:    (() => void) | null = null;
  private _partyTargetNext:  (() => void) | null = null;
  private _partyTargetPrev:  (() => void) | null = null;

  // ── Setters ──────────────────────────────────────────────────────────────

  setPlayerEntity(pe: PlayerEntity | null): void { this._playerEntity = pe; }
  setIsMenuOpen(fn: () => boolean): void          { this._isMenuOpen = fn; }
  setLayoutEditActive(fn: () => boolean): void    { this._layoutEditActive = fn; }
  setTabTargetNext(fn: () => void): void          { this._tabTargetNext = fn; }
  setTabTargetPrev(fn: () => void): void          { this._tabTargetPrev = fn; }
  setPartyTargetNext(fn: () => void): void        { this._partyTargetNext = fn; }
  setPartyTargetPrev(fn: () => void): void        { this._partyTargetPrev = fn; }

  constructor(
    private readonly camera: OrbitCamera,
    private readonly socket: SocketClient,
    private readonly player: PlayerState,
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

    // ── D-pad ─────────────────────────────────────────────────────────────
    this._tickDpad(snap);

    // ── Death / root gate ────────────────────────────────────────────────
    if (!this.player.isAlive || this.player.isRooted) {
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

    // Cancel any active click-move
    this._playerEntity?.stopClickMove();

    // Rotate by camera yaw → world-space (identical to WASDController)
    const yaw    = this.camera.getYaw();
    const worldX =  nx * Math.cos(yaw) - nz * Math.sin(yaw);
    const worldZ = -nx * Math.sin(yaw) - nz * Math.cos(yaw);

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    // ── Client-side prediction ────────────────────────────────────────────
    if (this._localX === null && this._playerEntity) {
      const p = this._playerEntity.object3d.position;
      this._localX = p.x;
      this._localY = p.y;
      this._localZ = p.z;
    }

    if (this._localX !== null && this._localY !== null && this._localZ !== null) {
      const speedMPS = this.player.movementSpeedMPS || FALLBACK_SPEED_MPS;
      this._localX += normX * speedMPS * dt;
      this._localZ += normZ * speedMPS * dt;
      this._localY  = this.player.position.y;
      this._playerEntity?.drivePosition(this._localX, this._localY, this._localZ);
    }

    // ── Continuous server send ─────────────────────────────────────────────
    let headingDeg = Math.atan2(normX, normZ) * (180 / Math.PI);
    if (headingDeg < 0) headingDeg += 360;

    const now = Date.now();
    const headingDelta = Math.abs(headingDeg - this._lastSentHeading);
    const wrappedDelta = Math.min(headingDelta, 360 - headingDelta);

    const shouldSend = !this._isMoving
      || wrappedDelta > HEADING_RESEND
      || now - this._lastSendAt >= SEND_INTERVAL_MS;

    if (shouldSend) {
      this.socket.sendMoveContinuous(headingDeg, 'run');
      this._lastSentHeading = headingDeg;
      this._lastSendAt = now;
      this._isMoving = true;
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
  };

  // ── Movement ──────────────────────────────────────────────────────────

  private _stopMovement(): void {
    if (this._isMoving) {
      this.socket.sendMoveStop();
      this._isMoving = false;
      this._lastSentHeading = -999;
    }
    if (this._localX !== null) {
      this._localX = this._localY = this._localZ = null;
      this._playerEntity?.stopWASD();
    }
  }

  // ── D-pad ─────────────────────────────────────────────────────────────

  private _tickDpad(snap: GamepadSnapshot): void {
    const menuOpen = this._isMenuOpen?.() ?? false;

    const pressed: [boolean, boolean, boolean, boolean] = [
      snap.buttons[DPAD_UP]    ?? false,
      snap.buttons[DPAD_DOWN]  ?? false,
      snap.buttons[DPAD_LEFT]  ?? false,
      snap.buttons[DPAD_RIGHT] ?? false,
    ];

    if (menuOpen) {
      this._dpadButton(0, pressed[0], () => this._dispatchArrow('ArrowUp'));
      this._dpadButton(1, pressed[1], () => this._dispatchArrow('ArrowDown'));
      this._dpadButton(2, pressed[2], () => this._dispatchArrow('ArrowLeft'));
      this._dpadButton(3, pressed[3], () => this._dispatchArrow('ArrowRight'));
    } else {
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

  private _dispatchArrow(key: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
    }));
  }
}
