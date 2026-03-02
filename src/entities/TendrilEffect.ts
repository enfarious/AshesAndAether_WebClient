import * as THREE from 'three';

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Number of tendrils per death effect. */
const TENDRIL_COUNT    = 7;

/** Maximum height a tendril grows to (metres). */
const TENDRIL_HEIGHT   = 2.4;

/** Number of line segments per tendril. */
const TENDRIL_SEGMENTS = 14;

/** Seconds for tendrils to fully emerge from the ground. */
const GROW_DURATION    = 1.2;

/** Seconds for tendrils to fade out once beginFade() is called. */
const FADE_DURATION    = 0.9;

/** Radial spread from the death position (metres). */
const SPREAD_RADIUS    = 0.55;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tendril {
  line:       THREE.Line;
  mat:        THREE.LineBasicMaterial;
  positions:  Float32Array;
  /** World-space angle this tendril grows toward. */
  angle:      number;
  /** Base XZ offset radius. */
  radius:     number;
  /** Height multiplier (0.6–1.4) — gives varying heights. */
  hMult:      number;
  /** Phase offset for the sway sine function. */
  phase:      number;
  /** Extra spiral twist factor. */
  twist:      number;
}

// ── Effect ────────────────────────────────────────────────────────────────────

/**
 * TendrilEffect — eldritch black tendrils that emerge from the ground at the
 * position of a dying entity and slowly consume the corpse.
 *
 * Lifecycle:
 *   1. Grow phase  (0 → GROW_DURATION): tendrils push out of the earth.
 *   2. Active phase: tendrils writhe, awaiting beginFade().
 *   3. Fade phase   (FADE_DURATION): opacity drains to 0.
 *
 * For mobs, the CorpseSystem calls beginFade() when the entity is removed.
 * For players, it calls beginFade() when isAlive becomes true again.
 * Short dissolves (<= 10 s) auto-schedule a beginFade() internally.
 */
export class TendrilEffect {
  private group:      THREE.Group;
  private tendrils:   Tendril[] = [];
  private age         = 0;
  /** Age at which fade started; -1 = not yet fading. */
  private fadeAge     = -1;
  private _disposed   = false;
  /** If positive, auto-begin-fade at this age. */
  private autoFadeAt: number;

  constructor(
    scene:    THREE.Scene,
    position: THREE.Vector3,
    /** Game-world seconds until corpse dissolves (e.g. 4 for mobs, 3600 for players). */
    dissolveDurationSeconds: number,
  ) {
    this.group = new THREE.Group();
    this.group.position.copy(position);
    scene.add(this.group);

    // For short dissolves, auto-trigger fade so the effect fits within the window.
    // For long dissolves (players), don't auto-fade — caller drives it.
    this.autoFadeAt = dissolveDurationSeconds <= 30
      ? Math.max(GROW_DURATION, dissolveDurationSeconds - FADE_DURATION)
      : Infinity;

    for (let i = 0; i < TENDRIL_COUNT; i++) {
      const angle  = (i / TENDRIL_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const radius = SPREAD_RADIUS * (0.4 + Math.random() * 0.6);
      const hMult  = 0.6 + Math.random() * 0.8;
      const phase  = Math.random() * Math.PI * 2;
      const twist  = (Math.random() - 0.5) * 2.0;

      const count     = (TENDRIL_SEGMENTS + 1) * 3;
      const positions = new Float32Array(count);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // Two material layers per tendril:
      //   core  — near-black with faint indigo hint
      //   glow  — transparent deep purple for a spectral rim
      // We create two Line objects for each tendril path.
      const coreMat = new THREE.LineBasicMaterial({
        color:       0x08000f,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
      });

      const glowGeo = new THREE.BufferGeometry();
      glowGeo.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
      const glowMat = new THREE.LineBasicMaterial({
        color:       0x3a0066,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
      });

      const coreLine = new THREE.Line(geo, coreMat);
      const glowLine = new THREE.Line(glowGeo, glowMat);

      this.group.add(coreLine, glowLine);
      this.tendrils.push({ line: coreLine, mat: coreMat, positions, angle, radius, hMult, phase, twist });

      // Keep glow geometry reference so we can update it each frame.
      // We abuse userData to store the glow pair.
      (coreLine as THREE.Object3D).userData['glowLine'] = glowLine;
      (coreLine as THREE.Object3D).userData['glowMat']  = glowMat;
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Signal that the effect should begin fading out. */
  beginFade(): void {
    if (this.fadeAge < 0) this.fadeAge = this.age;
  }

  /**
   * Advance the effect by dt seconds.
   * Returns true when the effect is fully faded and can be disposed.
   */
  update(dt: number): boolean {
    if (this._disposed) return true;
    this.age += dt;

    // Auto-fade trigger for short dissolves
    if (this.fadeAge < 0 && this.age >= this.autoFadeAt) {
      this.fadeAge = this.age;
    }

    // Compute master opacity
    const growT   = Math.min(this.age / GROW_DURATION, 1.0);
    let   opacity = growT;

    if (this.fadeAge >= 0) {
      const fadeT = (this.age - this.fadeAge) / FADE_DURATION;
      opacity     = Math.max(0, 1.0 - fadeT);
      if (opacity === 0) return true; // Done
    }

    // Slow sway speed — more unsettling than fast
    const swayT = this.age * 0.55;

    for (const t of this.tendrils) {
      const coreOpacity = opacity * 0.95;
      const glowOpacity = opacity * 0.28;

      t.mat.opacity = coreOpacity;
      const glowMat = (t.line as THREE.Object3D).userData['glowMat'] as THREE.LineBasicMaterial;
      glowMat.opacity = glowOpacity;

      const positions = t.positions;

      for (let j = 0; j <= TENDRIL_SEGMENTS; j++) {
        const segT   = j / TENDRIL_SEGMENTS;
        const height = segT * TENDRIL_HEIGHT * t.hMult * growT;

        // Sway: amplitude increases with height for a whip-like motion.
        const sway1 = Math.sin(swayT + segT * 4.5 + t.phase)     * 0.12 * segT;
        const sway2 = Math.cos(swayT * 1.4 + segT * 3.2 + t.phase) * 0.09 * segT;

        // Spiral curl: adds a slow helical motion that makes the tip arc
        const spiralAngle = t.angle + t.twist * segT * growT + swayT * 0.18;
        const r           = t.radius * (1 - segT * 0.45); // narrower at tip

        positions[j * 3]     = Math.cos(spiralAngle) * r + sway1;
        positions[j * 3 + 1] = height;
        positions[j * 3 + 2] = Math.sin(spiralAngle) * r + sway2;
      }

      const attr = t.line.geometry.attributes['position'] as THREE.BufferAttribute;
      attr.needsUpdate = true;

      // Keep glow geometry in sync
      const glowLine = (t.line as THREE.Object3D).userData['glowLine'] as THREE.Line;
      const glowAttr = glowLine.geometry.attributes['position'] as THREE.BufferAttribute;
      const glowArr  = glowAttr.array as Float32Array;
      glowArr.set(positions);
      glowAttr.needsUpdate = true;
    }

    return false;
  }

  /** Clean up Three.js objects. The effect group is removed from its parent scene. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    for (const t of this.tendrils) {
      const glowLine = (t.line as THREE.Object3D).userData['glowLine'] as THREE.Line | undefined;
      if (glowLine) {
        glowLine.geometry.dispose();
        (glowLine.material as THREE.Material).dispose();
      }
      t.line.geometry.dispose();
      t.mat.dispose();
    }

    this.group.parent?.remove(this.group);
  }
}
