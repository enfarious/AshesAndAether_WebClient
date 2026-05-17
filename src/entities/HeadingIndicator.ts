import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';
import { fitToTerrain } from '@/world/TangentPlaneFit';

/**
 * HeadingIndicator — a low chevron plate sitting on the local tangent
 * plane of the terrain, pointing in the entity's facing direction.
 *
 * The mesh is rigid and a top-level scene object (not parented to the
 * entity). Each frame the owner calls `update(worldX, worldY, worldZ,
 * headingRad)` and a tangent-plane fit samples DEM at the centre + four
 * cardinals, applies position + rotation so the chevron rides on the
 * terrain. This eliminates the per-vertex Y jitter the tessellated
 * shader-conform approach suffered when an entity moved across DEM cells.
 *
 * Shape: a solid triangular chevron pointing in local +Z, with a beveled
 * rim — outer silhouette at the plate floor, interior raised by
 * uBevelHeight, slopes between the two. Reads as a small physical plate
 * sitting on the ground.
 *
 * Prominence variants:
 *   prominent — full-size, bright. Player, party, hostile mobs, locked targets.
 *   subtle    — smaller, dimmer. Ambient NPCs, non-hostile wildlife.
 */

export type HeadingIndicatorProminence = 'prominent' | 'subtle';

interface ChevronDims {
  halfWidth:  number;   // half the back width
  length:     number;   // back edge to tip distance
  bevelInset: number;   // slope width from outer silhouette to inner top
  bevelHeight: number;  // interior plate height
  yLift:      number;   // small clearance above terrain
  opacity:    number;
  /** Slope-sample baseline in metres for the tangent-plane fit. Matches the
   *  chevron's own footprint so the slope estimate reflects the surface the
   *  chevron actually covers. */
  sampleDist: number;
  /** Metres to shift the chevron forward (in the heading direction) from
   *  the entity's centre. Pushes it past the body capsule so it sits in
   *  front of the entity rather than overlapping their feet. */
  forwardOffset: number;
}

const PROMINENT_DIMS: ChevronDims = {
  halfWidth:     0.40,
  length:        0.55,
  bevelInset:    0.06,
  bevelHeight:   0.05,
  yLift:         0.02,
  opacity:       0.80,
  sampleDist:    0.5,
  forwardOffset: 0.60,
};

const SUBTLE_DIMS: ChevronDims = {
  halfWidth:     0.24,
  length:        0.35,
  bevelInset:    0.04,
  bevelHeight:   0.03,
  yLift:         0.02,
  opacity:       0.40,
  sampleDist:    0.4,
  forwardOffset: 0.20,
};

/** Build a triangular chevron pointing in local +Z, with a beveled rim.
 *  6 vertices: 3 outer silhouette (back-left, back-right, tip) at the
 *  plate floor (bevel mask 0), 3 inner (inset toward centroid) at the
 *  plate top (bevel mask 1). 7 triangles: 1 inner + 6 rim quads (2 per
 *  silhouette edge). */
function buildChevronGeometry(dims: ChevronDims): THREE.BufferGeometry {
  const { halfWidth: hw, length: len, bevelInset: inset } = dims;

  // Outer silhouette
  const outerBL  = new THREE.Vector3(-hw, 0, 0);
  const outerBR  = new THREE.Vector3( hw, 0, 0);
  const outerTip = new THREE.Vector3(  0, 0, len);

  // Centroid for inset direction
  const cx = 0;
  const cz = len / 3;

  // Inset each outer vertex toward the centroid by `inset` metres.
  function insetToward(v: THREE.Vector3): THREE.Vector3 {
    const dx = cx - v.x;
    const dz = cz - v.z;
    const dlen = Math.hypot(dx, dz);
    const t = dlen > 1e-6 ? inset / dlen : 0;
    return new THREE.Vector3(v.x + dx * t, 0, v.z + dz * t);
  }
  const innerBL  = insetToward(outerBL);
  const innerBR  = insetToward(outerBR);
  const innerTip = insetToward(outerTip);

  // 6 vertices: outer 0..2, inner 3..5
  const positions = new Float32Array([
    outerBL.x,  0, outerBL.z,
    outerBR.x,  0, outerBR.z,
    outerTip.x, 0, outerTip.z,
    innerBL.x,  0, innerBL.z,
    innerBR.x,  0, innerBR.z,
    innerTip.x, 0, innerTip.z,
  ]);
  const bevelMask = new Float32Array([0, 0, 0, 1, 1, 1]);

  // CCW winding from above. Inner triangle + three rim quads (back, right,
  // left — each split into two triangles).
  const indices = [
    // Inner top — CCW from above is BL → tip → BR.
    3, 5, 4,
    // Back rim (between BL and BR, outer 0-1, inner 3-4)
    0, 4, 1,  0, 3, 4,
    // Right rim (between BR and tip, outer 1-2, inner 4-5)
    1, 5, 2,  1, 4, 5,
    // Left rim (between tip and BL, outer 2-0, inner 5-3)
    2, 3, 0,  2, 5, 3,
  ];

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',   new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

const VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float aBevelMask;
  uniform float uBevelHeight;

  void main() {
    vec3 pos = position;
    pos.y += aBevelMask * uBevelHeight;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3  uColor;
  uniform float uOpacity;
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

export class HeadingIndicator {
  private mesh:       THREE.Mesh;
  private material:   THREE.ShaderMaterial;
  private heightmap:  HeightmapService | null = null;
  private dims:       ChevronDims;

  constructor(
    private readonly scene: THREE.Scene,
    color:                  THREE.Color,
    private readonly prominence: HeadingIndicatorProminence,
  ) {
    this.dims = prominence === 'prominent' ? PROMINENT_DIMS : SUBTLE_DIMS;
    const geometry = buildChevronGeometry(this.dims);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor:       { value: color.clone() },
        uOpacity:     { value: this.dims.opacity },
        uBevelHeight: { value: this.dims.bevelHeight },
      },
      vertexShader:        VERTEX_SHADER,
      fragmentShader:      FRAGMENT_SHADER,
      transparent:         true,
      depthWrite:          false,
      depthTest:           true,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side:                THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder   = prominence === 'prominent' ? 5 : 4;
    this.mesh.frustumCulled = false;     // tangent-plane fit shifts position
    this.mesh.visible       = false;
    scene.add(this.mesh);
  }

  /** Bind the heightmap so tangent-plane fits can sample real terrain.
   *  Pass null on zone teardown / vault entry — the indicator will sit
   *  flat at the entity's reported Y when the heightmap is unbound. */
  setHeightmap(hm: HeightmapService | null): void {
    this.heightmap = hm;
  }

  /** Re-fit the chevron to the local terrain tangent plane at the given
   *  world XZ + heading. The chevron is shifted forwardOffset metres ahead
   *  of the entity's centre in the heading direction so it sits past the
   *  body capsule. Owner calls every frame from its own update. */
  update(worldX: number, worldY: number, worldZ: number, headingRad: number): void {
    // Server heading: 0 = +Z (south), atan2(dx, dz). Forward direction
    // vector is (sin H, cos H) in world XZ.
    const off = this.dims.forwardOffset;
    const fx  = Math.sin(headingRad) * off;
    const fz  = Math.cos(headingRad) * off;
    fitToTerrain(
      this.mesh,
      this.heightmap,
      worldX + fx,
      worldZ + fz,
      headingRad,
      this.dims.sampleDist,
      this.dims.yLift,
      worldY,
    );
    this.mesh.visible = true;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
