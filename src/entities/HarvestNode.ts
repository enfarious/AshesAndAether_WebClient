import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * HarvestNodeManager — floating glints on entities the player can harvest.
 *
 * Server-authoritative: per-zone NodePool emits `harvest_node_added`,
 * `harvest_node_batch_added`, and `harvest_node_removed` events. The client
 * maintains visuals in response.
 *
 * Renderer architecture: ONE InstancedMesh per tier (5 total). Each glint
 * is an instance slot with its own per-frame matrix (bob, spin, lateral
 * camera offset). Shard-only — sprite halo dropped because per-glint Sprite
 * + per-glint Material was burning ~3600 draw calls / frame at 1800 glints.
 *
 * Tier color via shared MeshBasicMaterial per tier (5 materials, not one
 * per glint). Material opacity pulses tier-wide (subtle, all glints in a
 * tier breathe together — acceptable simplification for the perf win).
 *
 * Slot management: pre-allocates SLOT_CAPACITY per tier; on remove we
 * compact via swap-with-last so mesh.count drops with population. Capacity
 * is generous (each tier averages ~360 with 1800 total + 5 tiers) so we
 * never need to grow at runtime.
 */

export interface HarvestNodeData {
  id:       string;
  type:     'tree' | 'rock' | 'plant';
  tier:     number;
  position: { x: number; y: number; z: number };
  species:  string;
}

const TIER_COLORS: Record<number, number> = {
  1: 0xcccccc, // silver
  2: 0x66ff66, // green
  3: 0x4ea0ff, // blue
  4: 0xc060ff, // purple
  5: 0xffcc44, // gold
  6: 0xff6644, // orange-red (future)
  7: 0xff44ff, // magenta (future)
};

// ── Tuning ────────────────────────────────────────────────────────────────
const SHARD_SIZE      = 0.55;        // metres (bigger to compensate for the
                                     // dropped halo sprite)
const FLOAT_BASE_M    = 1.5;         // base height above ground anchor
const FLOAT_AMP_M     = 0.25;        // bob amplitude
const FLOAT_FREQ_HZ   = 0.6;         // bob cycles per second
const SPIN_RATE_HZ    = 0.3;         // shard rotations per second
const OPACITY_LO      = 0.75;
const OPACITY_HI      = 1.00;
const PULSE_HZ        = 0.7;
const TRUNK_OFFSET_M  = 1.2;
const TRUNK_OFFSET_MIN_DIST_M = 0.5;
const SLOT_CAPACITY   = 2000;        // per tier — well above expected ~360 avg

// ── Per-tier instanced mesh ──────────────────────────────────────────────

interface TierMesh {
  mesh:     THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  geometry: THREE.OctahedronGeometry;
  /** Slot index → nodeId for swap-with-last compaction on remove. */
  slotToNode: (string | null)[];
  /** Number of live slots (mesh.count). */
  liveCount: number;
}

interface NodeRecord {
  data:     HarvestNodeData;
  tier:     number;
  slot:     number;
  groundY:  number;
  phase:    number;
}

export class HarvestNodeManager {
  private nodes      = new Map<string, NodeRecord>();
  private tierMeshes = new Map<number, TierMesh>();
  private age        = 0;
  private _dummy     = new THREE.Object3D();
  private _scratch   = new THREE.Vector3();

  constructor(
    private readonly scene:        THREE.Scene,
    private readonly getCameraPos: () => THREE.Vector3,
    private readonly getHeightmap: () => HeightmapService | null = () => null,
  ) {}

  addNode(data: HarvestNodeData): void {
    if (this.nodes.has(data.id)) return;

    const tier = Math.max(1, Math.min(7, data.tier));
    const tm   = this._getOrCreateTierMesh(tier);
    if (tm.liveCount >= SLOT_CAPACITY) {
      // Pool full — drop silently. Capacity is generous; if this fires
      // regularly bump SLOT_CAPACITY.
      return;
    }
    const slot = tm.liveCount;
    tm.slotToNode[slot] = data.id;
    tm.liveCount++;
    tm.mesh.count = tm.liveCount;

    const hm = this.getHeightmap();
    const groundY = hm?.getElevation(data.position.x, data.position.z) ?? data.position.y;

    this.nodes.set(data.id, {
      data, tier, slot, groundY,
      phase: Math.random() * Math.PI * 2,
    });
    // First-frame matrix is set in the next update() tick.
  }

  /** Bulk add — used for the join-time snapshot. */
  addNodes(batch: HarvestNodeData[]): void {
    for (const data of batch) this.addNode(data);
  }

  removeNode(id: string): void {
    const rec = this.nodes.get(id);
    if (!rec) return;
    const tm = this.tierMeshes.get(rec.tier);
    if (!tm) { this.nodes.delete(id); return; }

    // Swap-with-last: move the last slot's record into rec.slot, decrement
    // liveCount. Keeps the InstancedMesh slot range contiguous so mesh.count
    // shrinks naturally and the GPU isn't drawing empty slots at the end.
    const lastSlot = tm.liveCount - 1;
    if (rec.slot !== lastSlot) {
      const lastId = tm.slotToNode[lastSlot]!;
      const lastRec = this.nodes.get(lastId);
      if (lastRec) {
        lastRec.slot = rec.slot;
        tm.slotToNode[rec.slot] = lastId;
      }
    }
    tm.slotToNode[lastSlot] = null;
    tm.liveCount--;
    tm.mesh.count = tm.liveCount;
    this.nodes.delete(id);
    // Note: matrices for swapped slot get updated next tick by update().
  }

  setVisible(visible: boolean): void {
    for (const tm of this.tierMeshes.values()) tm.mesh.visible = visible;
  }

  clear(): void {
    for (const tm of this.tierMeshes.values()) {
      this.scene.remove(tm.mesh);
      tm.geometry.dispose();
      tm.material.dispose();
    }
    this.tierMeshes.clear();
    this.nodes.clear();
  }

  /** Per-frame: rebuild every glint's matrix (bob + spin + camera offset)
   *  and pulse tier-wide opacity. CPU cost ≈ N matrix builds where N is
   *  total live nodes; cheap (~0.5ms for 1800). GPU cost is now ~5 draw
   *  calls (one InstancedMesh per tier) instead of 3600.
   *
   *  Distance cull: glints beyond ClientConfig.drawDistance get scale=0,
   *  which collapses to degenerate triangles and skips rasterization. Cuts
   *  fragment-shader cost on dense node fields and removes visual clutter
   *  when the player tunes their draw distance down. */
  update(_dt: number): void {
    this.age += _dt;
    const camPos = this.getCameraPos();
    this._scratch.copy(camPos);

    // Glints have their own range setting (separate from entity draw
     // distance) — they're gameplay markers, not landscape, so they want
     // tighter visibility to keep visual signal sharp.
    const drawDist   = ClientConfig.harvestGlintRange;
    const drawDistSq = drawDist * drawDist;

    // Tier-wide opacity pulse — applied once per tier, not per glint.
    const pulse = (Math.sin(this.age * PULSE_HZ * Math.PI * 2) + 1) * 0.5;
    const tierOpacity = OPACITY_LO + (OPACITY_HI - OPACITY_LO) * pulse;
    for (const tm of this.tierMeshes.values()) {
      tm.material.opacity = tierOpacity;
    }

    for (const rec of this.nodes.values()) {
      const tm = this.tierMeshes.get(rec.tier);
      if (!tm) continue;

      const trunkX = rec.data.position.x;
      const trunkZ = rec.data.position.z;
      const dxc = this._scratch.x - trunkX;
      const dzc = this._scratch.z - trunkZ;
      const camDistSq = dxc * dxc + dzc * dzc;

      // Distance cull — far glints collapse to scale=0. Skip the bob/spin
      // math too since the matrix won't be visible anyway.
      if (camDistSq > drawDistSq) {
        this._dummy.position.set(trunkX, rec.groundY, trunkZ);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.setScalar(0);
        this._dummy.updateMatrix();
        tm.mesh.setMatrixAt(rec.slot, this._dummy.matrix);
        continue;
      }

      const t = this.age + rec.phase;

      // Lateral offset: push toward camera so the shard clears the trunk.
      // Reuses the (dxc, dzc) computed above for the cull check.
      let posX = trunkX, posZ = trunkZ;
      if (camDistSq > TRUNK_OFFSET_MIN_DIST_M * TRUNK_OFFSET_MIN_DIST_M) {
        const dist = Math.sqrt(camDistSq);
        posX = trunkX + (dxc / dist) * TRUNK_OFFSET_M;
        posZ = trunkZ + (dzc / dist) * TRUNK_OFFSET_M;
      }
      const posY = rec.groundY + FLOAT_BASE_M
        + Math.sin(t * FLOAT_FREQ_HZ * Math.PI * 2) * FLOAT_AMP_M;

      this._dummy.position.set(posX, posY, posZ);
      this._dummy.rotation.set(0, t * SPIN_RATE_HZ * Math.PI * 2, 0);
      this._dummy.scale.setScalar(1);
      this._dummy.updateMatrix();
      tm.mesh.setMatrixAt(rec.slot, this._dummy.matrix);
    }

    // Mark each tier's instance buffer dirty once after all writes.
    for (const tm of this.tierMeshes.values()) {
      tm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Refresh cached groundY for every node — call after heightmap mounts
   *  if any nodes were added before terrain was available. */
  repositionOnTerrain(): void {
    const hm = this.getHeightmap();
    if (!hm) return;
    for (const rec of this.nodes.values()) {
      const y = hm.getElevation(rec.data.position.x, rec.data.position.z);
      if (y !== null) rec.groundY = y;
    }
  }

  get count(): number { return this.nodes.size; }

  /** True iff any live node sits within `range` of (x, z). Used for the
   *  F-key fallback + the "Press F to harvest" HUD prompt. Cheap (XZ
   *  scan over the live set, ~1800 entries worst case). */
  hasNodeWithin(x: number, z: number, range: number): boolean {
    const rangeSq = range * range;
    for (const rec of this.nodes.values()) {
      const dx = rec.data.position.x - x;
      const dz = rec.data.position.z - z;
      if (dx * dx + dz * dz <= rangeSq) return true;
    }
    return false;
  }

  dispose(): void { this.clear(); }

  // ── Internals ──────────────────────────────────────────────────────────

  private _getOrCreateTierMesh(tier: number): TierMesh {
    let tm = this.tierMeshes.get(tier);
    if (tm) return tm;

    const geometry = new THREE.OctahedronGeometry(SHARD_SIZE, 0);
    const material = new THREE.MeshBasicMaterial({
      color:       TIER_COLORS[tier] ?? 0xffffff,
      transparent: true,
      opacity:     OPACITY_HI,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, SLOT_CAPACITY);
    mesh.count = 0;
    mesh.frustumCulled = false; // glints are tiny; per-instance frustum cull
                                // would over-cull
    mesh.castShadow    = false;
    mesh.receiveShadow = false;

    tm = {
      mesh, material, geometry,
      slotToNode: new Array<string | null>(SLOT_CAPACITY).fill(null),
      liveCount:  0,
    };
    this.tierMeshes.set(tier, tm);
    this.scene.add(mesh);
    return tm;
  }
}
