import * as THREE from 'three';
import type { ZoneInfo } from '@/network/Protocol';

/**
 * SceneManager — owns the Three.js renderer, scene, and base lighting.
 *
 * Environment changes (day/night cycle, weather) are applied via
 * transitionZone() which smoothly crossfades all light colours, intensities,
 * fog density, and tone-mapping exposure over a configurable duration.
 *
 * Call tick(dt) every frame (before render()) to advance transitions.
 * Call applyZone() for instant snaps (world entry, teleport).
 */
export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene:    THREE.Scene;

  private ambientLight:     THREE.AmbientLight;
  private hemiLight:        THREE.HemisphereLight;
  private directionalLight: THREE.DirectionalLight;
  private fillLight:        THREE.DirectionalLight;

  // ── Environment transitions ────────────────────────────────────────────────
  private envTransition: {
    from:     EnvPreset;
    to:       EnvPreset;
    elapsed:  number;
    duration: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x3a5070);
    this.scene.fog = new THREE.FogExp2(0x6080a0, 0.00025);

    // ── Lighting ──────────────────────────────────────────────────────────
    // Hemisphere: sky colour from above, ground bounce from below.
    this.hemiLight = new THREE.HemisphereLight(
      0xb0c8e0, // sky colour  (cool blue-white)
      0x304820, // ground colour (cool dark green — light bouncing off grass)
      1.2,
    );
    this.scene.add(this.hemiLight);

    // Ambient: lifts the black shadows so nothing is pitch-dark.
    this.ambientLight = new THREE.AmbientLight(0x8090a0, 0.5);
    this.scene.add(this.ambientLight);

    // Key light (sun/moon) — angled to show terrain relief.
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.3);
    this.directionalLight.position.set(200, 400, 150);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);
    this.directionalLight.shadow.camera.near = 1;
    this.directionalLight.shadow.camera.far  = 2000;
    this.directionalLight.shadow.camera.left   = -600;
    this.directionalLight.shadow.camera.right  = 600;
    this.directionalLight.shadow.camera.top    = 600;
    this.directionalLight.shadow.camera.bottom = -600;
    this.directionalLight.shadow.bias = -0.0005;
    this.scene.add(this.directionalLight);

    // Fill/rim from the opposite side.
    this.fillLight = new THREE.DirectionalLight(0x4060a0, 0.4);
    this.fillLight.position.set(-150, 100, -200);
    this.scene.add(this.fillLight);

    window.addEventListener('resize', this._onResize);
  }

  // ── Zone environment ──────────────────────────────────────────────────────

  /**
   * Instantly apply a zone environment — use on initial world entry or teleport.
   * Cancels any in-progress transition.
   */
  applyZone(zone: ZoneInfo): void {
    this.envTransition = null;
    this._applyPreset(resolveEnvironment(zone));
  }

  /**
   * Smoothly crossfade from the current environment to the new zone environment.
   * @param durationSecs  Seconds to complete the fade (default 20 s).
   */
  transitionZone(zone: ZoneInfo, durationSecs = 20): void {
    const to = resolveEnvironment(zone);
    // If we are mid-transition, start the new fade from wherever we currently are.
    const from = this._capturePreset();
    this.envTransition = { from, to, elapsed: 0, duration: durationSecs };
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * Advance any in-progress environment transition.
   * Must be called once per frame, before render().
   */
  tick(dt: number): void {
    if (!this.envTransition) return;
    const tr = this.envTransition;
    tr.elapsed = Math.min(tr.elapsed + dt, tr.duration);
    const t = _easeInOut(tr.elapsed / tr.duration);
    this._applyLerped(tr.from, tr.to, t);
    if (tr.elapsed >= tr.duration) this.envTransition = null;
  }

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }

  private _onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  // ── Preset helpers ────────────────────────────────────────────────────────

  /** Write an EnvPreset directly to all lights / fog / renderer. */
  private _applyPreset(env: EnvPreset): void {
    this.scene.background = new THREE.Color(env.skyColor);
    (this.scene.fog as THREE.FogExp2).color.set(env.fogColor);
    (this.scene.fog as THREE.FogExp2).density = env.fogDensity;

    this.hemiLight.color.set(env.hemiSkyColor);
    this.hemiLight.groundColor.set(env.hemiGroundColor);
    this.hemiLight.intensity = env.hemiIntensity;

    this.ambientLight.color.set(env.ambientColor);
    this.ambientLight.intensity = env.ambientIntensity;

    this.directionalLight.color.set(env.sunColor);
    this.directionalLight.intensity = env.sunIntensity;

    this.fillLight.color.set(env.fillColor);
    this.fillLight.intensity = env.fillIntensity;

    this.renderer.toneMappingExposure = env.exposure;
  }

  /** Read current scene state back into an EnvPreset (for transition start). */
  private _capturePreset(): EnvPreset {
    return {
      skyColor:         (this.scene.background as THREE.Color).getHex(),
      fogColor:         (this.scene.fog as THREE.FogExp2).color.getHex(),
      fogDensity:       (this.scene.fog as THREE.FogExp2).density,
      hemiSkyColor:     this.hemiLight.color.getHex(),
      hemiGroundColor:  this.hemiLight.groundColor.getHex(),
      hemiIntensity:    this.hemiLight.intensity,
      ambientColor:     this.ambientLight.color.getHex(),
      ambientIntensity: this.ambientLight.intensity,
      sunColor:         this.directionalLight.color.getHex(),
      sunIntensity:     this.directionalLight.intensity,
      fillColor:        this.fillLight.color.getHex(),
      fillIntensity:    this.fillLight.intensity,
      exposure:         this.renderer.toneMappingExposure,
    };
  }

  /** Interpolate every field between two presets at position t ∈ [0, 1]. */
  private _applyLerped(from: EnvPreset, to: EnvPreset, t: number): void {
    const lc = (a: number, b: number): number => {
      const ca = new THREE.Color(a);
      const cb = new THREE.Color(b);
      return ca.lerp(cb, t).getHex();
    };
    const ln = (a: number, b: number): number => a + (b - a) * t;

    this.scene.background = new THREE.Color(lc(from.skyColor, to.skyColor));

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(lc(from.fogColor, to.fogColor));
    fog.density = ln(from.fogDensity, to.fogDensity);

    this.hemiLight.color.set(lc(from.hemiSkyColor, to.hemiSkyColor));
    this.hemiLight.groundColor.set(lc(from.hemiGroundColor, to.hemiGroundColor));
    this.hemiLight.intensity = ln(from.hemiIntensity, to.hemiIntensity);

    this.ambientLight.color.set(lc(from.ambientColor, to.ambientColor));
    this.ambientLight.intensity = ln(from.ambientIntensity, to.ambientIntensity);

    this.directionalLight.color.set(lc(from.sunColor, to.sunColor));
    this.directionalLight.intensity = ln(from.sunIntensity, to.sunIntensity);

    this.fillLight.color.set(lc(from.fillColor, to.fillColor));
    this.fillLight.intensity = ln(from.fillIntensity, to.fillIntensity);

    this.renderer.toneMappingExposure = ln(from.exposure, to.exposure);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Smooth step easing — ease in then out, feels natural for sky changes. */
function _easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ── Environment presets ───────────────────────────────────────────────────────

interface EnvPreset {
  skyColor:         number;
  fogColor:         number;
  fogDensity:       number;
  hemiSkyColor:     number;
  hemiGroundColor:  number;
  hemiIntensity:    number;
  ambientColor:     number;
  ambientIntensity: number;
  sunColor:         number;
  sunIntensity:     number;
  fillColor:        number;
  fillIntensity:    number;
  exposure:         number;
}

function resolveEnvironment(zone: ZoneInfo): EnvPreset {
  // Derive tod from float when available; only override string if they agree
  // (or if no string was sent). Protects against stale server default floats.
  let tod = zone.timeOfDay ?? 'day';
  if (zone.timeOfDayValue !== undefined) {
    const t = zone.timeOfDayValue;
    const floatTod = (t >= 0.167 && t < 0.25)  ? 'dawn'
                   : (t >= 0.25  && t < 0.75)  ? 'day'
                   : (t >= 0.75  && t < 0.833) ? 'dusk'
                   : 'night';
    if (!zone.timeOfDay || floatTod === zone.timeOfDay) {
      tod = floatTod;
    }
    // else: float and string disagree → trust string (stale gateway fallback)
  }
  const wx  = zone.weather   ?? 'clear';
  const lit = zone.lighting  ?? 'normal';

  let preset: EnvPreset;

  if (tod === 'night') {
    preset = {
      skyColor: 0x05080f, fogColor: 0x080c18, fogDensity: 0.00040,
      hemiSkyColor: 0x1e3050, hemiGroundColor: 0x0c0c10, hemiIntensity: 1.1,
      ambientColor: 0x1a2840, ambientIntensity: 0.75,
      sunColor: 0x4060b0, sunIntensity: 0.6,
      fillColor: 0x0c1020, fillIntensity: 0.28,
      exposure: 0.92,
    };
  } else if (tod === 'dusk' || tod === 'dawn') {
    preset = {
      skyColor: 0x251810, fogColor: 0x3a2010, fogDensity: 0.00030,
      hemiSkyColor: 0xd08050, hemiGroundColor: 0x301808, hemiIntensity: 1.0,
      ambientColor: 0x806040, ambientIntensity: 0.6,
      sunColor: 0xff9040, sunIntensity: 1.1,
      fillColor: 0x302050, fillIntensity: 0.35,
      exposure: 1.0,
    };
  } else {
    // day
    preset = {
      skyColor: 0x4a6a90, fogColor: 0x7090b8, fogDensity: 0.00022,
      hemiSkyColor: 0xb0c8e8, hemiGroundColor: 0x304820, hemiIntensity: 1.2,
      ambientColor: 0x90a0b0, ambientIntensity: 0.5,
      sunColor: 0xffffff, sunIntensity: 1.3,
      fillColor: 0x3050a0, fillIntensity: 0.35,
      exposure: 1.0,
    };
  }

  // Weather modifiers
  if (wx === 'fog' || wx === 'mist') {
    preset.fogDensity      *= 5;
    preset.fogColor         = 0x909aaa;
    preset.sunIntensity    *= 0.4;
    preset.hemiIntensity   *= 0.7;
    preset.exposure        *= 0.9;
  } else if (wx === 'rain' || wx === 'storm') {
    preset.fogDensity      *= 3;
    preset.skyColor         = 0x141820;
    preset.sunIntensity    *= 0.3;
    preset.hemiIntensity   *= 0.6;
    preset.ambientIntensity *= 0.7;
  } else if (wx === 'cloudy') {
    preset.fogDensity      *= 1.8;
    preset.sunIntensity    *= 0.7;
    preset.hemiIntensity   *= 0.85;
    preset.exposure        *= 0.95;
  }

  // Lighting — zone-level modifier (dungeons, special areas)
  if (lit === 'dark') {
    preset.sunIntensity     = Math.max(preset.sunIntensity * 0.5, 0.3);
    preset.hemiIntensity    = Math.max(preset.hemiIntensity * 0.6, 0.5);
    preset.ambientIntensity = Math.max(preset.ambientIntensity * 0.6, 0.3);
    preset.exposure         = Math.max(preset.exposure * 0.75, 0.8);
  } else if (lit === 'dim') {
    preset.sunIntensity     = Math.max(preset.sunIntensity * 0.75, 0.5);
    preset.hemiIntensity    = Math.max(preset.hemiIntensity * 0.8, 0.7);
    preset.ambientIntensity = Math.max(preset.ambientIntensity * 0.8, 0.4);
    preset.exposure         = Math.max(preset.exposure * 0.9, 0.9);
  }

  return preset;
}
