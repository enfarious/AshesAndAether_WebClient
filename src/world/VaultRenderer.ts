/**
 * VaultRenderer — builds Three.js geometry from vault tile grid data.
 *
 * Uses InstancedMesh for efficient rendering:
 *   - Floor tiles: PlaneGeometry(2, 2) rotated flat, dark stone
 *   - Wall tiles:  BoxGeometry(2, 3, 2) — 3m tall, darker stone
 *   - Entrance/exit markers: RingGeometry at Y=0.02 with emissive glow
 *
 * Typically 2 InstancedMesh draw calls for up to ~900 tiles.
 */

import * as THREE from 'three';

// ── Tile values (must match server VaultTileGrid.ts) ──────────────────────

const Tile = {
  VOID:  0,
  FLOOR: 1,
  WALL:  2,
} as const;

// ── JSON format received from /world/vault-tiles/:instanceId ──────────────

export interface VaultTileData {
  width:    number;
  height:   number;
  tileSize: number;
  tiles:    number[];
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
}

// ── Renderer ──────────────────────────────────────────────────────────────

const FLOOR_COLOR = 0x4a4a52;
const WALL_COLOR  = 0x3a3a42;
const WALL_HEIGHT = 3;

const ENTRANCE_COLOR = 0x40c080;
const EXIT_COLOR     = 0xc04040;

export class VaultRenderer {
  readonly group = new THREE.Group();
  group_name = 'VaultRenderer';

  private floorMesh: THREE.InstancedMesh | null = null;
  private wallMesh:  THREE.InstancedMesh | null = null;
  private markers:   THREE.Mesh[] = [];

  build(data: VaultTileData): void {
    this.dispose();

    const { width, height, tileSize, tiles } = data;

    // Count floor and wall tiles
    let floorCount = 0;
    let wallCount  = 0;
    for (const t of tiles) {
      if (t === Tile.FLOOR) floorCount++;
      else if (t === Tile.WALL) wallCount++;
    }

    // ── Floor InstancedMesh ──────────────────────────────────────────
    if (floorCount > 0) {
      const floorGeo = new THREE.PlaneGeometry(tileSize, tileSize);
      floorGeo.rotateX(-Math.PI / 2); // lay flat
      const floorMat = new THREE.MeshStandardMaterial({
        color: FLOOR_COLOR,
        roughness: 0.9,
        metalness: 0.1,
      });

      this.floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, floorCount);
      this.floorMesh.receiveShadow = true;

      const mat4 = new THREE.Matrix4();
      let idx = 0;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          if (tiles[row * width + col] !== Tile.FLOOR) continue;
          const wx = (col - width / 2) * tileSize + tileSize / 2;
          const wz = (row - height / 2) * tileSize + tileSize / 2;
          mat4.makeTranslation(wx, 0, wz);
          this.floorMesh.setMatrixAt(idx++, mat4);
        }
      }
      this.floorMesh.instanceMatrix.needsUpdate = true;
      this.group.add(this.floorMesh);
    }

    // ── Wall InstancedMesh ───────────────────────────────────────────
    if (wallCount > 0) {
      const wallGeo = new THREE.BoxGeometry(tileSize, WALL_HEIGHT, tileSize);
      const wallMat = new THREE.MeshStandardMaterial({
        color: WALL_COLOR,
        roughness: 0.95,
        metalness: 0.05,
      });

      this.wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, wallCount);
      this.wallMesh.castShadow = true;
      this.wallMesh.receiveShadow = true;

      const mat4 = new THREE.Matrix4();
      let idx = 0;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          if (tiles[row * width + col] !== Tile.WALL) continue;
          const wx = (col - width / 2) * tileSize + tileSize / 2;
          const wz = (row - height / 2) * tileSize + tileSize / 2;
          mat4.makeTranslation(wx, WALL_HEIGHT / 2, wz);
          this.wallMesh.setMatrixAt(idx++, mat4);
        }
      }
      this.wallMesh.instanceMatrix.needsUpdate = true;
      this.group.add(this.wallMesh);
    }

    // ── Entrance / Exit markers ──────────────────────────────────────
    this._addMarker(data.entrance.x, data.entrance.z, ENTRANCE_COLOR);
    this._addMarker(data.exit.x,     data.exit.z,     EXIT_COLOR);
  }

  dispose(): void {
    if (this.floorMesh) {
      this.floorMesh.geometry.dispose();
      (this.floorMesh.material as THREE.Material).dispose();
      this.group.remove(this.floorMesh);
      this.floorMesh = null;
    }
    if (this.wallMesh) {
      this.wallMesh.geometry.dispose();
      (this.wallMesh.material as THREE.Material).dispose();
      this.group.remove(this.wallMesh);
      this.wallMesh = null;
    }
    for (const m of this.markers) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.group.remove(m);
    }
    this.markers.length = 0;
  }

  private _addMarker(x: number, z: number, color: number): void {
    const geo = new THREE.RingGeometry(0.4, 0.8, 24);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.02, z);
    this.markers.push(mesh);
    this.group.add(mesh);
  }
}
