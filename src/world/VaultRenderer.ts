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

  /** Room-center point lights — candidates for the shadow follower. */
  private roomPointLights: THREE.PointLight[] = [];

  /** How many of the nearest room lights cast shadows each frame. Each
   *  enabled point shadow = 6 cubemap render passes, so this is the single
   *  biggest perf knob in a vault. */
  private shadowBudget = 1;

  /** Stored tile data for rebuilding meshes when gates open. */
  private _tileData: VaultTileData | null = null;

  /** Read-only access to the current tile data (mutated as gates open).
   *  Consumed by the vault minimap so it sees the same opened-gate state
   *  the 3D meshes do. Returns null until `build()` runs. */
  get tileData(): VaultTileData | null { return this._tileData; }

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
    // MeshLambertMaterial instead of Standard: vault walls/floors are matte
    // stone, no specular needed. Lambert's per-pixel light loop is ~3-4×
    // cheaper than PBR Standard, which dominates GPU cost in vaults where
    // every visible pixel is close-up wall lit by ~7 point lights.
    if (floorCount > 0) {
      const floorGeo = new THREE.PlaneGeometry(tileSize, tileSize);
      floorGeo.rotateX(-Math.PI / 2); // lay flat
      const floorMat = new THREE.MeshLambertMaterial({
        color: FLOOR_COLOR,
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
      const wallMat = new THREE.MeshLambertMaterial({
        color: WALL_COLOR,
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

    // ── Flat Ceiling ───────────────────────────────────────────────
    // Unlit MeshBasicMaterial: zero per-pixel light-loop cost (the dominant
    // GPU cost in vaults), just a flat color blended with fog. Cheaper than
    // leaving "look up = void" and avoids the discard-based clip shader the
    // previous implementation used (discard kills early-Z). When the orbit
    // camera rises above the ceiling Y, setClipCenter() hides the mesh so
    // it doesn't occlude the player.
    const vaultSpanX = width  * tileSize;
    const vaultSpanZ = height * tileSize;
    const ceilGeo = new THREE.PlaneGeometry(vaultSpanX, vaultSpanZ);
    ceilGeo.rotateX(Math.PI / 2);  // normal -Y, front face visible from below
    const ceilMat = new THREE.MeshBasicMaterial({
      color: CEILING_COLOR,
      fog:   true,
    });
    this.ceilingMesh = new THREE.Mesh(ceilGeo, ceilMat);
    this.ceilingMesh.position.set(0, ceilingHeight, 0);
    this.group.add(this.ceilingMesh);

    // ── Vault Lighting ───────────────────────────────────────────────
    // Static indoor lights that don't change with time-of-day.

    // Bright ambient fill — vaults have no sun/fill from SceneManager
    const ambient = new THREE.AmbientLight(0x909098, 1.0);
    this.lights.push(ambient);
    this.group.add(ambient);

    // Place a small fixed budget of point lights, evenly spaced across the
    // room list. Three.js MeshLambert/Standard materials run a per-pixel
    // loop over every light in the scene (no distance branch, no early-out)
    // so the count itself drives fragment cost — 6 lights × every visible
    // wall pixel was the wall. 2 atmospheric lights + ambient is plenty
    // for "ominous corner" feel; intensity is bumped to compensate.
    //
    // castShadow defaults off; updateShadowFollow() turns it on for the
    // nearest `shadowBudget` light each frame at 256² mapSize.
    const LIGHT_BUDGET = 2;
    const centers = data.roomCenters ?? [];
    if (centers.length > 0) {
      const count = Math.min(LIGHT_BUDGET, centers.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor((i * centers.length) / count);
        const center = centers[idx]!;
        const pointLight = new THREE.PointLight(0xddeeff, 4.0, 0, 1.0);
        pointLight.position.set(center.x, ceilingHeight * 0.6, center.z);
        pointLight.castShadow = false;
        pointLight.shadow.mapSize.set(256, 256);
        this.lights.push(pointLight);
        this.roomPointLights.push(pointLight);
        this.group.add(pointLight);
      }
    } else {
      // No room data — single light at vault center
      const pointLight = new THREE.PointLight(0xddeeff, 4.0, 0, 1.0);
      pointLight.position.set(0, ceilingHeight * 0.6, 0);
      pointLight.castShadow = false;
      pointLight.shadow.mapSize.set(256, 256);
      this.lights.push(pointLight);
      this.roomPointLights.push(pointLight);
      this.group.add(pointLight);
    }

    // ── Entrance marker ────────────────────────────────────────────────
    // Visible-from-anywhere amber beacon at the entry chamber: emissive
    // floor rune + tall light beam up through the ceiling so the player
    // can spot it across the whole dungeon and never lose their bearings.
    if (data.entrance) {
      // Floor rune ring.
      const markerGeo = new THREE.TorusGeometry(1.5, 0.12, 10, 32);
      markerGeo.rotateX(-Math.PI / 2);
      const markerMat = new THREE.MeshStandardMaterial({
        color:             0x201808,
        emissive:          0xffb04a,
        emissiveIntensity: 1.6,
        roughness:         0.5,
        metalness:         0.6,
      });
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.set(data.entrance.x, 0.05, data.entrance.z);
      this.group.add(marker);

      // Light beam — translucent amber column rising to the ceiling, additive
      // blended so it looks like volumetric light. Visible across the whole
      // vault even through walls (no depth write).
      const beamHeight = ceilingHeight + 4;
      const beamGeo = new THREE.CylinderGeometry(0.6, 0.9, beamHeight, 16, 1, true);
      const beamMat = new THREE.MeshBasicMaterial({
        color:       0xffa040,
        transparent: true,
        opacity:     0.30,
        side:        THREE.DoubleSide,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(data.entrance.x, beamHeight / 2, data.entrance.z);
      this.group.add(beam);

      // Brighter inner core for the beam.
      const coreGeo = new THREE.CylinderGeometry(0.2, 0.3, beamHeight, 12, 1, true);
      const coreMat = new THREE.MeshBasicMaterial({
        color:       0xffe8c0,
        transparent: true,
        opacity:     0.55,
        side:        THREE.DoubleSide,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.position.set(data.entrance.x, beamHeight / 2, data.entrance.z);
      this.group.add(core);

      // Floor halo light.
      const markerLight = new THREE.PointLight(0xffa040, 2.2, 12, 1.6);
      markerLight.position.set(data.entrance.x, 2, data.entrance.z);
      this.lights.push(markerLight);
      this.group.add(markerLight);
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
      const floorMat = new THREE.MeshLambertMaterial({ color: FLOOR_COLOR });
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
      const wallMat = new THREE.MeshLambertMaterial({ color: WALL_COLOR });
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
    this.roomPointLights.length = 0;
  }

  // ── Shadow follower ────────────────────────────────────────────────────

  /**
   * Enable `castShadow` on the {@link shadowBudget} room lights nearest the
   * player; disable it on the rest. Cheap O(N) over `roomPointLights`.
   *
   * Each point shadow is 6 cubemap render passes per frame, so going from
   * "all rooms cast" to "nearest 2" turns 6×6=36 shadow passes into 2×6=12.
   * Call once per frame from the game loop while in a vault.
   */
  updateShadowFollow(playerX: number, playerY: number, playerZ: number): void {
    const lights = this.roomPointLights;
    if (lights.length <= this.shadowBudget) {
      // Nothing to choose — every light gets to cast.
      for (const l of lights) l.castShadow = true;
      return;
    }
    // Pick the indices of the `shadowBudget` closest lights via a tiny
    // selection scan — avoids allocating per-frame for a 1–8 element list.
    const budget = this.shadowBudget;
    const dists  = lights.map(l => {
      const dx = l.position.x - playerX;
      const dy = l.position.y - playerY;
      const dz = l.position.z - playerZ;
      return dx*dx + dy*dy + dz*dz;
    });
    const winners = new Set<number>();
    for (let pick = 0; pick < budget; pick++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < lights.length; i++) {
        if (winners.has(i)) continue;
        if (dists[i]! < bestD) { bestD = dists[i]!; best = i; }
      }
      if (best >= 0) winners.add(best);
    }
    for (let i = 0; i < lights.length; i++) {
      lights[i]!.castShadow = winners.has(i);
    }
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
    // Hide the ceiling when the orbit camera rises above it — otherwise the
    // top-down camera would render the back of the ceiling and occlude the
    // player. 0.5m margin avoids flicker right at the boundary.
    if (this.ceilingMesh) {
      this.ceilingMesh.visible = camY < this._ceilingY - 0.5;
    }

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
