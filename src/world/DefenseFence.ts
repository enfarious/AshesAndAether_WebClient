import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * DefenseFence — the settlement-defense slice edge, drawn.
 *
 * The server walls a defense slice in with collision rects just outside
 * layout.bounds (Zone.ts _installSliceFence). This draws a post-and-rope
 * fence along that square, draped on the DEM, so players can see the edge
 * before they hit it. The matching movement stop lives in
 * PlayerEntity.setFenceBox — prediction halts at the fence like the server.
 */

/** Post spacing along each side (m). */
const POST_SPACING = 4;
const POST_HEIGHT  = 1.6;
const POST_RADIUS  = 0.09;
const SINK         = 0.2;
/** Rope heights above ground (m). */
const ROPES = [0.6, 1.25];
/** Drawn this far outside the stop line (m) so you see it ahead of you. */
export const FENCE_DRAW_OFFSET = 0.4;

export interface FenceBox { minX: number; maxX: number; minZ: number; maxZ: number; }

export class DefenseFence {
  private group: THREE.Group | null = null;
  private key = '';

  constructor(private readonly scene: THREE.Scene) {}

  /** Build (or keep) the fence for this box. Returns false if the heightmap
   *  can't be sampled yet — call again on the next state push. */
  show(box: FenceBox, heightmap: HeightmapService | null): boolean {
    const key = `${box.minX.toFixed(2)}|${box.maxX.toFixed(2)}|${box.minZ.toFixed(2)}|${box.maxZ.toFixed(2)}`;
    if (this.group && key === this.key) return true;
    const cx = (box.minX + box.maxX) / 2, cz = (box.minZ + box.maxZ) / 2;
    if (!heightmap || heightmap.getElevation(cx, cz) === null) return false;
    this.clear();
    this.key = key;

    const o = FENCE_DRAW_OFFSET;
    const corners: Array<[number, number]> = [
      [box.minX - o, box.minZ - o], [box.maxX + o, box.minZ - o],
      [box.maxX + o, box.maxZ + o], [box.minX - o, box.maxZ + o],
    ];
    const ground = (x: number, z: number): number => heightmap.getElevation(x, z) ?? 0;

    const pts: Array<{ x: number; z: number; y: number }> = [];
    for (let s = 0; s < 4; s++) {
      const [ax, az] = corners[s]!;
      const [bx, bz] = corners[(s + 1) % 4]!;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / POST_SPACING));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        pts.push({ x, z, y: ground(x, z) });
      }
    }

    const group = new THREE.Group();
    group.name = 'DefenseFence';

    const postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS * 1.2, POST_HEIGHT + SINK, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a4430, roughness: 0.95 });
    const posts = new THREE.InstancedMesh(postGeo, postMat, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach((p, i) => {
      m.makeTranslation(p.x, p.y + (POST_HEIGHT - SINK) / 2, p.z);
      posts.setMatrixAt(i, m);
    });
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    group.add(posts);

    // Ropes: one closed line per height, through every post top.
    const ropeMat = new THREE.LineBasicMaterial({ color: 0xb08a4a });
    for (const h of ROPES) {
      const verts: number[] = [];
      for (const p of pts) verts.push(p.x, p.y + h, p.z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      group.add(new THREE.LineLoop(g, ropeMat));
    }

    this.scene.add(group);
    this.group = group;
    return true;
  }

  clear(): void {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.group = null;
    this.key = '';
  }
}
