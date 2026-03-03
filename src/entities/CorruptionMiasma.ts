import * as THREE from 'three';

/**
 * CorruptionMiasma — environmental atmospheric effect tied to LOCATION,
 * not the player's personal corruption stat.
 *
 * Computes corruption intensity from the player's distance to the nearest
 * civic ward anchor (townhall, library). Walking away from civilisation
 * makes the world hazier, greener, and filled with drifting wisps.
 *
 * Two layers:
 *  1. Particle wisps: billboarded point sprites drifting around the player.
 *  2. Scene fog modulation: tints FogExp2 and increases density.
 *
 * Designed to be atmospheric, not punishing — players who live in high-
 * corruption zones should see mood, not a wall of green.
 */

// ── Anchor data ──────────────────────────────────────────────────────────────

interface AnchorData {
  worldX: number;
  worldZ: number;
  wardRadius: number;
  wardStrength: number;
}

/** Fallback anchors (Stephentown) if the API is unreachable. */
const FALLBACK_ANCHORS: AnchorData[] = [
  { worldX: 0, worldZ: 0, wardRadius: 500, wardStrength: -0.05 },           // Town Hall
  { worldX: -125, worldZ: -70, wardRadius: 300, wardStrength: -0.03 },      // Library
];

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Total particle pool size. */
const MAX_PARTICLES    = 150;

/** Cylinder radius (metres) around the player where particles spawn. */
const SPAWN_RADIUS_MIN = 10;
const SPAWN_RADIUS_MAX = 50;

/** Height range (metres above ground). */
const HEIGHT_MIN       = 0.5;
const HEIGHT_MAX       = 10;

/** Particle lifetime range (seconds). */
const LIFE_MIN         = 8;
const LIFE_MAX         = 18;

/** Drift speed range (m/s). */
const DRIFT_MIN        = 0.2;
const DRIFT_MAX        = 0.8;

/** Vertical drift (m/s) — wisps slowly rise. */
const RISE_SPEED       = 0.1;

/** Point sprite size range (world units). */
const SIZE_MIN         = 3.0;
const SIZE_MAX         = 7.0;

/**
 * Max active particles at full corruption.
 * Kept moderate so high-corruption zones feel moody, not blinding.
 */
const PARTICLES_AT_MAX = 80;

/** Per-particle opacity at full corruption. */
const OPACITY_AT_MAX   = 0.30;

/** Fog density added at full corruption (scene baseline is ~0.00025). */
const FOG_DENSITY_ADD  = 0.00025;

/** Maximum fog color blend toward corruption tint (0–1). */
const FOG_TINT_MAX     = 0.25;

// ── Colors ───────────────────────────────────────────────────────────────────

/** Wisp color at low corruption (warm grey-green). */
const COLOR_LOW  = new THREE.Color(0x889078);
/** Wisp color at high corruption (sickly green). */
const COLOR_HIGH = new THREE.Color(0x6a7840);

/** Fog tint target at max corruption. */
const FOG_TINT   = new THREE.Color(0x202818);

// ── Particle state ───────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  life: number;
  size: number;
  alive: boolean;
}

// ── CorruptionMiasma ─────────────────────────────────────────────────────────

export class CorruptionMiasma {
  private particles: Particle[] = [];
  private geometry:  THREE.BufferGeometry;
  private material:  THREE.PointsMaterial;
  private points:    THREE.Points;

  private baseFogColor:   THREE.Color;
  private baseFogDensity: number;

  /** Smoothed corruption intensity 0–1. */
  private _intensity = 0;


  /** Ward anchor positions in game-world coordinates. */
  private anchors: AnchorData[] = [];
  private anchorsLoaded = false;

  constructor(
    private readonly scene: THREE.Scene,
  ) {
    // Build particle pool
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        x: 0, y: -9999, z: 0,
        vx: 0, vy: 0, vz: 0,
        age: 0, life: 1, size: 1,
        alive: false,
      });
    }

    // Geometry
    this.geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_PARTICLES * 3);
    const sizes     = new Float32Array(MAX_PARTICLES);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

    // Texture
    const tex = CorruptionMiasma._makeWispTexture();

    // Material
    this.material = new THREE.PointsMaterial({
      map: tex,
      color: COLOR_LOW.clone(),
      size: SIZE_MIN,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Capture fog baseline
    const fog = this.scene.fog as THREE.FogExp2 | null;
    this.baseFogColor   = fog ? fog.color.clone() : new THREE.Color(0x6080a0);
    this.baseFogDensity = fog ? fog.density : 0.00025;

    // Fetch anchor data from server
    this._fetchAnchors();
  }

  // ── Anchor fetch ───────────────────────────────────────────────────────────

  private async _fetchAnchors(): Promise<void> {
    try {
      const res = await fetch('/api/map/anchors');
      if (res.ok) {
        const data = await res.json();
        const raw = data.anchors ?? [];
        this.anchors = raw.map((a: Record<string, number>) => ({
          worldX: a.worldX,
          worldZ: a.worldZ,
          wardRadius: a.wardRadius,
          wardStrength: a.wardStrength,
        }));
      }
    } catch { /* fall through to fallback */ }

    if (this.anchors.length === 0) {
      this.anchors = FALLBACK_ANCHORS;
    }
    this.anchorsLoaded = true;
  }

  // ── Corruption from location ───────────────────────────────────────────────

  /**
   * Compute visual corruption intensity (0–1) at a world position.
   *
   * Uses distance ratio (dist / wardRadius) from the nearest anchor to
   * drive the visual ramp.  This is intentionally decoupled from the
   * corruption *rate* model so that wisps start appearing right at the
   * ward boundary rather than 1000 m out:
   *
   *   ratio <= 1.0  → inside ward: clean (0)
   *   ratio  1–2    → fringe: first wisps appear
   *   ratio  2–3    → wilds:  moderate, clearly corrupted
   *   ratio  3+     → deep:   full miasma
   *
   * Uses smoothstep for a natural onset (no hard pop-in).
   * For a 500 m ward, first wisps at ~550 m, full intensity at ~2000 m.
   */
  private _computeIntensity(wx: number, wz: number): number {
    if (!this.anchorsLoaded || this.anchors.length === 0) return 0;

    // Find the best (smallest) distance ratio across all anchors.
    // This means the closest/strongest ward wins at each point.
    let bestRatio = Infinity;
    for (const a of this.anchors) {
      const dx = wx - a.worldX;
      const dz = wz - a.worldZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const ratio = dist / a.wardRadius;
      if (ratio < bestRatio) bestRatio = ratio;
    }

    // Inside any ward boundary → no corruption visuals.
    if (bestRatio <= 1.0) return 0;

    // Smoothstep ramp from ward edge (1.0) to deep wilderness (4.0).
    // t goes from 0 at the boundary to 1 at 4x the ward radius.
    // For a 500 m ward: first wisps at ~550 m, half at ~1250 m, full at ~2000 m.
    const t = Math.min((bestRatio - 1.0) / 3.0, 1.0);
    return t * t * (3 - 2 * t); // smoothstep: gradual onset, faster middle, soft cap
  }

  // ── Frame update ───────────────────────────────────────────────────────────

  update(
    dt: number,
    playerPos: THREE.Vector3 | { x: number; y: number; z: number },
  ): void {
    // Compute location-based corruption intensity
    const rawIntensity = this._computeIntensity(playerPos.x, playerPos.z);

    // Smooth transitions as player moves between zones
    this._intensity += (rawIntensity - this._intensity) * Math.min(dt * 0.5, 1);

    const t = this._intensity; // 0–1

    // Desired particle count (linear ramp — feels more natural than quadratic)
    const desiredCount = Math.floor(t * PARTICLES_AT_MAX);

    // ── Update existing particles ─────────────────────────────────────────
    const posAttr  = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sizeAttr = this.geometry.getAttribute('size')     as THREE.BufferAttribute;
    const posArr   = posAttr.array as Float32Array;
    const sizeArr  = sizeAttr.array as Float32Array;

    let aliveCount = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i]!;
      if (!p.alive) {
        posArr[i * 3]     = 0;
        posArr[i * 3 + 1] = -9999;
        posArr[i * 3 + 2] = 0;
        sizeArr[i]         = 0;
        continue;
      }

      aliveCount++;

      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        posArr[i * 3 + 1] = -9999;
        sizeArr[i] = 0;
        continue;
      }

      // Drift
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Gentle swirl
      const swirlPhase = p.age * 0.25 + i * 0.7;
      p.x += Math.sin(swirlPhase) * 0.1 * dt;
      p.z += Math.cos(swirlPhase) * 0.1 * dt;

      // Fade envelope: 25% in, 50% sustain, 25% out
      const lifeT = p.age / p.life;
      let fade: number;
      if (lifeT < 0.25)      fade = lifeT / 0.25;
      else if (lifeT > 0.75) fade = (1 - lifeT) / 0.25;
      else                    fade = 1;

      const sizeScale = 1 + lifeT * 0.3;

      posArr[i * 3]     = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;
      sizeArr[i]         = p.size * sizeScale * fade;
    }

    // ── Spawn to reach target ─────────────────────────────────────────────
    if (aliveCount < desiredCount) {
      const toSpawn = Math.min(desiredCount - aliveCount, 2);
      let spawned = 0;
      for (let i = 0; i < MAX_PARTICLES && spawned < toSpawn; i++) {
        if (!this.particles[i]!.alive) {
          this._spawn(this.particles[i]!, playerPos);
          spawned++;
        }
      }
    }

    // ── Gracefully fade excess ────────────────────────────────────────────
    if (aliveCount > desiredCount + 5) {
      let killed = 0;
      const toKill = aliveCount - desiredCount;
      for (let i = MAX_PARTICLES - 1; i >= 0 && killed < toKill; i--) {
        if (this.particles[i]!.alive) {
          this.particles[i]!.life = this.particles[i]!.age + 1.5;
          killed++;
        }
      }
    }

    posAttr.needsUpdate  = true;
    sizeAttr.needsUpdate = true;

    // ── Material ──────────────────────────────────────────────────────────
    this.material.opacity = t * OPACITY_AT_MAX;
    this.material.size    = SIZE_MIN + t * (SIZE_MAX - SIZE_MIN);
    this.material.color.copy(COLOR_LOW).lerp(COLOR_HIGH, t);

    // ── Fog ───────────────────────────────────────────────────────────────
    this._modulateFog(t);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    (this.material.map as THREE.Texture | null)?.dispose();

    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(this.baseFogColor);
      fog.density = this.baseFogDensity;
    }
  }

  recaptureFogBaseline(): void {
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      this.baseFogColor.copy(fog.color);
      this.baseFogDensity = fog.density;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _spawn(
    p: Particle,
    center: { x: number; y: number; z: number },
  ): void {
    const angle  = Math.random() * Math.PI * 2;
    const radius = SPAWN_RADIUS_MIN + Math.random() * (SPAWN_RADIUS_MAX - SPAWN_RADIUS_MIN);

    p.x = center.x + Math.cos(angle) * radius;
    p.y = center.y + HEIGHT_MIN + Math.random() * (HEIGHT_MAX - HEIGHT_MIN);
    p.z = center.z + Math.sin(angle) * radius;

    const driftAngle = Math.random() * Math.PI * 2;
    const driftSpeed = DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN);
    p.vx = Math.cos(driftAngle) * driftSpeed;
    p.vy = RISE_SPEED * (0.5 + Math.random());
    p.vz = Math.sin(driftAngle) * driftSpeed;

    p.age  = 0;
    p.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    p.size = 0.7 + Math.random() * 0.6;
    p.alive = true;
  }

  private _modulateFog(t: number): void {
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (!fog) return;

    // Gentle tint — max 25% blend toward corruption color
    fog.color.copy(this.baseFogColor).lerp(FOG_TINT, t * FOG_TINT_MAX);

    // Gentle density increase — roughly doubles at max corruption
    fog.density = this.baseFogDensity + t * FOG_DENSITY_ADD;
  }

  // ── Texture ────────────────────────────────────────────────────────────────

  private static _makeWispTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0,   'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.15, 'rgba(255, 255, 255, 0.5)');
    grad.addColorStop(0.4,  'rgba(255, 255, 255, 0.12)');
    grad.addColorStop(1,   'rgba(255, 255, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }
}
