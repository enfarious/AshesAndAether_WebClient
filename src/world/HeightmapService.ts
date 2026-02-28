import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * HeightmapService — loads the server's DEM (.json + .bin) and exposes:
 *   - getElevation(worldX, worldZ) → metres
 *   - raycast(ray) → THREE.Vector3 | null
 *
 * Coordinate conventions (matches PhysicsSystem.ts on the server):
 *   World origin  = zone centre (manifest origin lat/lon)
 *   X = East (+) / West (-)   → longitude increases with X
 *   Z = South (+) / North (-)  → latitude DECREASES as Z increases
 */

interface DemMetadata {
  originLat:    number;
  originLon:    number;
  pixelSizeDeg: number;
  width:        number;
  height:       number;
  nodata:       number | null;
  center?: { lat: number; lon: number };
}

export class HeightmapService {
  private meta!:       DemMetadata;
  private data!:       Float32Array;
  private centerLat!:  number;
  private centerLon!:  number;
  private mPerDegLat!: number;
  private mPerDegLon!: number;

  // ── Factory ────────────────────────────────────────────────────────────────

  /**
   * Load from explicit server-relative paths (taken directly from manifest).
   * metaPath e.g. "/world/terrain/usa_ny_stephentown_dem.json"
   * binPath  e.g. "/world/terrain/usa_ny_stephentown_dem.bin"
   */
  static async loadFromPaths(
    metaPath: string,
    binPath:  string,
    originLat: number,
    originLon: number,
  ): Promise<HeightmapService | null> {
    const base = ClientConfig.serverUrl;
    try {
      const [metaRes, binRes] = await Promise.all([
        fetch(`${base}${metaPath}`),
        fetch(`${base}${binPath}`),
      ]);
      if (!metaRes.ok || !binRes.ok) {
        console.warn(`[HeightmapService] DEM fetch failed (${metaRes.status}/${binRes.status})`);
        return null;
      }

      const meta   = await metaRes.json() as DemMetadata;
      const buffer = await binRes.arrayBuffer();

      const svc         = new HeightmapService();
      svc.meta          = meta;
      svc.data          = new Float32Array(buffer);
      // Prefer the manifest's origin (zone centre) over the DEM's own centre field,
      // which may differ slightly.
      svc.centerLat     = originLat;
      svc.centerLon     = originLon;
      svc.mPerDegLat    = 111320;
      svc.mPerDegLon    = 111320 * Math.cos((originLat * Math.PI) / 180);

      console.log(
        `[HeightmapService] ${meta.width}×${meta.height} DEM loaded`,
        `centre=(${originLat.toFixed(5)}, ${originLon.toFixed(5)})`,
        `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`,
      );
      return svc;
    } catch (err) {
      console.error('[HeightmapService] Load error:', err);
      return null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Sample terrain elevation (metres) at world-space (X, Z).
   * Returns null outside the DEM bounds.
   */
  getElevation(worldX: number, worldZ: number): number | null {
    const lat = this.centerLat - worldZ / this.mPerDegLat;
    const lon = this.centerLon + worldX / this.mPerDegLon;
    return this._sampleBilinear(lat, lon);
  }

  /**
   * Intersect a THREE.Ray with the heightmap surface.
   *
   * Algorithm: coarse ray-march (10 m steps) to bracket where the ray
   * crosses from above-terrain to below-terrain, then binary-search the
   * bracket to sub-centimetre precision.
   *
   * Returns the world-space hit point, or null if the ray never hits.
   */
  raycast(ray: THREE.Ray, maxDistance = 8000): THREE.Vector3 | null {
    const COARSE_STEP = 10;   // metres — safe given ~18 m avg triangle size
    const FINE_ITERS  = 14;   // bisection passes → ~0.6 mm precision

    const pt = new THREE.Vector3();

    // Find the starting t — if the ray origin is outside the DEM we scan forward
    let tA  = 0;
    let elA = this._elevAtT(ray, 0);
    if (elA === null) {
      tA = this._findDemEntry(ray, maxDistance);
      if (tA < 0) return null;
      elA = this._elevAtT(ray, tA);
      if (elA === null) return null;
    }

    let hA = ray.at(tA, pt).y - elA; // +ve = above terrain

    for (let t = tA + COARSE_STEP; t <= maxDistance; t += COARSE_STEP) {
      const elB = this._elevAtT(ray, t);
      if (elB === null) break;                       // left the DEM bounds

      const hB = ray.at(t, pt).y - elB;

      if (hA >= 0 && hB < 0) {
        // Bracketed a surface crossing — bisect
        let lo = tA, hi = t;
        for (let i = 0; i < FINE_ITERS; i++) {
          const mid  = (lo + hi) * 0.5;
          const elM  = this._elevAtT(ray, mid);
          if (elM === null) break;
          const hM   = ray.at(mid, pt).y - elM;
          if (hM >= 0) lo = mid; else hi = mid;
        }
        return ray.at((lo + hi) * 0.5, new THREE.Vector3());
      }

      tA = t;
      hA = hB;
    }
    return null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _elevAtT(ray: THREE.Ray, t: number): number | null {
    const pt = ray.at(t, new THREE.Vector3());
    return this.getElevation(pt.x, pt.z);
  }

  private _findDemEntry(ray: THREE.Ray, maxDist: number): number {
    const pt = new THREE.Vector3();
    for (let t = 0; t <= maxDist; t += 50) {
      ray.at(t, pt);
      if (this.getElevation(pt.x, pt.z) !== null) return t;
    }
    return -1;
  }

  private _sampleBilinear(lat: number, lon: number): number | null {
    const { originLat, originLon, pixelSizeDeg, width, height } = this.meta;
    const col = (lon - originLon) / pixelSizeDeg;
    const row = (originLat - lat) / pixelSizeDeg;

    if (col < 0 || row < 0 || col >= width - 1 || row >= height - 1) return null;

    const c0 = Math.floor(col), r0 = Math.floor(row);
    const q11 = this._px(r0,   c0);
    const q21 = this._px(r0,   c0+1);
    const q12 = this._px(r0+1, c0);
    const q22 = this._px(r0+1, c0+1);
    if (q11 === null || q21 === null || q12 === null || q22 === null) return null;

    const fx = col - c0, fy = row - r0;
    return (q11*(1-fx) + q21*fx) * (1-fy)
         + (q12*(1-fx) + q22*fx) * fy;
  }

  private _px(row: number, col: number): number | null {
    const v = this.data[row * this.meta.width + col];
    if (v === undefined || !Number.isFinite(v)) return null;
    if (this.meta.nodata !== null && v === this.meta.nodata) return null;
    return v;
  }
}
