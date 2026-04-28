import * as THREE from 'three';
import type { PlayerState } from '@/state/PlayerState';
import type { EntityFactory } from './EntityFactory';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * AutoAttackRing — a thin warm ring at the auto-attack target's feet that
 * fills clockwise as the swing timer charges, snaps back to empty on each
 * swing fire.
 *
 * Lives just outside EntityFactory's amber highlight ring so the two compose
 * cleanly when soft-target and auto-attack-target are the same entity:
 *   - Inner gold ring (highlight) = "what I have selected"
 *   - Outer warm ring (this)      = "what I am swinging at + when next swing"
 *
 * Driven by `player.combat.autoAttack { current, max }`. The server only
 * pushes this on combat events / state ticks, so we lerp locally between
 * pushes (anchor on each new value, advance by dt/weaponSpeed, snap when
 * the server's value differs from our last seen value).
 */

const INNER_RADIUS = 0.82;
const OUTER_RADIUS = 0.96;
const Y_LIFT       = 0.12;       // sit just above the highlight ring + clear of GROUND_CLEARANCE jitter
const RING_COLOR   = new THREE.Color(0xffa050);  // warm orange — distinct from amber highlight

/** Fragment shader colors any pixel whose angle (CW from 12 o'clock) falls
 *  below uFillProgress. Anti-aliased on the trailing edge with smoothstep
 *  so the sweep tip looks soft, not hard-cut. */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3  uColor;
  uniform float uFillProgress;   // 0..1
  uniform float uOpacity;
  varying vec2  vLocalPos;       // pre-rotation XY in object space

  void main() {
    // atan2(x, y) puts 0 at +Y (12 o'clock) and increases clockwise — exactly
    // the sweep direction a player expects for a charging timer.
    float a = atan(vLocalPos.x, vLocalPos.y);
    float t = (a < 0.0 ? a + 6.2831853 : a) / 6.2831853;   // 0..1 CW from 12

    // Soft trailing edge: fade out the leading 1.5% of the swept arc.
    float lead   = 0.015;
    float alpha  = 1.0 - smoothstep(uFillProgress - lead, uFillProgress, t);
    if (t > uFillProgress) discard;

    gl_FragColor = vec4(uColor, alpha * uOpacity);
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vLocalPos;
  void main() {
    vLocalPos   = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class AutoAttackRing {
  private mesh:     THREE.Mesh;
  private material: THREE.ShaderMaterial;

  // Local lerp state — see file header for rationale.
  private _localProgress    = 0;     // 0..1 we render this frame
  private _lastSeenVersion  = -1;    // PlayerState.combatVersion at last snap
  private _weaponSpeed      = 3;     // seconds per swing — refreshed from server each push

  // Optional heightmap for ground-conform Y. If unset, ring sits at the
  // target entity's reported Y (which is already terrain-snapped server-side).
  private _heightmap: HeightmapService | null = null;

  private unsubPlayer: (() => void) | null = null;

  constructor(
    private readonly scene:         THREE.Scene,
    private readonly entityFactory: EntityFactory,
    private readonly playerState:   PlayerState,
  ) {
    const geo = new THREE.RingGeometry(INNER_RADIUS, OUTER_RADIUS, 64, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor:        { value: RING_COLOR },
        uFillProgress: { value: 0 },
        uOpacity:      { value: 0.85 },
      },
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent:    true,
      depthWrite:     false,
      depthTest:      false,         // overlay-style: never occluded by entity meshes
      side:           THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.rotation.x = Math.PI / 2;   // lay flat on XZ ground plane
    this.mesh.renderOrder = 999;          // draw last so depthTest:false reads correctly
    this.mesh.visible = false;
    this.scene.add(this.mesh);

    // We don't need to react to PlayerState changes immediately — update(dt)
    // reads the current state every frame. But subscribe anyway so a future
    // need (e.g., snap on target switch) has a hook.
    this.unsubPlayer = playerState.onChange(() => { /* deferred to update() */ });
  }

  /** Wire the heightmap so the ring snaps to actual terrain elevation rather
   *  than relying on the entity's reported Y. Optional — call after the
   *  HeightmapService is ready. */
  setHeightmap(hm: HeightmapService | null): void {
    this._heightmap = hm;
  }

  dispose(): void {
    if (this.unsubPlayer) { this.unsubPlayer(); this.unsubPlayer = null; }
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  /** Call every frame. Reads server combat state, lerps locally, repositions. */
  update(dt: number): void {
    const combat   = this.playerState.combat;
    const aa       = combat.autoAttack;
    const targetId = combat.autoAttackTarget;

    if (!aa || !targetId || aa.max <= 0) {
      this.mesh.visible = false;
      this._lastSeenVersion = -1;
      this._localProgress   = 0;
      return;
    }

    // Anchor target entity in the scene — if it's not rendered (out of draw
    // distance, just spawned, just despawned), skip cleanly.
    const targetObj = this.entityFactory.getObject(targetId);
    if (!targetObj) {
      this.mesh.visible = false;
      return;
    }

    // Snap local progress on every fresh server push, regardless of value.
    // Comparing the raw current value alone misses the common case where
    // consecutive swing-fire resets both arrive as { current: 0 }.
    const version = this.playerState.combatVersion;
    if (version !== this._lastSeenVersion) {
      this._localProgress    = Math.max(0, Math.min(1, aa.current / aa.max));
      this._lastSeenVersion  = version;
      this._weaponSpeed      = aa.max;
    } else {
      // Advance locally between server pushes for a smooth fill.
      this._localProgress = Math.min(1, this._localProgress + dt / this._weaponSpeed);
    }

    // Position at target's rendered (interpolated) position. Prefer the
    // client-side heightmap if available so the ring snaps to actual
    // rendered terrain (avoids ring-buried-in-slope on uneven ground).
    const p = targetObj.object3d.position;
    let groundY = p.y;
    if (this._heightmap) {
      const hmY = this._heightmap.getElevation(p.x, p.z);
      if (hmY !== null) groundY = hmY;
    }
    this.mesh.position.set(p.x, groundY + Y_LIFT, p.z);

    this.material.uniforms['uFillProgress']!.value = this._localProgress;
    this.mesh.visible = true;
  }
}
