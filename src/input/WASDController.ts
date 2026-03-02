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
 * Movement uses client-side prediction: `_localPos` advances at RUN_SPEED_MPS
 * every frame so the player capsule moves without waiting for server round-trips.
 * Server commands are still sent at SEND_INTERVAL_MS for authoritative validation.
 * When keys are released the prediction clears and the entity smoothly reconciles
 * to the server position via its normal lerp.
 *
 * Camera rotation runs every frame (dt-scaled) for fluid response.
 */

const MOVE_STEP_M      = 2;     // metres ahead per server send (close waypoint = accurate tracking)
const SEND_INTERVAL_MS = 50;    // max server send rate (20 Hz)
const QE_SPEED         = 1.8;   // camera rotation speed, radians / second
const RUN_SPEED_MPS    = 17.5;  // must match server baseSpeed(5.0) × SPEED_MULTIPLIERS.run(3.5)
const DRIFT_SNAP_M     = 5;     // if local drifts this far from server, snap back (teleport etc.)

export class WASDController {
  private held              = new Set<string>();
  private lastSendAt        = 0;
  /** Client-predicted local position while movement keys are held. */
  private _localPos: { x: number; y: number; z: number } | null = null;
  private inventoryToggle:    (() => void) | null = null;
  private abilityToggle:      (() => void) | null = null;
  private abilitySlotCallback: ((slotIndex: number) => void) | null = null;

  setInventoryToggle(fn: () => void): void { this.inventoryToggle = fn; }
  setAbilityToggle(fn: () => void):   void { this.abilityToggle   = fn; }
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
    // Q / E — smooth camera orbit (every frame, dt-scaled)
    if (this.held.has('q')) this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('e')) this.camera.addYaw(-QE_SPEED * dt);

    // Build a [−1..1] input vector from held keys
    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);

    if (inputX === 0 && inputZ === 0) {
      // No movement keys — clear prediction so entity reverts to server lerp
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

    // Advance local position at run speed this frame.
    // Y is always taken from the server so terrain snapping remains authoritative.
    this._localPos.x += normX * RUN_SPEED_MPS * dt;
    this._localPos.z += normZ * RUN_SPEED_MPS * dt;
    this._localPos.y  = serverPos.y;

    // Snap local back to server if drift is large (teleport / hard correction).
    const driftX = this._localPos.x - serverPos.x;
    const driftZ = this._localPos.z - serverPos.z;
    if (Math.hypot(driftX, driftZ) > DRIFT_SNAP_M) {
      this._localPos.x = serverPos.x;
      this._localPos.z = serverPos.z;
    }

    // Push the predicted position to PlayerState so EntityFactory can forward
    // it to PlayerEntity before this frame's render.
    this.player.setLocalPosition(this._localPos);

    // ── Throttled server send ────────────────────────────────────────────────
    const now = Date.now();
    if (now - this.lastSendAt < SEND_INTERVAL_MS) return;

    this.socket.sendMovePosition(
      { x: serverPos.x + normX * MOVE_STEP_M, y: serverPos.y, z: serverPos.z + normZ * MOVE_STEP_M },
      'run',
    );
    this.lastSendAt = now;
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
