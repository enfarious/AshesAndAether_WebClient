import * as THREE from 'three';

/**
 * CorpseRenderer — overworld death-drop bundles.
 *
 * Server-authoritative: spawned via `corpse_added`, listed at join via
 * `corpses_initial`, removed via `corpse_removed` (decay or successful
 * loot). v0 is shared neutral mesh — all corpses look the same. A subtle
 * tier-distinction (own corpse glows softly) lives on the client side and
 * is opt-in based on which character we're rendering for.
 *
 * Visual: low-poly bundle (a flattened cylinder for the sack body + a
 * small flat-shaded box "lid"), gray-brown material, no animation. Owned
 * corpses get a soft warm pulse so the player can spot their own from a
 * distance when they walk back.
 */

export interface CorpseData {
  id:                 string;
  ownerCharacterId:   string;
  ownerCharacterName: string;
  position:           { x: number; y: number; z: number };
  expiresAt:          number;
}

const BUNDLE_RADIUS = 0.5;
const BUNDLE_HEIGHT = 0.55;
const LID_SIZE      = 0.45;
const LID_HEIGHT    = 0.18;

const COLOR_BUNDLE = new THREE.Color(0x6b5439); // dark brown leather
const COLOR_LID    = new THREE.Color(0x4a3525); // darker
const COLOR_OWN    = new THREE.Color(0xffaa55); // warm pulse for own-corpses

const OWN_PULSE_HZ      = 0.6;
const OWN_OPACITY_LO    = 0.25;
const OWN_OPACITY_HI    = 0.55;

interface CorpseInstance {
  data:        CorpseData;
  group:       THREE.Group;
  bundleMesh:  THREE.Mesh;
  lidMesh:     THREE.Mesh;
  /** Soft glow added only for the local player's own corpses. */
  ownGlow?:    THREE.Mesh;
  ownGlowMat?: THREE.MeshBasicMaterial;
  phase:       number;
}

export class CorpseRenderer {
  private corpses = new Map<string, CorpseInstance>();
  private age = 0;

  constructor(
    private readonly scene: THREE.Scene,
    /** Returns the local player's character id (or null pre-login). Used to
     *  apply the own-corpse glow only on corpses the local player can loot. */
    private readonly getLocalCharacterId: () => string | null,
    /** Terrain ground-Y lookup. Returns null until terrain loads. */
    private readonly getTerrainRoot?:     () => THREE.Object3D | null,
  ) {}

  addCorpse(data: CorpseData): void {
    if (this.corpses.has(data.id)) return;
    const inst = this._createCorpse(data);
    this.corpses.set(data.id, inst);
    this.scene.add(inst.group);
  }

  addCorpses(batch: CorpseData[]): void {
    for (const c of batch) this.addCorpse(c);
  }

  removeCorpse(id: string): void {
    const inst = this.corpses.get(id);
    if (!inst) return;
    this.scene.remove(inst.group);
    inst.bundleMesh.geometry.dispose();
    (inst.bundleMesh.material as THREE.Material).dispose();
    inst.lidMesh.geometry.dispose();
    (inst.lidMesh.material as THREE.Material).dispose();
    if (inst.ownGlow) {
      inst.ownGlow.geometry.dispose();
      inst.ownGlowMat?.dispose();
    }
    this.corpses.delete(id);
  }

  setVisible(visible: boolean): void {
    for (const inst of this.corpses.values()) inst.group.visible = visible;
  }

  clear(): void {
    for (const id of Array.from(this.corpses.keys())) this.removeCorpse(id);
  }

  /** Per-frame: pulse own-corpse glow opacity. Other corpses are static. */
  update(dt: number): void {
    this.age += dt;
    for (const inst of this.corpses.values()) {
      if (!inst.ownGlowMat) continue;
      const t = this.age + inst.phase;
      const pulse = (Math.sin(t * OWN_PULSE_HZ * Math.PI * 2) + 1) * 0.5;
      inst.ownGlowMat.opacity = OWN_OPACITY_LO + (OWN_OPACITY_HI - OWN_OPACITY_LO) * pulse;
    }
  }

  /** Re-raycast all corpses onto terrain — call after worldRoot loads. */
  repositionOnTerrain(): void {
    for (const inst of this.corpses.values()) {
      const { x, z, y } = inst.data.position;
      const groundY = this._findGroundY(x, z, y);
      inst.group.position.y = groundY;
    }
  }

  get count(): number { return this.corpses.size; }

  /** True if a corpse the local player can loot (their own) sits within
   *  `radius` metres of (x, z). Drives the F-key /loot probe + HUD prompt;
   *  mirrors `HarvestNodeManager.hasNodeWithin`'s shape. */
  hasLootableCorpseWithin(x: number, z: number, radius: number): boolean {
    const localId = this.getLocalCharacterId();
    if (!localId) return false;
    const r2 = radius * radius;
    for (const inst of this.corpses.values()) {
      if (inst.data.ownerCharacterId !== localId) continue;
      const dx = inst.data.position.x - x;
      const dz = inst.data.position.z - z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  dispose(): void { this.clear(); }

  // ── Internals ──────────────────────────────────────────────────────────

  private _createCorpse(data: CorpseData): CorpseInstance {
    const groundY = this._findGroundY(data.position.x, data.position.z, data.position.y);
    const isOwn   = data.ownerCharacterId === this.getLocalCharacterId();
    const phase   = Math.random() * Math.PI * 2;

    const group = new THREE.Group();
    group.position.set(data.position.x, groundY, data.position.z);

    // Bundle body — a squat flat-topped cylinder, slightly tilted for "fell"
    // feel.
    const bundleGeo = new THREE.CylinderGeometry(BUNDLE_RADIUS, BUNDLE_RADIUS * 1.1, BUNDLE_HEIGHT, 8, 1);
    bundleGeo.translate(0, BUNDLE_HEIGHT / 2, 0);
    const bundleMat = new THREE.MeshStandardMaterial({
      color:       COLOR_BUNDLE,
      roughness:   0.95,
      flatShading: true,
    });
    const bundleMesh = new THREE.Mesh(bundleGeo, bundleMat);
    bundleMesh.rotation.z = (Math.random() - 0.5) * 0.15;
    bundleMesh.frustumCulled = false;
    group.add(bundleMesh);

    // Lid — a flat box on top, slight rotation
    const lidGeo = new THREE.BoxGeometry(LID_SIZE, LID_HEIGHT, LID_SIZE);
    const lidMat = new THREE.MeshStandardMaterial({
      color:       COLOR_LID,
      roughness:   0.9,
      flatShading: true,
    });
    const lidMesh = new THREE.Mesh(lidGeo, lidMat);
    lidMesh.position.y = BUNDLE_HEIGHT + LID_HEIGHT / 2;
    lidMesh.rotation.y = Math.random() * Math.PI * 0.3;
    lidMesh.frustumCulled = false;
    group.add(lidMesh);

    const inst: CorpseInstance = { data, group, bundleMesh, lidMesh, phase };

    if (isOwn) {
      // Soft warm halo so the local player can spot their own corpse from
      // farther than the bundle silhouette alone allows.
      const glowGeo = new THREE.SphereGeometry(BUNDLE_RADIUS * 2.4, 12, 8);
      const glowMat = new THREE.MeshBasicMaterial({
        color:       COLOR_OWN,
        transparent: true,
        opacity:     OWN_OPACITY_HI,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.y = BUNDLE_HEIGHT * 0.6;
      glow.frustumCulled = false;
      group.add(glow);
      inst.ownGlow    = glow;
      inst.ownGlowMat = glowMat;
    }

    return inst;
  }

  private _findGroundY(x: number, z: number, fallbackY: number): number {
    const root = this.getTerrainRoot?.();
    if (!root) return fallbackY;
    const ray = new THREE.Raycaster(
      new THREE.Vector3(x, 5000, z),
      new THREE.Vector3(0, -1, 0),
    );
    const hits = ray.intersectObject(root, true);
    if (hits.length > 0 && hits[0]) return hits[0].point.y;
    return fallbackY;
  }
}
