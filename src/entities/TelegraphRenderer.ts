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

type TelegraphRole = 'danger' | 'beneficial' | 'own_offense' | 'skip';

const VERTEX_SHADER = /* glsl */`
  varying vec2 vLocalPos;
  void main() {
    vLocalPos   = position.xy;            // PlaneGeometry XY before flat rotation
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
  private _classify(p: TelegraphRegisterPayload): TelegraphRole {
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

    // Circle (only shape currently used by abilities). Cone/line are wire-
    // format-supported but not rendered yet — they'll fall through to
    // null until the first ability needs them.
    const geometry = this._makeGeometry(p.shape);
    if (!geometry) return null;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor:        { value: color.clone() },
        uFillProgress: { value: p.phase === 'channel' ? 1.0 : 0.0 },
        uPulse:        { value: 0.0 },
        uOpacity:      { value: this.opacityMaster },
      },
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_CIRCLE,
      transparent:    true,
      depthWrite:     false,
      // Overlay-style: never occluded by terrain or entity meshes. Mirrors
      // AutoAttackRing — telegraphs need to be readable from any camera
      // angle, including looking up at a slope where ground would otherwise
      // depth-cull a flat decal sitting on it.
      depthTest:      false,
      side:           THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;     // lay flat on XZ
    mesh.renderOrder = 998;             // under the auto-attack ring (999)
    mesh.visible = false;               // first frame's update() will position it

    // Geometry is unit-sized (vLocalPos in [-1, 1] for the shader's clip).
    // World size comes from the transform — circle scales uniformly to
    // shape.radius; cone/line will set per-axis scale when implemented.
    if (p.shape.shape === 'circle') {
      mesh.scale.setScalar(p.shape.radius);
    }

    // Heading-driven yaw for cone/line shapes — irrelevant for circle but
    // costs nothing to set.
    if (p.heading !== undefined && p.shape.shape !== 'circle') {
      mesh.rotation.y = p.heading * Math.PI / 180;
    }

    return { mesh, material };
  }

  /** Geometry sized so the shader's local XY range maps to ±1 across the
   *  unit-circle (or aligned-rectangle for line). The mesh transform scales
   *  to the AoE's actual world size — keeps the shader trivial. */
  private _makeGeometry(shape: AoeShape): THREE.BufferGeometry | null {
    if (shape.shape === 'circle') {
      // Unit-sized PlaneGeometry — positions in [-1, 1] on XY. Shader uses
      // length(vLocalPos) > 1 to clip outside the unit disc.
      return new THREE.PlaneGeometry(2, 2, 1, 1);
    }
    // Cone / line: scaffolded but not rendered yet — first abilities to use
    // these will land the geometry & shader path.
    return null;
  }
}
