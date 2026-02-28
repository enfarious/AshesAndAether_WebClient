import * as THREE from 'three';
import type { ZoneInfo } from '@/network/Protocol';

/**
 * SceneManager — owns the Three.js renderer, scene, and base lighting.
 */
export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene:    THREE.Scene;

  private ambientLight:     THREE.AmbientLight;
  private hemiLight:        THREE.HemisphereLight;
  private directionalLight: THREE.DirectionalLight;
  private fillLight:        THREE.DirectionalLight;

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
    // This is the most important light for making unlit/untextured geometry
    // readable — it gives hills a light top and dark underside naturally.
    this.hemiLight = new THREE.HemisphereLight(
      0xb0c8e0, // sky colour  (cool blue-white)
      0x304820, // ground colour (cool dark green — light bouncing off grass)
      1.2,      // intensity
    );
    this.scene.add(this.hemiLight);

    // Ambient: lifts the black shadows so nothing is pitch-dark.
    this.ambientLight = new THREE.AmbientLight(0x8090a0, 0.5);
    this.scene.add(this.ambientLight);

    // Key light (sun/moon) — angled to show terrain relief.
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.3);
    this.directionalLight.position.set(200, 400, 150);  // roughly south-east, high angle
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

  applyZone(zone: ZoneInfo): void {
    const env = resolveEnvironment(zone);

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

  // ── Frame ─────────────────────────────────────────────────────────────────

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }

  private _onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Camera aspect ratio update happens in OrbitCamera._onResize
  };
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
  const tod = zone.timeOfDay ?? 'day';
  const wx  = zone.weather   ?? 'clear';
  const lit = zone.lighting  ?? 'normal';

  let preset: EnvPreset;

  if (tod === 'night') {
    preset = {
      skyColor: 0x05080f, fogColor: 0x080c18, fogDensity: 0.00040,
      hemiSkyColor: 0x101828, hemiGroundColor: 0x0a0808, hemiIntensity: 0.8,
      ambientColor: 0x101828, ambientIntensity: 0.4,
      sunColor: 0x3050a0, sunIntensity: 0.4,
      fillColor: 0x080c18, fillIntensity: 0.15,
      exposure: 0.85,
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

  // Weather
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
  }

  // Lighting — only dim/dark, never below readable minimums
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
