import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
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

  /** Visible sun + moon discs that track the directional light. */
  private sunMesh:          THREE.Mesh;
  private moonMesh:         THREE.Mesh;

  /** Atmospheric sky dome — procedurally tinted by sun direction each frame. */
  private sky:              Sky;

  /** Star field — visible only when the sun is below the horizon. */
  private stars:            THREE.Points;

  // ── Environment transitions ────────────────────────────────────────────────
  private envTransition: {
    from:     EnvPreset;
    to:       EnvPreset;
    elapsed:  number;
    duration: number;
  } | null = null;

  /** Current weather/lighting modifiers — set by applyZone / transitionZone. */
  private _weather  = 'clear';
  private _lighting = 'normal';

  /** Cached TOD value — skip _resolvePresetForTod when change is < threshold. */
  private _lastTod = -1;

  /** True while setIndoorMode(true) is active — read by perf overlay. */
  private _indoor = false;
  get isIndoor(): boolean { return this._indoor; }

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
    this.scene.fog = new THREE.FogExp2(0x6080a0, 0.0014);

    // Atmospheric sky — Rayleigh scattering, auto-tints from sun direction
    // each frame.  Render at a large scale so it always sits "outside" the
    // far plane.  Background gets the sky shader output via cube-render.
    this.sky = new Sky();
    this.sky.scale.setScalar(10_000);
    const su = this.sky.material.uniforms;
    su['turbidity']!.value          = 6;     // haze: 1 (clear) – 20 (smoggy)
    su['rayleigh']!.value           = 1.6;   // blue scattering
    su['mieCoefficient']!.value     = 0.005;
    su['mieDirectionalG']!.value    = 0.85;
    this.scene.add(this.sky);

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
    this.directionalLight.shadow.mapSize.set(1024, 1024);
    this.directionalLight.shadow.camera.near = 1;
    this.directionalLight.shadow.camera.far  = 1200;
    this.directionalLight.shadow.camera.left   = -120;
    this.directionalLight.shadow.camera.right  = 120;
    this.directionalLight.shadow.camera.top    = 120;
    this.directionalLight.shadow.camera.bottom = -120;
    this.directionalLight.shadow.bias = -0.0005;
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target);

    // Fill/rim from the opposite side.
    this.fillLight = new THREE.DirectionalLight(0x4060a0, 0.4);
    this.fillLight.position.set(-150, 100, -200);
    this.scene.add(this.fillLight);

    // ── Visible sun + moon discs ─────────────────────────────────────────
    // MeshBasicMaterial — unlit, full brightness.  depthWrite:false so the
    // sky/distant terrain don't get z-blocked by the disc; normal depthTest
    // so trees & ground in front still occlude.  Sized big (radius 40) at
    // distance 425 → ~10× real-sun apparent size, easy to spot in the sky.
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(40, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c0, fog: false, depthWrite: false, transparent: true, opacity: 1,
      }),
    );
    this.sunMesh.renderOrder = 1;  // draw after the Sky shader
    this.scene.add(this.sunMesh);

    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(28, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xe0e8ff, fog: false, depthWrite: false, transparent: true, opacity: 1,
      }),
    );
    this.moonMesh.renderOrder = 1;
    this.scene.add(this.moonMesh);

    // ── Stars ────────────────────────────────────────────────────────────
    // Hemisphere of points at radius 9000 (just inside the Sky shader's
    // 10000-scale dome).  Faded in/out by sun elevation each frame.
    const STAR_COUNT = 2500;
    const STAR_RADIUS = 9000;
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starColors    = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // Spherical coords with elevation biased toward the upper hemisphere
      const azimuth = Math.random() * Math.PI * 2;
      const elevation = Math.acos(Math.random() * 0.95 + 0.05); // bias toward zenith but include some near-horizon
      const r = STAR_RADIUS;
      starPositions[i * 3 + 0] = r * Math.sin(elevation) * Math.cos(azimuth);
      starPositions[i * 3 + 1] = r * Math.cos(elevation);
      starPositions[i * 3 + 2] = r * Math.sin(elevation) * Math.sin(azimuth);
      // Subtle warm/cool tinting
      const tint = 0.85 + Math.random() * 0.15;
      const warm = Math.random() < 0.3;
      starColors[i * 3 + 0] = tint;
      starColors[i * 3 + 1] = tint * (warm ? 0.95 : 1.0);
      starColors[i * 3 + 2] = tint * (warm ? 0.85 : 1.0);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color',    new THREE.BufferAttribute(starColors,    3));
    const starMat = new THREE.PointsMaterial({
      size:             18,
      sizeAttenuation:  true,
      vertexColors:     true,
      transparent:      true,
      opacity:          0,    // faded by tick() based on sun elevation
      depthWrite:       false,
      fog:              false,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder   = 0;  // before sun/moon (renderOrder 1) so they sit "behind"
    this.scene.add(this.stars);

    window.addEventListener('resize', this._onResize);
  }

  // ── Zone environment ──────────────────────────────────────────────────────

  /**
   * Instantly apply a zone environment — use on initial world entry or teleport.
   * Cancels any in-progress transition.
   */
  applyZone(zone: ZoneInfo): void {
    this.envTransition = null;
    this._weather  = zone.weather  ?? 'clear';
    this._lighting = zone.lighting ?? 'normal';
    const tod = zone.timeOfDayValue ?? 0.5;
    this._applyPreset(_resolvePresetForTod(tod, this._weather, this._lighting));
  }

  /**
   * Tighten the camera frustum + fog and disable outdoor-only lights for
   * indoor scenes (vaults, dungeons). Three.js has no occlusion culling, so
   * a 2 km far plane in a tight hall still rasterises everything in the
   * frustum and overdraws walls behind walls.
   *
   * Disables:
   *   - directionalLight shadow casting — sun isn't visible indoors, the
   *     1024² shadow render is pure waste
   *   - fillLight — outdoor rim/fill, redundant per-pixel sampling indoors
   *
   * Vault point-light shadows (the ominous-corners atmosphere) stay on.
   *
   * Call with `on=true` on vault entry, `on=false` on vault exit.
   */
  setIndoorMode(on: boolean, camera: THREE.PerspectiveCamera): void {
    this._indoor = on;
    if (on) {
      camera.far = 200;
      // Fog density tuned so the far plane (~200m) fades into near-black;
      // the shorter draw distance becomes invisible to the player.
      (this.scene.fog as THREE.FogExp2).density = 0.018;
      this.directionalLight.castShadow = false;
      this.fillLight.visible = false;
      // Outdoor sky machinery is invisible from inside a vault but the meshes
      // still rasterise — Sky in particular runs an expensive Rayleigh shader
      // wherever it's not occluded. Hide them all while indoors.
      this.sky.visible      = false;
      this.sunMesh.visible  = false;
      this.moonMesh.visible = false;
      this.stars.visible    = false;
    } else {
      camera.far = 2000;
      (this.scene.fog as THREE.FogExp2).density = 0.0014;
      this.directionalLight.castShadow = true;
      this.fillLight.visible = true;
      // Restore the always-on sky dome; sun/moon/stars get re-flagged by the
      // next _updateSunPosition tick based on horizon fade, so leave them.
      this.sky.visible = true;
    }
    camera.updateProjectionMatrix();
  }

  /**
   * Smoothly crossfade from the current environment to the new zone environment.
   * @param durationSecs  Seconds to complete the fade (default 20 s).
   */
  transitionZone(zone: ZoneInfo, durationSecs = 20): void {
    this._weather  = zone.weather  ?? 'clear';
    this._lighting = zone.lighting ?? 'normal';
    const tod = zone.timeOfDayValue ?? 0.5;
    const to = _resolvePresetForTod(tod, this._weather, this._lighting);
    // If we are mid-transition, start the new fade from wherever we currently are.
    const from = this._capturePreset();
    this.envTransition = { from, to, elapsed: 0, duration: durationSecs };
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * Advance any in-progress environment transition and update the sun position.
   * Must be called once per frame, before render().
   *
   * @param dt            Frame delta in seconds.
   * @param timeOfDay     Normalised TOD (0–1, 0 = midnight, 0.5 = noon).
   * @param focusPoint    World-space player position — shadow frustum follows this.
   */
  tick(dt: number, timeOfDay?: number, focusPoint?: THREE.Vector3): void {
    // Weather / zone crossfade takes priority while active
    if (this.envTransition) {
      const tr = this.envTransition;
      tr.elapsed = Math.min(tr.elapsed + dt, tr.duration);
      const t = _easeInOut(tr.elapsed / tr.duration);
      this._applyLerped(tr.from, tr.to, t);
      if (tr.elapsed >= tr.duration) this.envTransition = null;
    } else if (timeOfDay !== undefined) {
      // Continuous TOD-driven lighting.  Skip the (expensive) preset resolve
      // + 12× Color allocations if the TOD hasn't moved meaningfully.
      // 0.001 ≈ 1.4 real seconds on a 24-min day cycle — invisible to players.
      if (Math.abs(timeOfDay - this._lastTod) > 0.001) {
        this._lastTod = timeOfDay;
        this._applyPreset(_resolvePresetForTod(timeOfDay, this._weather, this._lighting));
      }
    }

    // Sun orbit — move the directional light based on time of day.
    // Vault zones use static indoor lighting — skip sun movement.
    if (timeOfDay !== undefined && this._lighting !== 'vault') {
      this._updateSunPosition(timeOfDay, focusPoint);
    }
  }

  /** Normalized direction from the scene origin toward the sun/moon light. */
  getSunDirection(): THREE.Vector3 {
    return this.directionalLight.position.clone().normalize();
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

  // ── Sun orbit ────────────────────────────────────────────────────────────

  /**
   * Position the directional light on a circular orbit based on time of day.
   *
   * During the day the light represents the sun; at night it becomes the
   * moon (positioned on the opposite arc, at a lower elevation).  The env
   * presets already set the correct colour and intensity for each TOD
   * bucket — night preset gives a cool blue (0x5070c0) at 0.75 intensity,
   * so shadows at night are naturally moonlit without an extra light.
   *
   * TOD mapping (sun):
   *   0.25  = 6 am  → sunrise in the east   (horizon)
   *   0.5   = noon  → overhead               (zenith)
   *   0.75  = 6 pm  → sunset in the west     (horizon)
   *
   * TOD mapping (moon — active when sun is below horizon):
   *   0.75  = 6 pm  → moonrise in the east   (low)
   *   0.0   = midnight → highest point        (lower than noon sun)
   *   0.25  = 6 am  → moonset in the west     (low)
   */
  private _updateSunPosition(tod: number, focusPoint?: THREE.Vector3): void {
    const SUN_DIST  = 500;  // orbital radius from zone centre
    const SHADOW_SZ = 300;  // shadow ortho half-size in light-camera space

    // Sun orbit angle: 0 at sunrise (east), π/2 at noon (top), π at sunset
    const sunAngle = (tod - 0.25) * Math.PI * 2;
    const sunAboveHorizon = Math.sin(sunAngle) > 0;

    let lx: number, ly: number, lz: number;

    if (sunAboveHorizon) {
      lx =  Math.cos(sunAngle) * SUN_DIST;
      ly =  Math.sin(sunAngle) * SUN_DIST;
      lz = -0.3 * SUN_DIST;
    } else {
      const moonAngle = sunAngle + Math.PI;
      const moonDist  = SUN_DIST * 0.7;
      lx =  Math.cos(moonAngle) * moonDist;
      ly =  Math.sin(moonAngle) * moonDist * 0.6;
      lz =  0.2 * moonDist;
    }

    // Sun orbits the zone centre. Shadow camera must also follow the player so
    // the 1 k shadow texels stay centred on the character. We keep the same
    // direction (lx,ly,lz) and translate both position+target together.
    const px = focusPoint?.x ?? 0;
    const py = focusPoint?.y ?? 0;
    const pz = focusPoint?.z ?? 0;
    this.directionalLight.position.set(px + lx, py + ly, pz + lz);
    this.directionalLight.target.position.set(px, py, pz);
    this.directionalLight.target.updateMatrixWorld();

    const cam = this.directionalLight.shadow.camera;
    cam.left   = -SHADOW_SZ;
    cam.right  =  SHADOW_SZ;
    cam.top    =  SHADOW_SZ;
    cam.bottom = -SHADOW_SZ;
    cam.near   = 1;
    cam.far    = SUN_DIST * 2;
    cam.updateProjectionMatrix();

    // ── Place visible sun + moon discs ───────────────────────────────────
    // Position both at the directional-light vector, at a fixed sky distance.
    // Sun is visible when it's above the horizon; moon when below.  Cross-fade
    // both at horizon so transitions don't pop.
    const SKY_DIST = SUN_DIST * 0.85;
    if (sunAboveHorizon) {
      // Sun at light direction
      this.sunMesh.position.set(px + lx, py + ly, pz + lz)
        .sub(new THREE.Vector3(px, py, pz)).normalize()
        .multiplyScalar(SKY_DIST).add(new THREE.Vector3(px, py, pz));
      // Moon on the opposite side, lower
      const mAng = sunAngle + Math.PI;
      this.moonMesh.position.set(
        px + Math.cos(mAng) * SKY_DIST,
        py + Math.sin(mAng) * SKY_DIST * 0.6,
        pz + 0.2 * SKY_DIST,
      );
    } else {
      // Moon takes the directional-light direction at night
      const mAng = sunAngle + Math.PI;
      this.moonMesh.position.set(
        px + Math.cos(mAng) * SKY_DIST,
        py + Math.sin(mAng) * SKY_DIST * 0.6,
        pz + 0.2 * SKY_DIST,
      );
      // Sun below horizon — push it under so it's invisible
      this.sunMesh.position.set(
        px + Math.cos(sunAngle) * SKY_DIST,
        py + Math.sin(sunAngle) * SKY_DIST,
        pz - 0.3 * SKY_DIST,
      );
    }

    // Tint the sun: warm yellow at zenith, deep orange near the horizon.
    // Old ceilings (g=0.95, b=0.75) produced a pale parchment disc that
    // read as washed-out at any meaningful elevation. Pulling g and b down
    // gives a recognisable yellow-morning sun without sacrificing the
    // sunrise/sunset orange-red.
    const horizonProx = 1 - Math.abs(Math.sin(sunAngle));  // 1 at horizon, 0 at zenith
    const sunMat = this.sunMesh.material as THREE.MeshBasicMaterial;
    const r = 1.0;
    const g = 0.85 - 0.45 * horizonProx;   // 0.85 zenith → 0.40 horizon
    const b = 0.55 - 0.55 * horizonProx;   // 0.55 zenith → 0.00 horizon
    sunMat.color.setRGB(r, g, b);

    // Fade sun in/out as it crosses the horizon (within ~10° of horizon)
    const sunHorizonFade = Math.max(0, Math.min(1, Math.sin(sunAngle) * 6));
    sunMat.opacity = sunHorizonFade;
    this.sunMesh.visible = sunHorizonFade > 0.01;

    const moonMat = this.moonMesh.material as THREE.MeshBasicMaterial;
    const moonHorizonFade = Math.max(0, Math.min(1, -Math.sin(sunAngle) * 6));
    moonMat.opacity = moonHorizonFade;
    this.moonMesh.visible = moonHorizonFade > 0.01;

    // Drive the Sky shader.  We feed it a unit vector pointing at the sun;
    // when the sun is below the horizon, point it slightly above so the sky
    // stays a deep night blue (the shader otherwise gives a flat black).
    const skyAngle = sunAboveHorizon
      ? sunAngle
      : sunAngle + Math.PI;  // moon dir doubles as "where the dim ambient comes from"
    const elev = sunAboveHorizon ? Math.sin(sunAngle) : -0.05;
    const azim = sunAboveHorizon ? Math.cos(sunAngle) : Math.cos(skyAngle);
    const sunUni = this.sky.material.uniforms['sunPosition']!;
    sunUni.value.set(azim, Math.max(elev, -0.05), -0.3);
    sunUni.value.normalize();

    // ── Stars ────────────────────────────────────────────────────────────
    // Centred on the player so the field never moves away as you walk.
    // Opacity fades with sun elevation: full-bright once sun is well below
    // the horizon, gone before sunrise/sunset twilight ends.
    this.stars.position.set(px, py, pz);
    const starMat = this.stars.material as THREE.PointsMaterial;
    // sin(sunAngle) ranges -1 (deep night) → 0 (horizon) → 1 (zenith).
    // We want opacity 0 above horizon, 1 well below.  Use −sin scaled.
    const starsOn = Math.max(0, Math.min(1, -Math.sin(sunAngle) * 4 - 0.1));
    starMat.opacity = starsOn;
    this.stars.visible = starsOn > 0.01;
  }

  // ── Preset helpers ────────────────────────────────────────────────────────

  /** Write an EnvPreset directly to all lights / fog / renderer. */
  private _applyPreset(env: EnvPreset): void {
    // Sky background is now driven by the atmospheric Sky shader from sun
    // position — env.skyColor is no longer used directly.  Fog still tints
    // distance haze independent of the sky dome.
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
      // skyColor unused now (Sky shader drives background) but kept on the
      // preset shape so existing presets compile unchanged.
      skyColor:         0x000000,
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

  // Reusable Color objects to avoid per-frame allocations during transitions.
  private static readonly _ca = new THREE.Color();
  private static readonly _cb = new THREE.Color();

  /** Interpolate every field between two presets at position t ∈ [0, 1]. */
  private _applyLerped(from: EnvPreset, to: EnvPreset, t: number): void {
    const ca = SceneManager._ca;
    const cb = SceneManager._cb;
    const lc = (a: number, b: number): number => {
      ca.set(a);
      cb.set(b);
      return ca.lerp(cb, t).getHex();
    };
    const ln = (a: number, b: number): number => a + (b - a) * t;

    // Sky shader drives the background — no need to lerp skyColor any more.
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

// ── Base TOD presets ─────────────────────────────────────────────────────────

const PRESET_NIGHT: EnvPreset = {
  skyColor: 0x0a1020, fogColor: 0x101828, fogDensity: 0.0022,
  hemiSkyColor: 0x2a4060, hemiGroundColor: 0x141418, hemiIntensity: 1.3,
  ambientColor: 0x263850, ambientIntensity: 0.90,
  sunColor: 0x5070c0, sunIntensity: 0.75,
  fillColor: 0x182040, fillIntensity: 0.35,
  exposure: 1.0,
};

const PRESET_DAWN: EnvPreset = {
  skyColor: 0x251810, fogColor: 0x3a2010, fogDensity: 0.0018,
  hemiSkyColor: 0xd08050, hemiGroundColor: 0x301808, hemiIntensity: 1.0,
  ambientColor: 0x806040, ambientIntensity: 0.6,
  sunColor: 0xff9040, sunIntensity: 1.1,
  fillColor: 0x302050, fillIntensity: 0.35,
  exposure: 1.0,
};

const PRESET_DAY: EnvPreset = {
  skyColor: 0x4a6a90, fogColor: 0x7090b8, fogDensity: 0.0014,
  hemiSkyColor: 0xb0c8e8, hemiGroundColor: 0x304820, hemiIntensity: 1.2,
  ambientColor: 0x90a0b0, ambientIntensity: 0.5,
  sunColor: 0xffffff, sunIntensity: 1.3,
  fillColor: 0x3050a0, fillIntensity: 0.35,
  exposure: 1.0,
};

const PRESET_DUSK: EnvPreset = {
  skyColor: 0x251810, fogColor: 0x3a2010, fogDensity: 0.0018,
  hemiSkyColor: 0xd08050, hemiGroundColor: 0x301808, hemiIntensity: 1.0,
  ambientColor: 0x806040, ambientIntensity: 0.6,
  sunColor: 0xff9040, sunIntensity: 1.1,
  fillColor: 0x302050, fillIntensity: 0.35,
  exposure: 1.0,
};

/**
 * Anchor points — the preset is "purest" at these TOD values.
 * Between anchors every EnvPreset field is linearly interpolated.
 *
 *  midnight(0.0) → dawn(0.208) → noon(0.5) → dusk(0.792) → midnight(1.0)
 */
const TOD_ANCHORS = [
  { t: 0.0,   p: PRESET_NIGHT },
  { t: 0.208, p: PRESET_DAWN  },   // midpoint of dawn bucket  (0.167–0.25)
  { t: 0.5,   p: PRESET_DAY   },   // noon — full daylight
  { t: 0.792, p: PRESET_DUSK  },   // midpoint of dusk bucket  (0.75–0.833)
  { t: 1.0,   p: PRESET_NIGHT },   // wraps back to midnight
];

// Reusable Color objects for _lerpPreset (module-level to avoid allocation).
const _lpA = new THREE.Color();
const _lpB = new THREE.Color();

/** Linearly interpolate every field of two EnvPresets at position t ∈ [0,1]. */
function _lerpPreset(a: EnvPreset, b: EnvPreset, t: number): EnvPreset {
  const lc = (c1: number, c2: number): number => {
    _lpA.set(c1); _lpB.set(c2);
    return _lpA.lerp(_lpB, t).getHex();
  };
  const ln = (v1: number, v2: number): number => v1 + (v2 - v1) * t;

  return {
    skyColor:         lc(a.skyColor,        b.skyColor),
    fogColor:         lc(a.fogColor,        b.fogColor),
    fogDensity:       ln(a.fogDensity,      b.fogDensity),
    hemiSkyColor:     lc(a.hemiSkyColor,    b.hemiSkyColor),
    hemiGroundColor:  lc(a.hemiGroundColor, b.hemiGroundColor),
    hemiIntensity:    ln(a.hemiIntensity,   b.hemiIntensity),
    ambientColor:     lc(a.ambientColor,    b.ambientColor),
    ambientIntensity: ln(a.ambientIntensity, b.ambientIntensity),
    sunColor:         lc(a.sunColor,        b.sunColor),
    sunIntensity:     ln(a.sunIntensity,    b.sunIntensity),
    fillColor:        lc(a.fillColor,       b.fillColor),
    fillIntensity:    ln(a.fillIntensity,   b.fillIntensity),
    exposure:         ln(a.exposure,        b.exposure),
  };
}

/** Apply weather + zone-lighting modifiers to a base preset (returns a copy). */
function _applyModifiers(preset: EnvPreset, weather: string, lighting: string): EnvPreset {
  const p = { ...preset };

  if (weather === 'fog' || weather === 'mist') {
    p.fogDensity      *= 5;
    p.fogColor         = 0x909aaa;
    p.sunIntensity    *= 0.4;
    p.hemiIntensity   *= 0.7;
    p.exposure        *= 0.9;
  } else if (weather === 'rain' || weather === 'storm') {
    p.fogDensity      *= 3;
    p.skyColor         = 0x141820;
    p.sunIntensity    *= 0.3;
    p.hemiIntensity   *= 0.6;
    p.ambientIntensity *= 0.7;
  } else if (weather === 'cloudy') {
    p.fogDensity      *= 1.8;
    p.sunIntensity    *= 0.7;
    p.hemiIntensity   *= 0.85;
    p.exposure        *= 0.95;
  }

  if (lighting === 'dark') {
    p.sunIntensity     = Math.max(p.sunIntensity * 0.5, 0.3);
    p.hemiIntensity    = Math.max(p.hemiIntensity * 0.6, 0.5);
    p.ambientIntensity = Math.max(p.ambientIntensity * 0.6, 0.3);
    p.exposure         = Math.max(p.exposure * 0.75, 0.8);
  } else if (lighting === 'dim') {
    p.sunIntensity     = Math.max(p.sunIntensity * 0.75, 0.5);
    p.hemiIntensity    = Math.max(p.hemiIntensity * 0.8, 0.7);
    p.ambientIntensity = Math.max(p.ambientIntensity * 0.8, 0.4);
    p.exposure         = Math.max(p.exposure * 0.9, 0.9);
  } else if (lighting === 'vault') {
    // Indoor vault lighting — static preset, ignores TOD-derived values.
    // VaultRenderer adds its own ambient + point lights on top of these.
    p.skyColor         = 0x0c0c14;
    p.fogColor         = 0x181822;
    p.fogDensity       = 0.003;
    p.hemiSkyColor     = 0x607080;
    p.hemiGroundColor  = 0x2a2a30;
    p.hemiIntensity    = 1.2;
    p.ambientColor     = 0x808898;
    p.ambientIntensity = 1.0;
    p.sunIntensity     = 0;      // No sun/moon inside vaults
    p.fillIntensity    = 0;      // No fill light — point lights from VaultRenderer handle it
    p.exposure         = 1.3;
  }

  return p;
}

/**
 * Resolve a continuous EnvPreset for any TOD float by interpolating between
 * adjacent anchor presets, then applying weather/lighting modifiers.
 */
function _resolvePresetForTod(tod: number, weather: string, lighting: string): EnvPreset {
  // Wrap to [0, 1)
  tod = ((tod % 1) + 1) % 1;

  // Find surrounding anchors
  let lo = TOD_ANCHORS[0]!;
  let hi = TOD_ANCHORS[1]!;
  for (let i = 0; i < TOD_ANCHORS.length - 1; i++) {
    if (tod >= TOD_ANCHORS[i]!.t && tod < TOD_ANCHORS[i + 1]!.t) {
      lo = TOD_ANCHORS[i]!;
      hi = TOD_ANCHORS[i + 1]!;
      break;
    }
  }

  const range = hi.t - lo.t;
  const t = range > 0 ? (tod - lo.t) / range : 0;

  return _applyModifiers(_lerpPreset(lo.p, hi.p, t), weather, lighting);
}
