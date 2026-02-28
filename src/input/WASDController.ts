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
 * Movement sends `sendMovePosition` to a point MOVE_STEP_M metres ahead in the
 * combined direction, throttled to SEND_INTERVAL_MS.  The short step distance
 * means a resend arrives before the player reaches the target, keeping motion
 * smooth while keys are held.
 *
 * Camera rotation runs every frame (dt-scaled) for fluid response.
 */

const MOVE_STEP_M      = 4;     // metres ahead per send
const SEND_INTERVAL_MS = 80;    // max movement send rate (~12 Hz)
const QE_SPEED         = 1.8;   // camera rotation speed, radians / second

export class WASDController {
  private held        = new Set<string>();
  private lastSendAt  = 0;

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

    // WASD — throttled position sends
    const now = Date.now();
    if (now - this.lastSendAt < SEND_INTERVAL_MS) return;

    // Build a [−1..1] input vector from held keys
    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);
    if (inputX === 0 && inputZ === 0) return;

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
    const yaw   = this.camera.getYaw();
    const worldX =  inputX * Math.cos(yaw) - inputZ * Math.sin(yaw);
    const worldZ = -inputX * Math.sin(yaw) - inputZ * Math.cos(yaw);

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    const pos = this.player.position;
    this.socket.sendMovePosition(
      { x: pos.x + normX * MOVE_STEP_M, y: pos.y, z: pos.z + normZ * MOVE_STEP_M },
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
