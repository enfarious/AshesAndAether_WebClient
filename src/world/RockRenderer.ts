import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * RockRenderer — low-poly rock outcrops scattered by the server's
 * RockRegistry. Each rock is half-buried (geometry centered at the
 * server-provided terrain Y) for a "natural outcrop" look rather than a
 * sphere floating on the ground.
 *
 * Server-authoritative: a single `rocks_initial` batch event arrives on
 * player join; this manager builds 6 InstancedMesh objects (2 species ×
 * 3 variants) and drops every rock into its variant's instance matrix.
 *
 * Cheap by design: one MeshStandardMaterial per species with `flatShading`
 * for the faceted look; per-vertex random offset baked into each variant
 * geometry so they don't all look like identical spaceships.
 */

export type RockSpecies = 'rock_granite' | 'rock_basalt';

export interface RockData {
  id:       string;
  species:  RockSpecies;
  variant:  number;        // 0..2
  position: { x: number; y: number; z: number };
  scale:    number;
  rotY:     number;
}

// ── Tuning ────────────────────────────────────────────────────────────────
const BASE_RADIUS_M       = 1.2;
const VARIANTS_PER_SPECIES = 3;
const VERTEX_JITTER_FRAC  = 0.30; // ±30% per-vertex perturbation
const COLOR_GRANITE       = 0x80868d; // cool gray
const COLOR_BASALT        = 0x4a4540; // warm dark

const SPECIES_COLOR: Record<RockSpecies, number> = {
  rock_granite: COLOR_GRANITE,
  rock_basalt:  COLOR_BASALT,
};

// ── Per-variant InstancedMesh ─────────────────────────────────────────────

type VariantKey = `${RockSpecies}:${number}`;

interface RockSlotData {
  /** World-space anchor matrix (position + rotation + scale baked once at
   *  add time). Per-frame cull rebuilds the rendered matrix from this base
   *  + a scale multiplier (0 if culled, 1 if visible). */
  baseMatrix: THREE.Matrix4;
  /** XZ position cached for distance checks — avoids decomposing the
   *  matrix every frame. */
  x: number;
  z: number;
}

interface VariantMesh {
  mesh:     THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  geometry: THREE.BufferGeometry;
  count:    number;  // number of instances actually placed
  /** Per-slot anchor data for the per-frame distance cull. */
  slots:    RockSlotData[];
}

export class RockRenderer {
  private rocks   = new Map<string, { variantKey: VariantKey; slot: number }>();
  private variantMeshes = new Map<VariantKey, VariantMesh>();
  private _dummy = new THREE.Object3D();
  private _scratchMatrix = new THREE.Matrix4();
  private _scratchScale  = new THREE.Vector3();

  constructor(
    private readonly scene:        THREE.Scene,
    /** Heightmap source — used at add time to lock rock Y to the same DEM
     *  the tree/glint visuals use. Falls back to data.position.y when null. */
    private readonly getHeightmap: () => HeightmapService | null = () => null,
    /** Camera position lookup — used by the per-frame distance cull so far
     *  rocks collapse to scale=0 instead of always rendering. */
    private readonly getCameraPos: () => THREE.Vector3 = () => new THREE.Vector3(0, 0, 0),
  ) {}

  /** Bulk-add rocks — used for the join-time `rocks_initial` snapshot.
   *  Pre-counts per-variant so each InstancedMesh allocates the right
   *  capacity once instead of resizing repeatedly. */
  addRocks(batch: RockData[]): void {
    if (batch.length === 0) return;

    // Bucket by variant key so we know how many slots each mesh needs.
    const byVariant = new Map<VariantKey, RockData[]>();
    for (const r of batch) {
      const key: VariantKey = `${r.species}:${r.variant}`;
      const arr = byVariant.get(key);
      if (arr) arr.push(r);
      else     byVariant.set(key, [r]);
    }

    for (const [key, rocks] of byVariant) {
      let vm = this.variantMeshes.get(key);
      const additional = rocks.length;
      const existing   = vm?.count ?? 0;
      const totalSlots = existing + additional;

      if (!vm) {
        vm = this._buildVariantMesh(key, totalSlots);
        this.variantMeshes.set(key, vm);
        this.scene.add(vm.mesh);
      } else {
        // Need to grow the InstancedMesh — Three has no in-place resize, so
        // rebuild with a larger count. Cheap since we only do this on add.
        vm = this._growVariantMesh(vm, key, totalSlots);
        this.variantMeshes.set(key, vm);
      }

      const hm = this.getHeightmap();
      for (let i = 0; i < rocks.length; i++) {
        const r       = rocks[i]!;
        const slot    = existing + i;
        const groundY = hm?.getElevation(r.position.x, r.position.z) ?? r.position.y;
        this._dummy.position.set(r.position.x, groundY, r.position.z);
        this._dummy.rotation.set(0, r.rotY, 0);
        this._dummy.scale.setScalar(r.scale);
        this._dummy.updateMatrix();
        vm.mesh.setMatrixAt(slot, this._dummy.matrix);
        // Cache the base matrix + XZ for the per-frame distance cull.
        vm.slots[slot] = {
          baseMatrix: this._dummy.matrix.clone(),
          x: r.position.x,
          z: r.position.z,
        };
        this.rocks.set(r.id, { variantKey: key, slot });
      }
      vm.count = totalSlots;
      vm.mesh.count = totalSlots;
      vm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Per-frame distance cull. Rocks beyond ClientConfig.rockVisibleRange
   *  get scale=0 (degenerate triangles, no rasterization). Otherwise the
   *  pre-baked anchor matrix is used as-is. Cheaper than rebuilding every
   *  rock matrix every frame, even with the slot-iteration overhead. */
  update(_dt: number): void {
    const camPos = this.getCameraPos();
    const camX   = camPos.x, camZ = camPos.z;
    const range   = ClientConfig.rockVisibleRange;
    const rangeSq = range * range;

    for (const vm of this.variantMeshes.values()) {
      let dirty = false;
      for (let i = 0; i < vm.count; i++) {
        const s = vm.slots[i];
        if (!s) continue;
        const dx = s.x - camX;
        const dz = s.z - camZ;
        const inRange = dx * dx + dz * dz <= rangeSq;

        // Decide what matrix the slot should hold this frame.
        if (inRange) {
          // Restore base matrix (rotation + scale + position baked at add time).
          vm.mesh.setMatrixAt(i, s.baseMatrix);
        } else {
          // Collapse to scale=0 — keeps position so future frame restores
          // are cheap. Reuses scratch matrix to avoid alloc.
          this._scratchMatrix.copy(s.baseMatrix);
          this._scratchScale.set(0, 0, 0);
          this._scratchMatrix.scale(this._scratchScale);
          vm.mesh.setMatrixAt(i, this._scratchMatrix);
        }
        dirty = true;
      }
      if (dirty) vm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  setVisible(visible: boolean): void {
    for (const vm of this.variantMeshes.values()) vm.mesh.visible = visible;
  }

  /** Drop everything — used on zone change. */
  clear(): void {
    for (const vm of this.variantMeshes.values()) {
      this.scene.remove(vm.mesh);
      vm.geometry.dispose();
      vm.material.dispose();
    }
    this.variantMeshes.clear();
    this.rocks.clear();
  }

  /** Total live rock count — for HUD/debug. */
  get count(): number { return this.rocks.size; }

  dispose(): void {
    this.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private _buildVariantMesh(key: VariantKey, slots: number): VariantMesh {
    const colonIdx = key.lastIndexOf(':');
    const species  = key.slice(0, colonIdx) as RockSpecies;
    const variant  = parseInt(key.slice(colonIdx + 1), 10);

    const geometry = _buildRockGeo(variant, BASE_RADIUS_M);
    const material = new THREE.MeshStandardMaterial({
      color:        SPECIES_COLOR[species],
      roughness:    0.95,
      flatShading:  true,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, slots);
    mesh.castShadow    = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    return { mesh, material, geometry, count: 0, slots: new Array<RockSlotData>(slots) };
  }

  /** Allocate a larger InstancedMesh, copy existing matrices, replace in scene. */
  private _growVariantMesh(old: VariantMesh, key: VariantKey, newSlots: number): VariantMesh {
    const next = this._buildVariantMesh(key, newSlots);
    // Copy old instance matrices forward
    const m = new THREE.Matrix4();
    for (let i = 0; i < old.count; i++) {
      old.mesh.getMatrixAt(i, m);
      next.mesh.setMatrixAt(i, m);
      next.slots[i] = old.slots[i]!;
    }
    next.count = old.count;
    next.mesh.count = old.count;
    next.mesh.instanceMatrix.needsUpdate = true;

    this.scene.remove(old.mesh);
    old.geometry.dispose();
    old.material.dispose();
    this.scene.add(next.mesh);
    return next;
  }
}

// ── Geometry builders ─────────────────────────────────────────────────────

/** Icosahedron with per-vertex jitter, deterministic per variant. Different
 *  jitter seeds = different chunky shapes; same variant produces the same
 *  geometry across instances so we can reuse it via InstancedMesh. */
function _buildRockGeo(variant: number, baseRadius: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(baseRadius, 0);
  const positions = geo.attributes['position']!;
  const rng = _mulberry32(variant * 1000 + 73);
  for (let i = 0; i < positions.count; i++) {
    const jx = (rng() - 0.5) * baseRadius * VERTEX_JITTER_FRAC;
    const jy = (rng() - 0.5) * baseRadius * VERTEX_JITTER_FRAC * 0.6; // less Y jitter
    const jz = (rng() - 0.5) * baseRadius * VERTEX_JITTER_FRAC;
    positions.setX(i, positions.getX(i) + jx);
    positions.setY(i, positions.getY(i) + jy);
    positions.setZ(i, positions.getZ(i) + jz);
  }
  positions.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function _mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
