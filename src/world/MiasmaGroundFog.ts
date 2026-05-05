import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * MiasmaGroundFog — terrain-conformed translucent fog plane that follows
 * the player, density driven per-pixel by danger field.
 *
 * Visual goals (locked 2026-04-30 design dialog):
 *   - Hugs terrain at ankle height, looks oppressive in deep miasma
 *   - Thins toward zero inside civic safe zones
 *   - Visibly clears inside guild beacon bubbles → bubbles read as "relief"
 *   - Wispy / breathing — scrolling noise prevents flat fog look
 *   - Cheap enough to run at 60+fps
 *
 * Implementation:
 *   - 64 × 64 subdivided plane, 400m × 400m, recenters on player when they
 *     move > 30m from plane center. Vertices Y sampled from heightmap so
 *     fog drapes over hills and dips into valleys.
 *   - Fragment shader computes danger field from uniform arrays of civic
 *     anchors + guild beacons. Same math the server's DangerMap uses, just
 *     evaluated at every screen pixel.
 *   - NormalBlending (not additive) — fog should DARKEN/MIST the world, not
 *     glow. Additive over grass made it look like green light, not dread.
 */

/** Lift range — base height of the fog above terrain, scaled by per-pixel
 *  danger. Near civic anchors the fog is ankle-shallow; in deep miasma it
 *  rises to chest-deep, gradient driven by the same danger calc that
 *  fades alpha. Beacon bubbles also drive lift down (cleared zones look
 *  visibly shallower as well as more transparent). */
const LIFT_MIN_M = 0.05; // shallow ankle fog where civic ward dominates
const LIFT_MAX_M = 1.0;  // chest-deep where corruption is uncontested

/** Plane size + subdivisions are now constructor params (driven by
 *  ClientConfig.miasmaRange + miasmaQuality). Edge-falloff thresholds
 *  and the vertex spacing for grid-snap are computed from them. */

const MAX_CIVIC = 8;
const MAX_GUILD = 64;

interface AnchorEntry { x: number; z: number; r: number }

// Shared hash/noise functions — used in vertex shader for Y modulation
// (the "rolling fog" effect) and in fragment shader for wisp texture.
const NOISE_GLSL = `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`;

// Shared danger-uniforms + dangerAt() — declared in both shaders so the
// vertex shader can drive lift from danger and the fragment shader can
// drive alpha from the same value. Identical to the server's DangerMap
// formula: civic anchors push freedom up, guild beacons push danger
// back to zero inside their bubble.
const DANGER_GLSL = `
  uniform int   uCivicCount;
  uniform vec4  uCivic[${MAX_CIVIC}];   // xy = world XZ, z = wardRadius
  uniform int   uGuildCount;
  uniform vec4  uGuild[${MAX_GUILD}];   // xy = world XZ, z = effectRadius

  float dangerAt(vec2 worldXZ) {
    float civicFreedom = 0.0;
    for (int i = 0; i < ${MAX_CIVIC}; i++) {
      if (i >= uCivicCount) break;
      vec2  c = uCivic[i].xy;
      float r = uCivic[i].z;
      float d = distance(worldXZ, c);
      float f = 1.0 - smoothstep(r, r * 2.0, d);
      civicFreedom = max(civicFreedom, f);
    }
    float baseMiasma = 1.0 - civicFreedom;

    float guildPushback = 0.0;
    for (int i = 0; i < ${MAX_GUILD}; i++) {
      if (i >= uGuildCount) break;
      vec2  c = uGuild[i].xy;
      float r = uGuild[i].z;
      float d = distance(worldXZ, c);
      float push = 1.0 - smoothstep(r * 0.7, r, d);
      guildPushback = max(guildPushback, push);
    }
    return max(0.0, baseMiasma - guildPushback);
  }
`;

/** Outer-edge dip in metres. Generous so steep uphill terrain at the
 *  plane boundary doesn't poke through the dip below it. */
const EDGE_DIP_M = 30;

const VERTEX_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uTime;
  uniform float uPlaneHalf;             // PLANE_SIZE / 2 — drives edge falloff

  // Heightmap sampling — see HeightmapService.getShaderInputs(). World
  // (X, Z) → (lat, lon) → texel UV → bilinear sample → terrain elevation.
  // Sampling per-vertex on the GPU each frame is what makes the plane
  // truly world-aligned: macro shape is the heightmap regardless of
  // mesh.position, so a snap-recenter is invisible.
  uniform sampler2D uHeightmap;
  uniform vec2  uHeightmapSize;        // (width, height) in texels
  uniform vec2  uHeightmapOrigin;      // top-left pixel (lat, lon)
  uniform float uPixelSizeDeg;
  uniform vec2  uHeightmapCenter;      // zone manifest centre (lat, lon)
  uniform vec2  uMPerDeg;              // (lat, lon) metres per degree
  uniform float uHeightmapValid;       // 0 = no DEM loaded, skip sample

  varying vec2 vWorldXZ;

  ${NOISE_GLSL}
  ${DANGER_GLSL}

  // Sample the heightmap at world (X, Z). Returns 0 when no DEM is
  // bound (initial frame before setHeightmap fires).
  float sampleTerrainY(vec2 worldXZ) {
    if (uHeightmapValid < 0.5) return 0.0;
    float lat = uHeightmapCenter.x - worldXZ.y / uMPerDeg.x;
    float lon = uHeightmapCenter.y + worldXZ.x / uMPerDeg.y;
    vec2 uv = vec2(
      (lon - uHeightmapOrigin.y) / uPixelSizeDeg,
      (uHeightmapOrigin.x - lat) / uPixelSizeDeg
    ) / uHeightmapSize;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture2D(uHeightmap, uv).r;
  }

  void main() {
    // Compute world XZ first so all sampling is stable in world space.
    vec4 worldPosBase = modelMatrix * vec4(position, 1.0);
    vec2 worldXZ = worldPosBase.xz;

    // Surface ripple — uniform ±0.2m around terrain, gives the plane
    // texture without claiming to do anything player-specific. The
    // climb-to-engulf effect lives in the separate MiasmaPlayerAura
    // mesh now, so this plane just hugs the ground.
    float surfNoise01 = noise(worldXZ * 0.12 + vec2(uTime * 0.15, -uTime * 0.12));
    float surfaceMod = surfNoise01 * 0.4 - 0.2;

    // Big-roll drift — slow vertical undulation across the whole plane.
    float yMod = noise(worldXZ * 0.012 + vec2(uTime * 0.04, uTime * 0.03)) * 0.5 - 0.25;

    // Edge falloff: dip outer band below terrain so the rectangular
    // plane edge vanishes under ground when the camera zooms out.
    float distFromCenter = length(position.xz);
    float edgeInner = uPlaneHalf * 0.65;
    float edgeOuter = uPlaneHalf * 0.95;
    float edgeT = smoothstep(edgeInner, edgeOuter, distFromCenter);
    float edgeDip = edgeT * ${EDGE_DIP_M.toFixed(1)};

    // Lift scales with danger — shallow near civic anchors, chest-deep
    // out in deep miasma, pulled back down inside guild beacon bubbles.
    // Smooth gradient because the danger field is smooth.
    float danger = dangerAt(worldXZ);
    float lift = mix(${LIFT_MIN_M.toFixed(2)}, ${LIFT_MAX_M.toFixed(2)}, danger);

    // Build final world Y from the heightmap sample directly.
    float terrainY = sampleTerrainY(worldXZ);
    float worldY = terrainY + lift + yMod + surfaceMod - edgeDip;

    vec4 worldPos = vec4(worldXZ.x, worldY, worldXZ.y, 1.0);
    vWorldXZ = worldXZ;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform float uTime;
  uniform vec3  uColor;
  uniform float uBaseAlpha;

  varying vec2 vWorldXZ;

  ${NOISE_GLSL}
  ${DANGER_GLSL}

  void main() {
    #include <logdepthbuf_fragment>

    // Same danger field the vertex shader uses to drive lift — high
    // out in deep miasma, zero inside civic safe zones and guild bubbles.
    float density = dangerAt(vWorldXZ);

    // Scrolling-noise wisp — two octaves moving in opposite directions.
    // Gives the fog texture and motion without looking tiled.
    float n1 = noise(vWorldXZ * 0.04 + vec2( uTime * 0.030,  uTime * 0.020));
    float n2 = noise(vWorldXZ * 0.10 + vec2(-uTime * 0.025,  uTime * 0.040));
    float wisp = mix(0.55, 1.30, n1 * 0.6 + n2 * 0.4);

    float alpha = density * wisp * uBaseAlpha;
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export class MiasmaGroundFog {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private heightmapTexture: THREE.DataTexture | null = null;
  /** Spacing between adjacent vertices in mesh-local metres. Mesh
   *  position snaps to multiples of this so the world-space vertex
   *  lattice is stable as the player walks — sub-cell mesh translations
   *  cause triangle-membership flips at terrain edges, which read as
   *  "the plane breaks underfoot." */
  private readonly vertexSpacing: number;

  constructor(
    private readonly scene: THREE.Scene,
    /** Per-axis subdivision count. Higher = finer terrain conform at
     *  the cost of vertex count. Driven by ClientConfig.miasmaQuality. */
    subdivisions: number = 128,
    /** Plane width/depth in metres. View distance for the fog. Driven
     *  by ClientConfig.miasmaRange. */
    planeSize: number = 1000,
  ) {
    this.vertexSpacing = planeSize / subdivisions;
    const geometry = new THREE.PlaneGeometry(planeSize, planeSize, subdivisions, subdivisions);
    geometry.rotateX(-Math.PI / 2);

    // Civic + guild uniforms initialised empty; populate via setters.
    const civicArr = new Array(MAX_CIVIC).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0));
    const guildArr = new Array(MAX_GUILD).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:             { value: 0 },
        uPlaneHalf:        { value: planeSize / 2 },
        uColor:            { value: new THREE.Color(0x4a554a) },
        uBaseAlpha:        { value: 0.55 },
        uCivicCount:       { value: 0 },
        uCivic:            { value: civicArr },
        uGuildCount:       { value: 0 },
        uGuild:            { value: guildArr },
        // Heightmap-as-texture — populated in setHeightmap. Until then,
        // uHeightmapValid = 0 and the vertex shader skips sampling.
        uHeightmap:        { value: null },
        uHeightmapSize:    { value: new THREE.Vector2(1, 1) },
        uHeightmapOrigin:  { value: new THREE.Vector2(0, 0) },
        uHeightmapCenter:  { value: new THREE.Vector2(0, 0) },
        uPixelSizeDeg:     { value: 1 },
        uMPerDeg:          { value: new THREE.Vector2(1, 1) },
        uHeightmapValid:   { value: 0 },
      },
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent:    true,
      depthWrite:     false,
      depthTest:      true,
      blending:       THREE.NormalBlending,
      side:           THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;  // before transparent overlays so they paint over fog
    scene.add(this.mesh);
  }

  /** Heightmap arrives async after zone load. Builds a single-channel
   *  Float32 DataTexture from the DEM and uploads it as a uniform — the
   *  vertex shader samples this per-frame to derive terrain Y in true
   *  world space, no JS resampling. */
  setHeightmap(hm: HeightmapService | null): void {
    // Drop any prior texture so successive zone loads don't leak GPU mem.
    this.heightmapTexture?.dispose();
    this.heightmapTexture = null;

    if (!hm) {
      this.material.uniforms['uHeightmap']!.value     = null;
      this.material.uniforms['uHeightmapValid']!.value = 0;
      return;
    }

    const inputs = hm.getShaderInputs();
    // Cast through unknown — Float32Array's buffer type widened to
    // ArrayBufferLike in newer TS, but DataTexture's typing still expects
    // the older BufferSource shape. The runtime is fine.
    const tex = new THREE.DataTexture(
      inputs.data as unknown as BufferSource,
      inputs.width,
      inputs.height,
      THREE.RedFormat,
      THREE.FloatType,
    );
    tex.minFilter   = THREE.LinearFilter;
    tex.magFilter   = THREE.LinearFilter;
    tex.wrapS       = THREE.ClampToEdgeWrapping;
    tex.wrapT       = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.heightmapTexture = tex;

    const u = this.material.uniforms;
    u['uHeightmap']!.value     = tex;
    (u['uHeightmapSize']!.value   as THREE.Vector2).set(inputs.width, inputs.height);
    (u['uHeightmapOrigin']!.value as THREE.Vector2).set(inputs.originLat, inputs.originLon);
    (u['uHeightmapCenter']!.value as THREE.Vector2).set(inputs.centerLat, inputs.centerLon);
    (u['uMPerDeg']!.value         as THREE.Vector2).set(inputs.mPerDegLat, inputs.mPerDegLon);
    u['uPixelSizeDeg']!.value     = inputs.pixelSizeDeg;
    u['uHeightmapValid']!.value   = 1;
  }

  /** Civic anchor list — call when zone changes (after WardBeaconManager
   *  finishes its fetch). Anchors beyond MAX_CIVIC are dropped silently. */
  setCivicAnchors(list: AnchorEntry[]): void {
    const arr = this.material.uniforms['uCivic']!.value as THREE.Vector4[];
    const n = Math.min(list.length, MAX_CIVIC);
    for (let i = 0; i < n; i++) {
      const a = list[i]!;
      arr[i]!.set(a.x, a.z, a.r, 0);
    }
    this.material.uniforms['uCivicCount']!.value = n;
  }

  /** Guild beacon list — call on zone change AND on live placement so the
   *  newly-placed beacon's bubble immediately clears the fog around it. */
  setGuildBeacons(list: AnchorEntry[]): void {
    const arr = this.material.uniforms['uGuild']!.value as THREE.Vector4[];
    const n = Math.min(list.length, MAX_GUILD);
    for (let i = 0; i < n; i++) {
      const b = list[i]!;
      arr[i]!.set(b.x, b.z, b.r, 0);
    }
    this.material.uniforms['uGuildCount']!.value = n;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  /** Drive shader time + player uniform, and snap the mesh to the
   *  vertex-spacing-quantised player position. Snapping (instead of
   *  raw `playerX`) means the world-space vertex lattice is stable —
   *  it shifts in whole-cell increments rather than sub-cell jitter,
   *  so triangle membership at terrain edges is consistent and the
   *  visible fog edges don't break as you walk. The inner-band climb
   *  still tracks smoothly because uPlayerXZ is the raw player pos. */
  update(dt: number, playerX: number, playerZ: number): void {
    (this.material.uniforms['uTime']!.value as number) += dt;

    const snappedX = Math.round(playerX / this.vertexSpacing) * this.vertexSpacing;
    const snappedZ = Math.round(playerZ / this.vertexSpacing) * this.vertexSpacing;
    this.mesh.position.set(snappedX, 0, snappedZ);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightmapTexture?.dispose();
    this.heightmapTexture = null;
  }
}
