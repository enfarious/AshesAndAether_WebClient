import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';
import type { HeightmapService } from './HeightmapService';
import { chunkedFor }     from './yieldUtil';

// forests.json is already in zone-local metres [x, z] — no lat/lon conversion needed.
interface ForestPolygon {
  points: [number, number][];
}

export class ForestDebugRenderer {
  private readonly _scene: THREE.Scene;
  private _heightmap: HeightmapService | null;
  private readonly _meshes: THREE.Mesh[] = [];
  private readonly _lines: THREE.LineSegments[] = [];
  private _visible = true;
  /** Zone state stashed at loadForZone time so toggle() can lazy-load
   *  polygon meshes on first F8 press without re-fetching the registry. */
  private _zoneId: string | null = null;
  private _polygonsLoaded = false;
  private _polygonsLoading = false;

  // Fog disabled on both materials so the overlay is always visible regardless of distance.
  private readonly _fillMat = new THREE.MeshBasicMaterial({
    color: 0x22cc44,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  private readonly _lineMat = new THREE.LineBasicMaterial({
    color: 0x00ff44,
    opacity: 1.0,
    fog: false,
  });
  // Zone-boundary ring (white) — should sit at the terrain edge if coords are aligned.
  private readonly _ringMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    opacity: 1.0,
    fog: false,
  });

  constructor(scene: THREE.Scene, heightmap: HeightmapService | null) {
    this._scene = scene;
    this._heightmap = heightmap;
  }

  setHeightmap(hm: HeightmapService | null): void { this._heightmap = hm; }

  /** Called at zone load. Builds ONLY the white zone-boundary ring
   *  (cheap, ~256 line verts). Polygon meshes are deferred to the first
   *  F8 toggle — fetching forests.json + grid-sampled mesh building per
   *  polygon used to add multi-second main-thread blocking to every
   *  zone load even when the overlay was off. */
  loadForZone(zoneId: string, zoneRadiusM = 3219): void {
    this.clear();
    this._buildRing(zoneRadiusM);
    this._zoneId = zoneId;
    this._polygonsLoaded = false;
    this._polygonsLoading = false;
  }

  /** Lazy polygon build — fires once on first F8 toggle-on. Chunked so
   *  individual heavy polygons don't lock the main thread. */
  private async _loadPolygons(): Promise<void> {
    if (this._polygonsLoading || this._polygonsLoaded || !this._zoneId) return;
    this._polygonsLoading = true;
    const zoneId = this._zoneId;

    let polygons: ForestPolygon[];
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/world/osm/${zoneId}/forests.json`);
      if (!res.ok) {
        console.warn(`[ForestDebug] No forests.json for zone ${zoneId} (${res.status})`);
        this._polygonsLoading = false;
        return;
      }
      polygons = await res.json() as ForestPolygon[];
    } catch (err) {
      console.warn('[ForestDebug] Failed to load forests.json:', err);
      this._polygonsLoading = false;
      return;
    }

    if (!polygons.length) {
      console.warn('[ForestDebug] forests.json loaded but contains 0 polygons');
      this._polygonsLoaded = true;
      this._polygonsLoading = false;
      return;
    }

    // One polygon per chunk — _buildPolygon does heavy grid-sampled PIP
    // work that scales with polygon area × vertex count.
    await chunkedFor(polygons, 1, (poly) => {
      this._buildPolygon(poly.points);
      // Newly-built meshes inherit the current visibility — if the
      // user toggled OFF mid-load they shouldn't suddenly appear.
      const last = this._meshes[this._meshes.length - 1];
      if (last) last.visible = this._visible;
      const lastLine = this._lines[this._lines.length - 1];
      if (lastLine) lastLine.visible = this._visible;
    });

    this._polygonsLoaded = true;
    this._polygonsLoading = false;
    console.log(`[ForestDebug] ${polygons.length} polygon(s) loaded.`);
  }

  private _sampleGroundY(cx: number, cz: number): number {
    // Try the centroid first, then nearby offsets if the centroid is outside DEM bounds.
    const offsets: [number, number][] = [[0, 0], [100, 0], [-100, 0], [0, 100], [0, -100]];
    for (const [dx, dz] of offsets) {
      const y = this._heightmap?.getElevation(cx + dx, cz + dz);
      if (y !== null && y !== undefined) return y + 0.3;
    }
    // No DEM coverage — use a fallback that's clearly visible above sea level.
    console.warn(`[ForestDebug] No DEM coverage near (${cx.toFixed(0)}, ${cz.toFixed(0)}) — placing overlay at Y=200`);
    return 200;
  }

  private _buildPolygon(pts: [number, number][]): void {
    if (pts.length < 3) return;

    // Manual scan — Math.min(...arr) spreads onto the call stack and
    // throws on big polygons (forest polygons can be 5 000+ vertices).
    // Same loop also computes the centroid so we touch each point once.
    let cx = 0, cz = 0;
    let xMin =  Infinity, xMax = -Infinity;
    let zMin =  Infinity, zMax = -Infinity;
    for (const [x, z] of pts) {
      cx += x; cz += z;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    cx /= pts.length;
    cz /= pts.length;
    const groundY = this._sampleGroundY(cx, cz);

    // Grid-based fill: sample heightmap on a regular ~100 m grid so the overlay
    // conforms to rolling terrain instead of producing a few huge flat triangles
    // (ShapeGeometry earclip triangulation of a large polygon produces ~10 coarse
    // triangles that visually appear as a floating plane from inside the polygon).
    const CELL = 100;
    const cols = Math.ceil((xMax - xMin) / CELL) + 1;
    const rows = Math.ceil((zMax - zMin) / CELL) + 1;

    const heights: (number | null)[] = new Array(cols * rows).fill(null);
    for (let r = 0; r < rows; r++) {
      const wz = zMin + r * CELL;
      for (let c = 0; c < cols; c++) {
        const wx = xMin + c * CELL;
        if (this._pointInPolygon(wx, wz, pts))
          heights[r * cols + c] = this._heightmap?.getElevation(wx, wz) ?? groundY;
      }
    }

    const verts: number[] = [];
    const indices: number[] = [];
    const vertMap = new Map<number, number>();

    const addVert = (r: number, c: number): number => {
      const key = r * cols + c;
      if (!vertMap.has(key)) {
        vertMap.set(key, verts.length / 3);
        verts.push(xMin + c * CELL, (heights[key] ?? groundY) + 0.3, zMin + r * CELL);
      }
      return vertMap.get(key)!;
    };

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const h00 = heights[r * cols + c];
        const h01 = heights[r * cols + (c + 1)];
        const h10 = heights[(r + 1) * cols + c];
        const h11 = heights[(r + 1) * cols + (c + 1)];
        const inside = [h00, h01, h10, h11].filter(h => h !== null).length;
        if (inside < 3) continue;
        const v00 = addVert(r, c), v01 = addVert(r, c + 1);
        const v10 = addVert(r + 1, c), v11 = addVert(r + 1, c + 1);
        if (h00 !== null && h01 !== null && h11 !== null) indices.push(v00, v01, v11);
        if (h00 !== null && h11 !== null && h10 !== null) indices.push(v00, v11, v10);
      }
    }

    if (verts.length > 0) {
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      fillGeo.setIndex(indices);
      fillGeo.computeVertexNormals();
      const fillMesh = new THREE.Mesh(fillGeo, this._fillMat);
      fillMesh.renderOrder = 2;
      this._scene.add(fillMesh);
      this._meshes.push(fillMesh);
    }

    // Perimeter outline — subdivide edges so long segments also hug terrain
    const lineVerts: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i]!;
      const [bx, bz] = pts[(i + 1) % pts.length]!;
      const ay = this._heightmap?.getElevation(ax, az) ?? groundY;
      const by = this._heightmap?.getElevation(bx, bz) ?? groundY;
      lineVerts.push(ax, ay + 0.4, az, bx, by + 0.4, bz);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    const lines = new THREE.LineSegments(lineGeo, this._lineMat);
    lines.renderOrder = 3;
    this._scene.add(lines);
    this._lines.push(lines);
  }

  private _pointInPolygon(px: number, pz: number, pts: [number, number][]): boolean {
    let inside = false;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i]![0], zi = pts[i]![1];
      const xj = pts[j]![0], zj = pts[j]![1];
      if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi)
        inside = !inside;
    }
    return inside;
  }

  /** White ring at world origin (0,0) at zone radius — alignment reference. */
  private _buildRing(radius: number): void {
    const SEGS = 128;
    const verts: number[] = [];
    const y0 = this._heightmap?.getElevation(0, 0) ?? 200;
    for (let i = 0; i <= SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      const ya = this._heightmap?.getElevation(x0, z0) ?? y0;
      const yb = this._heightmap?.getElevation(x1, z1) ?? y0;
      verts.push(x0, ya + 0.5, z0, x1, yb + 0.5, z1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const ring = new THREE.LineSegments(geo, this._ringMat);
    ring.renderOrder = 3;
    this._scene.add(ring);
    this._lines.push(ring);
  }

  toggle(): void {
    this._visible = !this._visible;
    for (const m of this._meshes) m.visible = this._visible;
    for (const l of this._lines) l.visible = this._visible;
    // First ON-press triggers the polygon fetch + build. Async, doesn't
    // block input — meshes appear as each chunk lands.
    if (this._visible && !this._polygonsLoaded) {
      void this._loadPolygons();
    }
    console.log(`[ForestDebug] Overlay ${this._visible ? 'ON' : 'OFF'}`);
  }

  clear(): void {
    for (const m of this._meshes) { this._scene.remove(m); m.geometry.dispose(); }
    this._meshes.length = 0;
    for (const l of this._lines) { this._scene.remove(l); l.geometry.dispose(); }
    this._lines.length = 0;
  }

  dispose(): void {
    this.clear();
    this._fillMat.dispose();
    this._lineMat.dispose();
    this._ringMat.dispose();
  }
}
