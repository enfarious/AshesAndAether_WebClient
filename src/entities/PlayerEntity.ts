import * as THREE from 'three';
import { EntityObject } from './EntityObject';
import type { CharacterState } from '@/network/Protocol';

/**
 * PlayerEntity — the local player's visual representation.
 *
 * Position is driven by two sources:
 *   • setPredictedPosition() — called by EntityFactory each frame while
 *     WASD keys are held.  X/Z snap directly to the predicted position
 *     so movement is perfectly smooth.  Y is lerped so terrain transitions
 *     don't stutter.
 *   • setTargetPosition()    — called on server state_update.  Stored as
 *     serverTarget; the entity lerps toward it when prediction is inactive
 *     (player stopped moving) to reconcile any small drift.
 *
 * The camera follows this object's world position.
 */
export class PlayerEntity extends EntityObject {
  /** Smoothly lerp toward the server position each frame (used when not predicting). */
  private serverTarget  = new THREE.Vector3();
  private lerpSpeed     = 12; // units/sec reciprocal — higher = snappier
  /** Set by EntityFactory before this entity's update(); consumed and cleared inside update(). */
  private _predictedPos: THREE.Vector3 | null = null;

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

  /**
   * Called by EntityFactory.update() BEFORE this entity's own update() runs.
   * The position is consumed (and cleared) inside update() so it must be
   * re-supplied every frame prediction is active.
   */
  setPredictedPosition(v: THREE.Vector3): void {
    if (!this._predictedPos) this._predictedPos = new THREE.Vector3();
    this._predictedPos.copy(v);
  }

  override update(dt: number): void {
    if (this._predictedPos) {
      // Prediction active: X/Z snap directly (perfectly smooth);
      // Y lerps so terrain slope changes don't pop.
      this.object3d.position.x = this._predictedPos.x;
      this.object3d.position.z = this._predictedPos.z;
      this.object3d.position.y = THREE.MathUtils.lerp(
        this.object3d.position.y,
        this._predictedPos.y,
        Math.min(this.lerpSpeed * dt, 1),
      );
      this._predictedPos = null; // Consumed — must be re-set next frame
    } else {
      // No prediction (player stopped) — lerp toward server position to reconcile.
      this.object3d.position.lerp(this.serverTarget, Math.min(this.lerpSpeed * dt, 1));
    }
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
