import * as THREE from 'three';
import { EntityObject } from './EntityObject';
import { ClientConfig } from '@/config/ClientConfig';
import type { Entity } from '@/network/Protocol';

/**
 * MovementInterpolator — handles smooth server-authoritative movement.
 *
 * When a position update arrives:
 *   - If the delta is within snap threshold, lerp to target
 *   - If the delta exceeds snap threshold (large correction), snap immediately
 */
class MovementInterpolator {
  private from     = new THREE.Vector3();
  private target   = new THREE.Vector3();
  private elapsed  = 0;
  private duration = 0;
  private active   = false;

  get isActive(): boolean { return this.active; }
  get targetPosition(): THREE.Vector3 { return this.target.clone(); }

  setTarget(
    current:    THREE.Vector3,
    target:     THREE.Vector3,
    durationMs: number,
  ): boolean {
    const dist = current.distanceTo(target);

    if (dist > ClientConfig.movementSnapThreshold) {
      // Too far — snap
      this.active = false;
      return false;
    }

    this.from.copy(current);
    this.target.copy(target);
    this.elapsed  = 0;
    this.duration = durationMs / 1000;
    this.active   = true;
    return true;
  }

  tick(dt: number): THREE.Vector3 | null {
    if (!this.active) return null;
    this.elapsed += dt;
    const t   = Math.min(this.elapsed / this.duration, 1);
    const pos = this.from.clone().lerp(this.target, easeOut(t));
    if (t >= 1) this.active = false;
    return pos;
  }
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

/**
 * RemoteEntity — a non-player entity (NPC, mob, other player, companion, wildlife, plant) in the scene.
 *
 * Shape / colour legend:
 *   player    — blue capsule
 *   companion — green capsule
 *   npc       — green sphere
 *   mob       — yellow sphere (non-hostile) / red sphere (hostile)
 *   wildlife  — tan cone    (non-hostile) / red cone  (hostile)
 *   plant     — green tapered cylinder; scale + colour vary by growth stage
 */
export class RemoteEntity extends EntityObject {
  private interp        = new MovementInterpolator();
  private _entityType:  string;
  private _plantMeshRef: THREE.Mesh | null = null;
  private _plantStage:  string = '';

  constructor(entity: Entity, scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name  = `entity_${entity.id}`;

    const type = entity.type?.toLowerCase() ?? '';
    let mesh: THREE.Mesh;

    if (type === 'player' || type === 'companion') {
      mesh = EntityObject._capsuleMesh(EntityObject._entityColor(entity));
    } else if (type === 'wildlife') {
      mesh = EntityObject._coneMesh(EntityObject._entityColor(entity));
    } else if (type === 'plant') {
      const stage = (entity.currentAction as string | undefined) ?? 'mature';
      mesh = EntityObject._plantMesh(stage);
    } else {
      // npc, mob, and any unknown type → sphere
      mesh = EntityObject._sphereMesh(EntityObject._entityColor(entity));
    }

    root.add(mesh);

    if (entity.position) {
      root.position.set(entity.position.x, entity.position.y, entity.position.z);
    }
    if (entity.heading !== undefined) {
      root.rotation.y = THREE.MathUtils.degToRad(-entity.heading);
    }

    scene.add(root);
    super(entity.id, root);

    // Store for later updates
    this._entityType = type;
    if (type === 'plant') {
      this._plantMeshRef = mesh;
      this._plantStage   = (entity.currentAction as string | undefined) ?? 'mature';
    }
  }

  override update(dt: number): void {
    const pos = this.interp.tick(dt);
    if (pos) this.object3d.position.copy(pos);
  }

  override setTargetPosition(
    position:  THREE.Vector3,
    heading?:  number,
    durationMs = 100,
  ): void {
    const snapped = !this.interp.setTarget(this.object3d.position, position, durationMs);
    if (snapped) {
      this.object3d.position.copy(position);
    }
    if (heading !== undefined) {
      this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
    }
  }

  /**
   * React to entity attribute changes beyond position/heading.
   * Plants update their scale and colour when the growth stage changes.
   */
  override applyUpdate(partial: Partial<Entity>): void {
    if (this._entityType !== 'plant') return;
    if (!partial.currentAction) return;

    const newStage = partial.currentAction as string;
    if (newStage === this._plantStage) return; // no change

    this._plantStage = newStage;

    if (this._plantMeshRef) {
      // Swap material colour
      const mat = this._plantMeshRef.material as THREE.MeshStandardMaterial;
      mat.color.setHex(EntityObject._plantStageColor(newStage));

      // Adjust scale and re-centre on ground
      const s = EntityObject._plantStageScale(newStage);
      this._plantMeshRef.scale.setScalar(s);
      this._plantMeshRef.position.y = (0.70 * s) / 2;
    }
  }
}
