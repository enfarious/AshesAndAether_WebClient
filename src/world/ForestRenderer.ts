import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { HeightmapService } from '@/world/HeightmapService';
import { chunkedFor }     from '@/world/yieldUtil';
import type { Entity } from '@/network/Protocol';

export const FOREST_SPECIES = new Set(['pine_tree', 'oak_tree', 'maple_tree']);

type Species = 'pine_tree' | 'oak_tree' | 'maple_tree';
type VariantIndex = 0 | 1 | 2 | 3 | 4;
type VariantKey = `${Species}:${VariantIndex}`;

// Trees must move this far beyond the view range before being culled.
const REMOVE_HYSTERESIS = 1.10;

// Re-evaluate visibility when player moves this many metres.
const MOVE_THRESHOLD_SQ = 625; // 25 m

// ── Per-variant mesh pair ─────────────────────────────────────────────────────

interface VariantMeshes {
  bark:    THREE.InstancedMesh;
  foliage: THREE.InstancedMesh;
}

// ── Per-tree record ───────────────────────────────────────────────────────────

interface TreeRecord {
  variantKey: VariantKey;
  x:          number;
  y:          number;
  z:          number;
  scale:      number;  // growth-stage scale (0.1–1.0)
  rotY:       number;  // deterministic Y rotation from ID hash
  slot:       number;  // index in per-variant InstancedMesh (-1 when pending)
}

// ── ForestRenderer ────────────────────────────────────────────────────────────

/**
 * Renders forest trees using 15 pre-built variant geometries (5 per species).
 * Variant is server-authoritative (assigned at spawn, carried over protocol).
 *
 * Out-of-range trees are held in _pending (no GPU allocation).
 * In-range trees live in _active with a contiguous InstancedMesh slot.
 * Slots are compacted via swap-with-last when a tree leaves range.
 * _applyMatrix applies position + uniform growth scale + deterministic Y rotation.
 */
export class ForestRenderer {
  private _scene:     THREE.Scene;
  private _heightmap: HeightmapService | null = null;

  private _active       = new Map<string, TreeRecord>();
  private _pending      = new Map<string, TreeRecord>();
  private _variantSlots = new Map<VariantKey, string[]>();
  private _variantMeshes = new Map<VariantKey, VariantMeshes>();

  private _dirty     = false;
  private _lastPx    = NaN;
  private _lastPz    = NaN;
  private _lastRange = ClientConfig.treeVisibleRange;

  private readonly _dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, registry: EntityRegistry) {
    this._scene = scene;
    registry.onAdd(   e  => { if (_isTree(e)) this._add(e);      });
    registry.onUpdate(e  => { if (_isTree(e)) this._onUpdate(e); });
    registry.onRemove(id => this._remove(id));
  }

  /** Bulk-load trees from the per-zone landscape manifest fetched over HTTP
   *  during the loading screen. Bypasses the EntityRegistry (these aren't
   *  realtime entities) and inserts directly into _pending so the existing
   *  visibility refresh promotes them on the next update tick. Idempotent on
   *  id — duplicate plant_spawn deltas arriving over the WebSocket are
   *  no-ops thanks to the existing _add guard. */
  async bulkAddFromManifest(
    trees: Array<{
      id: string; species: string; x: number; y: number; z: number; variant?: number;
    }>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    // Chunked — large zones can ship 5 000+ trees and the per-tree cost
    // (heightmap sample + map insert) can pile up to a second-plus of
    // synchronous work without yielding. 500 trees per chunk lands well
    // inside the responsiveness budget.
    await chunkedFor(trees, 500, (t) => {
      if (this._active.has(t.id) || this._pending.has(t.id)) return;
      if (!FOREST_SPECIES.has(t.species)) return;
      const species = t.species as Species;
      const variant = ((t.variant ?? 0) % 5) as VariantIndex;
      const vk: VariantKey = `${species}:${variant}`;
      const y = this._heightmap?.getElevation(t.x, t.z) ?? t.y;
      const h = _idHash(t.id);
      const rotY = (h & 0xFFFF) / 0xFFFF * Math.PI * 2;
      this._pending.set(t.id, {
        variantKey: vk,
        x: t.x, y, z: t.z,
        scale: 1.0, // manifest trees ship at mature scale
        rotY,
        slot: -1,
      });
    }, onProgress);
    // Force a visibility recompute on the next update() so newly-added trees
    // around the player promote from _pending to _active immediately.
    this._lastPx = NaN;
  }

  setHeightmap(hm: HeightmapService | null): void {
    this._heightmap = hm;
    if (!hm) return;
    for (const r of this._active.values()) {
      const elev = hm.getElevation(r.x, r.z);
      if (elev !== null) r.y = elev;
    }
    for (const r of this._pending.values()) {
      const elev = hm.getElevation(r.x, r.z);
      if (elev !== null) r.y = elev;
    }
    this._dirty  = true;
    this._lastPx = NaN;
  }

  update(px: number, pz: number): void {
    const currentRange = ClientConfig.treeVisibleRange;
    if (currentRange !== this._lastRange) {
      this._lastRange = currentRange;
      this._lastPx = NaN;
    }

    const dx = px - this._lastPx;
    const dz = pz - this._lastPz;
    if (isNaN(this._lastPx) || dx * dx + dz * dz > MOVE_THRESHOLD_SQ) {
      this._lastPx = px;
      this._lastPz = pz;
      this._refreshVisibility(px, pz);
    }

    if (this._dirty) this._rebuild();
  }

  clear(): void {
    for (const vm of this._variantMeshes.values()) _disposeVariant(this._scene, vm);
    this._variantMeshes.clear();
    this._active.clear();
    this._pending.clear();
    this._variantSlots.clear();
    this._dirty  = false;
    this._lastPx = NaN;
  }

  dispose(): void { this.clear(); }

  /**
   * Returns XZ positions of all in-range trees within rSq of (x, z).
   * Used by PlayerEntity for analytical tree-trunk collision.
   */
  queryNearby(x: number, z: number, rSq: number): Array<{ x: number; z: number }> {
    const result: Array<{ x: number; z: number }> = [];
    for (const r of this._active.values()) {
      const dx = r.x - x, dz = r.z - z;
      if (dx * dx + dz * dz <= rSq) result.push({ x: r.x, z: r.z });
    }
    return result;
  }

  // ── Registry handlers ─────────────────────────────────────────────────────

  private _add(entity: Entity): void {
    if (this._active.has(entity.id) || this._pending.has(entity.id)) return;

    const species = entity.tag as Species;
    const pos     = entity.position ?? { x: 0, y: 0, z: 0 };
    const y       = this._heightmap?.getElevation(pos.x, pos.z) ?? pos.y;
    const variant = ((entity.variant ?? 0) % 5) as VariantIndex;
    const vk: VariantKey = `${species}:${variant}`;
    const h   = _idHash(entity.id);
    const rotY = (h & 0xFFFF) / 0xFFFF * Math.PI * 2;

    const r: TreeRecord = {
      variantKey: vk,
      x: pos.x, y, z: pos.z,
      scale: _stageScale(entity.currentAction as string | undefined),
      rotY,
      slot: -1,
    };

    if (!isNaN(this._lastPx)) {
      const ddx = pos.x - this._lastPx, ddz = pos.z - this._lastPz;
      if (ddx * ddx + ddz * ddz <= this._lastRange ** 2) {
        this._promoteToActive(entity.id, r);
        this._dirty = true;
        return;
      }
    }
    this._pending.set(entity.id, r);
  }

  private _onUpdate(entity: Entity): void {
    const r = this._active.get(entity.id) ?? this._pending.get(entity.id);
    if (!r) return;
    const stage = entity.currentAction as string | undefined;
    if (stage) {
      r.scale = _stageScale(stage);
      if (this._active.has(entity.id) && this._variantMeshes.has(r.variantKey)) {
        this._applyMatrix(r);
        const vm = this._variantMeshes.get(r.variantKey)!;
        vm.bark.instanceMatrix.needsUpdate    = true;
        vm.foliage.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private _remove(id: string): void {
    if (this._active.has(id)) {
      this._demoteFromActive(id);
      this._dirty = true;
    } else {
      this._pending.delete(id);
    }
  }

  // ── Slot management ───────────────────────────────────────────────────────

  private _promoteToActive(id: string, r: TreeRecord): void {
    const slots = this._variantSlots.get(r.variantKey) ?? [];
    r.slot = slots.length;
    slots.push(id);
    this._variantSlots.set(r.variantKey, slots);
    this._active.set(id, r);
    this._pending.delete(id);
  }

  private _demoteFromActive(id: string): void {
    const r = this._active.get(id);
    if (!r) return;
    this._active.delete(id);

    const slots   = this._variantSlots.get(r.variantKey)!;
    const lastIdx = slots.length - 1;
    if (r.slot !== lastIdx) {
      const swappedId = slots[lastIdx]!;
      slots[r.slot]   = swappedId;
      this._active.get(swappedId)!.slot = r.slot;
    }
    slots.pop();
    r.slot = -1;
  }

  // ── Rebuild / visibility ──────────────────────────────────────────────────

  private _rebuild(): void {
    for (const vm of this._variantMeshes.values()) _disposeVariant(this._scene, vm);
    this._variantMeshes.clear();

    for (const [vk, ids] of this._variantSlots) {
      const count = ids.length;
      if (count === 0) continue;
      const vm = _buildVariantMeshes(vk, count);
      this._scene.add(vm.bark, vm.foliage);
      this._variantMeshes.set(vk, vm);
    }

    for (const r of this._active.values()) this._applyMatrix(r);
    for (const vm of this._variantMeshes.values()) {
      vm.bark.instanceMatrix.needsUpdate    = true;
      vm.foliage.instanceMatrix.needsUpdate = true;
    }

    this._dirty = false;
  }

  private _refreshVisibility(px: number, pz: number): void {
    const range    = ClientConfig.treeVisibleRange;
    const addSq    = range ** 2;
    const removeSq = (range * REMOVE_HYSTERESIS) ** 2;
    let changed    = false;

    const toDemote: string[] = [];
    for (const [id, r] of this._active) {
      const dx = r.x - px, dz = r.z - pz;
      if (dx * dx + dz * dz > removeSq) toDemote.push(id);
    }
    for (const id of toDemote) {
      const r = this._active.get(id)!;
      this._demoteFromActive(id);
      this._pending.set(id, r);
      changed = true;
    }

    const toPromote: string[] = [];
    for (const [id, r] of this._pending) {
      const dx = r.x - px, dz = r.z - pz;
      if (dx * dx + dz * dz <= addSq) toPromote.push(id);
    }
    for (const id of toPromote) {
      this._promoteToActive(id, this._pending.get(id)!);
      changed = true;
    }

    if (changed) this._dirty = true;
  }

  private _applyMatrix(r: TreeRecord): void {
    const vm = this._variantMeshes.get(r.variantKey);
    if (!vm) return;
    const d = this._dummy;
    d.position.set(r.x, r.y, r.z);
    d.rotation.set(0, r.rotY, 0);
    d.scale.setScalar(r.scale);
    d.updateMatrix();
    vm.bark.setMatrixAt(r.slot, d.matrix);
    vm.foliage.setMatrixAt(r.slot, d.matrix);
  }
}

// ── Variant specs ─────────────────────────────────────────────────────────────

// Pine: each variant embeds its foliage tiers directly.
// yFrac = fraction of trunkH where the cone BASE starts (wide bottom of each tier).
// Tiers overlap intentionally — each tier's apex is above the next tier's base.
const PINE_SPECS = [
  // Variant 0: young sapling — 2 tiers
  { trunkH: 8,  trunkR: 0.18, cones: [
    { r: 3.2, h: 5.5, yFrac: 0.28 },
    { r: 1.6, h: 3.8, yFrac: 0.56 },
  ]},
  // Variant 1: adolescent — 3 tiers
  { trunkH: 11, trunkR: 0.24, cones: [
    { r: 4.0, h: 6.5, yFrac: 0.26 },
    { r: 2.6, h: 5.2, yFrac: 0.46 },
    { r: 1.4, h: 3.5, yFrac: 0.65 },
  ]},
  // Variant 2: mature — 4 tiers
  { trunkH: 14, trunkR: 0.30, cones: [
    { r: 5.0, h: 7.0, yFrac: 0.24 },
    { r: 3.4, h: 6.0, yFrac: 0.42 },
    { r: 2.1, h: 4.8, yFrac: 0.58 },
    { r: 1.0, h: 3.2, yFrac: 0.73 },
  ]},
  // Variant 3: old growth — 5 tiers
  { trunkH: 18, trunkR: 0.40, cones: [
    { r: 5.8, h: 7.5, yFrac: 0.22 },
    { r: 4.2, h: 6.5, yFrac: 0.37 },
    { r: 2.8, h: 5.5, yFrac: 0.51 },
    { r: 1.7, h: 4.0, yFrac: 0.63 },
    { r: 0.9, h: 2.8, yFrac: 0.75 },
  ]},
  // Variant 4: ancient — 6 tiers, bare spire tip
  { trunkH: 22, trunkR: 0.52, cones: [
    { r: 6.5, h: 8.0, yFrac: 0.20 },
    { r: 5.0, h: 7.0, yFrac: 0.33 },
    { r: 3.6, h: 6.0, yFrac: 0.46 },
    { r: 2.3, h: 4.8, yFrac: 0.57 },
    { r: 1.3, h: 3.5, yFrac: 0.68 },
    { r: 0.6, h: 2.2, yFrac: 0.79 },
  ]},
] as const;

type DeciduousSpec = {
  trunkH:     number;
  crownR:     number;
  limbs:      number;
  limbReach?: number;   // horizontal reach in metres (default crownR × 0.50)
  limbYFrac?: number;   // fraction up trunk for limb attachment (default 0.55)
  limbRatio?: number;   // limb sphere radius as fraction of crownR (default 0.30)
};

const DECIDUOUS_SPECS: Record<'oak_tree' | 'maple_tree', ReadonlyArray<DeciduousSpec>> = {
  // Oaks: "1 2 1" silhouette — 1 crown sphere on top, 2 wide limbs in the middle,
  // trunk tapers to the ground. limbReach > crownR pushes limbs well past the crown.
  oak_tree: [
    // 0: young oak — compact single crown, no limbs yet
    { trunkH: 9,  crownR: 5.5, limbs: 0 },
    // 1: adolescent — first two limbs spreading
    { trunkH: 11, crownR: 6.5, limbs: 2, limbReach: 5.5, limbYFrac: 0.60, limbRatio: 0.38 },
    // 2: classic mature "1 2 1"
    { trunkH: 12, crownR: 7.5, limbs: 2, limbReach: 7.5, limbYFrac: 0.58, limbRatio: 0.40 },
    // 3: large, three heavy limbs
    { trunkH: 13, crownR: 8.0, limbs: 3, limbReach: 7.0, limbYFrac: 0.56, limbRatio: 0.38 },
    // 4: ancient — two massive limbs reaching very wide
    { trunkH: 13, crownR: 9.0, limbs: 2, limbReach: 10.5, limbYFrac: 0.54, limbRatio: 0.46 },
  ],
  // Maples: broad, full crowns — crownR is large, limbs spread wide and overlap
  // to create a dense rounded canopy.
  maple_tree: [
    // 0: young maple — full round crown, no branches yet
    { trunkH: 8,  crownR: 6.5, limbs: 0 },
    // 1: medium maple — three spreading limbs fill out the canopy
    { trunkH: 9,  crownR: 8.0, limbs: 3, limbReach: 6.5, limbYFrac: 0.60, limbRatio: 0.33 },
    // 2: full spreading maple
    { trunkH: 10, crownR: 9.0, limbs: 4, limbReach: 8.0, limbYFrac: 0.58, limbRatio: 0.32 },
    // 3: large maple, very wide canopy
    { trunkH: 10, crownR: 10.0, limbs: 3, limbReach: 9.5, limbYFrac: 0.56, limbRatio: 0.36 },
    // 4: giant maple — massive spreading crown
    { trunkH: 11, crownR: 11.0, limbs: 4, limbReach: 10.5, limbYFrac: 0.55, limbRatio: 0.33 },
  ],
};

// ── Geometry builders ─────────────────────────────────────────────────────────

function _buildPineGeos(variant: number): { bark: THREE.BufferGeometry; foliage: THREE.BufferGeometry } {
  const spec = PINE_SPECS[variant]!;
  const { trunkH, trunkR, cones } = spec;

  const barkGeo = new THREE.ConeGeometry(trunkR, trunkH, 6, 1);
  barkGeo.translate(0, trunkH / 2, 0);

  const foliageGeos: THREE.BufferGeometry[] = [];
  for (const cs of cones) {
    const geo = new THREE.ConeGeometry(cs.r, cs.h, 7, 1);
    // yFrac marks where the cone base (wide end) starts; add h/2 to centre the geometry.
    geo.translate(0, trunkH * cs.yFrac + cs.h / 2, 0);
    foliageGeos.push(geo);
  }

  return { bark: barkGeo, foliage: _mergeGeos(foliageGeos) };
}

function _buildDeciduousGeos(species: 'oak_tree' | 'maple_tree', variant: number): { bark: THREE.BufferGeometry; foliage: THREE.BufferGeometry } {
  const spec      = DECIDUOUS_SPECS[species][variant]!;
  const { trunkH, crownR, limbs } = spec;
  const reach      = spec.limbReach  ?? crownR * 0.50;
  const attachFrac = spec.limbYFrac  ?? 0.55;
  const limbSphereR = crownR * (spec.limbRatio ?? 0.30);

  const trunkGeo = new THREE.ConeGeometry(0.45, trunkH, 6, 1);
  trunkGeo.translate(0, trunkH / 2, 0);
  const barkGeos: THREE.BufferGeometry[] = [trunkGeo];

  const crownGeo = new THREE.SphereGeometry(crownR, 8, 6);
  crownGeo.translate(0, trunkH * 0.90 + crownR * 0.55, 0);
  const foliageGeos: THREE.BufferGeometry[] = [crownGeo];

  const attachY = trunkH * attachFrac;

  for (let i = 0; i < limbs; i++) {
    const angle   = (i / limbs) * Math.PI * 2;
    const dx      = Math.cos(angle) * reach;
    const dz      = Math.sin(angle) * reach;
    const dy      = -reach * 0.10;
    const limbLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const limbGeo = new THREE.CylinderGeometry(0.12, 0.12, limbLen, 4, 1);
    const limbDir = new THREE.Vector3(dx, dy, dz).normalize();
    const quat    = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), limbDir);
    const mat4    = new THREE.Matrix4().compose(
      new THREE.Vector3(dx * 0.5, attachY + dy * 0.5, dz * 0.5),
      quat,
      new THREE.Vector3(1, 1, 1),
    );
    limbGeo.applyMatrix4(mat4);
    barkGeos.push(limbGeo);

    const sGeo = new THREE.SphereGeometry(limbSphereR, 6, 4);
    sGeo.translate(dx, attachY + dy, dz);
    foliageGeos.push(sGeo);
  }

  return { bark: _mergeGeos(barkGeos), foliage: _mergeGeos(foliageGeos) };
}

function _buildVariantMeshes(vk: VariantKey, count: number): VariantMeshes {
  const colonIdx = vk.lastIndexOf(':');
  const species  = vk.slice(0, colonIdx) as Species;
  const variant  = parseInt(vk.slice(colonIdx + 1));

  let barkGeo: THREE.BufferGeometry;
  let foliageGeo: THREE.BufferGeometry;
  let foliageColor: number;

  if (species === 'pine_tree') {
    const g = _buildPineGeos(variant);
    barkGeo    = g.bark;
    foliageGeo = g.foliage;
    foliageColor = 0x2d5a28;
  } else {
    const g = _buildDeciduousGeos(species, variant);
    barkGeo    = g.bark;
    foliageGeo = g.foliage;
    foliageColor = species === 'maple_tree' ? 0x4a6828 : 0x3a6820;
  }

  const barkMat    = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.92 });
  const foliageMat = new THREE.MeshStandardMaterial({ color: foliageColor, roughness: 0.88 });

  return {
    bark:    _instanced(barkGeo, barkMat, count),
    foliage: _instanced(foliageGeo, foliageMat, count),
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];
  let vertOffset = 0;

  for (const geo of geos) {
    const pos = geo.attributes['position']?.array as Float32Array | undefined;
    const nor = geo.attributes['normal']?.array   as Float32Array | undefined;
    const uv  = geo.attributes['uv']?.array       as Float32Array | undefined;
    const idx = geo.index?.array as Uint16Array | Uint32Array | undefined;
    if (!pos) { geo.dispose(); continue; }

    for (let i = 0; i < pos.length; i++) positions.push(pos[i]!);
    if (nor) for (let i = 0; i < nor.length; i++) normals.push(nor[i]!);
    if (uv)  for (let i = 0; i < uv.length;  i++) uvs.push(uv[i]!);

    const vertCount = pos.length / 3;
    if (idx) {
      for (let i = 0; i < idx.length; i++) indices.push(idx[i]! + vertOffset);
    } else {
      for (let i = 0; i < vertCount; i++) indices.push(i + vertOffset);
    }
    vertOffset += vertCount;
    geo.dispose();
  }

  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  if (normals.length) out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  if (uvs.length)     out.setAttribute('uv',     new THREE.BufferAttribute(new Float32Array(uvs), 2));
  out.setIndex(indices);
  return out;
}

function _instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.castShadow    = false;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

function _disposeVariant(scene: THREE.Scene, vm: VariantMeshes): void {
  scene.remove(vm.bark, vm.foliage);
  vm.bark.geometry.dispose();
  (vm.bark.material as THREE.Material).dispose();
  vm.foliage.geometry.dispose();
  (vm.foliage.material as THREE.Material).dispose();
}

function _isTree(e: Entity): boolean {
  return e.type === 'plant' && FOREST_SPECIES.has(e.tag ?? '');
}

function _stageScale(stage: string | undefined): number {
  switch (stage) {
    case 'stage_seed':      return 0.10;
    case 'stage_sprout':    return 0.30;
    case 'stage_growing':   return 0.60;
    case 'stage_mature':    return 1.00;
    case 'stage_flowering': return 1.00;
    case 'stage_withering': return 0.90;
    case 'stage_dead':      return 0.50;
    default:                return 1.00;
  }
}

function _idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}
