import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * MiasmaBoundaryWall — vertical "wall" of swirly miasma along the
 * zone boundary ring.
 *
 * Purely visual cue ("here be lethal aether"). The lethal damage system
 * runs server-side independently — this just makes the wall LEGIBLE so
 * players can see where it is before they wander into it.
 *
 * Implementation:
 *   - Open-ended CylinderGeometry at the zone radius, ~40m tall.
 *   - Terrain-conformed in the vertex shader (samples the same heightmap
 *     uniform MiasmaGroundFog uses) so the wall sits ~10m below ground
 *     and ~30m above terrain at every point along the ring. Without
 *     this, hills/valleys at the perimeter would visibly float or bury.
 *   - Fragment shader mixes black + purple + green via scrolling 2-octave
 *     noise — gives the "swirling miasma" look at all distances.
 *   - Alpha tapers at the top of the wall so it doesn't look like a
 *     hard ceiling; tapers gently at the bottom too in case the camera
 *     sees the underground section through a steep gulley.
 *   - DoubleSide so the wall remains visible when the player crosses
 *     past it (lethal territory), even though they probably won't last
 *     long out there.
 */

const RADIAL_SEGMENTS    = 256;
const HEIGHT_SEGMENTS    = 4;
const HEIGHT_BELOW_TERRAIN = 10;
const HEIGHT_ABOVE_TERRAIN = 30;
const TOTAL_HEIGHT       = HEIGHT_BELOW_TERRAIN + HEIGHT_ABOVE_TERRAIN;

const NOISE_GLSL = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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

const VERTEX_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform sampler2D uHeightmap;
  uniform vec2  uHeightmapSize;
  uniform vec2  uHeightmapOrigin;
  uniform float uPixelSizeDeg;
  uniform vec2  uHeightmapCenter;
  uniform vec2  uMPerDeg;
  uniform float uHeightmapValid;

  varying vec2  vUv;
  varying vec3  vWorldPos;

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
    vec2 worldXZ = position.xz;
    float terrainY = sampleTerrainY(worldXZ);
    float worldY = terrainY + position.y;

    vUv       = uv;
    vWorldPos = vec3(worldXZ.x, worldY, worldXZ.y);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldXZ.x, worldY, worldXZ.y, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform float uTime;
  uniform float uBaseAlpha;

  varying vec2  vUv;
  varying vec3  vWorldPos;

  ${NOISE_GLSL}

  // Domain-warped FBM — gives genuinely swirly turbulence rather than
  // blobby smooth noise. Each octave adds half the amplitude at twice
  // the frequency; the warp offset (q) bends streaks into curves.
  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) {
      v += amp * noise(p);
      p *= 2.0;
      amp *= 0.5;
    }
    return v;
  }

  float swirlyNoise(vec2 p, float t) {
    // Domain warp — feeds an FBM lookup into another, creating curl-like
    // streaks. Without this, FBM looks like wood grain; with it, swirls.
    vec2 q = vec2(
      fbm(p + vec2(0.0, t * 0.15)),
      fbm(p + vec2(5.2, 1.3) - vec2(t * 0.10, 0.0))
    );
    return fbm(p + q * 1.5);
  }

  void main() {
    #include <logdepthbuf_fragment>

    // World-aligned noise coords. As the cylinder bends, the noise stays
    // anchored in world space — swirl features line up across the surface
    // rather than tiling around the cylinder. Frequency tuned for ~2m
    // feature size (uMain coords go ~0.5/m).
    vec2 uMain   = vec2(vWorldPos.x, vWorldPos.z) * 0.18 + vec2(0.0, vWorldPos.y * 0.22);
    vec2 uDetail = vec2(vWorldPos.x, vWorldPos.z) * 0.55 + vec2(0.0, vWorldPos.y * 0.55);

    float swirl  = swirlyNoise(uMain, uTime);
    float detail = fbm(uDetail + vec2(uTime * 0.08, -uTime * 0.05));

    // Colors — near-black base + purple + sickly green swirls. Tightened
    // smoothstep bands so streaks stay narrow against the black field.
    vec3 baseColor   = vec3(0.04, 0.02, 0.06);
    vec3 purpleSwirl = vec3(0.35, 0.10, 0.55);
    vec3 greenSwirl  = vec3(0.18, 0.42, 0.16);

    float purpleW = smoothstep(0.48, 0.70, swirl);
    float greenW  = smoothstep(0.52, 0.80, swirl * 0.5 + detail * 0.5);

    vec3 col = baseColor + purpleSwirl * purpleW + greenSwirl * greenW;

    // Vertical alpha — solid mid, taper at top + bottom. UV.y still drives
    // this since "top of wall" is a cylinder-local concept.
    float bottomFade = smoothstep(0.00, 0.18, vUv.y);
    float topFade    = 1.0 - smoothstep(0.55, 1.00, vUv.y);

    // Wisp factor — modulated by the swirl so the wall feels alive.
    float wisp = mix(0.55, 1.10, swirl);

    float alpha = uBaseAlpha * topFade * bottomFade * wisp;
    if (alpha < 0.005) discard;

    gl_FragColor = vec4(col, alpha);
  }
`;

export class MiasmaBoundaryWall {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private heightmapTexture: THREE.DataTexture | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    /** Zone playable-circle radius in metres. Cylinder is built at this
     *  radius around world origin (0, 0, 0). */
    radius: number,
  ) {
    const geometry = new THREE.CylinderGeometry(
      radius, radius,
      TOTAL_HEIGHT,
      RADIAL_SEGMENTS,
      HEIGHT_SEGMENTS,
      true, // openEnded — no top/bottom caps
    );
    // Shift so local Y ranges [-HEIGHT_BELOW, +HEIGHT_ABOVE]. With this
    // baked in, the vertex shader adds terrainY to position.y directly.
    geometry.translate(0, (HEIGHT_ABOVE_TERRAIN - HEIGHT_BELOW_TERRAIN) / 2, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:            { value: 0 },
        uBaseAlpha:       { value: 0.85 },
        uHeightmap:       { value: null },
        uHeightmapSize:   { value: new THREE.Vector2(1, 1) },
        uHeightmapOrigin: { value: new THREE.Vector2(0, 0) },
        uHeightmapCenter: { value: new THREE.Vector2(0, 0) },
        uPixelSizeDeg:    { value: 1 },
        uMPerDeg:         { value: new THREE.Vector2(1, 1) },
        uHeightmapValid:  { value: 0 },
      },
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent:    true,
      depthWrite:     false,
      depthTest:      true,
      side:           THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    // Wall is built around world origin and stays there for the zone's
    // lifetime. No per-frame movement; just the time uniform.
    this.mesh.frustumCulled = false;
    // Render after opaque geometry so depth-test culls the section
    // behind hills, but stays in front of skybox / fog plane (which
    // renders at renderOrder = -1).
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /** Bind a heightmap so the wall conforms to terrain. Mirrors the
   *  pattern in MiasmaGroundFog — same uniforms, same sample math. */
  setHeightmap(hm: HeightmapService | null): void {
    this.heightmapTexture?.dispose();
    this.heightmapTexture = null;

    if (!hm) {
      this.material.uniforms['uHeightmap']!.value      = null;
      this.material.uniforms['uHeightmapValid']!.value = 0;
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
    tex.minFilter       = THREE.LinearFilter;
    tex.magFilter       = THREE.LinearFilter;
    tex.wrapS           = THREE.ClampToEdgeWrapping;
    tex.wrapT           = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate     = true;
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

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  update(dt: number): void {
    (this.material.uniforms['uTime']!.value as number) += dt;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightmapTexture?.dispose();
    this.heightmapTexture = null;
  }
}
