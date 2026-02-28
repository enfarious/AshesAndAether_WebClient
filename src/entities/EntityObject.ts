import * as THREE from 'three';
import type { Entity } from '@/network/Protocol';

/**
 * EntityObject — base class wrapping a Three.js Object3D with entity metadata.
 *
 * Subclasses (PlayerEntity, RemoteEntity) specialise the visual representation.
 * All entity scene objects derive from this so the scene can treat them uniformly.
 */
export abstract class EntityObject {
  readonly object3d: THREE.Object3D;
  readonly entityId: string;

  protected nameLabel: HTMLElement | null = null;

  constructor(entityId: string, object3d: THREE.Object3D) {
    this.entityId = entityId;
    this.object3d = object3d;
    this.object3d.userData['entityId'] = entityId;
  }

  /** Called every frame with delta time in seconds. */
  abstract update(dt: number): void;

  /** Update the server-authoritative target position (for interpolation). */
  abstract setTargetPosition(
    position: THREE.Vector3,
    heading?: number,
    durationMs?: number
  ): void;

  /** Snap immediately to position without lerp. */
  snapToPosition(position: THREE.Vector3): void {
    this.object3d.position.copy(position);
  }

  getWorldPosition(): THREE.Vector3 {
    return this.object3d.position.clone();
  }

  dispose(): void {
    this.object3d.parent?.remove(this.object3d);
    this.nameLabel?.remove();
    this.nameLabel = null;
    this._disposeGeometry(this.object3d);
  }

  protected _disposeGeometry(obj: THREE.Object3D): void {
    obj.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
  }

  // Shared placeholder geometry helpers

  protected static _capsuleMesh(color: number): THREE.Mesh {
    const geo = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;
    mesh.position.y    = 0.85; // lift off ground
    return mesh;
  }

  protected static _sphereMesh(color: number, radius = 0.4): THREE.Mesh {
    const geo = new THREE.SphereGeometry(radius, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.y = radius;
    return mesh;
  }

  protected static _entityColor(entity: Entity): number {
    const type = entity.type?.toLowerCase() ?? '';
    if (type === 'player')   return 0x4488ff;
    if (type === 'npc')      return 0x44cc66;
    if (entity.hostile)      return 0xdd3333;
    if (type === 'mob')      return 0xddaa22;
    if (type === 'wildlife') return 0x88aa55;
    return 0x888888;
  }
}
