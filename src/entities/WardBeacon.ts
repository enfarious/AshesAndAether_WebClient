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
  { worldX: 0, worldY: 0, worldZ: 0, wardRadius: 500, type: 'TOWNHALL', name: 'Town Hall' },
  { worldX: -125, worldY: 0, worldZ: -70, wardRadius: 300, type: 'LIBRARY', name: 'Library' },
];

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Total height of the light beam (metres). */
const BEAM_HEIGHT = 120;

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

const COLOR_TOWNHALL = new THREE.Color(0xdaa520); // warm gold
const COLOR_LIBRARY  = new THREE.Color(0x4488cc); // cool blue
const COLOR_DEFAULT  = new THREE.Color(0xbbaa77); // neutral warm

// ── Beacon instance ──────────────────────────────────────────────────────────

interface BeaconInstance {
  group: THREE.Group;
  ring: THREE.Mesh;
  upperRing: THREE.Mesh;
  beamMats: THREE.MeshBasicMaterial[];
  ringMat: THREE.MeshBasicMaterial;
  upperRingMat: THREE.MeshBasicMaterial;
  light: THREE.PointLight;
  phase: number;
}

// ── WardBeaconManager ────────────────────────────────────────────────────────

export class WardBeaconManager {
  private beacons: BeaconInstance[] = [];
  private age = 0;

  constructor(
    private readonly scene: THREE.Scene,
  ) {
    this._fetchAnchors();
  }

  // ── Anchor fetch ───────────────────────────────────────────────────────────

  private async _fetchAnchors(): Promise<void> {
    let anchors: AnchorData[] = [];

    try {
      const res = await fetch('/api/map/anchors');
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

    this.scene.add(group);

    this.beacons.push({
      group, ring, upperRing, beamMats, ringMat, upperRingMat, light, phase,
    });
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

      // Dispose shared beam geometry (from first child)
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
    const upper = type.toUpperCase();
    if (upper === 'TOWNHALL') return COLOR_TOWNHALL.clone();
    if (upper === 'LIBRARY')  return COLOR_LIBRARY.clone();
    return COLOR_DEFAULT.clone();
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
