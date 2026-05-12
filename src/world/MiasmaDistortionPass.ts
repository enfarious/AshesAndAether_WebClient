import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * MiasmaDistortionPass — full-screen post-process effect that activates
 * when the player is past the zone boundary (lethal territory).
 *
 * Trigger is **position-based**, not AD-based: a beacon near the ring
 * can suppress the local AD value enough to mask the actual lethal
 * threshold, so cueing on AD made the effect lag the boundary in some
 * places and lead it in others. Distance-from-origin vs. zoneRadiusM
 * is the true signal.
 *
 * Activation curve:
 *   distFromCenter ≤ radius                 — passthrough (no cost).
 *   distFromCenter ∈ [radius, radius + 5m]  — smooth fade from 0 to full,
 *                                              spanning the visual wall
 *                                              to the lethal damage threshold
 *                                              (matches DangerMap's
 *                                              BOUNDARY_LETHAL_EXTRA_M).
 *   distFromCenter ≥ radius + 5m            — full intensity.
 *
 * Effects at full intensity (unchanged from prior AD-driven version):
 *   - Swirl, boil ripple, chromatic aberration, faint purple tint, vignette.
 *
 * Cheap — single full-screen pass, bypasses when not past the ring
 * (which is most of the play area).
 */

const MIASMA_DISTORTION_SHADER = {
  uniforms: {
    tDiffuse:       { value: null as THREE.Texture | null },
    uTime:          { value: 0 },
    /** Player world XZ. Sent every frame from CPU. */
    uPlayerXZ:      { value: new THREE.Vector2(0, 0) },
    /** Zone playable-circle radius (m). 0 disables the effect entirely
     *  (vault zones, pre-load). */
    uZoneRadiusM:   { value: 0 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float     uTime;
    uniform vec2      uPlayerXZ;
    uniform float     uZoneRadiusM;

    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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

    void main() {
      // Disabled entirely in vault zones / before zone radius is known.
      if (uZoneRadiusM <= 0.0) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      // Position-based activation: smoothstep 0 → 1 over the 5m band from
      // the visual wall (ring) to the lethal damage threshold. Fade
      // matches the boundaryAd bridge in DangerMap so the screen effect
      // crescendos exactly as HP drain starts.
      float playerDist = length(uPlayerXZ);
      float intensity = smoothstep(uZoneRadiusM, uZoneRadiusM + 5.0, playerDist);

      if (intensity < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 center = vec2(0.5, 0.5);
      vec2 d = vUv - center;
      float r = length(d);

      float swirlAngle = (noise(vec2(uTime * 0.35, vUv.y * 8.0)) - 0.5) * 0.08 * intensity;
      float c = cos(swirlAngle);
      float s = sin(swirlAngle);
      mat2 rot = mat2(c, -s, s, c);
      vec2 warpedUv = center + rot * d;

      float ripple = (noise(vUv * 12.0 + uTime * 1.3) - 0.5) * 0.006 * intensity;
      warpedUv += vec2(ripple, ripple);

      vec2 dir    = r > 1e-4 ? d / r : vec2(0.0);
      float caOff = 0.005 * intensity * r;

      float red   = texture2D(tDiffuse, warpedUv + dir * caOff).r;
      float green = texture2D(tDiffuse, warpedUv).g;
      float blue  = texture2D(tDiffuse, warpedUv - dir * caOff).b;

      vec3 col = vec3(red, green, blue);

      vec3 tint = vec3(0.18, 0.06, 0.24) * intensity * 0.18;
      col += tint;

      float vignette = 1.0 - smoothstep(0.30, 0.85, r) * intensity * 0.25;
      col *= vignette;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class MiasmaDistortionPass extends ShaderPass {
  constructor() {
    super(MIASMA_DISTORTION_SHADER);
  }

  /** Push the current frame's player position + zone radius. Call once
   *  per frame before composer.render(). When `zoneRadiusM` is 0/null
   *  (vault, not yet loaded), the pass passes through cleanly. */
  update(dt: number, playerX: number, playerZ: number, zoneRadiusM: number | null): void {
    (this.uniforms['uTime']!.value as number) += dt;
    (this.uniforms['uPlayerXZ']!.value as THREE.Vector2).set(playerX, playerZ);
    this.uniforms['uZoneRadiusM']!.value = zoneRadiusM ?? 0;
  }
}
