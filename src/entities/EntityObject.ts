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

  // ── Shared placeholder geometry helpers ───────────────────────────────────

  /** Humanoid upright capsule — players and companions. */
  protected static _capsuleMesh(color: number): THREE.Mesh {
    const geo = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = false;
    mesh.position.y    = 0.85; // lift off ground
    return mesh;
  }

  /** Round sphere — NPCs and mobs. */
  protected static _sphereMesh(color: number, radius = 0.4): THREE.Mesh {
    const geo = new THREE.SphereGeometry(radius, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.y = radius;
    return mesh;
  }

  /** Upright cone — wildlife (non-humanoid creatures). */
  protected static _coneMesh(color: number): THREE.Mesh {
    const geo = new THREE.ConeGeometry(0.38, 1.0, 7);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.y = 0.5; // half-height lift
    return mesh;
  }

  /**
   * Compact tapered cylinder — flora/plant entities.
   * Scale and colour vary by growth stage so even placeholder plants are
   * visually distinguishable (tiny sprout vs full flowering bush).
   */
  protected static _plantMesh(stage: string): THREE.Mesh {
    const color = EntityObject._plantStageColor(stage);
    const geo   = new THREE.CylinderGeometry(0.22, 0.30, 0.70, 6);
    const mat   = new THREE.MeshStandardMaterial({ color, roughness: 0.90, metalness: 0.0 });
    const mesh  = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    const s = EntityObject._plantStageScale(stage);
    mesh.scale.setScalar(s);
    mesh.position.y = (0.70 * s) / 2; // sit flush with ground
    return mesh;
  }

  protected static _plantStageColor(stage: string): number {
    switch (stage) {
      case 'seed':      return 0x8b6914; // dark brown seed
      case 'sprout':    return 0x7cb84a; // bright young green
      case 'growing':   return 0x5a9a32; // mid green
      case 'mature':    return 0x2d7a1a; // deep forest green
      case 'flowering': return 0x55cc33; // bright lime — in bloom
      case 'withering': return 0xa08040; // yellowed, fading
      case 'dead':      return 0x6b5035; // dried brown
      default:          return 0x4a7a30; // fallback green
    }
  }

  protected static _plantStageScale(stage: string): number {
    switch (stage) {
      case 'seed':      return 0.15;
      case 'sprout':    return 0.30;
      case 'growing':   return 0.60;
      case 'mature':    return 0.85;
      case 'flowering': return 1.00;
      case 'withering': return 0.90;
      case 'dead':      return 0.50;
      default:          return 0.85;
    }
  }

  /**
   * Entity colour palette:
   *
   *   Player    — blue     #4488ff
   *   Companion — green    #44cc66  (capsule)
   *   NPC       — green    #44cc66  (sphere)
   *   Hostile   — red      #dd3333  (all entity types when hostile flag is set)
   *   Mob       — yellow   #ddaa22  (non-hostile)
   *   Wildlife  — tan      #c8a870  (non-hostile)
   *   Plant     — green    #4a7a30  (stage-specific tones applied in _plantMesh)
   */
  protected static _entityColor(entity: Entity): number {
    const type = entity.type?.toLowerCase() ?? '';
    if (type === 'player')    return 0x4488ff;
    if (type === 'companion') return 0x44cc66;
    if (type === 'npc')       return 0x44cc66;
    if (type === 'plant')     return 0x4a7a30; // green — actual tone set per-stage by _plantMesh
    if (entity.hostile)       return 0xdd3333; // red — covers hostile mobs AND hostile wildlife
    if (type === 'mob')       return 0xddaa22; // yellow — non-hostile mob
    if (type === 'wildlife')  return 0xc8a870; // tan — non-hostile wildlife
    return 0x888888;
  }

  /**
   * Called when entity attributes are updated beyond position/heading.
   * Default is a no-op; subclasses override to react to attribute changes
   * (e.g. RemoteEntity updates plant scale when growth stage changes).
   */
  applyUpdate(_partial: Partial<Entity>): void { /* no-op */ }
}
