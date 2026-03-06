import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ClientConfig } from '@/config/ClientConfig';
import { HeightmapService } from './HeightmapService';

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
    if (!manifest) throw new Error(`No manifest for "${zoneId}"`);

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
