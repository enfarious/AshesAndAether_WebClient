import * as THREE from 'three';
import type { Entity } from '@/network/Protocol';

// Body-size scale factors relative to a medium rabbit (1.0).
// Drive capsule scale so larger animals appear meaningfully bigger.
const ANIMAL_SIZE: Record<string, number> = {
  chipmunk:    0.50,
  woodpecker:  0.60,
  frog:        0.65,
  squirrel:    0.70,
  crow:        0.80,
  turtle:      0.90,
  rabbit:      1.00,
  owl:         1.00,
  skunk:       1.10,
  snake:       1.10,
  porcupine:   1.20,
  eagle:       1.20,
  raccoon:     1.30,
  turkey:      1.50,
  fox:         1.60,
  coyote:      2.00,
  wolf:        2.20,
  boar:        2.50,
  deer:        2.80,
  bear:        3.50,
};

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
    durationMs?: number,
    from?: THREE.Vector3,
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

  /**
   * Horizontal capsule — animals, scaled by species body size.
   * Capsule lies on its side (rotation.z = 90°); radius × scale lifts it
   * off the ground so it rests on its belly rather than floating.
   */
  protected static _animalMesh(tag: string): THREE.Mesh {
    const scale  = ANIMAL_SIZE[tag] ?? 1.0;
    const geo    = new THREE.CapsuleGeometry(0.20, 0.50, 4, 8);
    const mat    = new THREE.MeshStandardMaterial({ color: 0xc8a870, roughness: 0.85, metalness: 0.05 });
    const mesh   = new THREE.Mesh(geo, mat);
    mesh.castShadow   = true;
    mesh.rotation.z   = Math.PI / 2; // lay on side
    mesh.scale.setScalar(scale);
    mesh.position.y   = 0.20 * scale; // radius × scale off ground
    return mesh;
  }

  /** Species tags that should render as trees rather than the generic plant cone. */
  static readonly TREE_TAGS = new Set(['pine_tree', 'oak_tree', 'maple_tree', 'apple_tree', 'pear_tree']);

  /**
   * Build a vault entrance portal directly into the given group:
   *   - Flat emissive torus ring on the ground (the "rune circle")
   *   - Tall translucent cyan light column rising from its center
   *   - A subtle PointLight tinting the ground around it
   *
   * The torus and column are interactive geometry — raycasting against
   * either picks the entity up. Total polycount is tiny.
   */
  static _addVaultPortalToGroup(group: THREE.Group): void {
    // Ground rune ring — flat torus laid horizontally.
    const ringGeo = new THREE.TorusGeometry(2.0, 0.18, 12, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshStandardMaterial({
      color:           0x102028,
      emissive:        0x4cc8ff,
      emissiveIntensity: 1.6,
      roughness:       0.4,
      metalness:       0.7,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.05;
    ring.castShadow = false;
    ring.receiveShadow = false;
    group.add(ring);

    // Light column — translucent cyan cylinder rising from the ring center.
    const columnGeo = new THREE.CylinderGeometry(1.6, 1.8, 8.0, 24, 1, true);
    const columnMat = new THREE.MeshBasicMaterial({
      color:       0x6ad8ff,
      transparent: true,
      opacity:     0.18,
      side:        THREE.DoubleSide,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const column = new THREE.Mesh(columnGeo, columnMat);
    column.position.y = 4.0;
    group.add(column);

    // A second narrower inner column for a brighter core.
    const coreGeo = new THREE.CylinderGeometry(0.6, 0.8, 7.0, 16, 1, true);
    const coreMat = new THREE.MeshBasicMaterial({
      color:       0xc8efff,
      transparent: true,
      opacity:     0.35,
      side:        THREE.DoubleSide,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 3.5;
    group.add(core);

    // Soft point light at the base for area glow.
    const light = new THREE.PointLight(0x4cc8ff, 1.8, 12, 1.4);
    light.position.set(0, 1.5, 0);
    group.add(light);
  }

  /**
   * Add procedural tree geometry to a group.  Two variants:
   *   pine  — brown cone trunk + stacked green cone foliage layers
   *   decid — brown cylinder trunk + green sphere crown
   * These are placeholder visuals until GLB assets are available.
   */
  static _addTreeToGroup(group: THREE.Group, tag: string): void {
    const isPine = tag === 'pine_tree';

    // Shared trunk
    const trunkH = isPine ? 5.5 : 4.5;
    const trunkR = isPine ? 0.22 : 0.30;
    const trunkGeo = new THREE.ConeGeometry(trunkR, trunkH, 6, 1);
    trunkGeo.translate(0, trunkH / 2, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.92 });
    const trunk    = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.castShadow = true;
    group.add(trunk);

    if (isPine) {
      // Two stacked cone foliage layers, narrowing toward the top
      const layerData = [
        { r: 2.2, h: 4.0, y: trunkH * 0.50 },
        { r: 1.4, h: 3.2, y: trunkH * 0.75 },
      ];
      const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2d5a28, roughness: 0.88 });
      for (const { r, h, y } of layerData) {
        const geo  = new THREE.ConeGeometry(r, h, 7, 1);
        geo.translate(0, y + h / 2, 0);
        const mesh = new THREE.Mesh(geo, foliageMat);
        mesh.castShadow = true;
        group.add(mesh);
      }
    } else {
      // Deciduous: one large crown sphere
      const crownY   = trunkH * 0.90;
      const crownR   = tag === 'maple_tree' ? 2.8 : 3.2;
      const crownGeo = new THREE.SphereGeometry(crownR, 8, 6);
      crownGeo.translate(0, crownY + crownR * 0.6, 0);
      const crownColor = tag === 'maple_tree' ? 0x4a6828 : 0x3a6820;
      const crownMat = new THREE.MeshStandardMaterial({ color: crownColor, roughness: 0.85 });
      const crown    = new THREE.Mesh(crownGeo, crownMat);
      crown.castShadow = true;
      group.add(crown);
    }
  }

  /**
   * Inverted cone — plants (point down, wide top).
   * Scale and colour vary by growth stage.
   */
  protected static _plantMesh(stage: string): THREE.Mesh {
    const color  = EntityObject._plantStageColor(stage);
    const s      = EntityObject._plantStageScale(stage);
    const geo    = new THREE.ConeGeometry(0.35, 1.0, 7);
    const mat    = new THREE.MeshStandardMaterial({ color, roughness: 0.90, metalness: 0.0 });
    const mesh   = new THREE.Mesh(geo, mat);
    mesh.castShadow   = true;
    mesh.rotation.x   = Math.PI; // flip: point faces down
    mesh.scale.setScalar(s);
    mesh.position.y   = 0.50 * s; // tip touches ground, base floats at s metres up
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
    if (type === 'player')    return 0xffdd44; // bright yellow
    if (type === 'companion') return 0x44ddee; // bright cyan
    if (type === 'npc')       return 0x44ddee; // bright cyan (same as companion — friendly)
    if (type === 'plant')     return 0x4a7a30; // dark green — actual tone set per-stage
    if (entity.hostile)       return 0xff3333; // bright red — hostile of any type
    if (type === 'mob')       return 0xffa500; // bright orange — non-hostile mob
    if (type === 'wildlife')  return 0xc8a870; // tan — non-hostile wildlife
    return 0xff44dd; // alarm magenta — UNKNOWN TYPE, indicates a payload bug
  }

  /**
   * Called when entity attributes are updated beyond position/heading.
   * Default is a no-op; subclasses override to react to attribute changes
   * (e.g. RemoteEntity updates plant scale when growth stage changes).
   */
  applyUpdate(_partial: Partial<Entity>): void { /* no-op */ }
}
