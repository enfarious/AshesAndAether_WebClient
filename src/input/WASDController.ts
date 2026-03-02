import type { OrbitCamera }  from '@/camera/OrbitCamera';
import type { SocketClient }  from '@/network/SocketClient';
import type { PlayerState }   from '@/state/PlayerState';

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
 * The client runs parallel prediction so the player capsule moves without
 * waiting for server round-trips.  When keys are released a `stop` command
 * is sent and the entity smoothly reconciles to the server position.
 *
 * Camera rotation runs every frame (dt-scaled) for fluid response.
 */

const QE_SPEED         = 1.8;   // camera yaw speed, radians / second
const PITCH_SPEED      = 50;    // camera pitch speed, degrees / second
const ZOOM_SPEED       = 30;    // camera zoom speed, units / second
const FALLBACK_SPEED_MPS = 5;   // walk speed — undershoot so reconciliation only pulls forward
const TELEPORT_SNAP_M  = 15;    // only hard-snap for teleport-scale corrections
const RECONCILE_RATE   = 4.0;   // blend prediction toward server per second (higher = tighter)
const HEADING_RESEND   = 3;     // degrees — resend heading if direction changed more than this
const SEND_INTERVAL_MS = 100;   // min gap between heading sends (10 Hz)

export class WASDController {
  private held              = new Set<string>();
  private lastSendAt        = 0;
  private lastSentHeading   = -999; // impossible heading → forces first send
  private isMoving          = false;
  /** Client-predicted local position while movement keys are held. */
  private _localPos: { x: number; y: number; z: number } | null = null;
  private inventoryToggle:      (() => void) | null = null;
  private abilityToggle:        (() => void) | null = null;
  private characterSheetToggle: (() => void) | null = null;
  private partyToggle:          (() => void) | null = null;
  private abilitySlotCallback:  ((slotIndex: number) => void) | null = null;

  setInventoryToggle(fn: () => void):      void { this.inventoryToggle      = fn; }
  setAbilityToggle(fn: () => void):        void { this.abilityToggle        = fn; }
  setCharacterSheetToggle(fn: () => void): void { this.characterSheetToggle = fn; }
  setPartyToggle(fn: () => void):          void { this.partyToggle          = fn; }
  setAbilitySlotCallback(fn: (slotIndex: number) => void): void { this.abilitySlotCallback = fn; }

  constructor(
    private readonly camera: OrbitCamera,
    private readonly socket: SocketClient,
    private readonly player: PlayerState,
  ) {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  // ── Called once per frame from App._loop ───────────────────────────────────

  tick(dt: number): void {
    // Q / E — smooth camera yaw (every frame, dt-scaled)
    if (this.held.has('q')) this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('e')) this.camera.addYaw(-QE_SPEED * dt);

    // Arrow keys — camera yaw + pitch
    if (this.held.has('arrowleft'))  this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('arrowright')) this.camera.addYaw(-QE_SPEED * dt);
    if (this.held.has('arrowup'))   this.camera.addPitch(+PITCH_SPEED * dt);
    if (this.held.has('arrowdown')) this.camera.addPitch(-PITCH_SPEED * dt);

    // +/- — keyboard zoom
    if (this.held.has('=') || this.held.has('+')) this.camera.addZoom(+ZOOM_SPEED * dt);
    if (this.held.has('-'))                       this.camera.addZoom(-ZOOM_SPEED * dt);

    // Build a [−1..1] input vector from held keys
    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);

    if (inputX === 0 && inputZ === 0) {
      // No movement keys — stop server movement and clear prediction
      if (this.isMoving) {
        this.socket.sendMoveStop();
        this.isMoving = false;
        this.lastSentHeading = -999;
      }
      if (this._localPos !== null) {
        this._localPos = null;
        this.player.clearLocalPosition();
      }
      return;
    }

    // Rotate input by camera yaw → world-space XZ direction.
    //
    // Camera sits at offset (sin(yaw), _, cos(yaw)) * distance from the player
    // so the "into screen / forward" direction is (-sin(yaw), 0, -cos(yaw)).
    //
    //   forward  (W)  = (-sin(yaw), 0, -cos(yaw))
    //   right    (D)  = ( cos(yaw), 0, -sin(yaw))
    //
    // Combined: worldX = inputX*cos(yaw) - inputZ*sin(yaw)
    //           worldZ = -inputX*sin(yaw) - inputZ*cos(yaw)
    const yaw    = this.camera.getYaw();
    const worldX =  inputX * Math.cos(yaw) - inputZ * Math.sin(yaw);
    const worldZ = -inputX * Math.sin(yaw) - inputZ * Math.cos(yaw);

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    // ── Client-side prediction ───────────────────────────────────────────────
    // Seed from server position on the first frame of each movement burst.
    const serverPos = this.player.position;
    if (!this._localPos) {
      this._localPos = { x: serverPos.x, y: serverPos.y, z: serverPos.z };
    }

    // Advance local position at the server's actual speed this frame.
    const speedMPS = this.player.movementSpeedMPS || FALLBACK_SPEED_MPS;
    this._localPos.x += normX * speedMPS * dt;
    this._localPos.z += normZ * speedMPS * dt;

    // Soft reconciliation: continuously blend prediction toward the
    // server-authoritative position.  This keeps drift bounded without
    // hard snaps — the prediction naturally tracks the server with a
    // small latency-proportional lead.
    const pull = Math.min(RECONCILE_RATE * dt, 1);
    this._localPos.x += (serverPos.x - this._localPos.x) * pull;
    this._localPos.z += (serverPos.z - this._localPos.z) * pull;
    this._localPos.y  = serverPos.y;

    // Hard snap only for true teleports (zone change, GM warp, etc.)
    const drift = Math.hypot(this._localPos.x - serverPos.x, this._localPos.z - serverPos.z);
    if (drift > TELEPORT_SNAP_M) {
      this._localPos.x = serverPos.x;
      this._localPos.z = serverPos.z;
    }

    // Push the predicted position to PlayerState so EntityFactory can forward
    // it to PlayerEntity before this frame's render.
    this.player.setLocalPosition(this._localPos);

    // ── Continuous server send ──────────────────────────────────────────────────
    // Convert world direction to heading (degrees).  Server convention:
    //   heading 0 = +Z (south), increases clockwise → atan2(X, Z).
    let headingDeg = Math.atan2(normX, normZ) * (180 / Math.PI);
    if (headingDeg < 0) headingDeg += 360;

    const now = Date.now();
    const headingDelta = Math.abs(headingDeg - this.lastSentHeading);
    // Wrap-around-safe delta (e.g. 359° → 1° = 2°, not 358°)
    const wrappedDelta = Math.min(headingDelta, 360 - headingDelta);

    // Send immediately on start, on heading change, or every 100 ms as heartbeat
    const shouldSend = !this.isMoving
      || wrappedDelta > HEADING_RESEND
      || now - this.lastSendAt >= SEND_INTERVAL_MS;

    if (shouldSend) {
      this.socket.sendMoveContinuous(headingDeg, 'run');
      this.lastSentHeading = headingDeg;
      this.lastSendAt = now;
      this.isMoving = true;
    }
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

    // Prevent browser scrolling for arrow keys and +/-
    const key = e.key.toLowerCase();
    if (key.startsWith('arrow') || key === '=' || key === '+' || key === '-') {
      e.preventDefault();
    }

    // H — respawn when dead
    if (e.key.toLowerCase() === 'h' && !this.player.isAlive) {
      this.socket.sendRespawn();
      return;
    }

    // I — toggle inventory
    if (e.key.toLowerCase() === 'i') {
      this.inventoryToggle?.();
      return;
    }

    // K — toggle ability tree
    if (e.key.toLowerCase() === 'k') {
      this.abilityToggle?.();
      return;
    }

    // C — toggle character sheet
    if (e.key.toLowerCase() === 'c') {
      this.characterSheetToggle?.();
      return;
    }

    // P — toggle party window
    if (e.key.toLowerCase() === 'p') {
      this.partyToggle?.();
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
    this.held.delete(e.key.toLowerCase());
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
}
