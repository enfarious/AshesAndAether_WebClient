import * as THREE from 'three';
import type { PlayerState } from '@/state/PlayerState';
import type { EntityFactory } from './EntityFactory';
import type { HeightmapService } from '@/world/HeightmapService';
import { fitToTerrain } from '@/world/TangentPlaneFit';

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
 * Geometry is a flat low-poly annulus. Each frame the ring is positioned
 * + rotated to sit on the local tangent plane of the terrain via DEM
 * sampling at the target's XZ + four cardinal offsets. Rigid mesh => no
 * per-vertex Y jitter, much cheaper than the tessellated shader-conform
 * approach.
 */

const INNER_RADIUS    = 0.82;
const OUTER_RADIUS    = 0.96;
const Y_LIFT          = 0.02;        // tiny clearance above terrain
const BEVEL_HEIGHT    = 0.05;        // height of the lifted top of the ring
const SAMPLE_DIST     = 0.9;         // ~ outer radius; tangent plane covers the ring
const RADIAL_SEGMENTS = 48;          // around the ring (smooth circle)
const RING_SEGMENTS   = 4;           // 5 rings across width: edge / flat / mid / flat / edge
const RING_COLOR      = new THREE.Color(0xffa050);  // warm orange

/** Build a flat tessellated annulus in the XZ plane (Y=0). Each vertex
 *  carries an `aLocalDir` attribute (for fragment fill-progress angle)
 *  and an `aBevelMask` (0 at inner/outer rim, 1 on the flat top). */
function buildAnnulusGeometry(): THREE.BufferGeometry {
  const vertCount = (RING_SEGMENTS + 1) * RADIAL_SEGMENTS;
  const positions = new Float32Array(vertCount * 3);
  const localDir  = new Float32Array(vertCount * 2);
  const bevelMask = new Float32Array(vertCount);

  for (let r = 0; r <= RING_SEGMENTS; r++) {
    const t      = r / RING_SEGMENTS;
    const radius = INNER_RADIUS + (OUTER_RADIUS - INNER_RADIUS) * t;
    const mask   = (r === 0 || r === RING_SEGMENTS) ? 0 : 1;
    for (let s = 0; s < RADIAL_SEGMENTS; s++) {
      const a = (s / RADIAL_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const idx = r * RADIAL_SEGMENTS + s;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z;
      // 12 o'clock = -Z in mesh space.
      localDir[idx * 2]      = x;
      localDir[idx * 2 + 1]  = -z;
      bevelMask[idx]         = mask;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < RING_SEGMENTS; r++) {
    const baseInner = r * RADIAL_SEGMENTS;
    const baseOuter = (r + 1) * RADIAL_SEGMENTS;
    for (let s = 0; s < RADIAL_SEGMENTS; s++) {
      const sNext = (s + 1) % RADIAL_SEGMENTS;
      const a = baseInner + s;
      const b = baseInner + sNext;
      const c = baseOuter + s;
      const d = baseOuter + sNext;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',   new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aLocalDir',  new THREE.BufferAttribute(localDir, 2));
  geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

const VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute vec2  aLocalDir;
  attribute float aBevelMask;
  uniform float   uBevelHeight;
  varying vec2    vLocalDir;

  void main() {
    vec3 pos = position;
    pos.y += aBevelMask * uBevelHeight;
    vLocalDir = aLocalDir;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3  uColor;
  uniform float uFillProgress;
  uniform float uOpacity;
  varying vec2  vLocalDir;

  void main() {
    #include <logdepthbuf_fragment>
    // atan2(x, y) with y = -z (north) puts 0 at the player's 12 o'clock and
    // sweeps clockwise — exactly the direction a charging timer reads.
    float a = atan(vLocalDir.x, vLocalDir.y);
    float t = (a < 0.0 ? a + 6.2831853 : a) / 6.2831853;

    float lead   = 0.015;
    float alpha  = 1.0 - smoothstep(uFillProgress - lead, uFillProgress, t);
    if (t > uFillProgress) discard;

    gl_FragColor = vec4(uColor, alpha * uOpacity);
  }
`;

export class AutoAttackRing {
  private mesh:     THREE.Mesh;
  private material: THREE.ShaderMaterial;

  // Local lerp state — see file header for rationale.
  private _localProgress    = 0;
  private _lastSeenVersion  = -1;
  private _weaponSpeed      = 3;

  private _heightmap: HeightmapService | null = null;
  private unsubPlayer: (() => void) | null = null;

  constructor(
    private readonly scene:         THREE.Scene,
    private readonly entityFactory: EntityFactory,
    private readonly playerState:   PlayerState,
  ) {
    const geo = buildAnnulusGeometry();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor:        { value: RING_COLOR },
        uFillProgress: { value: 0 },
        uOpacity:      { value: 0.85 },
        uBevelHeight:  { value: BEVEL_HEIGHT },
      },
      vertexShader:        VERTEX_SHADER,
      fragmentShader:      FRAGMENT_SHADER,
      transparent:         true,
      depthWrite:          false,
      depthTest:           true,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side:                THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder   = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible       = false;
    this.scene.add(this.mesh);

    this.unsubPlayer = playerState.onChange(() => { /* deferred to update() */ });
  }

  setHeightmap(hm: HeightmapService | null): void {
    this._heightmap = hm;
  }

  dispose(): void {
    if (this.unsubPlayer) { this.unsubPlayer(); this.unsubPlayer = null; }
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

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

    const targetObj = this.entityFactory.getObject(targetId);
    if (!targetObj) {
      this.mesh.visible = false;
      return;
    }

    const version = this.playerState.combatVersion;
    if (version !== this._lastSeenVersion) {
      this._localProgress    = Math.max(0, Math.min(1, aa.current / aa.max));
      this._lastSeenVersion  = version;
      this._weaponSpeed      = aa.max;
    } else {
      this._localProgress = Math.min(1, this._localProgress + dt / this._weaponSpeed);
    }

    // Tangent-plane fit to the local terrain at the target's feet. The ring
    // is rotationally symmetric, so we pass null for headingRad — only the
    // terrain tilt matters.
    const p = targetObj.object3d.position;
    fitToTerrain(this.mesh, this._heightmap, p.x, p.z, null, SAMPLE_DIST, Y_LIFT, p.y);

    this.material.uniforms['uFillProgress']!.value = this._localProgress;
    this.mesh.visible = true;
  }
}
