import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ClientConfig } from '@/config/ClientConfig';
import { HeightmapService } from './HeightmapService';
import { chunkedFor }       from './yieldUtil';

export interface ManifestAsset {
  id:        string;
  path:      string;
  type?:     string;
  optional?: boolean;
  metaPath?: string;  // for terrain_heightmap assets
  scale?:    number;  // per-asset scale multiplier (applied on top of zone unitScale)
}

export interface WorldManifest {
  worldId?: string;
  assets?:  ManifestAsset[];
  origin?: {
    units?: string;
    lat?:   number;
    lon?:   number;
  };
}

export interface ZoneAssets {
  worldRoot:  THREE.Group;
  heightmap:  HeightmapService | null;
  origin?:    { lat: number; lon: number } | undefined;
}

// ── Road geometry thickening ──────────────────────────────────────────────────

const ROAD_THICKNESS_M = 0.2;

/**
 * Extrudes each mesh in `scene` downward by `thickness` (in GLB local units),
 * turning each flat road surface into a 3D slab with top face, bottom face, and
 * side walls.  Called once at load time for road GLBs so hills don't clip the road
 * surface into invisibility.
 */
function thickenRoadScene(scene: THREE.Group, unitScale: number): void {
  const t = ROAD_THICKNESS_M / (unitScale > 0 ? unitScale : 1);
  scene.traverse(node => {
    if (node instanceof THREE.Mesh) _thickenMesh(node, t);
  });
}

function _thickenMesh(mesh: THREE.Mesh, thickness: number): void {
  const geo     = mesh.geometry;
  const posAttr = geo.attributes['position'] as THREE.BufferAttribute | undefined;
  if (!posAttr) return;
  const nVerts = posAttr.count;

  // Resolve index buffer (handle non-indexed geometry)
  let idxSrc: ArrayLike<number>;
  if (geo.index) {
    idxSrc = geo.index.array;
  } else {
    const tmp = new Uint32Array(nVerts);
    for (let i = 0; i < nVerts; i++) tmp[i] = i;
    idxSrc = tmp;
  }
  const nTris = Math.floor(idxSrc.length / 3);

  // Find boundary edges (those belonging to exactly one triangle — the perimeter).
  const edgeCount = new Map<string, number>();
  const edgeVerts = new Map<string, [number, number]>();
  for (let t2 = 0; t2 < nTris; t2++) {
    const a = idxSrc[t2 * 3]!;
    const b = idxSrc[t2 * 3 + 1]!;
    const c = idxSrc[t2 * 3 + 2]!;
    for (const [i, j] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!edgeVerts.has(key)) edgeVerts.set(key, [i, j]);
    }
  }
  const boundary: [number, number][] = [];
  for (const [key, cnt] of edgeCount) {
    if (cnt === 1) boundary.push(edgeVerts.get(key)!);
  }

  // Build new position buffer: top vertices (unchanged) + bottom vertices (Y -= thickness).
  const newPos = new Float32Array(nVerts * 2 * 3);
  for (let i = 0; i < nVerts; i++) {
    newPos[i * 3]              = posAttr.getX(i);
    newPos[i * 3 + 1]          = posAttr.getY(i);
    newPos[i * 3 + 2]          = posAttr.getZ(i);
    newPos[(nVerts + i) * 3]     = posAttr.getX(i);
    newPos[(nVerts + i) * 3 + 1] = posAttr.getY(i) - thickness;
    newPos[(nVerts + i) * 3 + 2] = posAttr.getZ(i);
  }

  // Build index buffer: top (original winding) + bottom (flipped) + side quads.
  const newIdxArr = new Uint32Array(nTris * 6 + boundary.length * 6);
  let p = 0;

  for (let i = 0; i < nTris * 3; i++) newIdxArr[p++] = idxSrc[i]!;

  for (let t2 = 0; t2 < nTris; t2++) {
    newIdxArr[p++] = nVerts + idxSrc[t2 * 3]!;
    newIdxArr[p++] = nVerts + idxSrc[t2 * 3 + 2]!;  // flipped winding → normals face down
    newIdxArr[p++] = nVerts + idxSrc[t2 * 3 + 1]!;
  }

  for (const [v0, v1] of boundary) {
    newIdxArr[p++] = v0;           newIdxArr[p++] = v1;           newIdxArr[p++] = nVerts + v1;
    newIdxArr[p++] = v0;           newIdxArr[p++] = nVerts + v1;  newIdxArr[p++] = nVerts + v0;
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  newGeo.setIndex(new THREE.BufferAttribute(newIdxArr, 1));
  newGeo.computeVertexNormals();
  geo.dispose();
  mesh.geometry = newGeo;
}

// ── Semantic material palette ─────────────────────────────────────────────────

const MAT: Record<string, THREE.MeshStandardMaterial> = {
  // Terrain: saturated green. The cool ground bounce on the hemisphere light
  // now reads as grass-lit rather than earthy, so we can push the base colour
  // greener without it going muddy.
  terrain:   new THREE.MeshStandardMaterial({ color: 0x6a9448, roughness: 0.95, metalness: 0.0 }),
  // Buildings: neutral stone grey — distinct from both the green terrain and
  // the dark asphalt roads. Warm stone reads too brown under the scene lighting;
  // a cooler grey-beige holds its own.
  // FrontSide only: DoubleSide was causing interior faces to render from outside,
  // inverting the lighting on exterior walls and making buildings look misshapen.
  // polygonOffset lifts building faces slightly to prevent z-fighting with terrain.
  buildings: new THREE.MeshStandardMaterial({ color: 0xa09888, roughness: 0.80, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  // Roads: cool asphalt grey — clearly darker than terrain, no brown tint.
  // polygonOffset pushes them slightly toward the camera so they don't
  // z-fight with the terrain mesh underneath.
  roads:     new THREE.MeshStandardMaterial({ color: 0x252528, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  water:     new THREE.MeshStandardMaterial({ color: 0x3a6888, roughness: 0.05, metalness: 0.1,  transparent: true, opacity: 0.85 }),
  forest:    new THREE.MeshStandardMaterial({ color: 0x2d6828, roughness: 0.95, metalness: 0.0  }),
  default:   new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9,  metalness: 0.0  }),
};

function materialForAsset(asset: ManifestAsset): THREE.MeshStandardMaterial {
  const slug = `${asset.type ?? ''} ${asset.id ?? ''} ${asset.path ?? ''}`.toLowerCase();
  if (slug.includes('terrain')) return MAT['terrain']!;
  if (slug.includes('building')) return MAT['buildings']!;
  if (slug.includes('road')) return MAT['roads']!;
  if (slug.includes('water')) return MAT['water']!;
  if (slug.includes('forest') || slug.includes('tree') || slug.includes('veg')) return MAT['forest']!;
  return MAT['default']!;
}

type StatusListener   = (msg: string) => void;
type ProgressListener = (pct: number) => void;

// Bump this when the loader logic changes to invalidate cached GLBs/manifests.
const DB_VERSION = 6;

export class AssetLoader {
  private readonly loader = new GLTFLoader();
  private readonly db: Promise<IDBDatabase>;

  private statusListeners:   Set<StatusListener>   = new Set();
  private progressListeners: Set<ProgressListener> = new Set();

  constructor() {
    this.db = this._openDb();
  }

  onStatus(fn: StatusListener):    () => void { this.statusListeners.add(fn);   return () => this.statusListeners.delete(fn); }
  onProgress(fn: ProgressListener): () => void { this.progressListeners.add(fn); return () => this.progressListeners.delete(fn); }

  async loadZone(zoneId: string): Promise<ZoneAssets> {
    this._status(`Fetching manifest for ${zoneId}…`);
    const manifest = await this._fetchManifest(zoneId);
    if (!manifest) {
      // Zone not yet built — render a blank world so the player isn't stuck in a void.
      console.warn(`[AssetLoader] No manifest for "${zoneId}" — rendering empty zone`);
      const root = new THREE.Group();
      root.name  = 'WorldRoot';
      const flat = this._buildFlatTerrain();
      flat.name  = 'flat_terrain_fallback';
      root.add(flat);
      return { worldRoot: root, heightmap: null };
    }

    const unitScale  = resolveUnitScale(manifest.origin?.units);
    const originLat  = manifest.origin?.lat ?? 0;
    const originLon  = manifest.origin?.lon ?? 0;
    const allAssets  = manifest.assets ?? [];

    // ── Heightmap (load first, in parallel with nothing yet) ─────────────────
    const hmAsset = allAssets.find(a => a.type === 'terrain_heightmap');
    let heightmap: HeightmapService | null = null;
    if (hmAsset?.path && hmAsset.metaPath) {
      this._status('Loading heightmap…');
      heightmap = await HeightmapService.loadFromPaths(
        hmAsset.metaPath, hmAsset.path, originLat, originLon,
      );
    } else {
      console.warn('[AssetLoader] No terrain_heightmap asset in manifest — click-to-move disabled');
    }

    // ── GLB meshes ────────────────────────────────────────────────────────────
    const glbAssets = allAssets.filter(a =>
      (a.path ?? '').toLowerCase().match(/\.(glb|gltf)$/)
    );

    const root  = new THREE.Group();
    root.name   = 'WorldRoot';
    const total = glbAssets.length;
    let loaded  = 0;

    for (const asset of glbAssets) {
      this._status(`Loading ${asset.id}…`);
      try {
        const group = await this._loadGlb(asset, unitScale);
        group.name  = asset.id;
        root.add(group);
        console.log(`[AssetLoader] Added ${asset.id} to WorldRoot`);
      } catch (err) {
        console.error(`[AssetLoader] ${asset.optional ? 'Optional' : 'REQUIRED'} asset ${asset.id} FAILED:`, err);
      }
      loaded++;
      this._progress(total > 0 ? loaded / total : 1);
    }

    // ── OSM procedural assets (buildings_osm, roads_osm) ──────────────────────
    const osmAssets = allAssets.filter(a => a.type === 'buildings_osm' || a.type === 'roads_osm');
    for (const asset of osmAssets) {
      this._status(`Building ${asset.type === 'buildings_osm' ? 'buildings' : 'roads'}…`);
      try {
        const mesh = asset.type === 'buildings_osm'
          ? await this._buildOsmBuildings(asset, originLat, originLon)
          : await this._buildOsmRoads(asset, originLat, originLon);
        if (mesh) { mesh.name = asset.id; root.add(mesh); }
      } catch (err) {
        console.warn(`[AssetLoader] OSM asset ${asset.id} failed:`, err);
      }
    }

    // Flat terrain fallback — added only when no GLB terrain and no DEM heightmap
    const hasTerrainMesh = glbAssets.some(a => (a.type ?? '').includes('terrain'));
    if (!heightmap && !hasTerrainMesh) {
      const flat = this._buildFlatTerrain();
      flat.name  = 'flat_terrain_fallback';
      root.add(flat);
      console.log('[AssetLoader] Added flat terrain fallback (no DEM)');
    }

    let meshCount = 0, vertCount = 0;
    root.traverse(child => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        vertCount += child.geometry.attributes['position']?.count ?? 0;
      }
    });
    console.log(`[AssetLoader] WorldRoot: ${meshCount} meshes, ${vertCount.toLocaleString()} verts`);

    this._status('World assets ready');
    return {
      worldRoot: root,
      heightmap,
      origin: manifest.origin
        ? { lat: originLat, lon: originLon }
        : undefined,
    };
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  private async _fetchManifest(zoneId: string): Promise<WorldManifest | null> {
    const url      = `${ClientConfig.serverUrl}/world/assets/${zoneId}`;
    const cacheKey = `manifest:v${DB_VERSION}:${zoneId}`;
    const cached   = await this._dbGet<{ json: string; etag: string }>(cacheKey);
    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    try {
      const res = await fetch(url, { headers });
      if (res.status === 304 && cached) return JSON.parse(cached.json) as WorldManifest;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const etag = res.headers.get('ETag') ?? '';
      await this._dbSet(cacheKey, { json: text, etag });
      return JSON.parse(text) as WorldManifest;
    } catch (err) {
      if (cached) return JSON.parse(cached.json) as WorldManifest;
      console.error('[AssetLoader] Manifest fetch failed:', err);
      return null;
    }
  }

  // ── GLB loading ───────────────────────────────────────────────────────────

  private async _loadGlb(asset: ManifestAsset, unitScale: number): Promise<THREE.Group> {
    const url      = `${ClientConfig.serverUrl}${asset.path}`;
    const cacheKey = `glb:v${DB_VERSION}:${asset.path}`;

    let buffer = await this._dbGet<ArrayBuffer>(cacheKey);
    if (!buffer) {
      console.log(`[AssetLoader] Downloading ${asset.path}…`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      buffer = await res.arrayBuffer();
      // Store a copy — IDB structured clone may transfer (detach) the original.
      await this._dbSet(cacheKey, buffer.slice(0));
      console.log(`[AssetLoader] Cached ${asset.path} (${(buffer.byteLength/1024).toFixed(0)} KB)`);
    } else {
      console.log(`[AssetLoader] Cache hit for ${asset.path} (${(buffer.byteLength/1024).toFixed(0)} KB)`);
    }

    if (!buffer.byteLength) {
      throw new Error(`Buffer for ${asset.path} is empty/detached`);
    }

    console.log(`[AssetLoader] Parsing ${asset.id} (${(buffer.byteLength/1024).toFixed(0)} KB)…`);
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      this.loader.parse(
        buffer!,
        '',
        g => resolve(g as { scene: THREE.Group }),
        err => reject(err),
      );
    });

    const mat = materialForAsset(asset);

    let meshCount = 0;
    let vertCount = 0;

    const isTerrain = mat === MAT['terrain'];
    const isRoad    = mat === MAT['roads'];
    gltf.scene.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      meshCount++;
      const verts = child.geometry.attributes['position']?.count ?? 0;
      vertCount += verts;

      if (!child.geometry.attributes['normal']) {
        child.geometry.computeVertexNormals();
      }
      child.material = mat;
      // Terrain: receive only (flat ground self-shadow is invisible).
      // Small meshes (< 50 verts — tiny props): neither cast nor receive.
      // Everything else: cast + receive.
      if (isTerrain) {
        child.castShadow    = false;
        child.receiveShadow = true;
      } else if (verts < 50) {
        child.castShadow    = false;
        child.receiveShadow = false;
      } else {
        child.castShadow    = true;
        child.receiveShadow = true;
      }
    });

    // Extrude road surfaces into 0.2 m slabs so they stay visible on slopes.
    if (isRoad) thickenRoadScene(gltf.scene, unitScale);

    // Apply scale: zone unitScale × optional per-asset scale from manifest.
    const effectiveScale = unitScale * (asset.scale ?? 1);
    gltf.scene.scale.setScalar(effectiveScale);

    // Log bounding box to help diagnose scale/position issues.
    const box    = new THREE.Box3().setFromObject(gltf.scene);
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    console.log(
      `[AssetLoader] ${asset.id}: ${meshCount} meshes, ${vertCount.toLocaleString()} verts,` +
      ` scale=${effectiveScale}` +
      ` | bbox size=(${size.x.toFixed(1)}, ${size.y.toFixed(1)}, ${size.z.toFixed(1)})` +
      ` center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)})`,
    );

    if (meshCount === 0) {
      console.warn(`[AssetLoader] WARNING: ${asset.id} parsed but contains NO meshes!`);
    }

    return gltf.scene;
  }

  // ── OSM procedural mesh builders ──────────────────────────────────────────

  private async _buildOsmBuildings(
    asset: ManifestAsset,
    originLat: number,
    originLon: number,
  ): Promise<THREE.Mesh | null> {
    const res = await fetch(`${ClientConfig.serverUrl}${asset.path}`);
    if (!res.ok) return null;
    const features = await res.json() as OsmFeature[];

    const DEG   = Math.PI / 180;
    const R_lat = DEG * 6_378_137;
    const R_lon = R_lat * Math.cos(originLat * DEG);

    const positions: number[] = [];
    const normals:   number[] = [];
    const idxArr:    number[] = [];

    // Chunked extrusion — keeps the main thread responsive (browser-
    // unresponsive watchdog fires after ~10 s). 200 footprints per
    // chunk hits roughly 30–80 ms per batch on medium hardware.
    await chunkedFor(features, 200, (feat) => {
      const raw = feat.nodes ?? [];
      if (raw.length < 3) return;

      // World XZ coordinates
      const pts: [number, number][] = raw.map(n => [
        (n.lon - originLon) * R_lon,
        -(n.lat - originLat) * R_lat,
      ]);

      // Drop duplicate closing node
      if (pts.length > 1) {
        const [fx, fz] = pts[0]!;
        const [lx, lz] = pts[pts.length - 1]!;
        if (Math.abs(fx - lx) < 0.01 && Math.abs(fz - lz) < 0.01) pts.pop();
      }
      if (pts.length < 3) return;

      const h    = osmBuildingHeight(feat.tags);
      const base = positions.length / 3;
      const n    = pts.length;

      // Interleaved: bottom (Y=0) + top (Y=h) for each footprint vertex
      for (const [x, z] of pts) {
        positions.push(x, 0, z);
        normals.push(0, -1, 0);
        positions.push(x, h, z);
        normals.push(0,  1, 0);
      }

      // Side walls
      for (let i = 0; i < n; i++) {
        const j   = (i + 1) % n;
        const b0  = base + i * 2;
        const t0  = base + i * 2 + 1;
        const b1  = base + j * 2;
        const t1  = base + j * 2 + 1;
        idxArr.push(b0, b1, t0, t0, b1, t1);
      }

      // Top cap — simple fan from first vertex
      for (let i = 1; i < n - 1; i++) {
        idxArr.push(
          base + 1,           // top 0
          base + i * 2 + 1,   // top i
          base + (i + 1) * 2 + 1, // top i+1
        );
      }
    }, (done, total) => {
      this._status(`Building structures (${done}/${total})…`);
    });

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(normals),   3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();

    const mat  = new THREE.MeshStandardMaterial({
      color: 0xa09888, roughness: 0.80, metalness: 0.05,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    console.log(`[AssetLoader] OSM buildings: ${features.length} footprints → ${positions.length / 3} verts`);
    return mesh;
  }

  private async _buildOsmRoads(
    asset: ManifestAsset,
    originLat: number,
    originLon: number,
  ): Promise<THREE.Mesh | null> {
    const res = await fetch(`${ClientConfig.serverUrl}${asset.path}`);
    if (!res.ok) return null;
    const features = await res.json() as OsmFeature[];

    const DEG   = Math.PI / 180;
    const R_lat = DEG * 6_378_137;
    const R_lon = R_lat * Math.cos(originLat * DEG);

    const positions: number[] = [];
    const idxArr:    number[] = [];

    // Same chunking story as buildings — keeps the main thread breathing.
    await chunkedFor(features, 200, (feat) => {
      const raw = feat.nodes ?? [];
      if (raw.length < 2) return;

      const halfW = osmRoadWidth(feat.tags?.highway ?? '') / 2;
      const pts   = raw.map(n => ({
        x:  (n.lon - originLon) * R_lon,
        z: -(n.lat - originLat) * R_lat,
      }));

      for (let i = 0; i < pts.length - 1; i++) {
        const a  = pts[i]!;
        const b  = pts[i + 1]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.01) continue;

        // Perpendicular in XZ plane (right-hand rule, Z+ = south)
        const px =  dz / len * halfW;
        const pz = -dx / len * halfW;

        const base = positions.length / 3;
        // 0.05 m above ground to avoid z-fighting with flat terrain
        positions.push(a.x + px, 0.05, a.z + pz);
        positions.push(a.x - px, 0.05, a.z - pz);
        positions.push(b.x + px, 0.05, b.z + pz);
        positions.push(b.x - px, 0.05, b.z - pz);

        idxArr.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }, (done, total) => {
      this._status(`Tracing roads (${done}/${total})…`);
    });

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();

    const mat  = new THREE.MeshStandardMaterial({
      color: 0x252528, roughness: 0.85, metalness: 0.0,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    console.log(`[AssetLoader] OSM roads: ${features.length} ways → ${positions.length / 3} verts`);
    return mesh;
  }

  private _buildFlatTerrain(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a9448, roughness: 0.95, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  // ── IndexedDB ──────────────────────────────────────────────────────────────

  private _openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('aa-asset-cache', DB_VERSION);
      req.onupgradeneeded = () => {
        // Wipe and recreate on version bump to clear stale cached data
        const db = req.result;
        if (db.objectStoreNames.contains('assets')) {
          db.deleteObjectStore('assets');
        }
        db.createObjectStore('assets');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  private async _dbGet<T>(key: string): Promise<T | null> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('assets', 'readonly');
      const req = tx.objectStore('assets').get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  private async _dbSet(key: string, value: unknown): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('assets', 'readwrite');
      const req = tx.objectStore('assets').put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  private _status(msg: string):   void { this.statusListeners.forEach(fn => fn(msg)); }
  private _progress(pct: number): void { this.progressListeners.forEach(fn => fn(pct)); }
}

function resolveUnitScale(units?: string): number {
  switch (units?.trim().toLowerCase()) {
    case 'feet': case 'foot': case 'ft': return 0.3048;
    default: return 1;
  }
}

// ── OSM helpers ───────────────────────────────────────────────────────────────

function osmBuildingHeight(tags?: Record<string, string>): number {
  if (!tags) return 5;
  const h = parseFloat(tags['height'] ?? '');
  if (Number.isFinite(h) && h > 0) return Math.min(h, 120);
  const levels = parseInt(tags['building:levels'] ?? '', 10);
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3.5, 120);
  const type = tags['building'] ?? '';
  if (type === 'church' || type === 'cathedral') return 15;
  if (type === 'industrial' || type === 'warehouse') return 8;
  return 5;
}

function osmRoadWidth(highway: string): number {
  switch (highway) {
    case 'motorway': case 'trunk':               return 12;
    case 'primary':                               return 9;
    case 'secondary':                             return 7;
    case 'tertiary':                              return 6;
    case 'residential': case 'unclassified':      return 5;
    case 'service':                               return 4;
    case 'footway': case 'path': case 'cycleway': return 2;
    case 'track':                                 return 3;
    default:                                      return 5;
  }
}

interface OsmNode    { lat: number; lon: number; }
interface OsmFeature { tags?: Record<string, string>; nodes?: OsmNode[]; }
