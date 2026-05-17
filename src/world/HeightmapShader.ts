import * as THREE from 'three';
import type { HeightmapService } from './HeightmapService';

/**
 * HeightmapShader — shared GLSL chunks and uniform plumbing for any
 * ShaderMaterial that wants its vertices to conform to the rendered
 * terrain surface.
 *
 * Mirrors the technique pioneered by MiasmaGroundFog: the DEM is uploaded
 * once as a single-channel Float32 DataTexture and sampled in the vertex
 * shader to derive each vertex's world Y from its world XZ. The same
 * DataTexture is shared across every material that wires up here (cached
 * per HeightmapService via WeakMap) so we don't burn GPU memory per
 * indicator.
 *
 * Usage from a custom material:
 *   const uniforms = { ...heightmapUniforms(), ...your uniforms };
 *   const vertexShader = `
 *     #include <common>
 *     #include <logdepthbuf_pars_vertex>
 *     ${HEIGHTMAP_VERTEX_PARS}
 *     void main() {
 *       vec4 worldBase = modelMatrix * vec4(position, 1.0);
 *       float y        = conformedWorldY(worldBase);
 *       gl_Position = projectionMatrix * viewMatrix * vec4(worldBase.x, y, worldBase.z, 1.0);
 *       #include <logdepthbuf_vertex>
 *     }
 *   `;
 *   // After material construction:
 *   wireHeightmap(material, hm);    // call again when zone changes
 *
 * When the heightmap is unbound (vault interior, initial frame before zone
 * load), `conformedWorldY` falls back to whatever Y the mesh's world matrix
 * already supplies — so callers can set `mesh.position.y` to the entity's
 * reported Y and the indicator still sits at the right height.
 */

/** GLSL chunk for the vertex shader: declares the heightmap uniforms and
 *  exposes two helpers:
 *    - `sampleTerrainY(vec2 worldXZ)` — DEM lookup with explicit bilinear
 *      interpolation. Returns 0 outside bounds / when no DEM is bound.
 *    - `conformedWorldY(vec4 worldBase)` — terrain Y + uYLift when DEM is
 *      bound, else worldBase.y + uYLift. This is the one most callers want.
 *
 *  Why explicit bilinear instead of relying on `LinearFilter` on the
 *  DataTexture: linear filtering of float textures requires the WebGL
 *  extension OES_texture_float_linear, which is widely but NOT universally
 *  available. When unsupported the driver silently falls back to nearest
 *  filtering — on terrain with ~30 m DEM pixels and a slope this puts each
 *  vertex at the wrong elevation by up to ~1 m, which is exactly what the
 *  pre-fix indicators showed. Doing the bilinear ourselves with four
 *  point-sampled fetches is portable and matches the CPU-side
 *  `HeightmapService.getElevation()` math exactly. */
export const HEIGHTMAP_VERTEX_PARS = /* glsl */`
  uniform sampler2D uHeightmap;
  uniform vec2  uHeightmapSize;
  uniform vec2  uHeightmapOrigin;
  uniform float uPixelSizeDeg;
  uniform vec2  uHeightmapCenter;
  uniform vec2  uMPerDeg;
  uniform float uHeightmapValid;
  uniform float uYLift;
  /** Smoothing neighbourhood radius in metres. 0 disables smoothing (pure
   *  bilinear at the vertex). >0 takes a 5-tap sample (centre + 4 cardinals
   *  at this radius) and blends average→max so the conform follows the
   *  overall slope while trending slightly above per-pixel DEM features —
   *  the indicator stays "flat-ish, a little wavy" instead of jagged. */
  uniform float uConformSmoothRadius;
  /** Height (metres) the interior of a beveled indicator sits above its
   *  edges. Vertex shaders that consume this should add aBevelMask *
   *  uBevelHeight to the conformed Y, where aBevelMask is a per-vertex
   *  attribute = 0 at the geometry's perimeter and 1 in its interior. The
   *  slope between the two hides per-vertex Y jitter that would otherwise
   *  read as a buzzing edge. */
  uniform float uBevelHeight;

  // Miasma uplift — replicates MiasmaGroundFog's danger calc per vertex so
  // an indicator rises above the fog inside corruption patches and settles
  // back to the terrain in civic safe zones / guild bubbles. Vertices on a
  // boundary blend smoothly because the danger field is smooth, giving the
  // "walk in/out of patches" transition. Shared anchor arrays are mutated
  // in-place by setMiasmaAnchors; sentinel is anchor radius <= 0 (slot unused).
  uniform vec4  uMiasmaCivic[8];   // xy = world XZ, z = wardRadius, w unused
  uniform vec4  uMiasmaGuild[64];  // xy = world XZ, z = effectRadius, w unused
  /** Extra metres above the miasma's modeled Y the indicator should sit, on
   *  top of uYLift. Covers MiasmaGroundFog's surface-noise + big-roll
   *  amplitude (~0.5 m peak) so the indicator clears the visible fog wave. */
  uniform float uMiasmaClearance;

  // Point-sample a single texel by integer (col, row). +0.5 lands us on the
  // pixel centre so a NearestFilter texture returns the exact stored value.
  float _texelAt(float col, float row) {
    vec2 uv = (vec2(col, row) + 0.5) / uHeightmapSize;
    return texture2D(uHeightmap, uv).r;
  }

  // CPU-equivalent bilinear sample: identical math to
  // HeightmapService._sampleBilinear so a vertex's world Y matches the value
  // an entity's CPU-side position.y was snapped to.
  float _sampleBilinear(float col, float row) {
    float c0 = floor(col);
    float r0 = floor(row);
    // Clamp so c0+1 / r0+1 never exceed the last pixel (matches CPU).
    c0 = clamp(c0, 0.0, uHeightmapSize.x - 2.0);
    r0 = clamp(r0, 0.0, uHeightmapSize.y - 2.0);
    float fx = col - c0;
    float fy = row - r0;
    float q11 = _texelAt(c0,     r0);
    float q21 = _texelAt(c0+1.0, r0);
    float q12 = _texelAt(c0,     r0+1.0);
    float q22 = _texelAt(c0+1.0, r0+1.0);
    return (q11*(1.0-fx) + q21*fx) * (1.0-fy)
         + (q12*(1.0-fx) + q22*fx) * fy;
  }

  // Returns true and fills outValue with the bilinear sample at worldXZ.
  // Returns false when no DEM is bound or the sample is OOB.
  bool _bilinearAtWorld(vec2 worldXZ, out float outValue) {
    if (uHeightmapValid < 0.5) { outValue = 0.0; return false; }
    float lat = uHeightmapCenter.x - worldXZ.y / uMPerDeg.x;
    float lon = uHeightmapCenter.y + worldXZ.x / uMPerDeg.y;
    float col = (lon - uHeightmapOrigin.y) / uPixelSizeDeg;
    float row = (uHeightmapOrigin.x - lat) / uPixelSizeDeg;
    if (col < 0.0 || row < 0.0 || col >= uHeightmapSize.x || row >= uHeightmapSize.y) {
      outValue = 0.0;
      return false;
    }
    outValue = _sampleBilinear(col, row);
    return true;
  }

  float sampleTerrainY(vec2 worldXZ) {
    float v;
    _bilinearAtWorld(worldXZ, v);
    return v;     // 0.0 when OOB / no DEM, matching prior behaviour
  }

  // 5-tap smoothed sample: centre + 4 cardinals at the given radius metres. Returns
  // mix(average, max, 0.7) — biased toward the upper envelope so the result
  // follows the overall slope while trending slightly above per-pixel DEM
  // features. Neighbour samples that land OOB fall back to the centre value
  // so we don't drag the average to zero near zone edges.
  float _sampleConformedSmooth(vec2 worldXZ, float radius, float centerValue) {
    float n, s, e, w;
    if (!_bilinearAtWorld(worldXZ + vec2(0.0, -radius), n)) n = centerValue;
    if (!_bilinearAtWorld(worldXZ + vec2(0.0,  radius), s)) s = centerValue;
    if (!_bilinearAtWorld(worldXZ + vec2( radius, 0.0), e)) e = centerValue;
    if (!_bilinearAtWorld(worldXZ + vec2(-radius, 0.0), w)) w = centerValue;
    float avg = (centerValue + n + s + e + w) * 0.2;
    float mx  = max(max(centerValue, max(n, s)), max(e, w));
    return mix(avg, mx, 0.7);
  }

  // Replicates MiasmaGroundFog.dangerAt with anchor-radius-as-sentinel:
  // an anchor slot with z (radius) <= 0 means "unused" and is skipped.
  // Returns danger in [0, 1] (0 = safe, 1 = deep miasma). Early-out when
  // no anchors are configured (zone with no miasma / pre-zone-load) saves
  // 72 distance computations per vertex.
  float _miasmaDangerAt(vec2 worldXZ) {
    if (uMiasmaCivic[0].z <= 0.0 && uMiasmaGuild[0].z <= 0.0) return 0.0;
    float civicFreedom = 0.0;
    for (int i = 0; i < 8; i++) {
      float r = uMiasmaCivic[i].z;
      if (r <= 0.0) continue;
      vec2  c = uMiasmaCivic[i].xy;
      float d = distance(worldXZ, c);
      float f = 1.0 - smoothstep(r, r * 2.0, d);
      civicFreedom = max(civicFreedom, f);
    }
    float baseMiasma = 1.0 - civicFreedom;
    float guildPushback = 0.0;
    for (int i = 0; i < 64; i++) {
      float r = uMiasmaGuild[i].z;
      if (r <= 0.0) continue;
      vec2  c = uMiasmaGuild[i].xy;
      float d = distance(worldXZ, c);
      float push = 1.0 - smoothstep(r * 0.7, r, d);
      guildPushback = max(guildPushback, push);
    }
    return max(0.0, baseMiasma - guildPushback);
  }

  // Returns the world Y a vertex should sit at after conforming. Falls back
  // to the mesh's own Y when the DEM is unbound (vault) or the vertex is
  // outside DEM bounds (zone edge) — so a CPU-side mesh.position.y set to
  // the entity's reported Y still keeps the indicator at the right height
  // in those cases.
  //
  // Surface rule:
  //   terrainY = max(smoothed conform, raw bilinear at this XZ)
  //   vertex Y = terrainY + uYLift
  //
  // The max() clamp prevents the smoothing's avg-pull from dragging peak
  // vertices below the actual ground (depthTest would otherwise bury them).
  //
  // No miasma uplift: lifting the indicator above the fog plane visually
  // worked out to ~0.5 m float in moderate-danger areas. The "occluded by
  // fog" issue is better solved at the render-order / blending level (fog
  // renders before indicators, fog doesn't write depth, indicators draw
  // after and alpha-blend on top). _miasmaDangerAt + the uMiasma* uniforms
  // stay declared in case we need them again, but are not used here.
  float conformedWorldY(vec4 worldBase) {
    float center;
    if (!_bilinearAtWorld(worldBase.xz, center)) return worldBase.y + uYLift;
    float smoothed = uConformSmoothRadius <= 0.001
      ? center
      : _sampleConformedSmooth(worldBase.xz, uConformSmoothRadius, center);
    float terrainY = max(smoothed, center);
    return terrainY + uYLift;
  }
`;

/** Build the uniforms object pre-populated with the right types but no DEM
 *  bound (uHeightmapValid = 0). Spread into your material's `uniforms`.
 *  `smoothRadius` (metres) controls the 5-tap neighbourhood used to smooth
 *  the conform — pick a value comparable to the indicator's own footprint
 *  so per-pixel DEM features get filtered out without losing slope
 *  information. 0 disables smoothing. `bevelHeight` (metres) is the height
 *  the indicator's interior sits above its edges — geometry attributes
 *  named `aBevelMask` (0 at perimeter, 1 in interior) drive the slope,
 *  giving the indicator a low-profile "plate" look that hides per-vertex
 *  Y jitter at the visible edge.
 *
 *  The miasma anchor arrays are SHARED by reference across every material
 *  this factory produces — setMiasmaAnchors mutates them in place and every
 *  material sees the update on its next render. No per-material registry
 *  needed; the slot's radius doubles as the "used" sentinel. */
export function heightmapUniforms(
  yLift = 0.01,
  smoothRadius = 100,
  bevelHeight = 0.25,
): Record<string, { value: unknown }> {
  return {
    uHeightmap:            { value: null },
    uHeightmapSize:        { value: new THREE.Vector2(1, 1) },
    uHeightmapOrigin:      { value: new THREE.Vector2(0, 0) },
    uHeightmapCenter:      { value: new THREE.Vector2(0, 0) },
    uMPerDeg:              { value: new THREE.Vector2(1, 1) },
    uPixelSizeDeg:         { value: 1 },
    uHeightmapValid:       { value: 0 },
    uYLift:                { value: yLift },
    uConformSmoothRadius:  { value: smoothRadius },
    uBevelHeight:          { value: bevelHeight },
    uMiasmaCivic:          { value: _miasmaCivic },
    uMiasmaGuild:          { value: _miasmaGuild },
    // Small lift above the (already noise-sampled) fog surface so the
    // indicator reads as "sitting on" the fog, not buried in it. We sample
    // the actual fog surface now (incl. noise), so this is just a clearance
    // gap, not a peak-amplitude cover.
    uMiasmaClearance:      { value: 0.01 },
  };
}

// ── Miasma anchor sharing ───────────────────────────────────────────────────

const _MIASMA_MAX_CIVIC = 8;
const _MIASMA_MAX_GUILD = 64;

/** Shared anchor arrays — same JS reference is held by every conforming
 *  material's uMiasmaCivic/uMiasmaGuild uniform. Slots are populated from
 *  index 0; unused slots have radius (.z) = 0, which the shader treats as
 *  the "skip me" sentinel. */
const _miasmaCivic = Array.from({ length: _MIASMA_MAX_CIVIC }, () => new THREE.Vector4(0, 0, 0, 0));
const _miasmaGuild = Array.from({ length: _MIASMA_MAX_GUILD }, () => new THREE.Vector4(0, 0, 0, 0));

export interface MiasmaAnchor { x: number; z: number; r: number }

/** Replace the active civic + guild anchor lists used by every conforming
 *  indicator's miasma-uplift calc. Call alongside MiasmaGroundFog's own
 *  setCivicAnchors / setGuildBeacons — same payload, same cadence. */
export function setMiasmaAnchors(civic: MiasmaAnchor[], guild: MiasmaAnchor[]): void {
  const civicN = Math.min(civic.length, _MIASMA_MAX_CIVIC);
  for (let i = 0; i < civicN; i++) {
    const a = civic[i]!;
    _miasmaCivic[i]!.set(a.x, a.z, a.r, 0);
  }
  for (let i = civicN; i < _MIASMA_MAX_CIVIC; i++) {
    _miasmaCivic[i]!.set(0, 0, 0, 0);
  }
  const guildN = Math.min(guild.length, _MIASMA_MAX_GUILD);
  for (let i = 0; i < guildN; i++) {
    const a = guild[i]!;
    _miasmaGuild[i]!.set(a.x, a.z, a.r, 0);
  }
  for (let i = guildN; i < _MIASMA_MAX_GUILD; i++) {
    _miasmaGuild[i]!.set(0, 0, 0, 0);
  }
}

/** Cached DataTexture per HeightmapService instance — one upload to GPU,
 *  many consuming materials. The cache is a WeakMap so when a zone-load
 *  drops its HeightmapService, the texture entry becomes garbage-collectable
 *  alongside it. */
const _textureCache = new WeakMap<HeightmapService, THREE.DataTexture>();

function _getOrCreateTexture(hm: HeightmapService): THREE.DataTexture {
  const cached = _textureCache.get(hm);
  if (cached) return cached;
  const inputs = hm.getShaderInputs();
  const tex = new THREE.DataTexture(
    inputs.data as unknown as BufferSource,
    inputs.width,
    inputs.height,
    THREE.RedFormat,
    THREE.FloatType,
  );
  // NearestFilter — explicit. LinearFilter on float textures requires
  // OES_texture_float_linear, which silently falls back to nearest on
  // GPUs without the extension. We do bilinear ourselves in the shader
  // (see HEIGHTMAP_VERTEX_PARS comment), so nearest at the texture level
  // is what we want regardless of GPU capability.
  tex.minFilter      = THREE.NearestFilter;
  tex.magFilter      = THREE.NearestFilter;
  tex.wrapS          = THREE.ClampToEdgeWrapping;
  tex.wrapT          = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate    = true;
  _textureCache.set(hm, tex);
  return tex;
}

/** Point a material's heightmap uniforms at the given HeightmapService (or
 *  clear them if `hm` is null). Idempotent and cheap to re-call. */
export function wireHeightmap(material: THREE.ShaderMaterial, hm: HeightmapService | null): void {
  const u = material.uniforms;
  if (!u['uHeightmapValid']) return;     // material doesn't conform — silently ignore
  if (!hm) {
    u['uHeightmap']!.value      = null;
    u['uHeightmapValid']!.value = 0;
    return;
  }
  const tex    = _getOrCreateTexture(hm);
  const inputs = hm.getShaderInputs();
  u['uHeightmap']!.value      = tex;
  (u['uHeightmapSize']!.value   as THREE.Vector2).set(inputs.width, inputs.height);
  (u['uHeightmapOrigin']!.value as THREE.Vector2).set(inputs.originLat, inputs.originLon);
  (u['uHeightmapCenter']!.value as THREE.Vector2).set(inputs.centerLat, inputs.centerLon);
  (u['uMPerDeg']!.value         as THREE.Vector2).set(inputs.mPerDegLat, inputs.mPerDegLon);
  u['uPixelSizeDeg']!.value     = inputs.pixelSizeDeg;
  u['uHeightmapValid']!.value   = 1;
}
