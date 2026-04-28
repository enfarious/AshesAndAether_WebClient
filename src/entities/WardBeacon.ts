import * as THREE from 'three';

/**
 * WardBeacon — holographic ward pylons above civic anchors (townhalls, libraries).
 *
 * Visible from far away so players exploring corrupted zones can navigate
 * back toward civilisation.  Each beacon is a tall translucent light-beam
 * (two crossed planes forming an X — visible from any angle) with a slowly
 * rotating ward ring at the base and a point light for ground glow.
 *
 * Color-coded:
 *   Townhall  → warm gold
 *   Library   → cool blue
 *
 * Fetches anchor positions from `/api/map/anchors` (same endpoint as
 * CorruptionMiasma) and creates one beacon per active anchor.
 */

// ── Anchor data ──────────────────────────────────────────────────────────────

interface AnchorData {
  worldX: number;
  worldY: number;
  worldZ: number;
  wardRadius: number;
  type?: string;   // 'TOWNHALL' | 'LIBRARY'
  name?: string;
}

/** Fallback anchors if the API is unreachable. */
const FALLBACK_ANCHORS: AnchorData[] = [
  { worldX: 0, worldY: 0, worldZ: 0, wardRadius: 150, type: 'TOWNHALL', name: 'Town Hall' },
  { worldX: -125, worldY: 0, worldZ: -70, wardRadius: 50, type: 'LIBRARY', name: 'Library' },
];

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Total height of the light beam (metres). */
const BEAM_HEIGHT = 80;

/** Width of each beam plane (metres). */
const BEAM_WIDTH = 8;

/** Radius of the rotating ward ring at the base. */
const RING_RADIUS = 6;

/** Height the ring sits above ground. */
const RING_HEIGHT = 2;

/** Ring tube radius. */
const RING_TUBE = 0.4;

/** Rotation speed of the ring (radians/second). */
const RING_SPIN_SPEED = 0.4;

/** Pulse speed for the beam opacity (cycles per second). */
const PULSE_SPEED = 0.25;

/** Base opacity of the beam planes. */
const BEAM_OPACITY = 0.45;

/** Opacity variation from pulse (±). */
const PULSE_AMPLITUDE = 0.1;

/** Ring opacity. */
const RING_OPACITY = 0.55;

/** Point light intensity at base. */
const LIGHT_INTENSITY = 2.0;

/** Point light range (metres). */
const LIGHT_RANGE = 40;

// ── Colors ───────────────────────────────────────────────────────────────────

const COLOR_TOWNHALL  = new THREE.Color(0xdaa520); // warm gold     — seat of authority
const COLOR_MEDICAL   = new THREE.Color(0xee4444); // red           — hospital / clinic / doctors
const COLOR_LIBRARY   = new THREE.Color(0x4488cc); // cool blue     — knowledge
const COLOR_EMERGENCY = new THREE.Color(0xff8800); // orange        — fire station / police
const COLOR_SCHOOL    = new THREE.Color(0x44bb88); // teal          — community shelter
const COLOR_DEFAULT   = new THREE.Color(0xbbaa77); // neutral warm

// ── Atmosphere tuning ────────────────────────────────────────────────────────

/** Mote particles per beacon. Sparse on purpose. */
const MOTE_COUNT  = 90;
/** Cylinder radius the motes drift within (metres). */
const MOTE_RADIUS = 22;
/** Max height motes rise before resetting (metres). */
const MOTE_HEIGHT = 16;
/** Point size of each mote (metres, attenuated by distance). */
const MOTE_SIZE   = 0.35;
/** Horizontal sway amplitude (metres). */
const MOTE_SWAY   = 1.4;

/** Radius of the worn-ground decal (metres). */
const DECAL_RADIUS = 11;

// ── Beacon instance ──────────────────────────────────────────────────────────

interface BeaconInstance {
  group:        THREE.Group;
  ring:         THREE.Mesh;
  upperRing:    THREE.Mesh;
  beamMats:     THREE.MeshBasicMaterial[];
  ringMat:      THREE.MeshBasicMaterial;
  upperRingMat: THREE.MeshBasicMaterial;
  light:        THREE.PointLight;
  phase:        number;
  // Atmosphere
  motes:        THREE.Points;
  motePos:      Float32Array; // raw positions buffer (3 floats per mote)
  moteMeta:     Float32Array; // [baseX, baseZ, startY, riseSpeed, swayPhase] per mote
  moteAge:      Float32Array; // current Y offset progress per mote (0→MOTE_HEIGHT)
  decal:        THREE.Mesh;
}

// ── WardBeaconManager ────────────────────────────────────────────────────────

export class WardBeaconManager {
  private beacons: BeaconInstance[] = [];
  /** Plain anchor data kept alongside `beacons` for cheap distance queries
   *  (e.g. respec gating). Same length and order as `beacons`. */
  private anchors: AnchorData[] = [];
  private age = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private zoneId?: string,
  ) {
    if (this.zoneId) this._fetchAnchors();
  }

  /** Switch to a new zone — clears existing beacons and re-fetches anchors. */
  loadForZone(zoneId: string): void {
    this.zoneId = zoneId;
    // Clear existing beacons
    for (const b of this.beacons) {
      this.scene.remove(b.group);
      for (const mat of b.beamMats) { mat.map?.dispose(); mat.dispose(); }
      b.ringMat.dispose();
      b.ring.geometry.dispose();
      b.upperRingMat.dispose();
      b.upperRing.geometry.dispose();
      b.light.dispose();
    }
    this.beacons = [];
    this.anchors = [];
    this._fetchAnchors();
  }

  /** True when (worldX, worldZ) lies inside any beacon's wardRadius.
   *  Used by respec UI to enable/disable the button without a server round-trip. */
  isPositionInRange(worldX: number, worldZ: number): boolean {
    for (const a of this.anchors) {
      const dx = worldX - a.worldX;
      const dz = worldZ - a.worldZ;
      if (dx * dx + dz * dz <= a.wardRadius * a.wardRadius) return true;
    }
    return false;
  }

  // ── Anchor fetch ───────────────────────────────────────────────────────────

  private async _fetchAnchors(): Promise<void> {
    if (!this.zoneId) {
      // No zone — place fallback beacons and bail
      this.anchors = FALLBACK_ANCHORS.slice();
      for (const anchor of FALLBACK_ANCHORS) this._createBeacon(anchor);
      return;
    }

    let anchors: AnchorData[] = [];

    try {
      const url = `/api/map/anchors?zoneId=${encodeURIComponent(this.zoneId)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const raw = data.anchors ?? [];
        anchors = raw.map((a: Record<string, unknown>) => ({
          worldX: (a.worldX as number) ?? 0,
          worldY: (a.worldY as number) ?? 0,
          worldZ: (a.worldZ as number) ?? 0,
          wardRadius: a.wardRadius as number,
          type: (a.type as string) ?? undefined,
          name: (a.name as string) ?? undefined,
        }));
      }
    } catch { /* fall through to fallback */ }

    if (anchors.length === 0) {
      anchors = FALLBACK_ANCHORS;
    }

    this.anchors = anchors.slice();
    for (const anchor of anchors) {
      this._createBeacon(anchor);
    }
  }

  // ── Create a single beacon ─────────────────────────────────────────────────

  private _createBeacon(anchor: AnchorData): void {
    // worldY from the DB is 0 — but the terrain is a real DEM heightmap
    // that sits much higher.  Raycast down to find the actual ground.
    const groundY = this._findGroundY(anchor.worldX, anchor.worldZ, anchor.worldY);

    const group = new THREE.Group();
    group.position.set(anchor.worldX, groundY, anchor.worldZ);

    const color = this._colorForType(anchor.type);
    const phase = Math.random() * Math.PI * 2;

    // ── Light beam (two crossed planes forming an X) ─────────────────────
    const beamGeo = new THREE.PlaneGeometry(BEAM_WIDTH, BEAM_HEIGHT);
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);

    const beamMats: THREE.MeshBasicMaterial[] = [];
    const beamTex = WardBeaconManager._makeBeamTexture();

    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: beamTex,
        color,
        transparent: true,
        opacity: BEAM_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      beamMats.push(mat);

      const plane = new THREE.Mesh(beamGeo, mat);
      plane.rotation.y = (i * Math.PI) / 2;
      plane.frustumCulled = false;
      group.add(plane);
    }

    // ── Ward ring (base) ─────────────────────────────────────────────────
    const ringGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: RING_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = RING_HEIGHT;
    ring.frustumCulled = false;
    group.add(ring);

    // ── Upper ring (decorative, counter-rotates) ─────────────────────────
    const upperRingGeo = new THREE.TorusGeometry(RING_RADIUS * 0.5, RING_TUBE * 0.7, 6, 32);
    const upperRingMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: RING_OPACITY * 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const upperRing = new THREE.Mesh(upperRingGeo, upperRingMat);
    upperRing.rotation.x = -Math.PI / 2;
    upperRing.position.y = BEAM_HEIGHT * 0.35;
    upperRing.frustumCulled = false;
    group.add(upperRing);

    // ── Point light for ground glow ──────────────────────────────────────
    const light = new THREE.PointLight(color, LIGHT_INTENSITY, LIGHT_RANGE);
    light.position.y = 5;
    group.add(light);

    // ── Drifting motes ───────────────────────────────────────────────────
    const { motes, motePos, moteMeta, moteAge } = this._createMotes(color);
    group.add(motes);

    // ── Worn ground decal ────────────────────────────────────────────────
    const decal = this._createGroundDecal(color);
    group.add(decal);

    this.scene.add(group);

    this.beacons.push({
      group, ring, upperRing, beamMats, ringMat, upperRingMat, light, phase,
      motes, motePos, moteMeta, moteAge, decal,
    });
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** Hide or show all beacons (e.g. suppress in vault zones). */
  setVisible(visible: boolean): void {
    for (const b of this.beacons) {
      b.group.visible = visible;
    }
  }

  // ── Frame update ───────────────────────────────────────────────────────────

  update(dt: number): void {
    this.age += dt;

    for (const b of this.beacons) {
      // Spin rings
      b.ring.rotation.z += RING_SPIN_SPEED * dt;
      b.upperRing.rotation.z -= RING_SPIN_SPEED * 0.7 * dt;

      // Opacity pulse
      const pulse = Math.sin(this.age * PULSE_SPEED * Math.PI * 2 + b.phase);
      const beamPulse = pulse * PULSE_AMPLITUDE;
      for (const mat of b.beamMats) {
        mat.opacity = BEAM_OPACITY + beamPulse;
      }
      b.ringMat.opacity = RING_OPACITY + beamPulse;
      b.upperRingMat.opacity = RING_OPACITY * 0.7 + beamPulse * 0.7;

      // Pulse the light too
      b.light.intensity = LIGHT_INTENSITY + pulse * 0.5;

      // Drift motes upward, sway horizontally, wrap on overflow
      for (let i = 0; i < MOTE_COUNT; i++) {
        const mi = i * 5;
        const bx = b.moteMeta[mi]!;
        const bz = b.moteMeta[mi + 1]!;
        const sy = b.moteMeta[mi + 2]!;
        const sp = b.moteMeta[mi + 3]!;
        const ph = b.moteMeta[mi + 4]!;

        b.moteAge[i]! += dt * sp;
        if (b.moteAge[i]! > MOTE_HEIGHT) b.moteAge[i]! -= MOTE_HEIGHT;

        const t   = this.age + ph;
        const pi3 = i * 3;
        b.motePos[pi3]!     = bx + Math.sin(t * 0.31 + ph) * MOTE_SWAY;
        b.motePos[pi3 + 1]! = sy + b.moteAge[i]!;
        b.motePos[pi3 + 2]! = bz + Math.cos(t * 0.27 + ph) * MOTE_SWAY;
      }
      (b.motes.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /**
   * Re-raycast all beacons onto the terrain.  Call this after the world
   * geometry has finished loading (the initial raycast fires before the
   * GLBs are in the scene so it always misses).
   */
  repositionOnTerrain(): void {
    for (const b of this.beacons) {
      const { x, z } = b.group.position;
      b.group.position.y = this._findGroundY(x, z, b.group.position.y);
    }
  }

  // ── Atmosphere helpers ─────────────────────────────────────────────────────

  private _createMotes(color: THREE.Color): {
    motes: THREE.Points; motePos: Float32Array;
    moteMeta: Float32Array; moteAge: Float32Array;
  } {
    const motePos  = new Float32Array(MOTE_COUNT * 3);
    const moteMeta = new Float32Array(MOTE_COUNT * 5);
    const moteAge  = new Float32Array(MOTE_COUNT);

    for (let i = 0; i < MOTE_COUNT; i++) {
      // Distribute uniformly in a disc using rejection sampling approximation
      const angle = Math.random() * Math.PI * 2;
      const r     = Math.sqrt(Math.random()) * MOTE_RADIUS;
      const bx    = Math.cos(angle) * r;
      const bz    = Math.sin(angle) * r;
      const sy    = Math.random() * MOTE_HEIGHT; // staggered start heights
      const sp    = 0.4 + Math.random() * 0.8;   // rise speed m/s
      const ph    = Math.random() * Math.PI * 2;  // sway phase

      moteMeta.set([bx, bz, sy, sp, ph], i * 5);
      moteAge[i]  = Math.random() * MOTE_HEIGHT;

      motePos.set([bx, sy + moteAge[i]!, bz], i * 3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));

    const mat = new THREE.PointsMaterial({
      color:           color.clone().lerp(new THREE.Color(0xffffff), 0.5),
      size:            MOTE_SIZE,
      sizeAttenuation: true,
      transparent:     true,
      opacity:         0.28,
      depthWrite:      false,
      blending:        THREE.AdditiveBlending,
    });

    const motes = new THREE.Points(geo, mat);
    motes.frustumCulled = false;
    return { motes, motePos, moteMeta, moteAge };
  }

  private _createGroundDecal(color: THREE.Color): THREE.Mesh {
    const geo = new THREE.CircleGeometry(DECAL_RADIUS, 48);
    geo.rotateX(-Math.PI / 2);

    const tex = WardBeaconManager._makeDecalTexture(color);
    const mat = new THREE.MeshBasicMaterial({
      map:               tex,
      transparent:       true,
      opacity:           0.22,
      depthWrite:        false,
      blending:          THREE.NormalBlending,
      polygonOffset:     true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.05; // just above terrain surface
    mesh.frustumCulled = false;
    return mesh;
  }

  private static _decalCache = new Map<string, THREE.Texture>();

  private static _makeDecalTexture(color: THREE.Color): THREE.Texture {
    const key = color.getHexString();
    if (WardBeaconManager._decalCache.has(key)) return WardBeaconManager._decalCache.get(key)!;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;

    // Worn earth — faint radial fill, darkened toward centre
    const fill = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    fill.addColorStop(0,   `rgba(${Math.round(color.r*80)},${Math.round(color.g*70)},${Math.round(color.b*60)}, 0.55)`);
    fill.addColorStop(0.5, `rgba(${Math.round(color.r*60)},${Math.round(color.g*55)},${Math.round(color.b*45)}, 0.25)`);
    fill.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, size, size);

    // Worn concentric scuff rings — like foot traffic
    ctx.strokeStyle = `rgba(200,190,170, 0.12)`;
    for (const rPct of [0.35, 0.62, 0.82]) {
      ctx.beginPath();
      ctx.arc(cx, cx, cx * rPct, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 + Math.random();
      // Break the ring into arcs to look worn, not painted
      for (let a = 0; a < Math.PI * 2; a += 0.18 + Math.random() * 0.25) {
        const span = 0.08 + Math.random() * 0.18;
        ctx.beginPath();
        ctx.arc(cx, cx, cx * rPct, a, a + span);
        ctx.stroke();
      }
    }

    // Scatter faint random marks inside the inner ring
    ctx.fillStyle = 'rgba(210,200,180, 0.08)';
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * cx * 0.55;
      ctx.fillRect(cx + Math.cos(a) * r - 1, cx + Math.sin(a) * r - 1, 2 + Math.random() * 3, 1);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    WardBeaconManager._decalCache.set(key, tex);
    return tex;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    for (const b of this.beacons) {
      this.scene.remove(b.group);
      for (const mat of b.beamMats) {
        mat.map?.dispose();
        mat.dispose();
      }
      b.ringMat.dispose();
      b.ring.geometry.dispose();
      b.upperRingMat.dispose();
      b.upperRing.geometry.dispose();
      b.light.dispose();
      (b.motes.material as THREE.PointsMaterial).dispose();
      b.motes.geometry.dispose();
      (b.decal.material as THREE.MeshBasicMaterial).dispose();
      b.decal.geometry.dispose();

      const firstBeamChild = b.group.children[0] as THREE.Mesh | undefined;
      firstBeamChild?.geometry.dispose();
    }
    this.beacons = [];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Raycast straight down from high above to find the terrain surface at (x, z).
   * Falls back to `fallbackY` if no terrain mesh is hit (e.g. scene not loaded yet).
   */
  private _findGroundY(x: number, z: number, fallbackY: number): number {
    const ray = new THREE.Raycaster(
      new THREE.Vector3(x, 2000, z),   // well above any terrain
      new THREE.Vector3(0, -1, 0),      // straight down
    );
    const hits = ray.intersectObjects(this.scene.children, true);
    if (hits.length > 0 && hits[0]) {
      return hits[0].point.y;
    }
    return fallbackY;
  }

  private _colorForType(type?: string): THREE.Color {
    if (!type) return COLOR_DEFAULT.clone();
    switch (type.toUpperCase()) {
      case 'TOWNHALL':                          return COLOR_TOWNHALL.clone();
      case 'HOSPITAL': case 'CLINIC':
      case 'DOCTORS':                           return COLOR_MEDICAL.clone();
      case 'LIBRARY': case 'POST_OFFICE':
      case 'COMMUNITY_CENTRE': case 'SOCIAL_CENTRE':
      case 'PLACE_OF_WORSHIP':                  return COLOR_LIBRARY.clone();
      case 'FIRE_STATION': case 'POLICE':       return COLOR_EMERGENCY.clone();
      case 'SCHOOL':                            return COLOR_SCHOOL.clone();
      default:                                  return COLOR_DEFAULT.clone();
    }
  }

  // ── Beam gradient texture ──────────────────────────────────────────────────

  private static _beamTexture: THREE.Texture | null = null;

  private static _makeBeamTexture(): THREE.Texture {
    if (WardBeaconManager._beamTexture) return WardBeaconManager._beamTexture;

    const w = 1;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Vertical gradient: strong at bottom, fading toward top.
    // Stays brighter longer so the beam is visible from distance.
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0,    'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.08, 'rgba(255, 255, 255, 0.9)');
    grad.addColorStop(0.25, 'rgba(255, 255, 255, 0.6)');
    grad.addColorStop(0.5,  'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.1)');
    grad.addColorStop(1.0,  'rgba(255, 255, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    WardBeaconManager._beamTexture = tex;
    return tex;
  }
}
