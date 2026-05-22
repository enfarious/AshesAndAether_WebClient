// ---------------------------------------------------------------------------
// BuildingCollider — continuous client-side overworld building collision.
//
// Mirrors the zone-server CollisionSystem's building layer EXACTLY:
//   • Same polygons — fetched pre-projected to world metres from the gateway
//     (/world/collision/:zoneId/buildings), which uses the identical origin
//     and formula the server collision uses. No client-side conversion, so
//     no origin drift.
//   • Same test — point-in-inflated-polygon (PLAYER_RADIUS halo).
//   • Same response — endpoint axis-slide (X priority).
//
// Because client WASD prediction and server authority now run identical math
// on identical data, they agree: no rubber-banding, and corners + slanted
// walls are the true polygon edge instead of a 1 m staircase.
//
// Replaces the old chest-height mesh raycast (PlayerEntity._clipMovement),
// which collided a single ray against rendered building GLBs — a different
// geometry source and algorithm that snagged corners and felt oversized.
// ---------------------------------------------------------------------------

import { ClientConfig } from '@/config/ClientConfig';

interface Vec2 { x: number; z: number; }
type Polygon = Vec2[];

/** MUST match the server CollisionSystem PLAYER_RADIUS — the inflate halo. */
const PLAYER_RADIUS = 0.5;
/** MUST match the server BUCKET_SIZE / BUCKET_STRIDE / originX,Z so the
 *  spatial index keys line up conceptually (only self-consistency matters,
 *  but mirroring the server keeps the two implementations easy to compare). */
const BUCKET_SIZE   = 32;
const BUCKET_STRIDE = 1 << 20;
const BUCKET_ORIGIN = -3600;   // server originX/originZ = -HALF_EXTENT

export class BuildingCollider {
  private polygons: Polygon[] = [];
  private buckets  = new Map<number, number[]>();
  private _ready   = false;

  /** True once a zone's footprints are loaded. While false, resolveMovement
   *  is a pass-through and the caller should fall back to its own collision
   *  (vault zones, or before the fetch completes). */
  get ready(): boolean { return this._ready; }

  /**
   * Fetch the pre-projected world-space footprints for a zone and build the
   * spatial index. Safe for any zone — non-OSM zones return an empty set and
   * the collider stays inert. Replaces whatever was loaded before.
   */
  async load(zoneId: string): Promise<void> {
    this.clear();
    try {
      const resp = await fetch(
        `${ClientConfig.serverUrl}/world/collision/${encodeURIComponent(zoneId)}/buildings`,
      );
      if (!resp.ok) return;
      const data = await resp.json() as { buildings?: number[][][] };
      for (const poly of data.buildings ?? []) {
        if (poly.length < 3) continue;
        this.polygons.push(poly.map(([x, z]) => ({ x: x ?? 0, z: z ?? 0 })));
      }
      this._buildBuckets();
      this._ready = this.polygons.length > 0;
      console.log(`[BuildingCollider] ${this.polygons.length} footprints loaded for "${zoneId}"`);
    } catch (err) {
      console.warn('[BuildingCollider] load failed:', err);
    }
  }

  /** Drop all footprints — call when leaving an overworld zone. */
  clear(): void {
    this.polygons = [];
    this.buckets.clear();
    this._ready = false;
  }

  /**
   * Resolve a desired move against the building footprints. Endpoint
   * axis-slide (X priority) — mirrors server CollisionSystem.resolveMovement
   * layer 1. Returns the resolved destination; equals (toX,toZ) when clear.
   */
  resolveMovement(fromX: number, fromZ: number, toX: number, toZ: number): Vec2 {
    if (!this._ready) return { x: toX, z: toZ };
    if (!this._blocked(toX,   toZ))   return { x: toX,   z: toZ   };
    if (!this._blocked(toX,   fromZ)) return { x: toX,   z: fromZ };
    if (!this._blocked(fromX, toZ))   return { x: fromX, z: toZ   };
    return { x: fromX, z: fromZ };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _blocked(x: number, z: number): boolean {
    const bucket = this.buckets.get(_bucketKey(x, z));
    if (!bucket) return false;
    for (const idx of bucket) {
      if (_pointNearPoly(x, z, this.polygons[idx]!, PLAYER_RADIUS)) return true;
    }
    return false;
  }

  /** Bucket each footprint into the coarse spatial index — every bucket its
   *  PLAYER_RADIUS-expanded bounding box overlaps, so a single-bucket lookup
   *  at query time never misses a footprint the point is within range of. */
  private _buildBuckets(): void {
    for (let pi = 0; pi < this.polygons.length; pi++) {
      const b = _polyBounds(this.polygons[pi]!);
      const minBX = Math.floor((b.minX - PLAYER_RADIUS - BUCKET_ORIGIN) / BUCKET_SIZE);
      const maxBX = Math.floor((b.maxX + PLAYER_RADIUS - BUCKET_ORIGIN) / BUCKET_SIZE);
      const minBZ = Math.floor((b.minZ - PLAYER_RADIUS - BUCKET_ORIGIN) / BUCKET_SIZE);
      const maxBZ = Math.floor((b.maxZ + PLAYER_RADIUS - BUCKET_ORIGIN) / BUCKET_SIZE);
      for (let bx = minBX; bx <= maxBX; bx++) {
        for (let bz = minBZ; bz <= maxBZ; bz++) {
          const key = bx * BUCKET_STRIDE + bz;
          let list = this.buckets.get(key);
          if (!list) { list = []; this.buckets.set(key, list); }
          list.push(pi);
        }
      }
    }
  }
}

// ── Geometry helpers — ported verbatim from server CollisionSystem ──────────

function _bucketKey(x: number, z: number): number {
  const bx = Math.floor((x - BUCKET_ORIGIN) / BUCKET_SIZE);
  const bz = Math.floor((z - BUCKET_ORIGIN) / BUCKET_SIZE);
  return bx * BUCKET_STRIDE + bz;
}

function _polyBounds(poly: Vec2[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of poly) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** True if (px,pz) is inside the polygon or within `expand` of a wall. */
function _pointNearPoly(px: number, pz: number, poly: Vec2[], expand: number): boolean {
  if (_pointInPoly(px, pz, poly)) return true;
  const expandSq = expand * expand;
  for (let i = 0; i < poly.length - 1; i++) {
    if (_segDistSq(px, pz, poly[i]!.x, poly[i]!.z, poly[i + 1]!.x, poly[i + 1]!.z) < expandSq) return true;
  }
  return false;
}

function _pointInPoly(px: number, pz: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x, zi = poly[i]!.z, xj = poly[j]!.x, zj = poly[j]!.z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function _segDistSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return (px - (ax + t * dx)) ** 2 + (pz - (az + t * dz)) ** 2;
}
