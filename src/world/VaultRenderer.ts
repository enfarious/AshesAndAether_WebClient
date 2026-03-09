/**
 * VaultRenderer — builds Three.js geometry from vault tile grid data.
 *
 * Uses InstancedMesh for efficient rendering:
 *   - Floor tiles:  PlaneGeometry(tileSize, tileSize) rotated flat, dark stone
 *   - Wall tiles:   BoxGeometry(tileSize, wallHeight, tileSize) — wall height from geometry config
 *   - Dome ceiling: EllipsoidGeometry covering the vault footprint, inside-out normals
 *   - Entrance/exit markers: RingGeometry at Y=0.02 with emissive glow
 *   - Vault lighting: ambient + point lights unaffected by time-of-day
 *
 * Typically 2 InstancedMesh draw calls for up to ~900 tiles + 1 ceiling mesh.
 */

import * as THREE from 'three';

// ── Tile values (must match server VaultTileGrid.ts) ──────────────────────

const Tile = {
  VOID:  0,
  FLOOR: 1,
  WALL:  2,
} as const;

// ── JSON format received from /world/vault-tiles/:instanceId ──────────────

export interface VaultGeometry {
  wallHeight: number;
  ceilingHeight: number;
  ceilingType: 'dome' | 'flat';
}

export interface VaultTileData {
  width:    number;
  height:   number;
  tileSize: number;
  tiles:    number[];
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
  roomCenters?: Array<{ x: number; z: number }>;
  roomSizes?: Array<{ width: number; height: number }>;
  geometry?: VaultGeometry;
}

// ── Renderer ──────────────────────────────────────────────────────────────

const FLOOR_COLOR = 0x4a4a52;
const WALL_COLOR  = 0x3a3a42;
const CEILING_COLOR = 0x353540;

const DEFAULT_WALL_HEIGHT    = 5;
const DEFAULT_CEILING_HEIGHT = 15;


/**
 * XZ radius (metres) of the circular ceiling cutout centred on the player.
 * Fragments closer than this are discarded so the camera can see through.
 */
const CEIL_CLIP_RADIUS = 12;

export class VaultRenderer {
  readonly group = new THREE.Group();
  group_name = 'VaultRenderer';

  private floorMesh:    THREE.InstancedMesh | null = null;
  private wallMesh:     THREE.InstancedMesh | null = null;
  private ceilingMesh:  THREE.Mesh | null = null;
  private colliderMesh: THREE.Mesh | null = null;
  private lights:       THREE.Light[] = [];

  /** Stored tile data for rebuilding meshes when gates open. */
  private _tileData: VaultTileData | null = null;

  /**
   * XZ centre of the ceiling clip hole — updated every frame via
   * {@link setClipCenter}.  Shared by reference with the ceiling
   * material's compiled shader uniform.
   */
  private _clipCenter = new THREE.Vector3();

  /** Cached ceiling Y so setClipCenter can do the ray-plane intersection. */
  private _ceilingY = DEFAULT_CEILING_HEIGHT;

  build(data: VaultTileData): void {
    this.dispose();

    // Keep a mutable copy of tile data so openGate() can update tiles
    this._tileData = { ...data, tiles: [...data.tiles] };

    const { width, height, tileSize, tiles, geometry } = this._tileData;

    const wallHeight    = geometry?.wallHeight    ?? DEFAULT_WALL_HEIGHT;
    const ceilingHeight = geometry?.ceilingHeight ?? DEFAULT_CEILING_HEIGHT;
    this._ceilingY = ceilingHeight;

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
      const wallGeo = new THREE.BoxGeometry(tileSize, wallHeight, tileSize);
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
          mat4.makeTranslation(wx, wallHeight / 2, wz);
          this.wallMesh.setMatrixAt(idx++, mat4);
        }
      }
      this.wallMesh.instanceMatrix.needsUpdate = true;
      this.group.add(this.wallMesh);
    }

    // ── Wall Collision Mesh ────────────────────────────────────────
    // A single merged BufferGeometry of vertical quads on every wall face
    // that borders a FLOOR tile.  Invisible (material.visible=false) but
    // raycaster still hits it.  Named 'vault_wall_collider' so
    // PlayerEntity.setWorldRoot() includes it despite spanning > 50 m.
    this._buildCollisionMesh(width, height, tileSize, tiles, wallHeight);

    // ── Flat Ceiling (disabled for debugging) ─────────────────────
    // TODO: re-enable ceiling once dungeon generation is validated
    // const vaultSpanX = width  * tileSize;
    // const vaultSpanZ = height * tileSize;
    // const ceilGeo = new THREE.PlaneGeometry(vaultSpanX, vaultSpanZ);
    // ceilGeo.rotateX(-Math.PI / 2);
    // const ceilMat = new THREE.MeshStandardMaterial({
    //   color: CEILING_COLOR, roughness: 0.95, metalness: 0.0, side: THREE.FrontSide,
    // });
    // this._applyCeilingClip(ceilMat);
    // this.ceilingMesh = new THREE.Mesh(ceilGeo, ceilMat);
    // this.ceilingMesh.receiveShadow = true;
    // this.ceilingMesh.position.set(0, ceilingHeight, 0);
    // this.group.add(this.ceilingMesh);

    // ── Vault Lighting ───────────────────────────────────────────────
    // Static indoor lights that don't change with time-of-day.

    // Bright ambient fill — vaults have no sun/fill from SceneManager
    const ambient = new THREE.AmbientLight(0x909098, 1.0);
    this.lights.push(ambient);
    this.group.add(ambient);

    // Place point lights at room centers for localized illumination
    if (data.roomCenters && data.roomCenters.length > 0) {
      for (const center of data.roomCenters) {
        const pointLight = new THREE.PointLight(0xddeeff, 2.5, 0, 1.0);
        pointLight.position.set(center.x, ceilingHeight * 0.6, center.z);
        pointLight.castShadow = true;
        pointLight.shadow.mapSize.set(512, 512);
        this.lights.push(pointLight);
        this.group.add(pointLight);
      }
    } else {
      // Single-room fallback: one light at vault center
      const pointLight = new THREE.PointLight(0xddeeff, 3.0, 0, 1.0);
      pointLight.position.set(0, ceilingHeight * 0.6, 0);
      pointLight.castShadow = true;
      this.lights.push(pointLight);
      this.group.add(pointLight);
    }

  }

  /**
   * Open a gate by converting its WALL tiles to FLOOR tiles and rebuilding
   * the wall, floor, and collision meshes.
   */
  openGate(gateTiles: Array<{ row: number; col: number }>): void {
    if (!this._tileData) return;

    const { width, tiles } = this._tileData;

    // Swap gate tiles from WALL → FLOOR in our mutable tile array
    for (const { row, col } of gateTiles) {
      const idx = row * width + col;
      if (tiles[idx] === Tile.WALL) {
        tiles[idx] = Tile.FLOOR;
      }
    }

    // Rebuild floor, wall, and collision meshes from updated tile data
    this._rebuildTileMeshes();
  }

  /**
   * Rebuild floor/wall InstancedMeshes and collision mesh from current
   * tile data. Called after openGate() modifies the tile array.
   */
  private _rebuildTileMeshes(): void {
    if (!this._tileData) return;

    const { width, height, tileSize, tiles, geometry } = this._tileData;
    const wallHeight = geometry?.wallHeight ?? DEFAULT_WALL_HEIGHT;

    // Remove old meshes (but keep lights and ceiling)
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
    // NOTE: colliderMesh is NOT removed here — _buildCollisionMesh updates
    // its geometry in-place so that PlayerEntity's cached reference stays valid.

    // Recount
    let floorCount = 0;
    let wallCount  = 0;
    for (const t of tiles) {
      if (t === Tile.FLOOR) floorCount++;
      else if (t === Tile.WALL) wallCount++;
    }

    // Rebuild floor
    if (floorCount > 0) {
      const floorGeo = new THREE.PlaneGeometry(tileSize, tileSize);
      floorGeo.rotateX(-Math.PI / 2);
      const floorMat = new THREE.MeshStandardMaterial({
        color: FLOOR_COLOR, roughness: 0.9, metalness: 0.1,
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

    // Rebuild walls
    if (wallCount > 0) {
      const wallGeo = new THREE.BoxGeometry(tileSize, wallHeight, tileSize);
      const wallMat = new THREE.MeshStandardMaterial({
        color: WALL_COLOR, roughness: 0.95, metalness: 0.05,
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
          mat4.makeTranslation(wx, wallHeight / 2, wz);
          this.wallMesh.setMatrixAt(idx++, mat4);
        }
      }
      this.wallMesh.instanceMatrix.needsUpdate = true;
      this.group.add(this.wallMesh);
    }

    // Rebuild collision
    this._buildCollisionMesh(width, height, tileSize, tiles, wallHeight);
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
    if (this.ceilingMesh) {
      this.ceilingMesh.geometry.dispose();
      (this.ceilingMesh.material as THREE.Material).dispose();
      this.group.remove(this.ceilingMesh);
      this.ceilingMesh = null;
    }
    if (this.colliderMesh) {
      this.colliderMesh.geometry.dispose();
      (this.colliderMesh.material as THREE.Material).dispose();
      this.group.remove(this.colliderMesh);
      this.colliderMesh = null;
    }
    for (const light of this.lights) {
      this.group.remove(light);
      if (light instanceof THREE.PointLight) light.dispose();
    }
    this.lights.length = 0;
  }

  // ── Ceiling clip ───────────────────────────────────────────────────────

  /**
   * Update the centre of the ceiling clip hole.  Computes where the ray
   * from camera → player intersects the ceiling plane (Y = ceilingHeight)
   * so the hole tracks the camera's actual line of sight.
   *
   * Call every frame after `camera.follow()`.
   */
  setClipCenter(
    camX: number, camY: number, camZ: number,
    playerX: number, playerZ: number,
  ): void {
    const dy = 0 - camY; // player Y is 0
    if (Math.abs(dy) < 0.001) {
      // Camera at player height — degenerate, just use player XZ
      this._clipCenter.set(playerX, 0, playerZ);
      return;
    }
    const t = (this._ceilingY - camY) / dy;
    // Clamp t to [0,1] — if camera is below the ceiling the intersection
    // is behind the camera; in that case use the player position.
    if (t < 0 || t > 1) {
      this._clipCenter.set(playerX, 0, playerZ);
      return;
    }
    this._clipCenter.set(
      camX + t * (playerX - camX),
      0,
      camZ + t * (playerZ - camZ),
    );
  }

  /** Toggle ceiling mesh visibility (useful for top-down debugging). */
  setCeilingVisible(visible: boolean): void {
    if (this.ceilingMesh) {
      this.ceilingMesh.visible = visible;
    }
  }

  /**
   * Inject a circular discard into the ceiling material's shader so that
   * fragments within {@link CEIL_CLIP_RADIUS} XZ-metres of `_clipCenter`
   * are discarded — letting the camera see through to the player.
   */
  private _applyCeilingClip(mat: THREE.MeshStandardMaterial): void {
    const clipCenter = this._clipCenter;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uClipCenter = { value: clipCenter };
      shader.uniforms.uClipRadius = { value: CEIL_CLIP_RADIUS };

      // ── vertex: compute world position for the fragment shader ──
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vCeilClipWPos;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvCeilClipWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );

      // ── fragment: discard inside the clip circle ──
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uClipCenter;\nuniform float uClipRadius;\nvarying vec3 vCeilClipWPos;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n'
        + 'float _cd = length(vCeilClipWPos.xz - uClipCenter.xz);\n'
        + 'if (_cd < uClipRadius) discard;',
      );
    };
  }

  // ── Wall collision ────────────────────────────────────────────────────

  /**
   * Build a single merged BufferGeometry containing a vertical quad for every
   * wall-tile face that is adjacent to a FLOOR tile.  This gives us ~1000–2000
   * triangles that exactly trace the inner wall surfaces — lightweight enough
   * for the narrow-phase raycast in PlayerEntity._clipMovement().
   *
   * The mesh is invisible (material.visible=false) so it doesn't render,
   * but Three.js Raycaster still tests against it because Mesh.raycast()
   * only checks object.visible, not material.visible.
   */
  private _buildCollisionMesh(
    width: number, height: number, tileSize: number,
    tiles: number[], wallHeight: number,
  ): void {
    const positions: number[] = [];
    const normals:   number[] = [];
    const half = tileSize / 2;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        if (tiles[row * width + col] !== Tile.WALL) continue;

        const wx = (col - width / 2) * tileSize + half;
        const wz = (row - height / 2) * tileSize + half;

        // North (row-1 is FLOOR) → face at z = wz - half, normal (0,0,-1)
        if (row > 0 && tiles[(row - 1) * width + col] === Tile.FLOOR) {
          this._pushQuad(positions, normals,
            wx - half, 0, wz - half,
            wx - half, wallHeight, wz - half,
            wx + half, wallHeight, wz - half,
            wx + half, 0, wz - half,
            0, 0, -1,
          );
        }
        // South (row+1 is FLOOR) → face at z = wz + half, normal (0,0,+1)
        if (row < height - 1 && tiles[(row + 1) * width + col] === Tile.FLOOR) {
          this._pushQuad(positions, normals,
            wx + half, 0, wz + half,
            wx + half, wallHeight, wz + half,
            wx - half, wallHeight, wz + half,
            wx - half, 0, wz + half,
            0, 0, 1,
          );
        }
        // West (col-1 is FLOOR) → face at x = wx - half, normal (-1,0,0)
        if (col > 0 && tiles[row * width + (col - 1)] === Tile.FLOOR) {
          this._pushQuad(positions, normals,
            wx - half, 0, wz + half,
            wx - half, wallHeight, wz + half,
            wx - half, wallHeight, wz - half,
            wx - half, 0, wz - half,
            -1, 0, 0,
          );
        }
        // East (col+1 is FLOOR) → face at x = wx + half, normal (+1,0,0)
        if (col < width - 1 && tiles[row * width + (col + 1)] === Tile.FLOOR) {
          this._pushQuad(positions, normals,
            wx + half, 0, wz - half,
            wx + half, wallHeight, wz - half,
            wx + half, wallHeight, wz + half,
            wx + half, 0, wz + half,
            1, 0, 0,
          );
        }
      }
    }

    if (positions.length === 0) {
      // No collision geometry — clear the existing mesh if it has one
      if (this.colliderMesh) {
        this.colliderMesh.geometry.dispose();
        this.colliderMesh.geometry = new THREE.BufferGeometry();
      }
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
    geo.computeBoundingSphere();

    if (this.colliderMesh) {
      // Update geometry in-place so PlayerEntity's cached reference stays valid
      this.colliderMesh.geometry.dispose();
      this.colliderMesh.geometry = geo;
    } else {
      // First build — create the mesh
      const mat = new THREE.MeshBasicMaterial({ visible: false });
      this.colliderMesh = new THREE.Mesh(geo, mat);
      this.colliderMesh.name = 'vault_wall_collider';
      this.group.add(this.colliderMesh);
    }
  }

  /** Push two triangles (one quad) with a flat normal into position/normal arrays. */
  private _pushQuad(
    pos: number[], nrm: number[],
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
  ): void {
    // Triangle 1: A → B → C
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    // Triangle 2: A → C → D
    pos.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
    nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }

}
