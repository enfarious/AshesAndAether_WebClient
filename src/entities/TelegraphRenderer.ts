import * as THREE from 'three';
import type { MessageRouter } from '@/network/MessageRouter';
import type { EntityFactory } from './EntityFactory';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import type { HeightmapService } from '@/world/HeightmapService';
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

/** Vertex shader for XY-plane geometry (the existing circle path). The mesh
 *  is rotated -90° around X afterwards so the disc lies flat on XZ. */
const VERTEX_XY = /* glsl */`
  varying vec2 vLocalPos;
  void main() {
    vLocalPos   = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Vertex shader for XZ-plane geometry (cone, line). Geometry is built
 *  already flat on the ground (Y=0), so no axis flip is needed and
 *  mesh.rotation.y aligns the shape to the server's heading directly. */
const VERTEX_XZ = /* glsl */`
  varying vec2 vLocalPos;
  void main() {
    vLocalPos   = vec2(position.x, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Circle: clip to unit disc, draw an outer border + a fill that grows from
 *  the centre outward as uFillProgress climbs. */
const FRAGMENT_CIRCLE = /* glsl */`
  uniform vec3  uColor;
  uniform float uFillProgress;   // 0..1
  uniform float uPulse;          // 0..1, additive flash
  uniform float uOpacity;        // master multiplier
  varying vec2  vLocalPos;       // unit-circle space (-1..1)

  void main() {
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
  uniform vec3  uColor;
  uniform float uFillProgress;
  uniform float uPulse;
  uniform float uOpacity;
  uniform float uHalfAngleRad;   // half of the cone's angular spread
  varying vec2  vLocalPos;       // x = sin(a), y = cos(a) at arc; (0,0) at apex

  void main() {
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
  uniform vec3  uColor;
  uniform float uFillProgress;
  uniform float uPulse;
  uniform float uOpacity;
  varying vec2  vLocalPos;       // x in [-0.5, 0.5], y in [0, 1]

  void main() {
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
      let z: number | null = null;
      if (tg.payload.anchorEntityId) {
        const obj = this.factory.getObject(tg.payload.anchorEntityId);
        if (obj) { x = obj.object3d.position.x; z = obj.object3d.position.z; }
      } else if (tg.payload.origin) {
        x = tg.payload.origin.x;
        z = tg.payload.origin.z;
      }
      if (x === null || z === null) {
        tg.mesh.visible = false;
        continue;
      }

      let y = 0;
      if (this.heightmap) {
        const hmY = this.heightmap.getElevation(x, z);
        if (hmY !== null) y = hmY;
      }
      tg.mesh.position.set(x, y + Y_LIFT, z);
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
   *  blend/depth behaviour stays consistent. Overlay-style: never occluded
   *  by terrain or entity meshes (mirrors AutoAttackRing). */
  private _commonMaterialOpts(): Partial<THREE.ShaderMaterialParameters> {
    return {
      transparent: true,
      depthWrite:  false,
      depthTest:   false,
      side:        THREE.DoubleSide,
    };
  }

  private _baseUniforms(color: THREE.Color, phase: TelegraphRegisterPayload['phase']): Record<string, { value: unknown }> {
    return {
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
    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
    const material = new THREE.ShaderMaterial({
      uniforms:       this._baseUniforms(color, _p.phase),
      vertexShader:   VERTEX_XY,
      fragmentShader: FRAGMENT_CIRCLE,
      ...this._commonMaterialOpts(),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;        // lay flat on XZ
    mesh.scale.setScalar(shape.radius);
    mesh.renderOrder = 998;
    mesh.visible = false;
    return { mesh, material };
  }

  private _makeConeMesh(
    p: TelegraphRegisterPayload,
    shape: Extract<AoeShape, { shape: 'cone' }>,
    color: THREE.Color,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    const geometry = TelegraphRenderer._makeConeGeometry();
    const halfAngleRad = (shape.angle / 2) * Math.PI / 180;
    const uniforms = this._baseUniforms(color, p.phase);
    uniforms['uHalfAngleRad'] = { value: halfAngleRad };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   VERTEX_XZ,
      fragmentShader: FRAGMENT_CONE,
      ...this._commonMaterialOpts(),
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Geometry already flat on XZ — only yaw to align with server heading.
    // Cone scales proportionally: x = z = length (radius and arc-width both
    // grow with the same length parameter, since angle is encoded in the
    // shader).
    mesh.scale.set(shape.length, 1, shape.length);
    if (p.heading !== undefined) mesh.rotation.y = p.heading * Math.PI / 180;
    mesh.renderOrder = 998;
    mesh.visible = false;
    return { mesh, material };
  }

  private _makeLineMesh(
    p: TelegraphRegisterPayload,
    shape: Extract<AoeShape, { shape: 'line' }>,
    color: THREE.Color,
  ): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    const geometry = TelegraphRenderer._makeLineGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms:       this._baseUniforms(color, p.phase),
      vertexShader:   VERTEX_XZ,
      fragmentShader: FRAGMENT_LINE,
      ...this._commonMaterialOpts(),
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Geometry already flat on XZ — only yaw to align with server heading.
    // Width on X, length on Z (forward).
    mesh.scale.set(shape.width, 1, shape.length);
    if (p.heading !== undefined) mesh.rotation.y = p.heading * Math.PI / 180;
    mesh.renderOrder = 998;
    mesh.visible = false;
    return { mesh, material };
  }

  /** Cone fan geometry — apex at (0,0,0), arc points at unit radius from
   *  -90° to +90° relative to +Z (32 segments). Fragment shader narrows
   *  the visible arc to the actual half-angle, so we don't rebuild this
   *  per ability. */
  private static _makeConeGeometry(): THREE.BufferGeometry {
    const N = 32;
    const halfFanRad = Math.PI / 2;
    const positions: number[] = [0, 0, 0];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = -halfFanRad + t * 2 * halfFanRad;
      positions.push(Math.sin(a), 0, Math.cos(a));
    }
    const indices: number[] = [];
    for (let i = 0; i < N; i++) {
      indices.push(0, i + 1, i + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  /** Line rectangle — origin at one short edge, length toward +Z. */
  private static _makeLineGeometry(): THREE.BufferGeometry {
    const positions = [
      -0.5, 0, 0,
       0.5, 0, 0,
       0.5, 0, 1,
      -0.5, 0, 1,
    ];
    const indices = [0, 1, 2, 0, 2, 3];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }
}
