import * as THREE from 'three';
import type { HeightmapService } from './HeightmapService';

/**
 * TangentPlaneFit — position + rotate a flat mesh so it sits on the local
 * tangent plane of the terrain. Sampled per-frame from HeightmapService at
 * the centre + four cardinal offsets. Eliminates per-vertex Y jitter that
 * a tessellated terrain conform exhibits when moving across DEM cells:
 * the mesh moves as a rigid body, so smoothing is done ONCE in the slope
 * estimate rather than re-evaluated at every vertex every frame.
 *
 * Use this for small indicators (~1-2 m) where the terrain is locally
 * approximately planar. Large indicators (10 m+ telegraphs) should keep
 * the tessellated shader-conform approach because a single tangent plane
 * can't track terrain that curves under their footprint.
 */

const _UP       = new THREE.Vector3(0, 1, 0);
const _normal   = new THREE.Vector3();
const _tiltQuat = new THREE.Quaternion();
const _yawQuat  = new THREE.Quaternion();

/**
 * Sample DEM around `(worldX, worldZ)`, fit a tangent plane to the four
 * cardinal slope offsets, and apply position + rotation to `mesh` so its
 * local +Y aligns with the terrain normal and its local +Z aligns with
 * `headingRad` (yaw around vertical).
 *
 * Behaviour without a DEM bound (vault interior, pre-zone-load): mesh sits
 * flat at `fallbackY + yLift`, yaw applied but no tilt.
 *
 * Performance: 5 `getElevation` calls + a couple of quaternion ops per
 * call. Cheap enough to run for dozens of indicators per frame.
 */
export function fitToTerrain(
  mesh:        THREE.Object3D,
  hm:          HeightmapService | null,
  worldX:      number,
  worldZ:      number,
  /** Forward heading in radians (0 = +Z = south, matches server convention),
   *  or null for a rotationally symmetric mesh (rings) where only the tilt
   *  matters. */
  headingRad:  number | null,
  /** Distance in metres to sample cardinal offsets for slope estimate. Pick
   *  something near the indicator's own half-size: too small = noisy normal
   *  from sub-DEM-cell variation, too large = misses local slope features. */
  sampleDist:  number,
  yLift:       number,
  /** Y to land at when no DEM is bound (vault). Typically the entity's
   *  reported position.y. */
  fallbackY:   number,
): void {
  if (hm) {
    const yCenter = hm.getElevation(worldX, worldZ);
    if (yCenter !== null) {
      // Cardinal samples — fall back to centre on OOB so the slope estimate
      // doesn't get pulled off at zone edges.
      const yN = hm.getElevation(worldX, worldZ - sampleDist) ?? yCenter;
      const yS = hm.getElevation(worldX, worldZ + sampleDist) ?? yCenter;
      const yE = hm.getElevation(worldX + sampleDist, worldZ) ?? yCenter;
      const yW = hm.getElevation(worldX - sampleDist, worldZ) ?? yCenter;

      // dy/dx and dy/dz across the sample baseline.
      const slopeX = (yE - yW) / (2 * sampleDist);
      const slopeZ = (yS - yN) / (2 * sampleDist);

      // Terrain normal in world space: for a surface y = y(x, z), the
      // upward normal is (-dy/dx, 1, -dy/dz) before normalisation.
      _normal.set(-slopeX, 1, -slopeZ).normalize();
      _tiltQuat.setFromUnitVectors(_UP, _normal);

      if (headingRad !== null) {
        // Apply yaw FIRST (around world Y), THEN tilt onto the terrain
        // plane. Mesh's +Z ends up pointing in the heading direction
        // projected onto the tangent plane.
        _yawQuat.setFromAxisAngle(_UP, headingRad);
        mesh.quaternion.copy(_tiltQuat).multiply(_yawQuat);
      } else {
        mesh.quaternion.copy(_tiltQuat);
      }
      mesh.position.set(worldX, yCenter + yLift, worldZ);
      return;
    }
  }

  // No DEM / out of bounds — sit flat at fallbackY.
  mesh.position.set(worldX, fallbackY + yLift, worldZ);
  if (headingRad !== null) {
    mesh.quaternion.setFromAxisAngle(_UP, headingRad);
  } else {
    mesh.quaternion.identity();
  }
}
