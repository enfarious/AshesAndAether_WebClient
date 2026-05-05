import * as THREE from 'three';

/**
 * DisposableBeaconManager — small portable beacons placed via /placebeacon.
 *
 * Visual identity is intentionally distinct from GuildBeaconManager:
 *   - Warm orange/ember palette (vs guild's saturated purple)
 *   - ~35% the scale (small farming nook, not territorial claim)
 *   - Single beam plane + single ring (no upper ring, no point light, no
 *     aura disc — keeps draw calls + light-loop overhead minimal across
 *     dozens of placed beacons)
 *
 * State machine matches the server's `DisposableBeaconAnchor.state`:
 *   - 'lit'       — full opacity, full size, normal pulse
 *   - 'emergency' — dim opacity, slower pulse, slight color shift toward
 *                   ember-red (player should immediately read "this is dying")
 *
 * Events consumed (via `world.onEvent`):
 *   - disposable_beacon_placed     → addBeacon
 *   - disposable_beacon_emergency  → setEmergency(id)
 *   - disposable_beacon_relit      → setLit(id)
 *   - disposable_beacon_expired    → removeBeacon(id)
 *   - disposable_beacons_initial   → addBeacons (snapshot on join)
 */

export type DisposableBeaconState = 'lit' | 'emergency';

export interface DisposableBeaconData {
  id:                    string;
  placedByCharacterId:   string;
  placedByCharacterName: string;
  worldX:                number;
  worldY:                number;
  worldZ:                number;
  effectRadius:          number;
  state:                 DisposableBeaconState;
  expiresAt:             number;
  emergencyEndsAt?:      number;
  loadedCells:           number;
}

// ── Tuning ────────────────────────────────────────────────────────────────
const BEAM_HEIGHT     = 18;     // metres
const BEAM_WIDTH      = 2.6;
const RING_RADIUS     = 1.6;
const RING_TUBE       = 0.18;
const DECAL_RADIUS    = 4;
const MOTE_COUNT      = 30;
const MOTE_RADIUS     = 5;
const MOTE_HEIGHT     = 6;
const MOTE_SIZE       = 0.18;
const MOTE_SWAY       = 0.6;

const RING_SPIN_SPEED       = 0.6;
const PULSE_SPEED_LIT       = 0.45;
const PULSE_SPEED_EMERGENCY = 0.18;
const PULSE_AMPLITUDE       = 0.12;

const BEAM_OPACITY_LIT       = 0.65;
const BEAM_OPACITY_EMERGENCY = 0.22;
const RING_OPACITY_LIT       = 0.70;
const RING_OPACITY_EMERGENCY = 0.30;
const DECAL_OPACITY_LIT       = 0.30;
const DECAL_OPACITY_EMERGENCY = 0.12;

// Warm fire palette — lit is bright orange, emergency drops to ember red.
const COLOR_LIT       = new THREE.Color(0xff7a33);
const COLOR_EMERGENCY = new THREE.Color(0x882a18);

interface BeaconInstance {
  data:     DisposableBeaconData;
  group:    THREE.Group;
  beam:     THREE.Mesh;
  ring:     THREE.Mesh;
  decal:    THREE.Mesh;
  motes:    THREE.Points;
  beamMat:  THREE.MeshBasicMaterial;
  ringMat:  THREE.MeshBasicMaterial;
  decalMat: THREE.MeshBasicMaterial;
  moteMat:  THREE.PointsMaterial;
  motePos:  Float32Array;
  moteMeta: Float32Array;
  moteAge:  Float32Array;
  phase:    number;
}

export class DisposableBeaconManager {
  private beacons = new Map<string, BeaconInstance>();
  private age     = 0;

  constructor(
    private readonly scene: THREE.Scene,
    /** Returns the terrain root for the active zone — beacon raycasts down
     *  against this to find ground Y. Returns null until terrain loads. */
    private readonly getTerrainRoot?: () => THREE.Object3D | null,
  ) {}

  /** Add a beacon. Idempotent on id (snapshot + live event race safe). */
  addBeacon(data: DisposableBeaconData): void {
    if (this.beacons.has(data.id)) return;
    const inst = this._createBeacon(data);
    this.beacons.set(data.id, inst);
    this.scene.add(inst.group);
  }

  addBeacons(batch: DisposableBeaconData[]): void {
    for (const b of batch) this.addBeacon(b);
  }

  removeBeacon(id: string): void {
    const inst = this.beacons.get(id);
    if (!inst) return;
    this.scene.remove(inst.group);
    inst.beam.geometry.dispose();
    inst.beamMat.dispose();
    inst.ring.geometry.dispose();
    inst.ringMat.dispose();
    inst.decal.geometry.dispose();
    inst.decalMat.map?.dispose();
    inst.decalMat.dispose();
    inst.motes.geometry.dispose();
    inst.moteMat.dispose();
    this.beacons.delete(id);
  }

  /** Transition to emergency state — dim everything down. */
  setEmergency(id: string): void {
    const inst = this.beacons.get(id);
    if (!inst) return;
    inst.data.state = 'emergency';
  }

  /** Transition back to lit (refuel succeeded). */
  setLit(id: string): void {
    const inst = this.beacons.get(id);
    if (!inst) return;
    inst.data.state = 'lit';
  }

  setVisible(visible: boolean): void {
    for (const inst of this.beacons.values()) inst.group.visible = visible;
  }

  clear(): void {
    for (const id of Array.from(this.beacons.keys())) this.removeBeacon(id);
  }

  /** Per-frame: ring spin, beam/ring/decal opacity pulse, mote drift. State-
   *  specific palette + pulse rate applied per-beacon based on current state. */
  update(dt: number): void {
    this.age += dt;
    for (const inst of this.beacons.values()) {
      const isEmergency = inst.data.state === 'emergency';
      const baseColor   = isEmergency ? COLOR_EMERGENCY : COLOR_LIT;
      const pulseSpeed  = isEmergency ? PULSE_SPEED_EMERGENCY : PULSE_SPEED_LIT;
      const beamOpBase  = isEmergency ? BEAM_OPACITY_EMERGENCY : BEAM_OPACITY_LIT;
      const ringOpBase  = isEmergency ? RING_OPACITY_EMERGENCY : RING_OPACITY_LIT;
      const decalOpBase = isEmergency ? DECAL_OPACITY_EMERGENCY : DECAL_OPACITY_LIT;

      const pulse = Math.sin(this.age * pulseSpeed * Math.PI * 2 + inst.phase) * PULSE_AMPLITUDE;
      inst.beamMat.opacity  = beamOpBase + pulse;
      inst.ringMat.opacity  = ringOpBase + pulse;
      inst.decalMat.opacity = decalOpBase + pulse * 0.4;
      inst.beamMat.color.copy(baseColor);
      inst.ringMat.color.copy(baseColor);
      inst.moteMat.color.copy(baseColor).lerp(new THREE.Color(0xffffff), 0.3);

      inst.ring.rotation.z += RING_SPIN_SPEED * dt * (isEmergency ? 0.4 : 1);

      // Motes drift up + sway
      for (let i = 0; i < MOTE_COUNT; i++) {
        const mi = i * 5;
        const bx = inst.moteMeta[mi]!;
        const bz = inst.moteMeta[mi + 1]!;
        const sy = inst.moteMeta[mi + 2]!;
        const sp = inst.moteMeta[mi + 3]!;
        const ph = inst.moteMeta[mi + 4]!;

        inst.moteAge[i]! += dt * sp * (isEmergency ? 0.5 : 1);
        if (inst.moteAge[i]! > MOTE_HEIGHT) inst.moteAge[i]! -= MOTE_HEIGHT;

        const t   = this.age + ph;
        const pi3 = i * 3;
        inst.motePos[pi3]!     = bx + Math.sin(t * 0.4 + ph) * MOTE_SWAY;
        inst.motePos[pi3 + 1]! = sy + inst.moteAge[i]!;
        inst.motePos[pi3 + 2]! = bz + Math.cos(t * 0.35 + ph) * MOTE_SWAY;
      }
      (inst.motes.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Re-raycast all beacons onto terrain — call after worldRoot loads. */
  repositionOnTerrain(): void {
    for (const inst of this.beacons.values()) {
      const { worldX, worldZ, worldY } = inst.data;
      const groundY = this._findGroundY(worldX, worldZ, worldY);
      inst.group.position.y = groundY;
    }
  }

  get count(): number { return this.beacons.size; }

  dispose(): void { this.clear(); }

  // ── Internals ──────────────────────────────────────────────────────────

  private _createBeacon(data: DisposableBeaconData): BeaconInstance {
    const groundY = this._findGroundY(data.worldX, data.worldZ, data.worldY);

    const group = new THREE.Group();
    group.position.set(data.worldX, groundY, data.worldZ);

    const phase = Math.random() * Math.PI * 2;

    // Beam — single vertical plane with additive blend, double-sided so the
    // player sees it from any angle.
    const beamGeo = new THREE.PlaneGeometry(BEAM_WIDTH, BEAM_HEIGHT);
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    const beamMat = new THREE.MeshBasicMaterial({
      map:         DisposableBeaconManager._makeBeamTexture(),
      color:       COLOR_LIT,
      transparent: true,
      opacity:     BEAM_OPACITY_LIT,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      blending:    THREE.AdditiveBlending,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.frustumCulled = false;
    group.add(beam);

    // Ring at base
    const ringGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 6, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color:       COLOR_LIT,
      transparent: true,
      opacity:     RING_OPACITY_LIT,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.4;
    ring.frustumCulled = false;
    group.add(ring);

    // Ground decal — subtle warm glow on the dirt
    const decal = this._createGroundDecal();
    group.add(decal);

    // Motes — small rising embers
    const { motes, motePos, moteMeta, moteAge } = this._createMotes();
    group.add(motes);

    return {
      data, group, beam, ring, decal, motes,
      beamMat, ringMat,
      decalMat: decal.material as THREE.MeshBasicMaterial,
      moteMat:  motes.material as THREE.PointsMaterial,
      motePos, moteMeta, moteAge, phase,
    };
  }

  private _createGroundDecal(): THREE.Mesh {
    const geo = new THREE.CircleGeometry(DECAL_RADIUS, 24);
    geo.rotateX(-Math.PI / 2);
    const tex = DisposableBeaconManager._makeDecalTexture();
    const mat = new THREE.MeshBasicMaterial({
      map:                 tex,
      color:               COLOR_LIT,
      transparent:         true,
      opacity:             DECAL_OPACITY_LIT,
      depthWrite:          false,
      blending:            THREE.AdditiveBlending,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.05;
    mesh.frustumCulled = false;
    return mesh;
  }

  private _createMotes(): {
    motes: THREE.Points; motePos: Float32Array;
    moteMeta: Float32Array; moteAge: Float32Array;
  } {
    const motePos  = new Float32Array(MOTE_COUNT * 3);
    const moteMeta = new Float32Array(MOTE_COUNT * 5);
    const moteAge  = new Float32Array(MOTE_COUNT);

    for (let i = 0; i < MOTE_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r     = Math.sqrt(Math.random()) * MOTE_RADIUS;
      const bx    = Math.cos(angle) * r;
      const bz    = Math.sin(angle) * r;
      const sy    = Math.random() * MOTE_HEIGHT;
      const sp    = 0.6 + Math.random() * 0.8;
      const ph    = Math.random() * Math.PI * 2;
      moteMeta.set([bx, bz, sy, sp, ph], i * 5);
      moteAge[i]  = Math.random() * MOTE_HEIGHT;
      motePos.set([bx, sy + moteAge[i]!, bz], i * 3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
    const mat = new THREE.PointsMaterial({
      color:           COLOR_LIT.clone().lerp(new THREE.Color(0xffffff), 0.3),
      size:            MOTE_SIZE,
      sizeAttenuation: true,
      transparent:     true,
      opacity:         0.4,
      depthWrite:      false,
      blending:        THREE.AdditiveBlending,
    });
    const motes = new THREE.Points(geo, mat);
    motes.frustumCulled = false;
    return { motes, motePos, moteMeta, moteAge };
  }

  private _findGroundY(x: number, z: number, fallbackY: number): number {
    const root = this.getTerrainRoot?.();
    if (!root) return fallbackY;
    const ray = new THREE.Raycaster(
      new THREE.Vector3(x, 5000, z),
      new THREE.Vector3(0, -1, 0),
    );
    const hits = ray.intersectObject(root, true);
    if (hits.length > 0 && hits[0]) return hits[0].point.y;
    return fallbackY;
  }

  // ── Static textures (cached across all instances) ─────────────────────

  private static _beamTexture:  THREE.Texture | null = null;
  private static _decalTexture: THREE.Texture | null = null;

  private static _makeBeamTexture(): THREE.Texture {
    if (DisposableBeaconManager._beamTexture) return DisposableBeaconManager._beamTexture;
    const w = 1, h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0,    'rgba(255,255,255,1.0)');
    grad.addColorStop(0.15, 'rgba(255,255,255,0.7)');
    grad.addColorStop(0.5,  'rgba(255,255,255,0.3)');
    grad.addColorStop(1.0,  'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    DisposableBeaconManager._beamTexture = tex;
    return tex;
  }

  private static _makeDecalTexture(): THREE.Texture {
    if (DisposableBeaconManager._decalTexture) return DisposableBeaconManager._decalTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grad.addColorStop(0,   'rgba(255, 200, 130, 0.7)');
    grad.addColorStop(0.4, 'rgba(255, 140, 60, 0.3)');
    grad.addColorStop(1,   'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    DisposableBeaconManager._decalTexture = tex;
    return tex;
  }
}
