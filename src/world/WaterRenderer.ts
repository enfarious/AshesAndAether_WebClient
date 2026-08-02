import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';
import type { HeightmapService } from './HeightmapService';

// ── Data types ─────────────────────────────────────────────────────────────────

interface WaterNode {
  lat: number;
  lon: number;
}

interface WaterFeature {
  id: number;
  tags?: Record<string, string>;
  nodes: WaterNode[];
}

interface WaterMeshEntry {
  mesh: THREE.Mesh;
  /** Water body id from the bake, or null for legacy polygon-built meshes.
   *  Ice forms per body, so this is how a freeze/thaw message finds the
   *  geometry it applies to. */
  bodyId?: number | null;
  kind?: 'lake' | 'river' | null;
}

// ── Shader source ──────────────────────────────────────────────────────────────

const WATER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying float vFogDepth;

void main() {
  vec3 pos = position;

  // Two overlapping sine waves for natural-looking displacement
  float wf = uWaveFrequency;
  float w1 = sin(pos.x * wf + uTime * 1.2)
           * cos(pos.z * wf * 0.7 + uTime * 0.9);
  float w2 = sin(pos.x * wf * 1.3 - uTime * 0.8)
           * cos(pos.z * wf * 1.1 + uTime * 1.1);
  pos.y += (w1 * 0.6 + w2 * 0.4) * uWaveAmplitude;

  // Analytical wave normal (partial derivatives of displacement).
  //
  // NOTE: the second term of dWdx previously carried an extra wf factor
  // (1.3 * wf * cos(...)) on top of the outer wf multiply, scaling X slopes
  // by wf^2 while Z slopes scaled by wf. The asymmetry produced hard
  // directional banding -- chevrons running diagonally across large flat
  // bodies -- because the normal tilted far harder along X than Z.
  // d/dx sin(x*wf*1.3) is 1.3*wf*cos(...), and the outer factor already
  // supplies the wf.
  float dWdx = wf * (
      cos(pos.x * wf + uTime * 1.2) * cos(pos.z * wf * 0.7 + uTime * 0.9) * 0.6
    + 1.3 * cos(pos.x * wf * 1.3 - uTime * 0.8)
      * cos(pos.z * wf * 1.1 + uTime * 1.1) * 0.4
  ) * uWaveAmplitude;
  float dWdz = wf * (
      sin(pos.x * wf + uTime * 1.2) * (-0.7) * sin(pos.z * wf * 0.7 + uTime * 0.9) * 0.6
    + sin(pos.x * wf * 1.3 - uTime * 0.8)
      * (-1.1) * sin(pos.z * wf * 1.1 + uTime * 1.1) * 0.4
  ) * uWaveAmplitude;

  vWorldNormal = normalize(vec3(-dWdx, 1.0, -dWdz));

  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPos.xyz;

  vec4 mvPosition = viewMatrix * worldPos;
  vFogDepth = -mvPosition.z;

  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform float uTime;
uniform vec3  uWaterColor;
uniform vec3  uDeepColor;
uniform vec3  uSunColor;
uniform vec3  uSunDirection;
uniform float uOpacity;
uniform float uSpecularPower;
uniform float uSpecularStrength;
uniform vec3  uFogColor;
uniform float uFogDensity;

// Heightmap-as-texture for terrain conform discard. Same pattern as
// MiasmaGroundFog. Lake polygons sit at a single Y; any fragment where
// the terrain rises above (waterY + epsilon) is discarded so islands,
// peninsulas, and shallow shores read as terrain instead of water
// clipping in and out of the heightmap.
uniform sampler2D uHeightmap;
uniform vec2  uHeightmapSize;
uniform vec2  uHeightmapOrigin;
uniform float uPixelSizeDeg;
uniform vec2  uHeightmapCenter;
uniform vec2  uMPerDeg;
uniform float uHeightmapValid;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying float vFogDepth;

float sampleTerrainY(vec2 worldXZ) {
  if (uHeightmapValid < 0.5) return -1.0e9;
  float lat = uHeightmapCenter.x - worldXZ.y / uMPerDeg.x;
  float lon = uHeightmapCenter.y + worldXZ.x / uMPerDeg.y;
  vec2 uv = vec2(
    (lon - uHeightmapOrigin.y) / uPixelSizeDeg,
    (uHeightmapOrigin.x - lat) / uPixelSizeDeg
  ) / uHeightmapSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -1.0e9;
  return texture2D(uHeightmap, uv).r;
}

// Simple value noise for surface detail
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  #include <logdepthbuf_fragment>

  // Discard fragments where terrain rises well above the water surface
  // (real peninsulas/islands inside a polygon). 1.5 m epsilon is loose
  // enough that minor DEM noise + ribbon-quad interpolation error don't
  // leave holes in rivers — the slab depth below the surface handles the
  // rest by giving the water visible volume even when the top quad dips
  // slightly under terrain between sampled corners.
  float terrainY = sampleTerrainY(vWorldPosition.xz);
  if (terrainY > vWorldPosition.y + 1.5) discard;

  vec3 normal  = normalize(vWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);

  // Fresnel — more opaque at glancing angles, more see-through from above
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  fresnel = 0.3 + 0.7 * fresnel;

  // Animated surface detail — three octaves.
  //
  // Frequencies are in world metres: 0.08 meant a ~12.5m noise period, which
  // on a large flat lake reads as huge slabs of colour sliding around rather
  // than water. Mesh subdivision doesn't help here — vertex density affects
  // displacement, not the fragment-stage colour pattern — so the frequency
  // itself has to come up. A third octave breaks up the regularity that any
  // two-layer value noise leaves behind.
  vec2 uv1 = vWorldPosition.xz * 0.18 + vec2(uTime * 0.04, uTime * 0.03);
  vec2 uv2 = vWorldPosition.xz * 0.40 + vec2(-uTime * 0.05, uTime * 0.06);
  vec2 uv3 = vWorldPosition.xz * 0.85 + vec2(uTime * 0.08, -uTime * 0.07);
  float detail = noise(uv1) * 0.55 + noise(uv2) * 0.30 + noise(uv3) * 0.15;

  // Blend deep ↔ surface colour using noise detail
  vec3 waterCol = mix(uDeepColor, uWaterColor, 0.5 + detail * 0.5);

  // Blinn-Phong sun specular highlight
  vec3 halfVec = normalize(uSunDirection + viewDir);
  float spec   = pow(max(dot(normal, halfVec), 0.0), uSpecularPower);
  waterCol    += uSunColor * spec * uSpecularStrength;

  // FogExp2 matching scene fog
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  waterCol = mix(waterCol, uFogColor, fogFactor);

  float alpha = uOpacity * fresnel;
  gl_FragColor = vec4(waterCol, alpha);
}
`;

// ── Constants ──────────────────────────────────────────────────────────────────

const M_PER_DEG_LAT = 111_320;

/** River/stream ribbon half-widths by waterway tag. */
const HALF_WIDTH: Record<string, number> = {
  river:  10,
  stream:  7.5,
  canal:   8,
  drain:   4,
  ditch:   3,
};
const DEFAULT_HALF_WIDTH = 5;

/** Miter join limit — clamp to prevent spikes on sharp bends. */
const MITER_LIMIT = 2.0;

// ── WaterRenderer ──────────────────────────────────────────────────────────────

/**
 * WaterRenderer — generates and animates water surfaces from OSM polygon data.
 *
 * Fetches water.json for the current zone, converts lat/lon polygons to
 * Three.js meshes (ShapeGeometry for lakes, ribbon for rivers), and applies
 * a custom animated ShaderMaterial with wave displacement, Fresnel
 * transparency, and sun specular highlights.
 *
 * Call `update(dt)` every frame to advance the wave animation.
 */
export class WaterRenderer {
  private _meshes: WaterMeshEntry[] = [];
  private _material: THREE.ShaderMaterial;
  private _elapsed = 0;
  private _heightmapTexture: THREE.DataTexture | null = null;

  constructor(
    private readonly _scene: THREE.Scene,
    private _heightmap: HeightmapService | null,
  ) {
    this._material = WaterRenderer._createMaterial();
    if (this._heightmap) this._uploadHeightmapUniforms(this._heightmap);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Replace the heightmap (e.g. after zone transfer). Also re-uploads the
   *  DEM as a DataTexture so the fragment shader's terrain-clip stays in
   *  sync with the new zone. */
  setHeightmap(hm: HeightmapService | null): void {
    this._heightmap = hm;
    this._uploadHeightmapUniforms(hm);
  }

  /** Build (or clear) the heightmap DataTexture + uniforms. Mirrors
   *  MiasmaGroundFog's pattern; both shaders need the same world↔texel
   *  transform constants to do a coherent lookup. */
  private _uploadHeightmapUniforms(hm: HeightmapService | null): void {
    this._heightmapTexture?.dispose();
    this._heightmapTexture = null;

    const u = this._material.uniforms;
    if (!hm) {
      u['uHeightmap']!.value      = null;
      u['uHeightmapValid']!.value = 0;
      return;
    }

    const inputs = hm.getShaderInputs();
    const tex = new THREE.DataTexture(
      inputs.data as unknown as BufferSource,
      inputs.width,
      inputs.height,
      THREE.RedFormat,
      THREE.FloatType,
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS     = THREE.ClampToEdgeWrapping;
    tex.wrapT     = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate     = true;
    this._heightmapTexture = tex;

    u['uHeightmap']!.value = tex;
    (u['uHeightmapSize']!.value   as THREE.Vector2).set(inputs.width, inputs.height);
    (u['uHeightmapOrigin']!.value as THREE.Vector2).set(inputs.originLat, inputs.originLon);
    (u['uHeightmapCenter']!.value as THREE.Vector2).set(inputs.centerLat, inputs.centerLon);
    (u['uMPerDeg']!.value         as THREE.Vector2).set(inputs.mPerDegLat, inputs.mPerDegLon);
    u['uPixelSizeDeg']!.value     = inputs.pixelSizeDeg;
    u['uHeightmapValid']!.value   = 1;
  }

  /**
   * Fetch water polygon data for a zone and generate meshes.
   * Safe to call for any zone — returns silently if no data exists.
   *
   * NOT chunked: the per-feature mesh build is fast (small OSM polygons
   * + cheap ribbon math), but each rAF yield between features triggered
   * a render-pass that hit the custom water shader's first-compile stall
   * AND per-mesh GPU upload, surfacing as a multi-second visible hang
   * (the "Building water (4/21)" symptom). Building all features in one
   * sync block keeps it under the responsiveness budget and defers the
   * single shader-compile/GPU-upload event to the rAF *after* this
   * whole phase finishes — one stall, between phases, not mid-loop.
   */
  async loadForZone(
    zoneId: string,
    originLat: number,
    originLon: number,
  ): Promise<void> {
    // Village / dungeon zones have no OSM water
    if (zoneId.startsWith('village:') || zoneId.startsWith('dungeon')) return;

    this.clear();

    // Prefer the baked per-body mesh from the zone bake.
    //
    // It's better geometry than anything derivable here: built from the
    // carve's water-surface grid, so river surfaces follow the terrain's
    // slope down a valley instead of sitting flat along their whole length,
    // and every body carries an id that ice can be applied to individually.
    // It also skips the THREE.Shape triangulation below, which ran per body
    // on every load for every player.
    //
    // Falls back to OSM polygons when a zone hasn't been rebaked yet.
    if (await this._loadBakedMeshes(zoneId)) return;

    let features: WaterFeature[];
    try {
      const res = await fetch(`${ClientConfig.serverUrl}/world/water/${zoneId}`);
      if (!res.ok) return;
      features = await res.json() as WaterFeature[];
    } catch { return; }

    if (!features || features.length === 0) return;

    const mPerDegLon = M_PER_DEG_LAT * Math.cos(originLat * Math.PI / 180);

    for (const feature of features) {
      // Skip underground culverts
      if (feature.tags?.tunnel === 'culvert' || feature.tags?.layer === '-1') continue;
      if (feature.nodes.length < 2) continue;

      const worldPts = feature.nodes.map(n => ({
        x:  (n.lon - originLon) * mPerDegLon,
        z: -(n.lat - originLat) * M_PER_DEG_LAT,
      }));

      const first = feature.nodes[0]!;
      const last  = feature.nodes[feature.nodes.length - 1]!;
      const closed =
        Math.abs(first.lat - last.lat) < 1e-6 &&
        Math.abs(first.lon - last.lon) < 1e-6;

      if (closed && worldPts.length >= 4) {
        this._buildPolygon(worldPts);
      } else if (worldPts.length >= 2) {
        this._buildRibbon(worldPts, feature.tags);
      }
    }

    if (this._meshes.length > 0) {
      console.log(`[WaterRenderer] ${this._meshes.length} water meshes for ${zoneId}`);
    }
  }

  /**
   * Load the baked per-body water mesh for a zone.
   *
   * Returns true when meshes were installed, false when the zone has no
   * baked water (older bake, or genuinely dry) so the caller can fall back.
   *
   * The GLB holds one mesh per body named `water_{id}_{kind}`, which is how
   * each mesh binds to the body the server will freeze and thaw. Geometry is
   * in feet like every other baked asset, so it takes the same unit scale
   * from the manifest origin.
   */
  private async _loadBakedMeshes(zoneId: string): Promise<boolean> {
    let manifest: {
      origin?: { units?: string };
      assets?: { type?: string; path?: string }[];
    };
    try {
      const res = await fetch(
        `${ClientConfig.serverUrl}/world/assets/${zoneId}/manifest.json`,
      );
      if (!res.ok) return false;
      manifest = await res.json();
    } catch { return false; }

    const asset = manifest.assets?.find(a => a.type === 'water_mesh');
    if (!asset?.path) return false;

    let buffer: ArrayBuffer;
    try {
      const res = await fetch(`${ClientConfig.serverUrl}${asset.path}`);
      if (!res.ok) return false;
      buffer = await res.arrayBuffer();
    } catch { return false; }

    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    let scene: THREE.Group;
    try {
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        new GLTFLoader().parse(buffer, '', g => resolve(g as { scene: THREE.Group }), reject);
      });
      scene = gltf.scene;
    } catch (err) {
      console.warn('[WaterRenderer] Baked water GLB parse failed:', err);
      return false;
    }

    // Baked assets are authored in feet; 'feet' is what the manifest declares.
    const unitScale = manifest.origin?.units === 'feet' ? 0.3048 : 1;

    const collected: THREE.Mesh[] = [];
    scene.traverse(child => {
      if (child instanceof THREE.Mesh) collected.push(child);
    });
    if (collected.length === 0) return false;

    for (const mesh of collected) {
      // Flatten the GLB hierarchy AND the unit conversion into the geometry.
      //
      // Baking scale into the vertices rather than leaving it on the object
      // matters because the water shader derives its wave and noise detail
      // from vertex position. Left as an object scale, the shader sees
      // feet-valued coordinates — 3.28× larger than the metres it was tuned
      // against — and the surface pattern stretches by the same factor.
      mesh.updateWorldMatrix(true, false);
      const xform = mesh.matrixWorld.clone();
      xform.premultiply(new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale));
      mesh.geometry.applyMatrix4(xform);
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.setScalar(1);
      mesh.geometry.computeBoundingSphere();

      mesh.material = this._material;
      mesh.renderOrder = 1;
      mesh.frustumCulled = true;

      // Name is `water_{id}_{kind}` — the binding to a freezable body.
      const m = /^water_(\d+)_(lake|river)/.exec(mesh.name ?? '');
      const bodyId = m ? Number.parseInt(m[1]!, 10) : null;
      const kind   = m ? (m[2] as 'lake' | 'river') : null;

      this._scene.add(mesh);
      this._meshes.push({ mesh, bodyId, kind });
    }

    console.log(
      `[WaterRenderer] ${this._meshes.length} baked water bodies for ${zoneId}`,
    );
    return true;
  }

  /** Advance wave animation + sync fog + sun. */
  update(dt: number, sunDirection?: THREE.Vector3): void {
    this._elapsed += dt;
    this._material.uniforms['uTime']!.value = this._elapsed;

    if (sunDirection) {
      (this._material.uniforms['uSunDirection']!.value as THREE.Vector3)
        .copy(sunDirection).normalize();
    }

    // Sync fog uniforms with scene fog
    const fog = this._scene.fog as THREE.FogExp2 | null;
    if (fog) {
      (this._material.uniforms['uFogColor']!.value as THREE.Color).copy(fog.color);
      this._material.uniforms['uFogDensity']!.value = fog.density;
    }
  }

  /** Remove all water meshes from the scene. */
  clear(): void {
    for (const entry of this._meshes) {
      this._scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    this._meshes = [];
  }

  dispose(): void {
    this.clear();
    this._material.dispose();
    this._heightmapTexture?.dispose();
    this._heightmapTexture = null;
  }

  // ── Geometry builders ──────────────────────────────────────────────────────

  /**
   * Triangulate a closed polygon (lake, pond) using THREE.ShapeGeometry.
   * ShapeGeometry works in 2D (X, Y) — we map world X→X, world Z→Y,
   * then remap the vertex buffer to XZ at the computed water level.
   */
  private _buildPolygon(pts: Array<{ x: number; z: number }>): void {
    // Remove duplicate closing point
    const poly = pts.slice(0, -1);
    if (poly.length < 3) return;

    const waterY = this._computeWaterLevel(poly);

    const shape = new THREE.Shape();
    shape.moveTo(poly[0]!.x, poly[0]!.z);
    for (let i = 1; i < poly.length; i++) {
      shape.lineTo(poly[i]!.x, poly[i]!.z);
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 1);

    // Remap ShapeGeometry's XY vertices → world XYZ
    const pos = geo.attributes['position']!.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!;
      const z = pos[i + 1]!;  // ShapeGeometry Y = our Z
      pos[i]     = x;
      pos[i + 1] = waterY;
      pos[i + 2] = z;
    }
    geo.attributes['position']!.needsUpdate = true;
    geo.computeVertexNormals();
    // ShapeGeometry pre-computes its bounding sphere from 2D XY positions
    // (worldX mapped to X, worldZ mapped to Y, all Z=0).  After remapping
    // vertices to actual world XYZ, the cached sphere is stale and sits at
    // roughly Y=worldZ instead of Y=waterY — causing incorrect frustum culling.
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    this._addMesh(geo, 'water-polygon');
  }

  /**
   * Extrude an open linestring (river, stream) into a ribbon with
   * miter-join normals at each vertex. Each cross-section follows
   * the terrain so the ribbon flows downhill correctly.
   */
  private _buildRibbon(
    pts: Array<{ x: number; z: number }>,
    tags?: Record<string, string>,
  ): void {
    if (pts.length < 2) return;

    const type = tags?.waterway ?? 'stream';
    const halfW = HALF_WIDTH[type] ?? DEFAULT_HALF_WIDTH;

    const vertCount = pts.length * 2;
    const positions = new Float32Array(vertCount * 3);
    const uvs       = new Float32Array(vertCount * 2);
    const indices: number[] = [];

    let accDist = 0;

    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i]!;
      // Per-vertex terrain height so the ribbon flows downhill naturally.
      const waterY = (this._heightmap?.getElevation(curr.x, curr.z) ?? 0) + 0.15;

      // Tangent direction (averaged at interior points for miter)
      let tx: number, tz: number;
      if (i === 0) {
        tx = pts[1]!.x - curr.x;
        tz = pts[1]!.z - curr.z;
      } else if (i === pts.length - 1) {
        tx = curr.x - pts[i - 1]!.x;
        tz = curr.z - pts[i - 1]!.z;
      } else {
        tx = pts[i + 1]!.x - pts[i - 1]!.x;
        tz = pts[i + 1]!.z - pts[i - 1]!.z;
      }

      const tLen = Math.hypot(tx, tz) || 1;
      // Perpendicular (rotated 90 degrees)
      let nx = -tz / tLen;
      let nz =  tx / tLen;

      // Miter limit — clamp to prevent spikes on sharp bends
      if (i > 0 && i < pts.length - 1) {
        const prevTx = curr.x - pts[i - 1]!.x;
        const prevTz = curr.z - pts[i - 1]!.z;
        const nextTx = pts[i + 1]!.x - curr.x;
        const nextTz = pts[i + 1]!.z - curr.z;
        const prevLen = Math.hypot(prevTx, prevTz) || 1;
        const nextLen = Math.hypot(nextTx, nextTz) || 1;
        const dot = (prevTx / prevLen) * (nextTx / nextLen)
                  + (prevTz / prevLen) * (nextTz / nextLen);
        // cos(angle) between segments — when very sharp, scale down normal
        const miterScale = 1 / Math.max(Math.sqrt((1 + dot) / 2), 1 / MITER_LIMIT);
        nx *= Math.min(miterScale, MITER_LIMIT);
        nz *= Math.min(miterScale, MITER_LIMIT);
      }

      if (i > 0) {
        const dx = curr.x - pts[i - 1]!.x;
        const dz = curr.z - pts[i - 1]!.z;
        accDist += Math.hypot(dx, dz);
      }

      const li = i * 2;
      const ri = i * 2 + 1;

      // Left vertex
      positions[li * 3]     = curr.x + nx * halfW;
      positions[li * 3 + 1] = waterY;
      positions[li * 3 + 2] = curr.z + nz * halfW;
      uvs[li * 2]     = 0;
      uvs[li * 2 + 1] = accDist / (halfW * 4);

      // Right vertex
      positions[ri * 3]     = curr.x - nx * halfW;
      positions[ri * 3 + 1] = waterY;
      positions[ri * 3 + 2] = curr.z - nz * halfW;
      uvs[ri * 2]     = 1;
      uvs[ri * 2 + 1] = accDist / (halfW * 4);

      // Two triangles per quad segment
      if (i < pts.length - 1) {
        const nli = (i + 1) * 2;
        const nri = (i + 1) * 2 + 1;
        indices.push(li, ri, nli);
        indices.push(ri, nri, nli);
      }
    }

    // Slab extrusion: copy every top vert to a bottom sibling (Y - depth),
    // then add a flipped bottom face + side walls along the two long
    // perimeter edges and the two end caps. Gives the ribbon visible
    // volume so when terrain bows up between sampled vertices the river
    // doesn't get sliced into invisibility — and gives the shoreline some
    // geometric depth instead of reading as a paper-thin sheet. Winding
    // on the new triangles is for cleanliness; the water shader replaces
    // the geometry normal with an analytical wave normal so face-side
    // lighting is unaffected.
    const SLAB_DEPTH_M = 0.5;
    const slabPos = new Float32Array(vertCount * 2 * 3);
    const slabUv  = new Float32Array(vertCount * 2 * 2);
    for (let i = 0; i < vertCount; i++) {
      const px = positions[i * 3]!;
      const py = positions[i * 3 + 1]!;
      const pz = positions[i * 3 + 2]!;
      slabPos[i * 3]                     = px;
      slabPos[i * 3 + 1]                 = py;
      slabPos[i * 3 + 2]                 = pz;
      slabPos[(vertCount + i) * 3]       = px;
      slabPos[(vertCount + i) * 3 + 1]   = py - SLAB_DEPTH_M;
      slabPos[(vertCount + i) * 3 + 2]   = pz;
      slabUv[i * 2]                      = uvs[i * 2]!;
      slabUv[i * 2 + 1]                  = uvs[i * 2 + 1]!;
      slabUv[(vertCount + i) * 2]        = uvs[i * 2]!;
      slabUv[(vertCount + i) * 2 + 1]    = uvs[i * 2 + 1]!;
    }
    const slabIdx: number[] = indices.slice();
    for (let t = 0; t < indices.length; t += 3) {
      slabIdx.push(
        vertCount + indices[t]!,
        vertCount + indices[t + 2]!,
        vertCount + indices[t + 1]!,
      );
    }
    const K = pts.length;
    for (let i = 0; i < K - 1; i++) {
      const a  = i * 2;
      const b  = (i + 1) * 2;
      slabIdx.push(a, vertCount + a, b);
      slabIdx.push(b, vertCount + a, vertCount + b);
    }
    for (let i = 0; i < K - 1; i++) {
      const a  = i * 2 + 1;
      const b  = (i + 1) * 2 + 1;
      slabIdx.push(a, b, vertCount + a);
      slabIdx.push(b, vertCount + b, vertCount + a);
    }
    slabIdx.push(0, 1, vertCount + 1);
    slabIdx.push(0, vertCount + 1, vertCount);
    const lE = (K - 1) * 2;
    const rE = lE + 1;
    slabIdx.push(lE, vertCount + rE, rE);
    slabIdx.push(lE, vertCount + lE, vertCount + rE);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(slabPos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(slabUv, 2));
    geo.setIndex(slabIdx);
    geo.computeVertexNormals();

    this._addMesh(geo, 'water-ribbon');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _addMesh(geo: THREE.BufferGeometry, name: string): void {
    const mesh = new THREE.Mesh(geo, this._material);
    mesh.name = name;
    mesh.receiveShadow = false;
    mesh.castShadow    = false;
    mesh.renderOrder   = 1; // after opaque geometry
    this._scene.add(mesh);
    this._meshes.push({ mesh });
  }

  /**
   * Sample heightmap at polygon/linestring vertices and return the minimum
   * elevation + a small offset as the water surface height.
   * Water pools at the lowest point of the feature.
   */
  private _computeWaterLevel(pts: Array<{ x: number; z: number }>): number {
    if (!this._heightmap) return 0;

    let minElev = Infinity;
    // Sample a subset for long features to keep it fast
    const step = Math.max(1, Math.floor(pts.length / 20));
    for (let i = 0; i < pts.length; i += step) {
      const elev = this._heightmap.getElevation(pts[i]!.x, pts[i]!.z);
      if (elev !== null && elev < minElev) minElev = elev;
    }
    // Always sample endpoints
    const firstElev = this._heightmap.getElevation(pts[0]!.x, pts[0]!.z);
    const lastElev  = this._heightmap.getElevation(
      pts[pts.length - 1]!.x, pts[pts.length - 1]!.z,
    );
    if (firstElev !== null && firstElev < minElev) minElev = firstElev;
    if (lastElev  !== null && lastElev  < minElev) minElev = lastElev;

    if (!Number.isFinite(minElev)) return 0;

    // Offset slightly above terrain to prevent z-fighting
    return minElev + 0.15;
  }

  // ── Material factory ───────────────────────────────────────────────────────

  private static _createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime:             { value: 0.0 },
        uWaterColor:       { value: new THREE.Color(0x3a6888) },
        uDeepColor:        { value: new THREE.Color(0x1a3848) },
        uSunColor:         { value: new THREE.Color(0xffffff) },
        uSunDirection:     { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
        uOpacity:          { value: 0.82 },
        uWaveAmplitude:    { value: 0.12 },
        // Wave period must stay well above the mesh's vertex spacing or the
        // sine aliases and the surface renders as alternating flat facets
        // rather than a wave. Water is meshed from the DEM grid (~10m cells)
        // subdivided 3x, so spacing is ~3.4m. At the old 0.8 the second wave
        // layer (wf * 1.3) had a 6.0m period, needing spacing under 3.0m --
        // just past the limit, which is what produced the chevron facets.
        // 0.3 gives periods of ~21m and ~16m, comfortably above spacing.
        uWaveFrequency:    { value: 0.3 },
        uSpecularPower:    { value: 48.0 },
        uSpecularStrength: { value: 0.6 },
        uFogColor:         { value: new THREE.Color(0x6080a0) },
        uFogDensity:       { value: 0.0014 },
        // Heightmap-as-texture — populated lazily by setHeightmap once the
        // DEM finishes loading. Until then uHeightmapValid = 0 and the
        // fragment shader skips the terrain-clip check.
        uHeightmap:        { value: null },
        uHeightmapSize:    { value: new THREE.Vector2(1, 1) },
        uHeightmapOrigin:  { value: new THREE.Vector2(0, 0) },
        uHeightmapCenter:  { value: new THREE.Vector2(0, 0) },
        uMPerDeg:          { value: new THREE.Vector2(1, 1) },
        uPixelSizeDeg:     { value: 1.0 },
        uHeightmapValid:   { value: 0.0 },
      },
      vertexShader:   WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      // Prevent z-fighting with terrain surface
      polygonOffset:       true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits:  -3,
    });
  }
}
