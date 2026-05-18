import * as THREE from 'three';
import type { BuildingChunkUserData } from './AssetLoader';

/**
 * Per-frame LOD switcher for chunked-buildings groups.
 *
 * AssetLoader wraps each baked building chunk in a parent THREE.Group whose
 * `userData` is a `BuildingChunkUserData` carrying the chunk centre (`cx` /
 * `cz`, metres) and one child group per LOD tier. This controller scans the
 * worldRoot once on `setWorldRoot()` to build a flat index, then on every
 * frame walks the index, computes XZ-plane distance from the player focus
 * to each chunk centre, and flips `.visible` per LOD group.
 *
 * Bands (with ±50 m hysteresis to avoid popping when the player loiters
 * near a boundary):
 *
 *   d ≤ 500 m            → LOD0
 *   500 m < d ≤ 1500 m   → LOD1 (fallback to LOD0 if no LOD1 baked)
 *   d > 1500 m           → hidden  (LOD2 impostor band, not yet baked)
 *
 * Focus is the player's XZ position, not the camera position. The orbit
 * camera floats behind the player so using camera position biases the
 * picker toward LOD0 in a way that doesn't match what the player is
 * actually looking at.
 */
export class BuildingLodController {
  // Squared thresholds avoid a sqrt per chunk per frame.
  private static readonly LOD0_MAX     = 500;
  private static readonly LOD1_MAX     = 1500;
  private static readonly HYSTERESIS_M = 50;

  private static readonly LOD0_MAX_SQ_ENTER = (BuildingLodController.LOD0_MAX) ** 2;
  private static readonly LOD0_MAX_SQ_EXIT  = (BuildingLodController.LOD0_MAX - BuildingLodController.HYSTERESIS_M) ** 2;
  private static readonly LOD1_MAX_SQ_ENTER = (BuildingLodController.LOD1_MAX) ** 2;
  private static readonly LOD1_MAX_SQ_EXIT  = (BuildingLodController.LOD1_MAX - BuildingLodController.HYSTERESIS_M) ** 2;

  private chunks: THREE.Object3D[] = [];
  private worldRoot: THREE.Object3D | null = null;

  /** Counts last touched chunks per tier — exposed for the F9 perf overlay. */
  public lastCounts: { lod0: number; lod1: number; hidden: number } = { lod0: 0, lod1: 0, hidden: 0 };

  setWorldRoot(root: THREE.Object3D | null): void {
    if (root === this.worldRoot) return;
    this.worldRoot = root;
    this.chunks    = [];
    if (!root) return;

    root.traverse(obj => {
      const ud = obj.userData as Partial<BuildingChunkUserData> | undefined;
      if (ud && ud.isBuildingChunk) this.chunks.push(obj);
    });
  }

  /**
   * Per-frame update. `focusX` / `focusZ` should be the player's world XZ
   * position in metres. Cheap: O(chunks) with no allocations.
   */
  update(focusX: number, focusZ: number): void {
    let nLod0 = 0, nLod1 = 0, nHidden = 0;

    for (const chunk of this.chunks) {
      const ud      = chunk.userData as BuildingChunkUserData;
      const dx      = ud.cx - focusX;
      const dz      = ud.cz - focusZ;
      const dSq     = dx * dx + dz * dz;
      const current = ud.currentLod;

      // Pick target LOD with hysteresis. Crossing a band threshold only
      // commits when we've moved HYSTERESIS_M past the boundary in the new
      // band's direction.
      let target = current;
      if (current === 0) {
        if (dSq > BuildingLodController.LOD0_MAX_SQ_ENTER) target = 1;
      } else if (current === 1) {
        if (dSq < BuildingLodController.LOD0_MAX_SQ_EXIT)  target = 0;
        else if (dSq > BuildingLodController.LOD1_MAX_SQ_ENTER) target = 2;
      } else if (current === 2) {
        if (dSq < BuildingLodController.LOD1_MAX_SQ_EXIT) target = 1;
      } else {
        target = dSq <= BuildingLodController.LOD0_MAX_SQ_ENTER ? 0
               : dSq <= BuildingLodController.LOD1_MAX_SQ_ENTER ? 1
               : 2;
      }

      // If the picked tier wasn't baked (e.g. LOD1 missing), fall back to
      // the next lower tier that exists. LOD2 has no baked geometry yet,
      // so target=2 always lands in the "all hidden" branch below.
      let effective = target;
      if (effective === 1 && !ud.lodGroups[1]) effective = 0;

      if (effective !== current) {
        for (let i = 0; i < ud.lodGroups.length; i++) {
          const g = ud.lodGroups[i];
          if (!g) continue;
          g.visible = (i === effective && effective < 2);
        }
        ud.currentLod = target;
      }

      if (effective === 0) nLod0++;
      else if (effective === 1) nLod1++;
      else nHidden++;
    }

    this.lastCounts.lod0   = nLod0;
    this.lastCounts.lod1   = nLod1;
    this.lastCounts.hidden = nHidden;
  }

  chunkCount(): number { return this.chunks.length; }
}
