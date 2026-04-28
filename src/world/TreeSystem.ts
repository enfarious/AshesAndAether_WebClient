import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';
import type { HeightmapService } from './HeightmapService';

// ── Season helpers ────────────────────────────────────────────────────────────

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

function normaliseSeason(raw: string): Season {
  const s = raw.toLowerCase();
  if (s === 'spring' || s === 'summer' || s === 'fall' || s === 'winter') return s;
  return 'summer';
}

// ── Tree variant types ────────────────────────────────────────────────────────

type TreeVariant = 'pine' | 'deciduous';

// ── Tree archetypes ───────────────────────────────────────────────────────────

interface PineDef {
  variant:       'pine';
  height:        number;
  trunkRadius:   number;
  layers:        number;   // 1–3 foliage cone layers
  foliageRadius: number;
  overlap:       number;
}

interface DeciduousDef {
  variant:        'deciduous';
  height:         number;
  trunkRadius:    number;
  branches:       number;   // 0–4 cone branches; 0 = single crown sphere, no branches
  foliageRadius:  number;   // sphere radius per foliage ball
  /** Horizontal reach from trunk to sphere centre. Spheres overlap when
   *  reach < 2 * foliageRadius. Keep at ~1.2–1.6× foliageRadius for
   *  a dense, touching canopy. */
  reach:          number;
  /** Per-branch height offsets (length === branches). Baked into the def so
   *  all instances of the same archetype share the same skeleton shape. */
  branchHeights:  number[];
}

type TreeDef = PineDef | DeciduousDef;

const PINE_DEFS: PineDef[] = [
  { variant: 'pine', height: 4.5,  trunkRadius: 0.18, layers: 1, foliageRadius: 1.2, overlap: 0.0 },
  { variant: 'pine', height: 8.0,  trunkRadius: 0.28, layers: 2, foliageRadius: 2.0, overlap: 0.3 },
  { variant: 'pine', height: 13.0, trunkRadius: 0.40, layers: 3, foliageRadius: 2.8, overlap: 0.35 },
];

const DECIDUOUS_DEFS: DeciduousDef[] = [
  // Single-sphere crown, no branches — compact young tree
  {
    variant: 'deciduous', height: 5.0, trunkRadius: 0.20,
    branches: 0, foliageRadius: 1.5, reach: 0,
    branchHeights: [],
  },
  // 2 branches — wide but asymmetric: one branch slightly higher
  {
    variant: 'deciduous', height: 7.5, trunkRadius: 0.28,
    branches: 2, foliageRadius: 1.6, reach: 1.9,
    branchHeights: [0.0, 0.5],
  },
  // 3 branches — uneven crown heights give a natural silhouette
  {
    variant: 'deciduous', height: 11.0, trunkRadius: 0.38,
    branches: 3, foliageRadius: 2.0, reach: 2.2,
    branchHeights: [0.0, 0.7, 0.35],
  },
  // 4 branches — full canopy, tallest branch varies most
  {
    variant: 'deciduous', height: 9.0, trunkRadius: 0.32,
    branches: 4, foliageRadius: 1.8, reach: 2.0,
    branchHeights: [0.0, 0.6, 0.3, 0.9],
  },
];

// ── Exclusion zone helpers ────────────────────────────────────────────────────

interface ExclusionRect {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
}

const M_PER_DEG_LAT = 111_320;
const BUILDING_MARGIN = 5;
const ROAD_HALF_WIDTH: Record<string, number> = {
  motorway: 18, trunk: 14, primary: 12, secondary: 10,
  tertiary: 8, residential: 7, service: 5, footway: 3, path: 3,
};
const DEFAULT_ROAD_HALF_WIDTH = 6;

interface OsmNode    { lat: number; lon: number; }
interface OsmFeature { id: number; nodes?: OsmNode[]; tags?: Record<string, string>; }

/**
 * Convert an array of OSM features to world-space XZ exclusion rects.
 * Buildings: polygon AABB + margin. Roads: per-segment ribbon + half-width.
 * Uses the same coordinate convention as the server anchor endpoint:
 *   X = (lon - originLon) * mPerDegLon
 *   Z = -(lat - originLat) * M_PER_DEG_LAT
 */
function osmToRects(
  features:  OsmFeature[],
  originLat: number,
  originLon: number,
  mode:      'buildings' | 'roads',
): ExclusionRect[] {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(originLat * Math.PI / 180);
  const rects: ExclusionRect[] = [];
  for (const f of features) {
    const nodes = f.nodes;
    if (!nodes || nodes.length < 2) continue;
    const pts = nodes.map(n => ({
      x:  (n.lon - originLon) * mPerDegLon,
      z: -(n.lat - originLat) * M_PER_DEG_LAT,
    }));
    if (mode === 'roads') {
      const hw = ROAD_HALF_WIDTH[f.tags?.['highway'] ?? ''] ?? DEFAULT_ROAD_HALF_WIDTH;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!, b = pts[i + 1]!;
        rects.push({
          minX: Math.min(a.x, b.x) - hw, maxX: Math.max(a.x, b.x) + hw,
          minZ: Math.min(a.z, b.z) - hw, maxZ: Math.max(a.z, b.z) + hw,
        });
      }
    } else {
      const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
      rects.push({
        minX: Math.min(...xs) - BUILDING_MARGIN, maxX: Math.max(...xs) + BUILDING_MARGIN,
        minZ: Math.min(...zs) - BUILDING_MARGIN, maxZ: Math.max(...zs) + BUILDING_MARGIN,
      });
    }
  }
  return rects;
}

// ── Geometry helpers ──────────────────────────────────────────────────────

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIdx   = 0;
  for (const g of geos) {
    totalVerts += (g.attributes['position'] as THREE.BufferAttribute).count;
    totalIdx   += g.index ? g.index.count : (g.attributes['position'] as THREE.BufferAttribute).count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);
  const indices   = new Uint32Array(totalIdx);

  let vOff = 0, iOff = 0, baseVert = 0;

  for (const g of geos) {
    const pos = g.attributes['position'] as THREE.BufferAttribute;
    const nor = g.attributes['normal']   as THREE.BufferAttribute | undefined;
    const uv  = g.attributes['uv']       as THREE.BufferAttribute | undefined;
    const idx = g.index;
    for (let i = 0; i < pos.count; i++) {
      positions[(vOff + i) * 3]     = pos.getX(i);
      positions[(vOff + i) * 3 + 1] = pos.getY(i);
      positions[(vOff + i) * 3 + 2] = pos.getZ(i);
      if (nor) {
        normals[(vOff + i) * 3]     = nor.getX(i);
        normals[(vOff + i) * 3 + 1] = nor.getY(i);
        normals[(vOff + i) * 3 + 2] = nor.getZ(i);
      }
      if (uv) {
        uvs[(vOff + i) * 2]     = uv.getX(i);
        uvs[(vOff + i) * 2 + 1] = uv.getY(i);
      }
    }
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff + i] = idx.getX(i) + baseVert;
      iOff += idx.count;
    } else {
      for (let i = 0; i < pos.count; i++) indices[iOff + i] = baseVert + i;
      iOff += pos.count;
    }
    baseVert += pos.count;
    vOff     += pos.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  out.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeVertexNormals();
  return out;
}

// ── Pine geometry ─────────────────────────────────────────────────────────────

function buildPineGeometry(def: PineDef): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const trunkH = def.height * 0.55;
  const trunkGeo = new THREE.ConeGeometry(def.trunkRadius, trunkH, 6, 1);
  trunkGeo.translate(0, trunkH / 2, 0);
  parts.push(trunkGeo);

  const layerH    = def.height * 0.55;
  const layerStep = layerH * (1 - def.overlap);
  for (let i = 0; i < def.layers; i++) {
    const radiusFraction = 1 - (i / def.layers) * 0.4;
    const coneGeo = new THREE.ConeGeometry(def.foliageRadius * radiusFraction, layerH, 7, 1);
    coneGeo.rotateY((i * Math.PI) / def.layers + (i % 2 === 0 ? 0 : Math.PI / (def.layers * 2)));
    const baseY = trunkH * (1 - def.overlap) + i * layerStep;
    coneGeo.translate(0, baseY + layerH / 2, 0);
    parts.push(coneGeo);
  }

  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

// ── Deciduous geometry ────────────────────────────────────────────────────────

/**
 * Deciduous tree geometry:
 *   - Cone trunk
 *   - If branches === 0: single sphere at crown, no branch geometry
 *   - If branches > 0:
 *       • A short vertical connector stub rises from the main crown point to
 *         each branch's individual Y offset, making the skeleton legible
 *       • A cone branch extends outward from that stub tip at a ~30° upward
 *         pitch, reaching toward the sphere centre
 *       • Sphere centres are placed at `reach` distance from trunk axis,
 *         with per-branch height offsets — keeps spheres overlapping and
 *         gives the crown an organic, asymmetric silhouette
 *
 * Foliage spheres are a separate InstancedMesh (season-tinted independently).
 * Returns { trunkGeo, foliageOffsets } where foliageOffsets are local-space
 * sphere centres used to compute world positions at scatter time.
 */
function buildDeciduousGeometry(def: DeciduousDef): {
  trunkGeo:       THREE.BufferGeometry;
  foliageOffsets: THREE.Vector3[];
  foliageRadii:   number[];
} {
  const parts: THREE.BufferGeometry[] = [];
  const foliageOffsets: THREE.Vector3[] = [];
  const foliageRadii:   number[]        = [];

  const trunkH  = def.height * 0.65;
  const crownY  = trunkH * 0.80;   // base Y where all branches originate

  // Main trunk cone
  const trunk = new THREE.ConeGeometry(def.trunkRadius, trunkH, 6, 1);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(trunk);

  if (def.branches === 0) {
    // Single crown sphere — sits just above trunk tip, no branches
    foliageOffsets.push(new THREE.Vector3(0, trunkH + def.foliageRadius * 0.4, 0));
    foliageRadii.push(def.foliageRadius);
  } else {
    const branchR = def.trunkRadius * 0.40;
    const stubR   = def.trunkRadius * 0.30;
    // Reusable objects for branch orientation
    const up   = new THREE.Vector3(0, 1, 0);
    const mat4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();

    // Compute the max height any branch sphere will reach
    const PITCH = Math.PI / 5.5;  // ~32° upward from horizontal, used throughout
    let maxBranchSphereY = crownY;
    for (let i = 0; i < def.branches; i++) {
      const heightOff = def.branchHeights[i] ?? 0;
      maxBranchSphereY = Math.max(maxBranchSphereY, crownY + heightOff + Math.sin(PITCH) * def.reach);
    }
    // Center crown sphere sits above all branch spheres
    const centerSphereY = maxBranchSphereY + def.foliageRadius * 0.5;
    foliageOffsets.push(new THREE.Vector3(0, centerSphereY, 0));
    foliageRadii.push(def.foliageRadius * 0.85); // slightly smaller for a natural apex

    for (let i = 0; i < def.branches; i++) {
      const yaw       = (i / def.branches) * Math.PI * 2;
      const pitch     = PITCH;
      const heightOff = def.branchHeights[i] ?? 0;
      const attachY   = crownY + heightOff;

      // Branch direction unit vector
      const dirX = Math.cos(yaw) * Math.cos(pitch);
      const dirY = Math.sin(pitch);
      const dirZ = Math.sin(yaw) * Math.cos(pitch);
      const dir  = new THREE.Vector3(dirX, dirY, dirZ); // already unit length

      // Sphere centre at `reach` along direction from attachment point
      const sphereX = dirX * def.reach;
      const sphereY = attachY + dirY * def.reach;
      const sphereZ = dirZ * def.reach;

      // ── Vertical connector stub ─────────────────────────────────────────
      if (heightOff > 0.05) {
        const stubH   = heightOff + 0.1;
        const stubGeo = new THREE.ConeGeometry(stubR, stubH, 4, 1);
        stubGeo.translate(0, crownY + stubH / 2, 0);
        parts.push(stubGeo);
      }

      // ── Branch cone ──────────────────────────────────────────────
      // ConeGeometry points along +Y by default. Rotate so +Y aligns with dir.
      const branchGeo = new THREE.ConeGeometry(branchR, def.reach, 5, 1);
      // Quaternion from +Y to dir
      quat.setFromUnitVectors(up, dir);
      mat4.makeRotationFromQuaternion(quat);
      branchGeo.applyMatrix4(mat4);
      // Translate so the base of the cone sits at attachY on the trunk axis
      // and the tip reaches toward the sphere centre.
      branchGeo.translate(
        dirX * def.reach * 0.5,
        attachY + dirY * def.reach * 0.5,
        dirZ * def.reach * 0.5,
      );
      parts.push(branchGeo);

      foliageOffsets.push(new THREE.Vector3(sphereX, sphereY, sphereZ));
      foliageRadii.push(def.foliageRadius);
    }
  }

  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return { trunkGeo: merged, foliageOffsets, foliageRadii };
}

// ── Foliage sphere geometry (shared) ─────────────────────────────────────────

const _foliageSphereGeo = new THREE.SphereGeometry(1, 7, 6); // radius=1, scaled per instance

// ── Materials ─────────────────────────────────────────────────────────────────

function buildPineMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.0, color: 0x2d5a28 });
}

function buildDeciduousTrunkMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0, color: 0x5c3d1e });
}

function buildDeciduousFoliageMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0, color: 0x4a7a28 });
}

// ── Seasonal foliage colour ───────────────────────────────────────────────────

/**
 * Returns an HSL colour for a deciduous foliage sphere, driven by season.
 *
 * spring:  fresh light green
 * summer:  deep green, slight variance
 * fall:    random warm — orange, red, brown, gold
 * winter:  white/pale blue-white (snow-covered) or hidden (sphere radius → 0)
 */
function deciduousFoliageColor(season: Season, rng: () => number): THREE.Color {
  const c = new THREE.Color();
  switch (season) {
    case 'spring':
      c.setHSL(0.28 + rng() * 0.06, 0.65, 0.38 + rng() * 0.08);
      break;
    case 'summer':
      c.setHSL(0.25 + rng() * 0.08, 0.55, 0.26 + rng() * 0.08);
      break;
    case 'fall': {
      // Oranges (0.06–0.10), reds (0.0–0.04), gold/brown (0.10–0.12)
      const r = rng();
      if (r < 0.35)       c.setHSL(0.06 + rng() * 0.04, 0.80, 0.38 + rng() * 0.12); // orange
      else if (r < 0.60)  c.setHSL(0.00 + rng() * 0.04, 0.75, 0.35 + rng() * 0.10); // red
      else if (r < 0.80)  c.setHSL(0.10 + rng() * 0.04, 0.70, 0.38 + rng() * 0.10); // gold
      else                c.setHSL(0.07 + rng() * 0.03, 0.50, 0.28 + rng() * 0.08); // brown
      break;
    }
    case 'winter':
      // Pale blue-white — snow on bare branches
      c.setHSL(0.58 + rng() * 0.04, 0.12, 0.82 + rng() * 0.10);
      break;
  }
  return c;
}

/** Scale for deciduous foliage in winter — very small (bare trees), not zero (avoids NaN matrix). */
const WINTER_FOLIAGE_SCALE = 0.05;

// ── Seeded RNG ────────────────────────────────────────────────────────────────

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) ^ s.charCodeAt(i); h = h >>> 0; }
  return h;
}

// ── Exclusion zone helpers ────────────────────────────────────────────────────

interface ExclusionRect {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
}

function isExcluded(x: number, z: number, zones: ExclusionRect[]): boolean {
  for (const r of zones) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
  }
  return false;
}

// ── TreeInstance ──────────────────────────────────────────────────────────────

interface TreeInstance {
  position:  THREE.Vector3;
  scale:     number;
  rotY:      number;
  def:       TreeDef;
}

// ── TreeSystem ────────────────────────────────────────────────────────────────

/**
 * TreeSystem — scatters two procedural tree varieties over a zone's heightmap:
 *
 *   Pine (conifer): cone trunk + stacked cone foliage layers — evergreen year-round.
 *   Deciduous:      cone trunk + optional cone branches + foliage spheres whose
 *                   colour and scale change by season:
 *                     spring  → fresh light green
 *                     summer  → deep green
 *                     fall    → random warm oranges / reds / golds / browns
 *                     winter  → pale white/blue (snow), nearly invisible radius
 *
 * Building and road footprints are fetched from the same OSM endpoint used by
 * WaterRenderer and used as exclusion zones — no trees will intersect structures.
 *
 * All trees of a given archetype share a single InstancedMesh (one draw call).
 * Deciduous foliage spheres are a second InstancedMesh so their colour is
 * independent from the trunk/branch mesh.
 */
export class TreeSystem {
  private _meshes:          THREE.InstancedMesh[]          = [];
  private _pineMat:         THREE.MeshStandardMaterial;
  private _decidTrunkMat:   THREE.MeshStandardMaterial;
  private _decidFoliageMat: THREE.MeshStandardMaterial;

  // Config
  private _treeCount  = 600;
  private _zoneRadius = 500;
  private _waterLine  = 1.0;
  private _slopeMax   = 0.65;

  constructor(private readonly _scene: THREE.Scene) {
    this._pineMat         = buildPineMaterial();
    this._decidTrunkMat   = buildDeciduousTrunkMaterial();
    this._decidFoliageMat = buildDeciduousFoliageMaterial();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch OSM exclusion data, scatter trees, build instanced meshes.
   *
   * @param heightmap  HeightmapService for elevation + slope queries.
   * @param zoneId     Zone identifier — used for RNG seed and OSM fetch.
   * @param seasonRaw  Season string from climate sim.
   * @param _dayOfYear Day 1–365 (reserved for future sub-seasonal variance).
   * @param origin     Zone lat/lon origin for OSM coordinate conversion.
   * @param count      Override default tree count.
   */
  async loadForZone(
    heightmap:  HeightmapService,
    zoneId:     string,
    seasonRaw = 'summer',
    _dayOfYear = 180,
    origin?:    { lat: number; lon: number },
    count?:     number,
    radius?:    number,
  ): Promise<void> {
    this.clear();
    if (count  !== undefined) this._treeCount  = count;
    if (radius !== undefined) this._zoneRadius = radius;

    const season = normaliseSeason(seasonRaw);
    const seed   = _hashString(zoneId);
    const rng    = makePrng(seed);

    const exclusions = origin
      ? await this._fetchExclusions(zoneId, origin)
      : [];
    console.log(`[TreeSystem] ${exclusions.length} exclusion rects for "${zoneId}"`);

    const candidates = this._scatter(heightmap, rng, exclusions);
    this._buildInstances(candidates, season, rng);

    console.log(
      `[TreeSystem] ${candidates.length} trees placed in "${zoneId}"`,
      `season=${season} drawCalls=${this._meshes.length}`,
    );
  }

  clear(): void {
    for (const m of this._meshes) {
      this._scene.remove(m);
      m.geometry.dispose();
    }
    this._meshes = [];
  }

  dispose(): void {
    this.clear();
    this._pineMat.dispose();
    this._decidTrunkMat.dispose();
    this._decidFoliageMat.dispose();
  }

  // ── OSM exclusion fetch ────────────────────────────────────────────────────

  private async _fetchExclusions(
    zoneId: string,
    origin: { lat: number; lon: number },
  ): Promise<ExclusionRect[]> {
    if (zoneId.startsWith('village:') || zoneId.startsWith('vault:')) return [];
    const base  = ClientConfig.serverUrl;
    const rects: ExclusionRect[] = [];
    try {
      const r = await fetch(`${base}/world/buildings/${zoneId}`);
      if (r.ok) rects.push(...osmToRects(await r.json() as OsmFeature[], origin.lat, origin.lon, 'buildings'));
    } catch { /* no building data */ }
    try {
      const r = await fetch(`${base}/world/roads/${zoneId}`);
      if (r.ok) rects.push(...osmToRects(await r.json() as OsmFeature[], origin.lat, origin.lon, 'roads'));
    } catch { /* no road data */ }
    return rects;
  }

  // ── Scatter ────────────────────────────────────────────────────────────────

  private _scatter(
    heightmap:  HeightmapService,
    rng:        () => number,
    exclusions: ExclusionRect[],
  ): TreeInstance[] {
    const results: TreeInstance[] = [];
    const R            = this._zoneRadius;
    const cellsPerAxis = Math.ceil(Math.sqrt(this._treeCount * 1.4));
    const cellSize     = (R * 2) / cellsPerAxis;

    outer:
    for (let xi = 0; xi < cellsPerAxis; xi++) {
      for (let zi = 0; zi < cellsPerAxis; zi++) {
        if (results.length >= this._treeCount) break outer;

        const cx = -R + (xi + 0.5) * cellSize + (rng() - 0.5) * cellSize;
        const cz = -R + (zi + 0.5) * cellSize + (rng() - 0.5) * cellSize;

        // Terrain checks
        const elev = heightmap.getElevation(cx, cz);
        if (elev === null || elev <= this._waterLine) continue;

        const STEP = 2;
        const eX0 = heightmap.getElevation(cx - STEP, cz);
        const eX1 = heightmap.getElevation(cx + STEP, cz);
        const eZ0 = heightmap.getElevation(cx, cz - STEP);
        const eZ1 = heightmap.getElevation(cx, cz + STEP);
        if (!eX0 || !eX1 || !eZ0 || !eZ1) continue;
        const slope = Math.sqrt(((eX1 - eX0) / (STEP * 2)) ** 2 + ((eZ1 - eZ0) / (STEP * 2)) ** 2);
        if (slope > this._slopeMax) continue;

        // Exclusion zone check
        if (exclusions.length > 0 && isExcluded(cx, cz, exclusions)) continue;

        // Pick variant: 60% pine, 40% deciduous
        const variant: TreeVariant = rng() < 0.60 ? 'pine' : 'deciduous';
        let def: TreeDef;
        if (variant === 'pine') {
          const r = rng();
          def = r < 0.30 ? PINE_DEFS[0]! : r < 0.75 ? PINE_DEFS[1]! : PINE_DEFS[2]!;
        } else {
          const r = rng();
          def = r < 0.25 ? DECIDUOUS_DEFS[0]! : r < 0.55 ? DECIDUOUS_DEFS[1]! : r < 0.80 ? DECIDUOUS_DEFS[2]! : DECIDUOUS_DEFS[3]!;
        }

        results.push({
          position: new THREE.Vector3(cx, elev, cz),
          scale:    0.75 + rng() * 0.5,
          rotY:     rng() * Math.PI * 2,
          def,
        });
      }
    }

    return results;
  }

  // ── Instanced mesh construction ────────────────────────────────────────────

  private _buildInstances(
    candidates: TreeInstance[],
    season:     Season,
    rng:        () => number,
  ): void {
    // ── Pine trees ─────────────────────────────────────────────────────────
    type PineGroup = Map<PineDef, TreeInstance[]>;
    const pineGroups: PineGroup = new Map();
    for (const inst of candidates) {
      if (inst.def.variant !== 'pine') continue;
      const def = inst.def as PineDef;
      let g = pineGroups.get(def);
      if (!g) { g = []; pineGroups.set(def, g); }
      g.push(inst);
    }

    const dummy   = new THREE.Object3D();
    const colorBuf = new THREE.Color();

    for (const [def, insts] of pineGroups) {
      const geo  = buildPineGeometry(def);
      const mesh = new THREE.InstancedMesh(geo, this._pineMat, insts.length);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      mesh.name = `trees-pine-h${def.height}`;

      for (let i = 0; i < insts.length; i++) {
        const inst = insts[i]!;
        dummy.position.copy(inst.position);
        dummy.rotation.set(0, inst.rotY, 0);
        dummy.scale.setScalar(inst.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Pine stays green year-round, subtle hue variance
        const hue = 0.27 + rng() * 0.06;
        colorBuf.setHSL(hue, 0.55, 0.22 + rng() * 0.06);
        mesh.setColorAt(i, colorBuf);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this._scene.add(mesh);
      this._meshes.push(mesh);
    }

    // ── Deciduous trees ────────────────────────────────────────────────────
    // Collect all deciduous instances and their foliage sphere world positions
    type FoliageSphere = { worldPos: THREE.Vector3; radius: number };
    const allFoliageSpheres: FoliageSphere[] = [];

    type DeciduousGroup = Map<DeciduousDef, TreeInstance[]>;
    const decidGroups: DeciduousGroup = new Map();
    for (const inst of candidates) {
      if (inst.def.variant !== 'deciduous') continue;
      const def = inst.def as DeciduousDef;
      let g = decidGroups.get(def);
      if (!g) { g = []; decidGroups.set(def, g); }
      g.push(inst);
    }

    for (const [def, insts] of decidGroups) {
      const { trunkGeo, foliageOffsets, foliageRadii } = buildDeciduousGeometry(def);
      const mesh = new THREE.InstancedMesh(trunkGeo, this._decidTrunkMat, insts.length);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      mesh.name = `trees-decid-trunk-h${def.height}`;

      for (let i = 0; i < insts.length; i++) {
        const inst = insts[i]!;
        dummy.position.copy(inst.position);
        dummy.rotation.set(0, inst.rotY, 0);
        dummy.scale.setScalar(inst.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Trunk colour: earthy brown variance
        colorBuf.setHSL(0.07 + rng() * 0.03, 0.45, 0.22 + rng() * 0.06);
        mesh.setColorAt(i, colorBuf);

        // Compute world-space positions of foliage spheres for this instance
        const cosR = Math.cos(inst.rotY), sinR = Math.sin(inst.rotY);
        for (let s = 0; s < foliageOffsets.length; s++) {
          const localOff = foliageOffsets[s]!;
          const rx = localOff.x * cosR - localOff.z * sinR;
          const rz = localOff.x * sinR + localOff.z * cosR;
          allFoliageSpheres.push({
            worldPos: new THREE.Vector3(
              inst.position.x + rx * inst.scale,
              inst.position.y + localOff.y * inst.scale,
              inst.position.z + rz * inst.scale,
            ),
            radius: (foliageRadii[s] ?? def.foliageRadius) * inst.scale,
          });
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this._scene.add(mesh);
      this._meshes.push(mesh);
    }

    // ── Foliage sphere InstancedMesh ────────────────────────────────────────
    if (allFoliageSpheres.length > 0) {
      const foliageMesh = new THREE.InstancedMesh(
        _foliageSphereGeo,
        this._decidFoliageMat,
        allFoliageSpheres.length,
      );
      foliageMesh.castShadow    = true;
      foliageMesh.receiveShadow = false;
      foliageMesh.name = 'trees-decid-foliage';

      for (let i = 0; i < allFoliageSpheres.length; i++) {
        const { worldPos, radius } = allFoliageSpheres[i]!;
        dummy.position.copy(worldPos);
        dummy.rotation.set(0, 0, 0);
        const sphereR = radius * (season === 'winter' ? WINTER_FOLIAGE_SCALE : 1.0);
        dummy.scale.setScalar(sphereR);
        dummy.updateMatrix();
        foliageMesh.setMatrixAt(i, dummy.matrix);
        foliageMesh.setColorAt(i, deciduousFoliageColor(season, rng));
      }

      foliageMesh.instanceMatrix.needsUpdate = true;
      if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
      this._scene.add(foliageMesh);
      this._meshes.push(foliageMesh);
    }
  }
}
