import * as THREE from 'three';

/**
 * CloudLayer — procedural cloud cover rendered as a single large plane high
 * above the player.  Uses a 3-octave fbm noise in the fragment shader to
 * generate animated cloud shapes that drift with wind.
 *
 * Inputs (set every frame):
 *   • cloudCover    0–1 from server (controls density / coverage)
 *   • windDir/speed  drives the UV scroll
 *   • sunDir         tints clouds (white at noon, warm at horizon)
 *   • weather        'storm' darkens to slate-grey
 */
export class CloudLayer {
  private readonly scene: THREE.Scene;
  private mesh:    THREE.Mesh;
  private mat:     THREE.ShaderMaterial;
  private elapsed: number = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    geo.rotateX(-Math.PI / 2);  // lay flat in XZ plane

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uWind:       { value: new THREE.Vector2(0, 0) },  // m/s in world space
        uCoverage:   { value: 0.0 },                      // 0 (clear) – 1 (overcast)
        uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
        uTint:       { value: new THREE.Color(1.0, 1.0, 1.0) },
        uDarken:     { value: 0.0 },                      // 0 = white, 1 = storm-grey
      },
      vertexShader: /* glsl */`
        varying vec2 vWorldXZ;
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vWorldXZ  = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vWorldXZ;
        varying vec3 vWorldPos;
        uniform float uTime;
        uniform vec2  uWind;
        uniform float uCoverage;
        uniform vec3  uSunDir;
        uniform vec3  uTint;
        uniform float uDarken;

        // Hash + 2D value noise + fbm — cheap, looks fine for clouds at altitude.
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 4; i++) {
            v += amp * noise(p);
            p *= 2.03;
            amp *= 0.5;
          }
          return v;
        }

        void main() {
          // Scale so a single "cloud" is ~120 m across.
          vec2 uv = vWorldXZ * 0.0015;
          // Wind drift — texture flows with the wind.
          uv -= uWind * uTime * 0.0008;

          float n = fbm(uv);
          // Coverage threshold: at uCoverage=0 we want sparse clouds; at 1, full overcast.
          float t = smoothstep(0.55 - uCoverage * 0.55, 0.85 - uCoverage * 0.35, n);

          if (t < 0.01) discard;

          // Edge-soften so cloud silhouettes aren't a hard line.
          float edge = smoothstep(0.0, 0.15, t);

          // Darken with the storm flag.
          vec3 cloudColor = mix(uTint, vec3(0.18, 0.20, 0.24), uDarken);
          // Subtle inner darkening for "thicker" core regions.
          cloudColor *= mix(0.85, 1.05, t);

          gl_FragColor = vec4(cloudColor, edge * mix(0.55, 0.92, uCoverage));
        }
      `,
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      fog:         false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.set(0, 220, 0);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder   = 0;  // before sun/moon (renderOrder 1) so they draw over clouds
    this.scene.add(this.mesh);
  }

  /** Call every frame.  Updates animation, position, and lighting tint. */
  tick(
    dt: number,
    playerPos: THREE.Vector3,
    cloudCover: number,
    windSpeed: number,
    windDirDeg: number,
    sunDir: THREE.Vector3,
    weather: string,
  ): void {
    this.elapsed += dt;
    this.mesh.position.set(playerPos.x, 220, playerPos.z);

    const u = this.mat.uniforms;
    u['uTime']!.value     = this.elapsed;
    u['uCoverage']!.value = cloudCover;

    // Wind vector in world XZ.  Direction is "from" angle in degrees from N.
    const rad = THREE.MathUtils.degToRad(windDirDeg);
    u['uWind']!.value.set(Math.sin(rad) * windSpeed, Math.cos(rad) * windSpeed);

    // Tint clouds by sun direction: warmer near horizon, white near zenith.
    // sunDir.y is positive when sun is up.
    const horizonProx = 1 - Math.min(1, Math.max(0, sunDir.y));
    const r = 1.0;
    const g = 1.0 - 0.25 * horizonProx;
    const b = 1.0 - 0.45 * horizonProx;
    (u['uTint']!.value as THREE.Color).setRGB(r, g, b);
    u['uSunDir']!.value.copy(sunDir);

    // Darken to storm-grey when stormy or heavy rain
    const darkenTarget = weather === 'storm' ? 1.0 : weather === 'rain' ? 0.6 : 0.0;
    // Smooth toward target
    const cur = u['uDarken']!.value as number;
    u['uDarken']!.value = cur + (darkenTarget - cur) * Math.min(1, dt * 1.5);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
