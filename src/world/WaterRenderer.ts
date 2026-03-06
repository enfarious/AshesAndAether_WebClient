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
}

// ── Shader source ──────────────────────────────────────────────────────────────

const WATER_VERT = /* glsl */ `
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

  // Analytical wave normal (partial derivatives of displacement)
  float dWdx = wf * (
      cos(pos.x * wf + uTime * 1.2) * cos(pos.z * wf * 0.7 + uTime * 0.9) * 0.6
    + 1.3 * wf * cos(pos.x * wf * 1.3 - uTime * 0.8)
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
}
`;

const WATER_FRAG = /* glsl */ `
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

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying float vFogDepth;

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
  vec3 normal  = normalize(vWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);

  // Fresnel — more opaque at glancing angles, more see-through from above
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  fresnel = 0.3 + 0.7 * fresnel;

  // Animated surface detail (two scrolling noise layers)
  vec2 uv1 = vWorldPosition.xz * 0.08 + vec2(uTime * 0.02, uTime * 0.015);
  vec2 uv2 = vWorldPosition.xz * 0.12 + vec2(-uTime * 0.018, uTime * 0.025);
  float detail = noise(uv1) * 0.5 + noise(uv2) * 0.5;

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

  constructor(
    private readonly _scene: THREE.Scene,
    private _heightmap: HeightmapService | null,
  ) {
    this._material = WaterRenderer._createMaterial();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Replace the heightmap (e.g. after zone transfer). */
  setHeightmap(hm: HeightmapService | null): void { this._heightmap = hm; }

  /**
   * Fetch water polygon data for a zone and generate meshes.
   * Safe to call for any zone — returns silently if no data exists.
   */
  async loadForZone(
    zoneId: string,
    originLat: number,
    originLon: number,
  ): Promise<void> {
    // Village / dungeon zones have no OSM water
    if (zoneId.startsWith('village:') || zoneId.startsWith('dungeon')) return;

    this.clear();

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

      // Convert lat/lon → world XZ
      const worldPts = feature.nodes.map(n => ({
        x:  (n.lon - originLon) * mPerDegLon,
        z: -(n.lat - originLat) * M_PER_DEG_LAT,
      }));

      // Closed polygon or open linestring?
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

    this._addMesh(geo, 'water-polygon');
  }

  /**
   * Extrude an open linestring (river, stream) into a flat ribbon with
   * miter-join normals at each vertex.
   */
  private _buildRibbon(
    pts: Array<{ x: number; z: number }>,
    tags?: Record<string, string>,
  ): void {
    if (pts.length < 2) return;

    const type = tags?.waterway ?? 'stream';
    const halfW = HALF_WIDTH[type] ?? DEFAULT_HALF_WIDTH;
    const waterY = this._computeWaterLevel(pts);

    const vertCount = pts.length * 2;
    const positions = new Float32Array(vertCount * 3);
    const uvs       = new Float32Array(vertCount * 2);
    const indices: number[] = [];

    let accDist = 0;

    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i]!;

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

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
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
        uWaveFrequency:    { value: 0.8 },
        uSpecularPower:    { value: 48.0 },
        uSpecularStrength: { value: 0.6 },
        uFogColor:         { value: new THREE.Color(0x6080a0) },
        uFogDensity:       { value: 0.0014 },
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
