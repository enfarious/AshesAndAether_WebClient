import type { PlayerState }   from '@/state/PlayerState';
import type { EntityFactory } from '@/entities/EntityFactory';
import { ClientConfig }       from '@/config/ClientConfig';

/** Minimum allowed distance between the player and a locked target while
 *  in lock-on mode. Forward input is clamped to zero at or under this
 *  range — the player slides along the ring instead of walking into the
 *  target's collision. Tuned to roughly an arm's length + weapon swing. */
export const LOCK_ON_MIN_APPROACH_M = 1.5;

/** Result of a lock-on-aware input resolution. */
export interface ResolvedMovement {
  /** World-space movement direction (unnormalised; magnitude reflects input). */
  worldX: number;
  worldZ: number;
  /** Body-facing override (degrees, server convention 0=+Z CW). null when
   *  the caller should use the movement heading for facing (= legacy). */
  facingHeadingDeg: number | null;
}

/**
 * Resolve an (inputX, inputZ) stick/WASD pair into world-space movement +
 * facing, applying lock-on-mode overrides when enabled.
 *
 * **Lock-on off, or no locked target, or lock-on camera ON:** legacy
 *   camera-relative rotation. (When lock-on camera is on, the camera will
 *   auto-yaw toward target elsewhere, which makes camera-relative input
 *   feel like orbit movement — no math change needed here.)
 *
 * **Lock-on movement on + camera off:** target-relative.
 *   - inputZ > 0 (W / stick up) → toward target, clamped at MIN_APPROACH_M.
 *   - inputZ < 0 (S / stick down) → directly away from target.
 *   - inputX (A/D / stick lateral) → pure perpendicular strafe to the
 *     player's left/right relative to facing.
 *   - facingHeadingDeg returns target direction so the body always points
 *     at the locked target even while strafing/backpedaling.
 *
 * Input axis convention (matches WASDController + GamepadController):
 *   inputX: +1 = right (D / stick right), -1 = left (A / stick left)
 *   inputZ: +1 = forward (W / stick up),  -1 = back (S / stick down)
 *
 * Player position resolved via EntityFactory (rendered/interpolated
 * position) — same source AutoAttackRing + SubTargetIndicator use, so
 * the player feels consistent across all world-space visuals.
 */
export function resolveMovement(
  inputX:  number,
  inputZ:  number,
  player:  PlayerState,
  factory: EntityFactory,
  cameraYaw: number,
): ResolvedMovement {
  // Lock-on movement is independent of the camera mode — body always faces
  // target, strafe is always target-perpendicular. The camera toggle only
  // affects whether the camera follows the target visually. (Earlier this
  // function gated lock-on math on `!lockOnCamera`, intending camera-relative
  // to "feel like orbit" when the cam tracked the target; the new free-look
  // cone in the camera lets the cam point off-axis, which broke orbit-strafe
  // and the facing override.)
  const lockOnActive = ClientConfig.lockOnMovement && player.targetLocked;

  if (!lockOnActive) {
    return _cameraRelative(inputX, inputZ, cameraYaw);
  }

  const targetId = player.lockedTargetId;
  if (!targetId) return _cameraRelative(inputX, inputZ, cameraYaw);

  const targetObj = factory.getObject(targetId);
  if (!targetObj) return _cameraRelative(inputX, inputZ, cameraYaw);

  // Direction player → target in XZ. Player position from the rendered
  // entity if available, else PlayerState's snapshot.
  const selfObj = factory.getObject(player.id ?? '');
  const px = selfObj ? selfObj.object3d.position.x : player.position.x;
  const pz = selfObj ? selfObj.object3d.position.z : player.position.z;
  const tp = targetObj.object3d.position;
  const dx = tp.x - px;
  const dz = tp.z - pz;
  const dist = Math.hypot(dx, dz);
  if (dist === 0) return _cameraRelative(inputX, inputZ, cameraYaw);

  const dirX = dx / dist;
  const dirZ = dz / dist;
  // Player's right relative to facing, viewed top-down (X+ east, Z+ south).
  // Stand facing east → your right hand is south. So right = (-dirZ, dirX).
  // (Earlier had (dirZ, -dirX) which gave the player's *left* — pressing D
  // stepped the wrong way.)
  const rightX = -dirZ;
  const rightZ =  dirX;

  let forwardCoef = inputZ;
  const strafeCoef = inputX;

  // Min-approach clamp — kill the forward component when we'd cross the ring.
  if (forwardCoef > 0 && dist <= LOCK_ON_MIN_APPROACH_M) {
    forwardCoef = 0;
  }

  const worldX = forwardCoef * dirX + strafeCoef * rightX;
  const worldZ = forwardCoef * dirZ + strafeCoef * rightZ;

  // Server convention: heading 0 = +Z (south), CW. atan2(dirX, dirZ).
  const facingRad = Math.atan2(dirX, dirZ);
  let facingHeadingDeg = (facingRad * 180) / Math.PI;
  if (facingHeadingDeg < 0) facingHeadingDeg += 360;

  return { worldX, worldZ, facingHeadingDeg };
}

function _cameraRelative(inputX: number, inputZ: number, cameraYaw: number): ResolvedMovement {
  const worldX =  inputX * Math.cos(cameraYaw) - inputZ * Math.sin(cameraYaw);
  const worldZ = -inputX * Math.sin(cameraYaw) - inputZ * Math.cos(cameraYaw);
  return { worldX, worldZ, facingHeadingDeg: null };
}
