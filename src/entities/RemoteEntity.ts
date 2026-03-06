import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
  /** Reusable scratch vector — avoids allocating a new Vector3 every tick. */
  private _scratch = new THREE.Vector3();
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
    const t = Math.min(this.elapsed / this.duration, 1);
    this._scratch.copy(this.from).lerp(this.target, easeOut(t));
    if (t >= 1) this.active = false;
    return this._scratch;
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

  /** Smooth heading interpolation — prevents jarring rotation snaps. */
  private _targetHeading: number | null = null;
  private static readonly HEADING_LERP_SPEED = 10; // radians per second (fast but smooth)

  // ── Static GLB model cache ────────────────────────────────────────────────
  // Shared across all RemoteEntity instances so the same model isn't fetched
  // twice. Keyed by modelAsset path (e.g. "dungeon/Dungeon_Entrance_01.glb").
  private static _glbCache  = new Map<string, THREE.Group>();
  private static _glbLoader = new GLTFLoader();

  /** Clone a cached model or return null if not yet cached. */
  private static _cloneCachedModel(assetPath: string): THREE.Group | null {
    const cached = RemoteEntity._glbCache.get(assetPath);
    if (!cached) return null;
    const clone = cached.clone(true);
    // Deep-clone materials so per-instance changes don't bleed.
    clone.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.material = (child.material as THREE.Material).clone();
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }

  constructor(entity: Entity, scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name  = `entity_${entity.id}`;

    const type = entity.type?.toLowerCase() ?? '';
    let mesh: THREE.Mesh;
    let placeholderForModel: THREE.Mesh | null = null;

    if (entity.modelAsset) {
      // GLB model — start with a small placeholder marker, swap when loaded
      mesh = EntityObject._sphereMesh(0x8866aa, 0.25); // purple marker
      placeholderForModel = mesh;
    } else if (type === 'player' || type === 'companion') {
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
    if (!placeholderForModel && type === 'plant') {
      this._plantMeshRef = mesh;
      this._plantStage   = (entity.currentAction as string | undefined) ?? 'mature';
    }

    // Kick off async model load after super() has been called
    if (placeholderForModel && entity.modelAsset) {
      this._loadModel(entity.modelAsset, root, placeholderForModel, entity.modelScale);
    }
  }

  // ── GLB loading ─────────────────────────────────────────────────────────

  /**
   * Load a GLB model from the server asset directory, replace the placeholder
   * mesh, and cache the prototype for future clones.
   */
  private _loadModel(assetPath: string, root: THREE.Group, placeholder: THREE.Mesh, scale?: number): void {
    const s = scale ?? 1;

    // Fast path: already cached → swap immediately
    const cached = RemoteEntity._cloneCachedModel(assetPath);
    if (cached) {
      root.remove(placeholder);
      placeholder.geometry?.dispose();
      (placeholder.material as THREE.Material)?.dispose();
      if (s !== 1) cached.scale.setScalar(s);
      root.add(cached);
      return;
    }

    // Async load
    const url = `${ClientConfig.serverUrl}/world/assets/${assetPath}`;
    RemoteEntity._glbLoader.load(
      url,
      (gltf) => {
        // Store prototype in cache (unscaled)
        RemoteEntity._glbCache.set(assetPath, gltf.scene.clone(true));

        // Prepare the loaded scene
        gltf.scene.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        // Apply scale
        if (s !== 1) gltf.scene.scale.setScalar(s);

        // Swap placeholder → model
        root.remove(placeholder);
        placeholder.geometry?.dispose();
        (placeholder.material as THREE.Material)?.dispose();
        root.add(gltf.scene);
      },
      undefined, // onProgress — not needed
      (err) => {
        console.warn(`[RemoteEntity] Failed to load model '${assetPath}':`, err);
        // Keep the placeholder visible as fallback
      },
    );
  }

  override update(dt: number): void {
    const pos = this.interp.tick(dt);
    if (pos) this.object3d.position.copy(pos);

    // Smooth heading interpolation (shortest-arc)
    if (this._targetHeading !== null) {
      const current = this.object3d.rotation.y;
      let delta = this._targetHeading - current;
      // Shortest arc
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) < 0.01) {
        this.object3d.rotation.y = this._targetHeading;
        this._targetHeading = null;
      } else {
        this.object3d.rotation.y += delta * Math.min(1, RemoteEntity.HEADING_LERP_SPEED * dt);
      }
    }
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
      const targetRad = THREE.MathUtils.degToRad(-heading);
      if (this._targetHeading === null) {
        // First update — snap to avoid spinning from 0
        this.object3d.rotation.y = targetRad;
      }
      this._targetHeading = targetRad;
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
