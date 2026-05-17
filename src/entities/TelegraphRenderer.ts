import * as THREE from 'three';
import type { MessageRouter } from '@/network/MessageRouter';
import type { EntityFactory } from './EntityFactory';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import type { HeightmapService } from '@/world/HeightmapService';
import { HEIGHTMAP_VERTEX_PARS, heightmapUniforms, wireHeightmap } from '@/world/HeightmapShader';
import type { TelegraphRegisterPayload, AoeShape } from '@/network/Protocol';

/**
 * TelegraphRenderer — ground rings warning of incoming AoE.
 *
 * Visual model:
 *   - Bright outer border ring (always visible while telegraph is alive)
 *   - Interior fill that grows from center outward as the cast progresses
 *     (uFillProgress = 0..1). Channel-phase telegraphs start at fill = 1.
 *   - Pulse on channel_tick: brief additive alpha flash so each meteor
 *     impact has visible feedback even from above.
 *
 * Affinity colour, resolved per-viewer (the local player decides what's
 * relevant to them):
 *   - Red    — hostile caster's hostile AoE (it will hit me).
 *   - Green  — friendly caster's friendly AoE (heal/buff zone I can stand in).
 *   - Blue   — my own hostile AoE (positioning aid so I can aim — the
 *              radius around me/my anchor isn't where *I* am, it's where
 *              the damage lands, so the ring is genuine new info).
 *   - Skip   — won't affect me and I didn't cast it (ally's damage AoE on
 *              enemies, mob's self-buff). Also: my own friendly AoE
 *              (auras, self-buff zones) — I'm already at the centre, so
 *              the ring is just noise; allies still see it as green.
 *
 * Anchor model:
 *   - origin set      → static worldspace XZ (snapshot channel anchor).
 *   - anchorEntityId  → follows the entity each frame via EntityFactory's
 *     rendered (lerped) position. Saves bandwidth — server doesn't push
 *     position updates for the telegraph itself.
 *
 * Lifecycle: server-authoritative register/cancel via MessageRouter.
 * Natural expiry is local from `endsAt` — server doesn't broadcast that
 * (saves bandwidth and matches the cast-bar's local-timer pattern).
 */

const Y_LIFT = 0.06;        // Slightly above ground to clear z-fighting.
const COLOR_DANGER       = new THREE.Color(0xff3838);   // red — incoming damage on me
const COLOR_BENEFICIAL   = new THREE.Color(0x52e07a);   // green — incoming heal/buff
const COLOR_OWN_OFFENSE  = new THREE.Color(0x4a8fff);   // blue — my own AoE on enemies
const PULSE_DECAY_PER_SEC = 4.0;   // pulse fades from 1.0 → 0 in ~250ms.

/** Renderable telegraph roles — the colour band the mesh draws in. 'skip'
 *  is a classification result, not a renderable role; meshes are never
 *  created for it. */
export type TelegraphRole = 'danger' | 'beneficial' | 'own_offense';
type ClassifyResult = TelegraphRole | 'skip';

/** Vertex shader shared by all telegraph shapes. Geometry is built flat on
 *  XZ (Y=0) and carries an `aLocalPos` attribute holding its design-space
 *  XY (-1..1 unit-disc for circles; sin(angle)/cos(angle) at unit radius
 *  for cones; (-0.5..0.5, 0..1) for lines) so each fragment shader can keep
 *  its existing logic regardless of how finely the geometry is tessellated.
 *  World Y is sampled per-vertex from the heightmap so the mesh drapes over
 *  slopes instead of clipping. */
const VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  ${HEIGHTMAP_VERTEX_PARS}

  attribute vec2  aLocalPos;
  attribute float aBevelMask;
  varying vec2    vLocalPos;

  void main() {
    vec4 worldBase = modelMatrix * vec4(position, 1.0);
    float y        = conformedWorldY(worldBase) + aBevelMask * uBevelHeight;
    vLocalPos = aLocalPos;
    gl_Position = projectionMatrix * viewMatrix * vec4(worldBase.x, y, worldBase.z, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

/** Circle: clip to unit disc, draw an outer border + a fill that grows from
 *  the centre outward as uFillProgress climbs. */
const FRAGMENT_CIRCLE = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3  uColor;
  uniform float uFillProgress;   // 0..1
  uniform float uPulse;          // 0..1, additive flash
  uniform float uOpacity;        // master multiplier
  varying vec2  vLocalPos;       // unit-circle space (-1..1)

  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vLocalPos);
    if (r > 1.0) discard;

    // Outer border — bright at r ≈ 0.9..1.0, antialiased on both edges.
    float border = smoothstep(0.86, 0.94, r) * (1.0 - smoothstep(0.95, 1.0, r));

    // Interior fill — pixels with r < fillProgress are "active". Mild
    // radial darkening so the centre reads as solid.
    float inside = step(r, uFillProgress) * (0.55 - r * 0.15);

    float a = border * 0.95 + max(inside, 0.0);
    a = min(a + uPulse * 0.35, 1.0);
    gl_FragColor = vec4(uColor, a * uOpacity);
  }
`;

/** Cone (sector): apex at local origin (0,0,0), forward = +Z (server heading
 *  convention), unit radius. Geometry is a wide fan (±90°); shader narrows
 *  to the actual half-angle so geometry can be shared across cone sizes.
 *  Fill grows radially outward from the apex. */
const FRAGMENT_CONE = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3  uColor;
  uniform float uFillProgress;
  uniform float uPulse;
  uniform float uOpacity;
  uniform float uHalfAngleRad;   // half of the cone's angular spread
  varying vec2  vLocalPos;       // x = sin(a), y = cos(a) at arc; (0,0) at apex

  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vLocalPos);
    if (r > 1.0) discard;

    // Angle from forward axis (+y). Range (-π, π]; cone is symmetric.
    float ang = atan(vLocalPos.x, vLocalPos.y);
    float absAng = abs(ang);
    if (absAng > uHalfAngleRad) discard;

    // Far-edge ring (same shape as the circle's border).
    float border = smoothstep(0.86, 0.94, r) * (1.0 - smoothstep(0.95, 1.0, r));

    // Soft fade at angular edges so the cone reads as outlined, not jagged.
    float sideFade = 1.0 - smoothstep(max(uHalfAngleRad - 0.05, 0.0), uHalfAngleRad, absAng);

    // Side-rail outline along the two straight edges — bright like the border.
    float sideRail = smoothstep(uHalfAngleRad - 0.04, uHalfAngleRad - 0.005, absAng);

    // Interior fill grows from apex outward.
    float inside = step(r, uFillProgress) * (0.55 - r * 0.15);

    float a = max(border, sideRail) * 0.95 + max(inside, 0.0);
    a = min(a + uPulse * 0.35, 1.0);
    gl_FragColor = vec4(uColor, a * uOpacity * sideFade);
  }
`;

/** Line (rectangle): origin at one short edge, forward = +Z, length 1, width 1.
 *  Mesh scales x = width, z = length to reach world dimensions. Border is the
 *  rectangle perimeter; fill marches from start edge to uFillProgress*length. */
const FRAGMENT_LINE = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3  uColor;
  uniform float uFillProgress;
  uniform float uPulse;
  uniform float uOpacity;
  varying vec2  vLocalPos;       // x in [-0.5, 0.5], y in [0, 1]

  void main() {
    #include <logdepthbuf_fragment>
    // Distance to nearest perimeter edge in unit-rectangle space.
    float distLat  = 0.5 - abs(vLocalPos.x);
    float distLong = min(vLocalPos.y, 1.0 - vLocalPos.y);
    float dist = min(distLat, distLong);

    // Perimeter border — bright within ~0.04 of any edge. Note: because the
    // mesh is scaled non-uniformly (width vs length), border thickness in
    // world units differs between long and short sides. Acceptable for a
    // first cut; symmetric outline would need aspect-aware shading.
    float border = (1.0 - smoothstep(0.0, 0.04, dist)) * 0.95;

    // Interior fill grows lengthwise from the start edge (y=0).
    float inside = step(vLocalPos.y, uFillProgress) * 0.45;

    float a = border + max(inside, 0.0);
    a = min(a + uPulse * 0.35, 1.0);
    gl_FragColor = vec4(uColor, a * uOpacity);
  }
`;

interface ActiveTelegraph {
  payload:    TelegraphRegisterPayload;
  mesh:       THREE.Mesh;
  material:   THREE.ShaderMaterial;
  pulse:      number;          // 0..1, decays each frame
  duration:   number;          // ms, cached
  isChannel:  boolean;
}

export class TelegraphRenderer {
  private active = new Map<string, ActiveTelegraph>();
  private heightmap: HeightmapService | null = null;
  private opacityMaster = 1.0;       // /telegraphs off → 0
  private unsubRegister: (() => void) | null = null;
  private unsubCancel:   (() => void) | null = null;
  private unsubTick:     (() => void) | null = null;

  constructor(
    private readonly scene:    THREE.Scene,
    private readonly router:   MessageRouter,
    private readonly factory:  EntityFactory,
    private readonly registry: EntityRegistry,
    private readonly player:   PlayerState,
  ) {
    this.unsubRegister = router.onTelegraphRegister(p => this._onRegister(p));
    this.unsubCancel   = router.onTelegraphCancel  (p => this._dispose(p.id));
    this.unsubTick     = router.onChannelTick      (p => this._onChannelTick(p.entityId));
  }

  setHeightmap(hm: HeightmapService | null): void {
    this.heightmap = hm;
    // Retro-wire any telegraphs that registered before the heightmap loaded
    // (e.g. a long-running channel that survives a zone change handoff).
    for (const tg of this.active.values()) wireHeightmap(tg.material, hm);
  }

  /** /telegraphs on|off — master visibility toggle. Off keeps subscriptions
   *  alive (so re-enabling shows current telegraphs immediately) but renders
   *  nothing. */
  setVisible(visible: boolean): void {
    this.opacityMaster = visible ? 1.0 : 0.0;
    for (const tg of this.active.values()) {
      tg.material.uniforms['uOpacity']!.value = this.opacityMaster;
    }
  }

  dispose(): void {
    this.unsubRegister?.();
    this.unsubCancel?.();
    this.unsubTick?.();
    for (const id of [...this.active.keys()]) this._dispose(id);
  }

  /** Frame tick — repositions follow-anchor telegraphs, advances cast fill,
   *  decays pulse, disposes naturally-expired entries. */
  update(dt: number): void {
    const now = Date.now();
    for (const [id, tg] of this.active) {
      // Natural expiry — server doesn't broadcast cancel for these.
      if (now >= tg.payload.endsAt) {
        this._dispose(id);
        continue;
      }

      // Cast phase fills 0→1; channel phase pinned at 1.
      const fill = tg.isChannel
        ? 1.0
        : Math.max(0, Math.min(1, (now - tg.payload.startedAt) / tg.duration));
      tg.material.uniforms['uFillProgress']!.value = fill;

      // Pulse decays exponentially-ish toward 0.
      if (tg.pulse > 0) {
        tg.pulse = Math.max(0, tg.pulse - dt * PULSE_DECAY_PER_SEC);
        tg.material.uniforms['uPulse']!.value = tg.pulse;
      }

      // Anchor: static origin or follow entity (lerp from EntityFactory).
      let x: number | null = null;
      let y = 0;
      let z: number | null = null;
      if (tg.payload.anchorEntityId) {
        const obj = this.factory.getObject(tg.payload.anchorEntityId);
        if (obj) {
          x = obj.object3d.position.x;
          y = obj.object3d.position.y;       // vault fallback Y (no heightmap)
          z = obj.object3d.position.z;
        }
      } else if (tg.payload.origin) {
        x = tg.payload.origin.x;
        z = tg.payload.origin.z;
        // y stays 0 — telegraph origins are XZ-only on the wire. With the
        // heightmap bound, the vertex shader overrides Y from the DEM. In
        // a vault (no DEM), Y=0 matches the vault floor convention.
      }
      if (x === null || z === null) {
        tg.mesh.visible = false;
        continue;
      }

      // Y comes from the vertex shader (terrain-conformed). The CPU Y above
      // is only the fallback the shader uses inside a vault (no DEM bound).
      tg.mesh.position.set(x, y, z);
      tg.mesh.visible = this.opacityMaster > 0;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _onRegister(p: TelegraphRegisterPayload): void {
    // Idempotency — server is authoritative; dispose any prior with the
    // same id before deciding to render the new one (covers the rare case
    // where a re-register has a different role than the prior).
    this._dispose(p.id);

    // Decide whether this telegraph matters to me, and how to colour it.
    // Skipped telegraphs never create a mesh — keeps the scene clean and
    // saves a per-frame transform on hidden geometry.
    const role = this._classify(p);
    if (role === 'skip') return;

    const mesh = this._makeMesh(p, role);
    if (!mesh) return;
    this.scene.add(mesh.mesh);

    this.active.set(p.id, {
      payload:   p,
      mesh:      mesh.mesh,
      material:  mesh.material,
      pulse:     0,
      duration:  Math.max(1, p.endsAt - p.startedAt),
      isChannel: p.phase === 'channel',
    });
  }

  /** Per-viewer classification — turns a zone-wide telegraph payload into
   *  "what does this mean to me?". Cuts the visual noise of e.g. an ally's
   *  Storm on a far-off enemy pack the local player will never engage. */
  private _classify(p: TelegraphRegisterPayload): ClassifyResult {
    const myId = this.player.id;

    // I cast it. Hostile self-casts get blue (ring shows where the damage
    // lands — useful for aiming, even though I'm at the centre). Friendly
    // self-casts (auras, self-buff zones) skip: I'm already at the centre,
    // so the radius doesn't tell me anything I don't know. Allies still
    // see it as green.
    if (p.casterId === myId) {
      return p.affinity === 'hostile' ? 'own_offense' : 'skip';
    }

    // Someone else cast it — does it actually affect me? Look up caster
    // type to decide friend vs foe. Default-treat unknown casters as
    // hostile so a missing entity record errs toward "show the danger".
    const caster = this.registry.get(p.casterId);
    const casterIsHostile = !caster || caster.type === 'mob';

    if (p.affinity === 'hostile') {
      // Hostile AoE filters to caster's enemies. I'm only an enemy of a
      // hostile caster, so a friendly's offensive AoE doesn't reach me.
      return casterIsHostile ? 'danger' : 'skip';
    } else {
      // Friendly AoE filters to caster's allies. I'm only an ally of a
      // non-hostile caster — a mob's self/ally heal doesn't reach me.
      return casterIsHostile ? 'skip' : 'beneficial';
    }
  }

  /** A channel tick on the casting entity flashes any of their channel-phase
   *  telegraphs. Cast-phase telegraphs ignore ticks (they don't tick). */
  private _onChannelTick(entityId: string): void {
    for (const tg of this.active.values()) {
      if (tg.payload.casterId === entityId && tg.isChannel) {
        tg.pulse = 1.0;
        tg.material.uniforms['uPulse']!.value = 1.0;
      }
    }
  }

  private _dispose(id: string): void {
    const tg = this.active.get(id);
    if (!tg) return;
    this.scene.remove(tg.mesh);
    tg.mesh.geometry.dispose();
    tg.material.dispose();
    this.active.delete(id);
  }

  private _makeMesh(p: TelegraphRegisterPayload, role: TelegraphRole): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } | null {
    const color =
      role === 'danger'      ? COLOR_DANGER      :
      role === 'beneficial'  ? COLOR_BENEFICIAL  :
                               COLOR_OWN_OFFENSE;

    switch (p.shape.shape) {
      case 'circle': return this._makeCircleMesh(p, p.shape, color);
      case 'cone':   return this._makeConeMesh  (p, p.shape, color);
      case 'line':   return this._makeLineMesh  (p, p.shape, color);
    }
  }

  /** Build a one-off shape mesh outside the register/active-map flow.
   *  Caller owns the lifecycle (scene add/remove, per-frame positioning,
   *  geometry/material dispose). Returns null for unsupported shapes.
   *  Used by AoEPreviewIndicator to share cone/line/circle rendering. */
  buildExternalMesh(
    shape:    AoeShape,
    role:     TelegraphRole,
    heading:  number | undefined,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } | null {
    const color =
      role === 'danger'      ? COLOR_DANGER      :
      role === 'beneficial'  ? COLOR_BENEFICIAL  :
                               COLOR_OWN_OFFENSE;
    // Synthesize a minimal payload — only `phase` and `heading` are read
    // by the make-mesh helpers (and only `heading` for cone/line). 'cast'
    // phase means fill starts at 0, which is what we want for a static
    // outline preview that doesn't animate.
    const fauxPayload = { phase: 'cast' as const, heading } as TelegraphRegisterPayload;
    switch (shape.shape) {
      case 'circle': return this._makeCircleMesh(fauxPayload, shape, color);
      case 'cone':   return this._makeConeMesh  (fauxPayload, shape, color);
      case 'line':   return this._makeLineMesh  (fauxPayload, shape, color);
    }
  }

  /** Shared shader-material options applied to every telegraph shape so
   *  blend/depth behaviour stays consistent. Conforming geometry + depth
   *  testing means a telegraph behind a wall stays hidden — same model as
   *  the entity body it warns about. polygonOffset biases the mesh slightly
   *  toward the camera so the conformed disc doesn't z-fight against the
   *  terrain it drapes over (BeaconAura disc pattern). */
  private _commonMaterialOpts(): Partial<THREE.ShaderMaterialParameters> {
    return {
      transparent:         true,
      depthWrite:          false,
      depthTest:           true,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side:                THREE.DoubleSide,
    };
  }

  private _baseUniforms(
    color: THREE.Color,
    phase: TelegraphRegisterPayload['phase'],
    smoothRadius: number,
  ): Record<string, { value: unknown }> {
    return {
      ...heightmapUniforms(Y_LIFT, smoothRadius),
      uColor:        { value: color.clone() },
      uFillProgress: { value: phase === 'channel' ? 1.0 : 0.0 },
      uPulse:        { value: 0.0 },
      uOpacity:      { value: this.opacityMaster },
    };
  }

  private _makeCircleMesh(
    _p: TelegraphRegisterPayload,
    shape: Extract<AoeShape, { shape: 'circle' }>,
    color: THREE.Color,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    // Radial × ring detail scales mildly with radius so a 30 m raid AoE
    // still conforms cleanly on uneven terrain without a flat 5 m circle
    // being overkill. Capped to keep the high end sane.
    const radial = Math.min(64, Math.max(24, Math.round(shape.radius * 4)));
    const rings  = Math.min(10, Math.max(4,  Math.round(shape.radius * 0.6)));
    const geometry = TelegraphRenderer._makeDiscGeometry(radial, rings);
    // Smoothing scales with radius — a 30 m raid AoE needs broader filtering
    // than a 3 m bomb to look like a single shape on bumpy terrain. Capped
    // at 4 m so the upper-envelope bias doesn't lift the disc too far above
    // ground on very large AoEs.
    const smoothRadius = Math.min(4.0, Math.max(0.6, shape.radius * 0.30));
    const material = new THREE.ShaderMaterial({
      uniforms:       this._baseUniforms(color, _p.phase, smoothRadius),
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_CIRCLE,
      ...this._commonMaterialOpts(),
    });
    wireHeightmap(material, this.heightmap);
    const mesh = new THREE.Mesh(geometry, material);
    // Geometry is already flat on XZ with unit radius — scale to world size.
    mesh.scale.set(shape.radius, 1, shape.radius);
    mesh.renderOrder = 998;
    mesh.visible = false;
    mesh.frustumCulled = false;       // shader displaces Y; CPU bounds lie
    return { mesh, material };
  }

  private _makeConeMesh(
    p: TelegraphRegisterPayload,
    shape: Extract<AoeShape, { shape: 'cone' }>,
    color: THREE.Color,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    // Cone tessellation also scales with length so a 20 m cone gets enough
    // rings to drape across hills, while a 3 m breath weapon stays cheap.
    const radial = Math.min(64, Math.max(24, Math.round(shape.length * 4)));
    const rings  = Math.min(10, Math.max(4,  Math.round(shape.length * 0.6)));
    const geometry = TelegraphRenderer._makeConeGeometry(radial, rings);
    const halfAngleRad = (shape.angle / 2) * Math.PI / 180;
    const smoothRadius = Math.min(4.0, Math.max(0.6, shape.length * 0.20));
    const uniforms = this._baseUniforms(color, p.phase, smoothRadius);
    uniforms['uHalfAngleRad'] = { value: halfAngleRad };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_CONE,
      ...this._commonMaterialOpts(),
    });
    wireHeightmap(material, this.heightmap);
    const mesh = new THREE.Mesh(geometry, material);
    // Cone scales proportionally: x = z = length (radius and arc-width both
    // grow with the same length parameter, since angle is encoded in the
    // shader).
    mesh.scale.set(shape.length, 1, shape.length);
    if (p.heading !== undefined) mesh.rotation.y = p.heading * Math.PI / 180;
    mesh.renderOrder = 998;
    mesh.visible = false;
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  private _makeLineMesh(
    p: TelegraphRegisterPayload,
    shape: Extract<AoeShape, { shape: 'line' }>,
    color: THREE.Color,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    // Length gets more subdivisions than width since the line is usually
    // long+thin. Keep them proportional to absolute world size.
    const lengthSegs = Math.min(48, Math.max(16, Math.round(shape.length * 1.5)));
    const widthSegs  = Math.min(12, Math.max(4,  Math.round(shape.width  * 2)));
    const geometry = TelegraphRenderer._makeLineGeometry(widthSegs, lengthSegs);
    // Smoothing keyed to the SHORT axis so a 30 m × 2 m line doesn't get
    // over-smoothed sideways. Width sets the scale of acceptable kinking
    // across the stripe.
    const smoothRadius = Math.min(2.0, Math.max(0.4, shape.width * 0.6));
    const material = new THREE.ShaderMaterial({
      uniforms:       this._baseUniforms(color, p.phase, smoothRadius),
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_LINE,
      ...this._commonMaterialOpts(),
    });
    wireHeightmap(material, this.heightmap);
    const mesh = new THREE.Mesh(geometry, material);
    // Geometry already flat on XZ — only yaw to align with server heading.
    // Width on X, length on Z (forward).
    mesh.scale.set(shape.width, 1, shape.length);
    if (p.heading !== undefined) mesh.rotation.y = p.heading * Math.PI / 180;
    mesh.renderOrder = 998;
    mesh.visible = false;
    mesh.frustumCulled = false;
    return { mesh, material };
  }

  /** Tessellated unit disc — radial wedges × concentric rings, plus a centre
   *  vertex. Local-pos attribute carries the same XY in [-1, 1] the legacy
   *  PlaneGeometry passed to the fragment shader, so FRAGMENT_CIRCLE keeps
   *  working unchanged. Bevel mask is 1 at centre, ramps to 0 over the
   *  outermost ~15% of rings so the disc reads as a low plateau with a
   *  beveled rim. */
  private static _makeDiscGeometry(radial: number, rings: number): THREE.BufferGeometry {
    const vertCount = 1 + rings * radial;
    const positions = new Float32Array(vertCount * 3);
    const localPos  = new Float32Array(vertCount * 2);
    const bevelMask = new Float32Array(vertCount);

    // Centre vertex
    positions[0] = 0; positions[1] = 0; positions[2] = 0;
    localPos[0]  = 0; localPos[1]  = 0;
    bevelMask[0] = 1;

    // Bevel-ramp threshold (in normalised radius) — outer ~15% slopes down.
    const bevelStart = 0.85;
    for (let r = 1; r <= rings; r++) {
      const tRing  = r / rings;
      const mask   = tRing <= bevelStart
        ? 1
        : Math.max(0, 1 - (tRing - bevelStart) / (1 - bevelStart));
      const radius = tRing;
      for (let s = 0; s < radial; s++) {
        const a = (s / radial) * Math.PI * 2;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        const idx = 1 + (r - 1) * radial + s;
        positions[idx * 3]     = x;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = z;
        localPos[idx * 2]      = x;
        localPos[idx * 2 + 1]  = z;
        bevelMask[idx]         = mask;
      }
    }

    const indices: number[] = [];
    // Centre fan
    for (let s = 0; s < radial; s++) {
      const a = 1 + s;
      const b = 1 + ((s + 1) % radial);
      indices.push(0, a, b);
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
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aLocalPos',  new THREE.BufferAttribute(localPos, 2));
    geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  /** Tessellated cone fan — apex at (0,0,0), arc covers -90°..+90° relative
   *  to +Z, unit radius. Subdivides both radially (across the arc) and into
   *  rings so the surface follows terrain. Fragment shader still narrows
   *  the visible arc to the per-ability half-angle. Bevel mask ramps down
   *  near the outer arc and the two angular edges so the cone reads as a
   *  low plateau with beveled rim + side rails. */
  private static _makeConeGeometry(radial: number, rings: number): THREE.BufferGeometry {
    const halfFanRad = Math.PI / 2;
    const vertCount = 1 + rings * (radial + 1);
    const positions = new Float32Array(vertCount * 3);
    const localPos  = new Float32Array(vertCount * 2);
    const bevelMask = new Float32Array(vertCount);

    // Apex — interior of the plate
    positions[0] = 0; positions[1] = 0; positions[2] = 0;
    localPos[0]  = 0; localPos[1]  = 0;
    bevelMask[0] = 1;

    const radialBevelStart  = 0.85;     // outer 15% of radius slopes down
    const angularBevelEdge  = 0.10;     // outer 10% of arc on each side slopes down
    for (let r = 1; r <= rings; r++) {
      const tRing  = r / rings;
      const radialMask = tRing <= radialBevelStart
        ? 1
        : Math.max(0, 1 - (tRing - radialBevelStart) / (1 - radialBevelStart));
      const radius = tRing;
      for (let s = 0; s <= radial; s++) {
        const t = s / radial;
        // Distance from nearest angular edge, normalised 0..1 of half-arc.
        const angDist = Math.min(t, 1 - t);
        const angularMask = angDist >= angularBevelEdge
          ? 1
          : angDist / angularBevelEdge;
        const a = -halfFanRad + t * 2 * halfFanRad;
        const x = Math.sin(a) * radius;
        const z = Math.cos(a) * radius;
        const idx = 1 + (r - 1) * (radial + 1) + s;
        positions[idx * 3]     = x;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = z;
        localPos[idx * 2]      = x;
        localPos[idx * 2 + 1]  = z;
        bevelMask[idx]         = Math.min(radialMask, angularMask);
      }
    }

    const indices: number[] = [];
    // Apex fan to first ring (no wrap — cone is an open sector)
    for (let s = 0; s < radial; s++) {
      const a = 1 + s;
      const b = 1 + s + 1;
      indices.push(0, a, b);
    }
    // Ring quads
    for (let r = 0; r < rings - 1; r++) {
      const baseInner = 1 + r * (radial + 1);
      const baseOuter = 1 + (r + 1) * (radial + 1);
      for (let s = 0; s < radial; s++) {
        const a = baseInner + s;
        const b = baseInner + s + 1;
        const c = baseOuter + s;
        const d = baseOuter + s + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aLocalPos',  new THREE.BufferAttribute(localPos, 2));
    geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  /** Tessellated line rectangle — origin at one short edge, length toward
   *  +Z, width along X centred at 0. Local-pos attribute mirrors the legacy
   *  shader's interpretation: x in [-0.5, 0.5], y (= local z) in [0, 1].
   *  Bevel mask is 0 on the perimeter (both short edges + both long sides)
   *  and 1 on the interior so the rectangle reads as a low plate. */
  private static _makeLineGeometry(widthSegs: number, lengthSegs: number): THREE.BufferGeometry {
    const vertsPerRow = widthSegs + 1;
    const vertCount   = (lengthSegs + 1) * vertsPerRow;
    const positions = new Float32Array(vertCount * 3);
    const localPos  = new Float32Array(vertCount * 2);
    const bevelMask = new Float32Array(vertCount);

    for (let j = 0; j <= lengthSegs; j++) {
      const z = j / lengthSegs;            // 0..1
      const lengthEdge = (j === 0 || j === lengthSegs);
      for (let i = 0; i <= widthSegs; i++) {
        const x = -0.5 + (i / widthSegs);  // -0.5..0.5
        const widthEdge = (i === 0 || i === widthSegs);
        const idx = j * vertsPerRow + i;
        positions[idx * 3]     = x;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = z;
        localPos[idx * 2]      = x;
        localPos[idx * 2 + 1]  = z;
        bevelMask[idx]         = (lengthEdge || widthEdge) ? 0 : 1;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < lengthSegs; j++) {
      for (let i = 0; i < widthSegs; i++) {
        const a = j * vertsPerRow + i;
        const b = a + 1;
        const c = a + vertsPerRow;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aLocalPos',  new THREE.BufferAttribute(localPos, 2));
    geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }
}
