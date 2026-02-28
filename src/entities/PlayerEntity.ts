import * as THREE from 'three';
import { EntityObject } from './EntityObject';
import type { CharacterState } from '@/network/Protocol';

/**
 * PlayerEntity — the local player's visual representation.
 *
 * Position is driven by server updates via setTargetPosition.
 * The camera follows this object's world position.
 *
 * Uses a distinct visual to differentiate from RemoteEntity.
 */
export class PlayerEntity extends EntityObject {
  /** Smoothly lerp toward the server position each frame. */
  private serverTarget = new THREE.Vector3();
  private lerpSpeed    = 12; // units/sec reciprocal — higher = snappier

  constructor(character: CharacterState, scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name  = `player_${character.id}`;

    // Player is a slightly brighter capsule with a subtle emissive rim
    const geo = new THREE.CapsuleGeometry(0.38, 1.05, 4, 8);
    const mat = new THREE.MeshStandardMaterial({
      color:     0x6699ff,
      emissive:  0x112244,
      roughness: 0.6,
      metalness: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.y = 0.9;
    root.add(mesh);

    // Small glow ring at feet
    const ringGeo = new THREE.TorusGeometry(0.45, 0.04, 6, 24);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x4477ff,
      emissive: 0x2244aa,
      roughness: 1,
      metalness: 0,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    root.add(ring);

    if (character.position) {
      root.position.set(character.position.x, character.position.y, character.position.z);
    }
    if (character.heading !== undefined) {
      root.rotation.y = THREE.MathUtils.degToRad(-character.heading);
    }

    scene.add(root);
    super(character.id, root);

    this.serverTarget.copy(root.position);
  }

  override update(dt: number): void {
    // Smooth follow toward server-authoritative position
    this.object3d.position.lerp(this.serverTarget, Math.min(this.lerpSpeed * dt, 1));
  }

  override setTargetPosition(
    position: THREE.Vector3,
    heading?: number,
    _durationMs?: number,
  ): void {
    const dist = this.object3d.position.distanceTo(position);
    if (dist > 4) {
      // Large correction — snap
      this.object3d.position.copy(position);
    }
    this.serverTarget.copy(position);
    if (heading !== undefined) {
      this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
    }
  }

  /** Predicted position used for camera follow (pre-reconciliation). */
  get cameraTarget(): THREE.Vector3 {
    return this.object3d.position;
  }
}
