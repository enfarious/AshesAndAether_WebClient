import * as THREE from 'three';

/**
 * WeatherEffects — visible precipitation, lightning, and ambient weather
 * cues that follow the player.
 *
 * Owns three layers:
 *   • Rain  — vertical streaks falling around the player; activated by
 *             weather === 'rain' or 'storm'.
 *   • Snow  — slower, swirling flakes; activated by season === 'winter'
 *             or temperature < freezing.
 *   • Lightning — brief scene-wide flash during 'storm' weather.
 *
 * Call setState() whenever zone weather/season changes.
 * Call tick(dt, playerPos) once per frame.
 */
export class WeatherEffects {
  private readonly scene: THREE.Scene;

  // Rain
  private rainPoints:    THREE.Points;
  private rainPositions: Float32Array;
  private rainVel:       Float32Array;
  private static readonly RAIN_COUNT  = 4000;
  private static readonly RAIN_RADIUS = 60;   // metres around player
  private static readonly RAIN_HEIGHT = 35;
  private static readonly RAIN_SPEED  = 30;   // m/s downward

  // Snow
  private snowPoints:    THREE.Points;
  private snowPositions: Float32Array;
  private snowVel:       Float32Array;
  private static readonly SNOW_COUNT  = 2500;
  private static readonly SNOW_RADIUS = 50;
  private static readonly SNOW_HEIGHT = 30;
  private static readonly SNOW_SPEED  = 2.0;

  // Lightning
  private lightningLight: THREE.DirectionalLight;
  private lightningFlash: THREE.Mesh;
  private lightningTime  = 0;
  private nextStrikeAt   = 0;
  private flashIntensity = 0;

  // State
  private weather: string = 'clear';
  private season:  string = 'summer';

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // ── Rain ──────────────────────────────────────────────────────────────
    this.rainPositions = new Float32Array(WeatherEffects.RAIN_COUNT * 3);
    this.rainVel       = new Float32Array(WeatherEffects.RAIN_COUNT);
    for (let i = 0; i < WeatherEffects.RAIN_COUNT; i++) {
      this._seedRainDrop(i, 0, 0, 0);
      this.rainVel[i] = WeatherEffects.RAIN_SPEED * (0.85 + Math.random() * 0.3);
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    const rainMat = new THREE.PointsMaterial({
      color:       0xa0c0e0,
      size:        0.15,
      sizeAttenuation: true,
      transparent: true,
      opacity:     0.55,
      depthWrite:  false,
    });
    this.rainPoints = new THREE.Points(rainGeo, rainMat);
    this.rainPoints.visible = false;
    this.rainPoints.frustumCulled = false;  // we move the geometry every frame
    this.scene.add(this.rainPoints);

    // ── Snow ──────────────────────────────────────────────────────────────
    this.snowPositions = new Float32Array(WeatherEffects.SNOW_COUNT * 3);
    this.snowVel       = new Float32Array(WeatherEffects.SNOW_COUNT);
    for (let i = 0; i < WeatherEffects.SNOW_COUNT; i++) {
      this._seedSnowFlake(i, 0, 0, 0);
      this.snowVel[i] = WeatherEffects.SNOW_SPEED * (0.7 + Math.random() * 0.6);
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(this.snowPositions, 3));
    const snowMat = new THREE.PointsMaterial({
      color:       0xf0f4ff,
      size:        0.35,
      sizeAttenuation: true,
      transparent: true,
      opacity:     0.85,
      depthWrite:  false,
    });
    this.snowPoints = new THREE.Points(snowGeo, snowMat);
    this.snowPoints.visible = false;
    this.snowPoints.frustumCulled = false;
    this.scene.add(this.snowPoints);

    // ── Lightning ─────────────────────────────────────────────────────────
    // Directional light (no falloff) so the entire scene flashes — visible
    // even at noon under direct sun.  Plus a billboard "flash" plane in the
    // sky for a visible lightning origin.
    this.lightningLight = new THREE.DirectionalLight(0xd0e0ff, 0);
    this.lightningLight.position.set(50, 300, 50);
    this.scene.add(this.lightningLight);
    this.scene.add(this.lightningLight.target);

    // Flat sky-flash sprite — sits high overhead and brightens during a strike
    const flashGeo = new THREE.PlaneGeometry(400, 400);
    const flashMat = new THREE.MeshBasicMaterial({
      color:       0xffffff,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      fog:         false,
      side:        THREE.DoubleSide,
    });
    this.lightningFlash = new THREE.Mesh(flashGeo, flashMat);
    this.lightningFlash.rotation.x = Math.PI / 2;
    this.lightningFlash.position.set(0, 250, 0);
    this.lightningFlash.renderOrder = 2;
    this.scene.add(this.lightningFlash);
  }

  /** Update weather/season state. Called when zone state changes. */
  setState(weather: string, season: string): void {
    this.weather = weather;
    this.season  = season;

    const wantsRain = weather === 'rain' || weather === 'storm';
    const wantsSnow = season === 'winter' && (weather === 'cloudy' || weather === 'storm' || weather === 'fog' || weather === 'mist');
    this.rainPoints.visible = wantsRain;
    this.snowPoints.visible = wantsSnow;
  }

  /** Advance precipitation + lightning. Call once per frame. */
  tick(dt: number, playerPos: THREE.Vector3): void {
    if (this.rainPoints.visible) this._tickRain(dt, playerPos);
    if (this.snowPoints.visible) this._tickSnow(dt, playerPos);
    if (this.weather === 'storm') {
      this._tickLightning(dt, playerPos);
    } else {
      this.flashIntensity = 0;
      this.lightningLight.intensity = 0;
      (this.lightningFlash.material as THREE.MeshBasicMaterial).opacity = 0;
      this.lightningFlash.visible = false;
    }
  }

  dispose(): void {
    this.scene.remove(this.rainPoints);
    this.scene.remove(this.snowPoints);
    this.scene.remove(this.lightningLight);
    this.scene.remove(this.lightningLight.target);
    this.scene.remove(this.lightningFlash);
    this.rainPoints.geometry.dispose();
    (this.rainPoints.material as THREE.Material).dispose();
    this.snowPoints.geometry.dispose();
    (this.snowPoints.material as THREE.Material).dispose();
    this.lightningFlash.geometry.dispose();
    (this.lightningFlash.material as THREE.Material).dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _seedRainDrop(i: number, px: number, py: number, pz: number): void {
    const ang = Math.random() * Math.PI * 2;
    const r   = Math.sqrt(Math.random()) * WeatherEffects.RAIN_RADIUS;
    this.rainPositions[i * 3 + 0] = px + Math.cos(ang) * r;
    this.rainPositions[i * 3 + 1] = py + Math.random() * WeatherEffects.RAIN_HEIGHT + 5;
    this.rainPositions[i * 3 + 2] = pz + Math.sin(ang) * r;
  }

  private _seedSnowFlake(i: number, px: number, py: number, pz: number): void {
    const ang = Math.random() * Math.PI * 2;
    const r   = Math.sqrt(Math.random()) * WeatherEffects.SNOW_RADIUS;
    this.snowPositions[i * 3 + 0] = px + Math.cos(ang) * r;
    this.snowPositions[i * 3 + 1] = py + Math.random() * WeatherEffects.SNOW_HEIGHT + 5;
    this.snowPositions[i * 3 + 2] = pz + Math.sin(ang) * r;
  }

  private _tickRain(dt: number, p: THREE.Vector3): void {
    const pos = this.rainPositions;
    for (let i = 0; i < WeatherEffects.RAIN_COUNT; i++) {
      const yi = i * 3 + 1;
      pos[yi]! -= this.rainVel[i]! * dt;
      const dx = pos[i * 3]!     - p.x;
      const dz = pos[i * 3 + 2]! - p.z;
      if (pos[yi]! < p.y || dx * dx + dz * dz > WeatherEffects.RAIN_RADIUS * WeatherEffects.RAIN_RADIUS) {
        this._seedRainDrop(i, p.x, p.y, p.z);
      }
    }
    (this.rainPoints.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private _tickSnow(dt: number, p: THREE.Vector3): void {
    const pos = this.snowPositions;
    for (let i = 0; i < WeatherEffects.SNOW_COUNT; i++) {
      const xi = i * 3, yi = i * 3 + 1, zi = i * 3 + 2;
      pos[yi]! -= this.snowVel[i]! * dt;
      pos[xi]! += Math.sin(pos[yi]! * 0.4 + i) * 0.5 * dt;
      pos[zi]! += Math.cos(pos[yi]! * 0.4 + i) * 0.5 * dt;
      const dx = pos[xi]! - p.x;
      const dz = pos[zi]! - p.z;
      if (pos[yi]! < p.y || dx * dx + dz * dz > WeatherEffects.SNOW_RADIUS * WeatherEffects.SNOW_RADIUS) {
        this._seedSnowFlake(i, p.x, p.y, p.z);
      }
    }
    (this.snowPoints.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private _tickLightning(dt: number, p: THREE.Vector3): void {
    this.lightningTime += dt;

    // Track a flash envelope separately from the lights — shape:
    //   instant rise to 1.0, decay over ~0.4 s, optional secondary flicker.
    if (this.lightningTime >= this.nextStrikeAt) {
      // Fire — pick a sky offset around the player so the flash direction varies.
      const ang = Math.random() * Math.PI * 2;
      const r   = 100 + Math.random() * 300;
      this.lightningLight.position.set(
        p.x + Math.cos(ang) * r,
        p.y + 200 + Math.random() * 80,
        p.z + Math.sin(ang) * r,
      );
      this.lightningLight.target.position.set(p.x, p.y, p.z);
      this.lightningLight.target.updateMatrixWorld();

      this.lightningFlash.position.set(p.x, p.y + 250, p.z);

      // Some strikes are double-flashes — feels real.  ~30% chance.
      const isDouble = Math.random() < 0.3;
      this.flashIntensity = 1.0;
      this.lightningTime  = 0;
      this.nextStrikeAt   = isDouble ? 0.08 : 4 + Math.random() * 12;
    } else {
      // Decay the flash envelope.  ~0.35 s half-life — a real lightning
      // flash is even faster but a hair longer reads better at video rates.
      this.flashIntensity *= Math.pow(0.05, dt * 1.5);
    }

    // Apply the envelope to both lights.  Directional intensity 8 totally
    // overpowers the sun, so the entire scene flashes.  Sky-flash sprite
    // gives a visible bright patch in the clouds even when looking up.
    this.lightningLight.intensity = this.flashIntensity * 8;
    (this.lightningFlash.material as THREE.MeshBasicMaterial).opacity = this.flashIntensity * 0.85;
    this.lightningFlash.visible = this.flashIntensity > 0.01;
  }
}
