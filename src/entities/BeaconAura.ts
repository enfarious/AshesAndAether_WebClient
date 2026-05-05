import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * BeaconAura — translucent ground disc + dome marking a beacon's safe zone.
 *
 * Visual goals (driven by playtest design dialog 2026-04-30):
 *   - Ground disc conforms to heightmap so it doesn't clip into terrain
 *   - Edge of disc is brighter than middle → reads as "you're crossing
 *     the boundary" when you walk in or out
 *   - Guild beacons get an additional center "gathering glow" so the
 *     beacon foot reads as a meeting place; disposables don't
 *   - Dome rises above the disc, sits well above tree-tops on guilds so
 *     the bubble is visible from far away (drives inter-guild scouting)
 *   - Two-layer scrolling noise gives the whole thing a wispy, breathing
 *     look without per-frame CPU cost — uniform-driven shader animation
 *   - Disposables can `setBurnFraction(0..1)` to dim alpha as fuel drains
 *
 * Subdivision count comes from ClientConfig.beaconDetail at construction
 * time. Rebuilding on setting change is the renderer's job (call
 * `rebuild()` after toggling the setting on existing auras).
 */

export type AuraMode = 'guild' | 'disposable';

export interface BeaconAuraOptions {
  scene:        THREE.Scene;
  /** Beacon foot in world coords. Y is the terrain height at the beacon. */
  position:     THREE.Vector3;
  /** Pushback effect radius (m). 100 for guild, ~30-40 for disposable. */
  radius:       number;
  /** Top of the dome, in metres above `position.y`. */
  domeHeight:   number;
  mode:         AuraMode;
  /** Aura tint — should match the parent beacon's mesh color so the
   *  ground ring + dome read as part of the same effect. */
  color:        THREE.Color;
  /** Returns the THREE objects to raycast against when finding terrain
   *  Y for disc vertices. Should resolve to the terrain root (worldRoot
   *  in the app). Without this, raycasts hit anything opaque — including
   *  tree canopies — and the disc drapes over the forest instead of the
   *  ground. Falls back to scene-wide raycast (with transparent
   *  filtering) when null/undefined. */
  getRaycastTargets?: () => THREE.Object3D[] | null;
}

/** Set true to force the disc to render fully opaque, bypassing the
 *  radial+noise alpha calc — useful when debugging visibility issues
 *  (raycast picking the wrong hit, geometry not reaching render, etc). */
const DEBUG_OPAQUE_DISC = false;

// Vertex shader — pass world XZ to fragment for noise sampling, plus the
// vertex's normalised radial position (0 at center, 1 at edge) and
// normalised dome height (0 at floor, 1 at apex; always 0 for the disc).
//
// Includes THREE's logdepthbuf chunks because the renderer uses
// `logarithmicDepthBuffer: true`. Without these, gl_Position.z is in the
// wrong depth space and depth tests fail for every fragment — the disc
// became completely invisible with depthTest=true even though geometry,
// scene tree, and material were all fine.
const VERTEX_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec2  vWorldXZ;
  varying float vRadialT;
  varying float vDomeT;

  attribute float aRadialT;
  attribute float aDomeT;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ  = worldPos.xz;
    vRadialT  = aRadialT;
    vDomeT    = aDomeT;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

// Fragment shader — radial alpha shape + scrolling noise + dome falloff.
// Noise is two layers of value-noise sampled at world XZ, scrolled in
// opposite directions so they interfere into wispy structure without
// looking tiled.
const FRAGMENT_SHADER = `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3  uColor;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uMode;       // 0.0 = disposable, 1.0 = guild
  uniform float uIsDome;     // 0.0 = disc, 1.0 = dome

  varying vec2  vWorldXZ;
  varying float vRadialT;
  varying float vDomeT;

  // Cheap value noise — adequate for atmospheric wispiness, no need for
  // simplex/perlin quality at this scale.
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

  void main() {
    #include <logdepthbuf_fragment>

    // DEBUG path — forces disc to render fully opaque to verify it's
    // actually showing up. Set DEBUG_OPAQUE_DISC=false on the JS side to
    // disable. Only affects the disc; dome path runs normally so we can
    // still iterate on it.
    #if defined(DEBUG_OPAQUE_DISC)
    if (uIsDome < 0.5) {
      gl_FragColor = vec4(uColor, 0.85);
      return;
    }
    #endif

    // Radial alpha shape:
    //   Disposable: edge-bright only — smoothstep ramp from 70% out to edge.
    //   Guild:      edge-bright PLUS a center "gathering glow" that fades
    //               between 0% and 25% radius. The two terms don't quite
    //               touch, so the middle band stays soft and you still
    //               feel safe-ish without it dominating.
    float edge   = smoothstep(0.70, 0.96, vRadialT) * 1.0;
    float center = (1.0 - smoothstep(0.0, 0.28, vRadialT)) * 0.55 * uMode;
    float radial = max(edge, center);

    // Dome: "fountain" gradient — brightest at apex (where the beam's
    // light crests and spills outward), fading completely to zero before
    // it hits the ground. The bottom ~30% is cut so the dome reads as a
    // luminous cap floating above the bubble, not a solid hemisphere.
    //
    // Plus an energy-cascade: bright bands traveling down the dome
    // surface over time, perturbed by a slow noise field so the bands
    // curve, break, and reform instead of marching as perfect stripes.
    // Creates the "wonky energy" feel — same fountain motion, less
    // mechanical.
    if (uIsDome > 0.5) {
      float fountain = smoothstep(0.30, 1.0, vDomeT);      // 0 below 30%, 1 at apex
      // Distortion field — sampled at world XZ + dome height so bands
      // chaotic but stable as the camera moves. Time only drifts the
      // X axis of the sample, keeping the structure recognisable
      // turn-to-turn while still evolving.
      float bandPerturb = noise(vWorldXZ * 0.04 + vec2(uTime * 0.18, vDomeT * 3.0)) * 1.1;
      float bandPhase   = vDomeT * 8.0 + uTime * 0.45 + bandPerturb;
      float cascade     = sin(bandPhase * 6.2831853) * 0.5 + 0.5;
      cascade           = pow(cascade, 3.0);                // sharpen ridges, soften troughs
      // Mix: 55% steady fountain glow + 45% cascading shimmer so the
      // dome doesn't strobe — base brightness with traveling highlights.
      radial = fountain * (0.55 + 0.45 * cascade);
    }

    // Scrolling-noise layers — two octaves drifting in opposite directions
    // through world space. Phase offset by uTime so adjacent beacons
    // don't visibly march in sync.
    float n1 = noise(vWorldXZ * 0.05 + vec2( uTime * 0.06,  uTime * 0.03));
    float n2 = noise(vWorldXZ * 0.13 + vec2(-uTime * 0.04, -uTime * 0.07));
    float wisp = mix(0.55, 1.30, (n1 * 0.6 + n2 * 0.4));

    float alpha = radial * wisp * uIntensity;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

interface BuiltMesh {
  mesh:     THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class BeaconAura {
  private discMesh: BuiltMesh | null = null;
  private domeMesh: BuiltMesh | null = null;
  private rootGroup: THREE.Group;
  private intensity = 1.0;
  private subdivisions: { radial: number; rings: number };

  constructor(private readonly opts: BeaconAuraOptions) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.position.copy(opts.position);
    this.subdivisions = ClientConfig.beaconSubdivisions();
    this._buildAll();
    opts.scene.add(this.rootGroup);
  }

  /** Rebuild geometry — call after the player changes beacon detail in
   *  Settings, or after the terrain heightmap finishes loading so disc
   *  vertices snap onto the actual surface. */
  rebuild(): void {
    this._teardown();
    this.subdivisions = ClientConfig.beaconSubdivisions();
    this._buildAll();
  }

  /** Drive shader time uniforms. Call from the manager's update tick. */
  update(dt: number): void {
    if (this.discMesh) {
      const u = this.discMesh.material.uniforms;
      if (u) {
        (u['uTime']!.value as number) += dt;
        u['uIntensity']!.value = this.intensity;
      }
    }
    if (this.domeMesh) {
      const u = this.domeMesh.material.uniforms;
      if (u) {
        (u['uTime']!.value as number) += dt;
        u['uIntensity']!.value = this.intensity;
      }
    }
  }

  /** Disposable beacons fade as fuel drains. 1.0 = full, 0.0 = burnt out.
   *  Has no effect on guild auras (they're full intensity until pulled). */
  setBurnFraction(fraction: number): void {
    this.intensity = Math.max(0, Math.min(1, fraction));
  }

  setVisible(visible: boolean): void {
    this.rootGroup.visible = visible;
  }

  /** Move the aura — disc + dome — to a new world position. Disc vertices
   *  re-raycast onto terrain at the new spot. */
  reposition(position: THREE.Vector3): void {
    this.rootGroup.position.copy(position);
    this.rebuild();
  }

  dispose(): void {
    this._teardown();
    this.opts.scene.remove(this.rootGroup);
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  private _buildAll(): void {
    this.discMesh = this._buildDisc();
    this.rootGroup.add(this.discMesh.mesh);
    this.domeMesh = this._buildDome();
    this.rootGroup.add(this.domeMesh.mesh);
  }

  private _teardown(): void {
    if (this.discMesh) {
      this.rootGroup.remove(this.discMesh.mesh);
      this.discMesh.mesh.geometry.dispose();
      this.discMesh.material.dispose();
      this.discMesh = null;
    }
    if (this.domeMesh) {
      this.rootGroup.remove(this.domeMesh.mesh);
      this.domeMesh.mesh.geometry.dispose();
      this.domeMesh.material.dispose();
      this.domeMesh = null;
    }
  }

  /** Construct a disc with `radial × rings` vertices (plus a center
   *  vertex), each raycast onto whatever scene geometry sits below it.
   *  Vertices at radial position r/rings live at distance r * stride
   *  from the center. */
  private _buildDisc(): BuiltMesh {
    const { radial, rings } = this.subdivisions;
    const radius = this.opts.radius;
    const ringStride = radius / rings;


    const vertCount = 1 + radial * rings;
    const positions = new Float32Array(vertCount * 3);
    const radialT   = new Float32Array(vertCount);
    const domeT     = new Float32Array(vertCount); // all 0 for disc

    // Center vertex
    const centerY = this._raycastGroundOffsetY(0, 0);
    positions[0] = 0; positions[1] = centerY; positions[2] = 0;
    radialT[0] = 0;

    // Concentric rings
    for (let r = 1; r <= rings; r++) {
      const dist = r * ringStride;
      const t = r / rings;
      for (let s = 0; s < radial; s++) {
        const angle = (s / radial) * Math.PI * 2;
        const x = Math.cos(angle) * dist;
        const z = Math.sin(angle) * dist;
        const y = this._raycastGroundOffsetY(x, z);
        const idx = 1 + (r - 1) * radial + s;
        positions[idx * 3]     = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;
        radialT[idx] = t;
      }
    }

    // Triangles. Innermost ring fans from center vertex; subsequent rings
    // are quads split into two tris.
    const triCount = radial + (rings - 1) * radial * 2;
    const indices  = new Uint16Array(triCount * 3);
    let i = 0;

    // Center fan
    for (let s = 0; s < radial; s++) {
      const a = 1 + s;
      const b = 1 + ((s + 1) % radial);
      indices[i++] = 0; indices[i++] = a; indices[i++] = b;
    }
    // Ring quads
    for (let r = 0; r < rings - 1; r++) {
      const baseInner = 1 + r * radial;
      const baseOuter = 1 + (r + 1) * radial;
      for (let s = 0; s < radial; s++) {
        const sNext = (s + 1) % radial;
        const a = baseInner + s;
        const b = baseInner + sNext;
        const c = baseOuter + s;
        const d = baseOuter + sNext;
        indices[i++] = a; indices[i++] = c; indices[i++] = b;
        indices[i++] = b; indices[i++] = c; indices[i++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aRadialT', new THREE.BufferAttribute(radialT, 1));
    geo.setAttribute('aDomeT',   new THREE.BufferAttribute(domeT, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const material = this._makeMaterial(/* isDome */ false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  /** Hemispherical dome — same radial topology as disc but vertices ride
   *  on a half-sphere of base `radius` and apex `domeHeight`. Bottom
   *  ring sits at y=0 (beacon foot) so it kisses the disc edge; apex is
   *  a single vertex at y=domeHeight. */
  private _buildDome(): BuiltMesh {
    const { radial, rings } = this.subdivisions;
    const radius     = this.opts.radius;
    const domeHeight = this.opts.domeHeight;

    const vertCount = 1 + rings * radial; // 1 apex + rings × radial
    const positions = new Float32Array(vertCount * 3);
    const radialT   = new Float32Array(vertCount); // 1.0 at base, 0.0 at apex
    const domeT     = new Float32Array(vertCount); // 0.0 at base, 1.0 at apex

    // Apex
    positions[0] = 0; positions[1] = domeHeight; positions[2] = 0;
    radialT[0] = 0;
    domeT[0]   = 1;

    // Rings descending from just-below-apex to base. ring 0 is closest to
    // apex (small radius, high y), ring rings-1 is the base.
    for (let r = 0; r < rings; r++) {
      // theta: 0 at apex, π/2 at base. Distribute rings linearly along
      // theta so geometry isn't too sparse near the base.
      const theta = ((r + 1) / rings) * (Math.PI / 2);
      const ringRadius = Math.sin(theta) * radius;
      const ringY      = Math.cos(theta) * domeHeight;
      const tDome      = 1.0 - (r + 1) / rings; // 1 near apex, 0 at base
      const tRadial    = (r + 1) / rings;       // 0 near apex, 1 at base

      for (let s = 0; s < radial; s++) {
        const angle = (s / radial) * Math.PI * 2;
        const x = Math.cos(angle) * ringRadius;
        const z = Math.sin(angle) * ringRadius;
        const idx = 1 + r * radial + s;
        positions[idx * 3]     = x;
        positions[idx * 3 + 1] = ringY;
        positions[idx * 3 + 2] = z;
        radialT[idx] = tRadial;
        domeT[idx]   = tDome;
      }
    }

    const triCount = radial + (rings - 1) * radial * 2;
    const indices  = new Uint16Array(triCount * 3);
    let i = 0;

    // Apex fan to first ring
    for (let s = 0; s < radial; s++) {
      const a = 1 + s;
      const b = 1 + ((s + 1) % radial);
      indices[i++] = 0; indices[i++] = b; indices[i++] = a; // wind outward
    }
    // Ring quads (rings indexed 0..rings-2 are joined to ring r+1)
    for (let r = 0; r < rings - 1; r++) {
      const baseInner = 1 + r * radial;
      const baseOuter = 1 + (r + 1) * radial;
      for (let s = 0; s < radial; s++) {
        const sNext = (s + 1) % radial;
        const a = baseInner + s;
        const b = baseInner + sNext;
        const c = baseOuter + s;
        const d = baseOuter + sNext;
        indices[i++] = a; indices[i++] = b; indices[i++] = c;
        indices[i++] = b; indices[i++] = d; indices[i++] = c;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aRadialT', new THREE.BufferAttribute(radialT, 1));
    geo.setAttribute('aDomeT',   new THREE.BufferAttribute(domeT, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = this._makeMaterial(/* isDome */ true);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  private _makeMaterial(isDome: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: this.opts.color.clone() },
        uTime:      { value: Math.random() * 100 }, // de-sync adjacent beacons
        uIntensity: { value: 1.0 },
        uMode:      { value: this.opts.mode === 'guild' ? 1.0 : 0.0 },
        uIsDome:    { value: isDome ? 1.0 : 0.0 },
      },
      defines: DEBUG_OPAQUE_DISC ? { DEBUG_OPAQUE_DISC: '' } : {},
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent:    true,
      depthWrite:     false,
      // Dome skips depthTest to avoid the half-nearest-camera ghosting
      // (front/back face sort vs terrain depth interaction).
      // Disc keeps depthTest + polygonOffset so trees and buildings
      // inside the bubble correctly occlude it from overhead.
      depthTest:      isDome ? false : true,
      polygonOffset:       !isDome,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      blending:       THREE.AdditiveBlending,
      side:           THREE.DoubleSide,
    });
  }

  /** Raycast straight down through the scene from high above to find the
   *  terrain Y at (localX, localZ) relative to the beacon root. Result is
   *  the LOCAL y offset from the root group's position (so ridges and
   *  valleys under the disc are tracked). Falls back to 0 if nothing
   *  hits — the disc just sits at the beacon's foot in that case.
   *
   *  Skips transparent meshes so the disc doesn't end up snagging on the
   *  beacon's own beam/ring/decal/dome (all transparent) or on other
   *  beacons' auras. Terrain is opaque, this filter cleanly separates. */
  private _raycastGroundOffsetY(localX: number, localZ: number): number {
    const worldX = this.opts.position.x + localX;
    const worldZ = this.opts.position.z + localZ;
    const ray = new THREE.Raycaster(
      new THREE.Vector3(worldX, 2000, worldZ),
      new THREE.Vector3(0, -1, 0),
    );

    // Prefer terrain-only raycast when the manager provides a target
    // resolver — this is the correct path because trees, beacons, and
    // other non-terrain meshes opaquely intercept top-down rays and
    // would skew the disc onto whatever's tallest.
    const targets = this.opts.getRaycastTargets?.();
    const objects = targets && targets.length > 0
      ? targets
      : this.opts.scene.children;

    const hits = ray.intersectObjects(objects, true);
    for (const hit of hits) {
      const mat = (hit.object as THREE.Mesh).material as
        | THREE.Material | THREE.Material[] | undefined;
      const matFlat = Array.isArray(mat) ? mat[0] : mat;
      if (matFlat?.transparent) continue;       // belt-and-suspenders for fallback path
      const offset = hit.point.y - this.opts.position.y;
      // Sanity clamp — a 100 m bubble shouldn't span more than ~30 m of
      // terrain variation. Anything past that is the raycast hitting a
      // mesh higher up we missed; fall back to flat-at-foot.
      if (offset > 30 || offset < -30) return 0.1;
      // 0.1 m lift on every vertex: with logdepthbuf chunks now in the
      // shader, depth math is correct and a small honest gap reads
      // cleanly. polygonOffset is also enabled below as belt-and-suspenders.
      return offset + 0.1;
    }
    return 0;
  }
}
