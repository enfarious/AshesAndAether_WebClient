import * as THREE from 'three';
import { BeaconAura } from './BeaconAura';

/**
 * GuildBeaconManager — guild-claimed pylons in deep miasma.
 *
 * Sibling to WardBeaconManager (civic ward beacons). Same visual primitive
 * (crossed beam planes + rotating rings + ground decal + drifting motes),
 * scaled to 80% and tinted purple so the type difference reads at a glance.
 *
 * Fetched from /api/guild-beacons?zoneId=... on zone change. Live placements
 * arrive as `event` payloads with eventType='guild_beacon_placed' so the
 * mesh appears without a re-zone.
 */

export interface GuildBeaconData {
  id:           string;
  guildId:      string;
  guildName:    string;
  worldX:       number;
  worldY:       number;
  worldZ:       number;
  effectRadius: number;
}

// ── Tuning (80% of WardBeacon's values) ──────────────────────────────────────
const SCALE = 0.8;

const BEAM_HEIGHT = 80 * SCALE;
const BEAM_WIDTH  = 8  * SCALE;
const RING_RADIUS = 6  * SCALE;
const RING_HEIGHT = 2  * SCALE;
const RING_TUBE   = 0.4 * SCALE;
const RING_SPIN_SPEED = 0.4;
const PULSE_SPEED     = 0.25;
const BEAM_OPACITY    = 0.45;
const PULSE_AMPLITUDE = 0.1;
const RING_OPACITY    = 0.55;
const LIGHT_INTENSITY = 2.0;
const LIGHT_RANGE     = 40 * SCALE;

const MOTE_COUNT  = 90;
const MOTE_RADIUS = 22 * SCALE;
const MOTE_HEIGHT = 16 * SCALE;
const MOTE_SIZE   = 0.35 * SCALE;
const MOTE_SWAY   = 1.4 * SCALE;

const DECAL_RADIUS = 11 * SCALE;

// Guild-beacon hue. Saturated mid-purple — distinctly NOT civic gold/blue.
const COLOR_GUILD = new THREE.Color(0x9933ff);

interface BeaconInstance {
  data:         GuildBeaconData;
  group:        THREE.Group;
  ring:         THREE.Mesh;
  upperRing:    THREE.Mesh;
  beamMats:     THREE.MeshBasicMaterial[];
  ringMat:      THREE.MeshBasicMaterial;
  upperRingMat: THREE.MeshBasicMaterial;
  light:        THREE.PointLight;
  phase:        number;
  motes:        THREE.Points;
  motePos:      Float32Array;
  moteMeta:     Float32Array;
  moteAge:      Float32Array;
  decal:        THREE.Mesh;
  /** Translucent ground disc + dome marking the safe zone. Owned by this
   *  beacon and sized to its effectRadius. Disposed alongside the rest. */
  aura:         BeaconAura;
}

/** Vertical clearance above the beacon foot for the dome apex. 50 m
 *  comfortably clears mature trees (~22 m today) with headroom; revisit
 *  once tree heights are bumped per the spawned follow-up task. */
const GUILD_DOME_HEIGHT_M = 50;

export class GuildBeaconManager {
  private beacons: BeaconInstance[] = [];
  private age = 0;
  private zoneId?: string;

  constructor(
    private readonly scene: THREE.Scene,
    /** Returns the terrain root for the active zone — beacon auras
     *  raycast against this only, so tree canopies / mob meshes /
     *  beacons themselves don't intercept the ground-Y lookup. */
    private readonly getTerrainRoot?: () => THREE.Object3D | null,
  ) {}

  /** Switch to a new zone — clears existing beacons and re-fetches. */
  loadForZone(zoneId: string): void {
    this.zoneId = zoneId;
    this._clearAll();
    void this._fetch();
  }

  /** Add a single beacon at runtime (e.g. from a `guild_beacon_placed`
   *  event). Idempotent on beacon id — duplicate adds are ignored so a
   *  fetch + live event race can't double-render. */
  addBeacon(data: GuildBeaconData): void {
    if (this.beacons.some((b) => b.data.id === data.id)) return;
    this._createBeacon(data);
  }

  setVisible(visible: boolean): void {
    for (const b of this.beacons) {
      b.group.visible = visible;
      b.aura.setVisible(visible);
    }
  }

  /** Snapshot of (worldX, worldZ, effectRadius) for every lit guild beacon.
   *  Used by MiasmaGroundFog to subtract pushback per-fragment in the
   *  shader so the fog visibly clears inside a beacon's bubble. */
  beaconList(): Array<{ x: number; z: number; r: number }> {
    return this.beacons.map((b) => ({ x: b.data.worldX, z: b.data.worldZ, r: b.data.effectRadius }));
  }

  /** Re-raycast onto the terrain after world geometry finishes loading.
   *  Fires the aura rebuild too so the disc snaps onto the freshly
   *  loaded heightmap instead of staying flat at the fallback Y. */
  repositionOnTerrain(): void {
    for (const b of this.beacons) {
      const { x, z } = b.group.position;
      const groundY = this._findGroundY(x, z, b.group.position.y);
      b.group.position.y = groundY;
      b.aura.reposition(new THREE.Vector3(x, groundY, z));
    }
  }

  update(dt: number): void {
    this.age += dt;
    for (const b of this.beacons) {
      b.ring.rotation.z      += RING_SPIN_SPEED * dt;
      b.upperRing.rotation.z -= RING_SPIN_SPEED * 0.7 * dt;

      const pulse = Math.sin(this.age * PULSE_SPEED * Math.PI * 2 + b.phase);
      const beamPulse = pulse * PULSE_AMPLITUDE;
      for (const mat of b.beamMats) mat.opacity = BEAM_OPACITY + beamPulse;
      b.ringMat.opacity      = RING_OPACITY + beamPulse;
      b.upperRingMat.opacity = RING_OPACITY * 0.7 + beamPulse * 0.7;
      b.light.intensity      = LIGHT_INTENSITY + pulse * 0.5;

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
      b.aura.update(dt);
    }
  }

  dispose(): void {
    this._clearAll();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _fetch(): Promise<void> {
    if (!this.zoneId) return;
    try {
      const url = `/api/guild-beacons?zoneId=${encodeURIComponent(this.zoneId)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const list = (data.beacons ?? []) as GuildBeaconData[];
      for (const b of list) this.addBeacon(b);
    } catch { /* silent — empty fetch is the same as no beacons */ }
  }

  private _clearAll(): void {
    for (const b of this.beacons) {
      this.scene.remove(b.group);
      for (const mat of b.beamMats) { mat.map?.dispose(); mat.dispose(); }
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
      b.aura.dispose();
    }
    this.beacons = [];
  }

  /** Rebuild every aura's geometry — called by app.ts after the player
   *  changes the Beacon Detail setting so existing bubbles in the world
   *  pick up the new subdivision count. */
  rebuildAuras(): void {
    for (const b of this.beacons) b.aura.rebuild();
  }

  private _createBeacon(data: GuildBeaconData): void {
    const groundY = this._findGroundY(data.worldX, data.worldZ, data.worldY);

    const group = new THREE.Group();
    group.position.set(data.worldX, groundY, data.worldZ);

    const color = COLOR_GUILD.clone();
    const phase = Math.random() * Math.PI * 2;

    // Light beam
    const beamGeo = new THREE.PlaneGeometry(BEAM_WIDTH, BEAM_HEIGHT);
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    const beamMats: THREE.MeshBasicMaterial[] = [];
    const beamTex = GuildBeaconManager._makeBeamTexture();
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

    // Lower ring
    const ringGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: RING_OPACITY,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = RING_HEIGHT;
    ring.frustumCulled = false;
    group.add(ring);

    // Upper ring
    const upperRingGeo = new THREE.TorusGeometry(RING_RADIUS * 0.5, RING_TUBE * 0.7, 6, 32);
    const upperRingMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: RING_OPACITY * 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const upperRing = new THREE.Mesh(upperRingGeo, upperRingMat);
    upperRing.rotation.x = -Math.PI / 2;
    upperRing.position.y = BEAM_HEIGHT * 0.35;
    upperRing.frustumCulled = false;
    group.add(upperRing);

    // Ground glow
    const light = new THREE.PointLight(color, LIGHT_INTENSITY, LIGHT_RANGE);
    light.position.y = 5 * SCALE;
    group.add(light);

    // Motes
    const { motes, motePos, moteMeta, moteAge } = this._createMotes(color);
    group.add(motes);

    // Decal
    const decal = this._createGroundDecal(color);
    group.add(decal);

    this.scene.add(group);

    // Translucent disc + dome covering the beacon's effect radius.
    // Lives in WORLD space, not as a child of `group`, because its disc
    // vertices raycast against scene terrain — the raycast already
    // accounts for the beacon's world position internally.
    const aura = new BeaconAura({
      scene:      this.scene,
      position:   new THREE.Vector3(data.worldX, groundY, data.worldZ),
      radius:     data.effectRadius,
      domeHeight: GUILD_DOME_HEIGHT_M,
      mode:       'guild',
      // Aura tint matches the beacon's mesh color so the ground ring +
      // dome read as part of the same effect, not separate decorations.
      color:      COLOR_GUILD.clone(),
      getRaycastTargets: () => {
        const root = this.getTerrainRoot?.();
        return root ? [root] : null;
      },
    });

    this.beacons.push({
      data, group, ring, upperRing, beamMats, ringMat, upperRingMat, light, phase,
      motes, motePos, moteMeta, moteAge, decal, aura,
    });
  }

  private _createMotes(color: THREE.Color): {
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
      const sp    = 0.4 + Math.random() * 0.8;
      const ph    = Math.random() * Math.PI * 2;
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
    const tex = GuildBeaconManager._makeDecalTexture(color);
    const mat = new THREE.MeshBasicMaterial({
      map:                 tex,
      transparent:         true,
      opacity:             0.22,
      depthWrite:          false,
      blending:            THREE.NormalBlending,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.05;
    mesh.frustumCulled = false;
    return mesh;
  }

  private _findGroundY(x: number, z: number, fallbackY: number): number {
    const ray = new THREE.Raycaster(
      new THREE.Vector3(x, 2000, z),
      new THREE.Vector3(0, -1, 0),
    );
    const hits = ray.intersectObjects(this.scene.children, true);
    if (hits.length > 0 && hits[0]) return hits[0].point.y;
    return fallbackY;
  }

  // ── Shared static textures (one per color, cached) ────────────────────────

  private static _beamTexture: THREE.Texture | null = null;
  private static _decalCache  = new Map<string, THREE.Texture>();

  private static _makeBeamTexture(): THREE.Texture {
    if (GuildBeaconManager._beamTexture) return GuildBeaconManager._beamTexture;
    const w = 1, h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
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
    GuildBeaconManager._beamTexture = tex;
    return tex;
  }

  private static _makeDecalTexture(color: THREE.Color): THREE.Texture {
    const key = color.getHexString();
    if (GuildBeaconManager._decalCache.has(key)) return GuildBeaconManager._decalCache.get(key)!;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const fill = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    fill.addColorStop(0,   `rgba(${Math.round(color.r*80)},${Math.round(color.g*70)},${Math.round(color.b*60)}, 0.55)`);
    fill.addColorStop(0.5, `rgba(${Math.round(color.r*60)},${Math.round(color.g*55)},${Math.round(color.b*45)}, 0.25)`);
    fill.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = `rgba(200,190,170, 0.12)`;
    for (const rPct of [0.35, 0.62, 0.82]) {
      ctx.beginPath();
      ctx.arc(cx, cx, cx * rPct, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 + Math.random();
      for (let a = 0; a < Math.PI * 2; a += 0.18 + Math.random() * 0.25) {
        const span = 0.08 + Math.random() * 0.18;
        ctx.beginPath();
        ctx.arc(cx, cx, cx * rPct, a, a + span);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(210,200,180, 0.08)';
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * cx * 0.55;
      ctx.fillRect(cx + Math.cos(a) * r - 1, cx + Math.sin(a) * r - 1, 2 + Math.random() * 3, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    GuildBeaconManager._decalCache.set(key, tex);
    return tex;
  }
}
