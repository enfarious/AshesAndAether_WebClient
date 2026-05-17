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

  /** Update the server-authoritative target position (for interpolation).
   *  `movementSpeed` (m/s) lets RemoteEntity dead-reckon between broadcasts —
   *  with server-side broadcast suppression for sustained-direction movers,
   *  gaps can stretch to ~1s, and without extrapolation the entity teleports
   *  from snapshot to snapshot. Client extrapolates along heading × speed
   *  until the next broadcast lands as a correction. Optional — undefined
   *  speed implies no extrapolation. */
  abstract setTargetPosition(
    position: THREE.Vector3,
    heading?: number,
    durationMs?: number,
    from?: THREE.Vector3,
    movementSpeed?: number,
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
   * Hireling-console obelisk for vault entry rooms. A tapered four-sided
   * pillar with an emissive amber band — readable from across the room
   * as "the thing you press F on before stepping out of staging." Total
   * polycount is tiny.
   */
  static _addHirelingConsoleToGroup(group: THREE.Group): void {
    // Base plate
    const baseGeo = new THREE.CylinderGeometry(1.4, 1.6, 0.25, 16);
    const baseMat = new THREE.MeshStandardMaterial({
      color:     0x2b231a,
      roughness: 0.85,
      metalness: 0.15,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.125;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    // Tapered obelisk shaft (square frustum)
    const shaftGeo = new THREE.CylinderGeometry(0.30, 0.55, 2.8, 4);
    const shaftMat = new THREE.MeshStandardMaterial({
      color:     0x3a2f24,
      roughness: 0.62,
      metalness: 0.32,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.y = 0.25 + 1.4;
    shaft.rotation.y = Math.PI / 4;
    shaft.castShadow = true;
    group.add(shaft);

    // Emissive amber band — readable signal that this is an interactable.
    const bandGeo = new THREE.CylinderGeometry(0.46, 0.49, 0.32, 4);
    const bandMat = new THREE.MeshStandardMaterial({
      color:             0x4a2d10,
      emissive:          0xffaa50,
      emissiveIntensity: 1.4,
      roughness:         0.4,
      metalness:         0.5,
    });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.position.y = 0.25 + 0.6;
    band.rotation.y = Math.PI / 4;
    group.add(band);

    // Cap pyramid
    const capGeo = new THREE.ConeGeometry(0.42, 0.6, 4);
    const capMat = new THREE.MeshStandardMaterial({
      color:     0x4a3a2c,
      roughness: 0.55,
      metalness: 0.4,
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.25 + 2.8 + 0.3;
    cap.rotation.y = Math.PI / 4;
    group.add(cap);

    // Small warm point light to read clearly in low-light vault entries.
    const light = new THREE.PointLight(0xffaa50, 0.9, 8, 1.6);
    light.position.set(0, 1.4, 0);
    group.add(light);
  }

  /**
   * Placeholder caravan cart mesh — attached under a rider during a
   * caravan ride. Phase C placeholder shape; Phase D replaces with
   * proper vehicle geometry + animated wheels. A short flat deck +
   * two wheel discs read as "vehicle" from any angle.
   *
   * Returned as a Group so the caller can dispose it cleanly (toggling
   * visibility on a Group skips child rendering — no per-frame cost
   * when off).
   */
  static _buildCaravanCart(): THREE.Group {
    const cart = new THREE.Group();
    cart.name = 'caravan_cart';

    // Deck plank under the rider — wide enough that the player + party
    // formation reads as "all on the same vehicle."
    const deckGeo = new THREE.BoxGeometry(4.2, 0.18, 6.0);
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.85, metalness: 0.05 });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = -0.15;
    deck.castShadow = true;
    deck.receiveShadow = true;
    cart.add(deck);

    // Wheel discs — flat side-rendered cylinders so they read at any angle.
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.18, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.7, metalness: 0.25 });
    const offsets: Array<[number, number]> = [
      [-2.1, -2.4], [2.1, -2.4], [-2.1, 2.4], [2.1, 2.4],
    ];
    for (const [wx, wz] of offsets) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(wx, -0.5, wz);
      w.castShadow = true;
      cart.add(w);
    }

    return cart;
  }

  /**
   * Caravan terminal — boarding kiosk placed south of each civic / guild
   * beacon. Visual: a low circular pad ("stand here"), a wooden signpost
   * pole, and an emissive cyan sign so it reads as travel-tier
   * infrastructure (vs. the hireling console's warm-amber obelisk).
   * Placeholder geometry until art lands.
   */
  static _addCaravanTerminalToGroup(group: THREE.Group): void {
    // Boarding pad
    const padGeo = new THREE.CylinderGeometry(1.8, 1.9, 0.18, 24);
    const padMat = new THREE.MeshStandardMaterial({ color: 0x3a352e, roughness: 0.88 });
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.y = 0.09;
    pad.receiveShadow = true;
    group.add(pad);

    // Signpost pole
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.6, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.78 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(1.3, 1.48, 0);
    pole.castShadow = true;
    group.add(pole);

    // Sign — emissive cyan panel, facing south
    const signGeo = new THREE.BoxGeometry(1.25, 0.55, 0.08);
    const signMat = new THREE.MeshStandardMaterial({
      color:             0x1a2a3a,
      emissive:          0x55a8d8,
      emissiveIntensity: 1.3,
      roughness:         0.45,
      metalness:         0.55,
    });
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0.95, 2.45, 0);
    group.add(sign);

    // Soft cyan light so the terminal reads at distance + dusk.
    const light = new THREE.PointLight(0x55a8d8, 0.7, 7, 1.5);
    light.position.set(0.95, 2.45, 0);
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
   *   Hireling  — amber    #ffaa44  (capsule — warm tone distinguishes mercs from bound companion)
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
    if (type === 'hireling')  return 0xffaa44; // warm amber — distinct from cyan companion + yellow player
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

  /**
   * Set visibility of any scene-level meshes the entity owns that aren't
   * children of `object3d` — heading chevron, etc. Called by EntityFactory's
   * distance-culling pass alongside `object3d.visible`. Default no-op;
   * subclasses with detached meshes override.
   */
  setSceneOwnedVisible(_visible: boolean): void { /* no-op */ }
}
