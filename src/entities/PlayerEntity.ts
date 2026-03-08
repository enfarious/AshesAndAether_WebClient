import * as THREE from 'three';
import { EntityObject } from './EntityObject';
import type { CharacterState } from '@/network/Protocol';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * PlayerMoveMode — exactly one position source has authority per mode.
 *
 *   IDLE       — lerp toward the latest server position (like RemoteEntity)
 *   WASD       — WASDController drives position directly each frame
 *   CLICK_MOVE — PlayerEntity predicts toward the click target at server speed
 */
export const enum PlayerMoveMode {
  IDLE       = 0,
  WASD       = 1,
  CLICK_MOVE = 2,
}

/** Player capsule radius — stop this far before walls. */
const CAPSULE_RADIUS = 0.38;

/** Height at which to cast horizontal wall-detection rays (chest level). */
const RAY_HEIGHT = 0.9;

/**
 * Max bounding-sphere radius for a collision candidate (m).
 * Meshes larger than this are presumed to be terrain — the heightmap already
 * handles terrain-following, so we skip them to avoid expensive raycasts
 * against hundreds-of-thousands of terrain triangles.
 */
const COLLISION_CANDIDATE_MAX_RADIUS = 50;

/** Extra margin beyond movement distance for broad-phase sphere test (m). */
const BROAD_PHASE_MARGIN = 2.0;

/**
 * Minimum Y extent (height) for a collision candidate (m).
 * Flat geometry (roads, ground planes, water surfaces) is excluded —
 * a horizontal chest-level ray would never hit them anyway, and skipping
 * them keeps the candidate list lean.
 */
const COLLISION_MIN_HEIGHT = 1.0;

/** Pre-computed collision candidate from worldRoot. */
interface CollisionCandidate {
  obj:    THREE.Object3D;
  center: THREE.Vector3;
  radius: number;
}

/**
 * PlayerEntity — the local player's visual representation.
 *
 * Uses a mode-based state machine so exactly one position source has
 * authority at any time.  No consumed-per-frame nullable.
 *
 * Client-side physics:
 *   • Terrain following — samples HeightmapService for Y each frame
 *   • Wall collision    — short horizontal raycast against worldRoot meshes
 *
 * Mode transitions:
 *   IDLE → WASD        drivePosition() called
 *   WASD → IDLE        stopWASD() called (keys released)
 *   IDLE → CLICK_MOVE  startClickMove() called
 *   CLICK_MOVE → IDLE  arrives at target (< 0.1m) or server drift > 3m
 *   CLICK_MOVE → WASD  user presses WASD (stopClickMove() + drivePosition())
 *   ANY → IDLE (snap)  server position > 15m away (teleport detection)
 */
export class PlayerEntity extends EntityObject {
  // ── Mode state ────────────────────────────────────────────────────────────
  private _mode: PlayerMoveMode = PlayerMoveMode.IDLE;

  /** Latest server-authoritative position — always kept up-to-date. */
  private _serverPos  = new THREE.Vector3();

  /** Click-to-move destination. null when not in CLICK_MOVE mode. */
  private _clickTarget: THREE.Vector3 | null = null;

  /** Movement speed for click-move prediction (m/s). */
  private _speedMPS = 5.0;

  /** Lerp speed for IDLE reconciliation (higher = snappier). */
  private _lerpSpeed = 12;

  /** Teleport threshold — snap + force IDLE if server pos > this. */
  private static readonly TELEPORT_DIST = 15;

  /** Click-move drift threshold — cancel prediction if server disagrees. */
  private static readonly CLICK_DRIFT_MAX = 3;

  // ── Client-side physics ──────────────────────────────────────────────────
  private _heightmap:  HeightmapService | null   = null;
  private _worldRoot:  THREE.Object3D  | null    = null;

  /**
   * Pre-computed bounding spheres for worldRoot's top-level children.
   * Terrain-scale meshes (radius > COLLISION_CANDIDATE_MAX_RADIUS) are
   * excluded — heightmap handles terrain following.  Only buildings,
   * structures, and other walkable-scale obstacles are kept.
   */
  private _collisionCandidates: CollisionCandidate[] = [];

  /** Reusable raycaster for wall collision — avoids per-frame allocation. */
  private _collisionRay = new THREE.Raycaster();

  /** Scratch vectors reused every frame — avoids GC pressure. */
  private _rayOrigin = new THREE.Vector3();
  private _rayDir    = new THREE.Vector3();

  constructor(character: CharacterState, scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name = `player_${character.id}`;

    // Player is a slightly brighter capsule with a subtle emissive rim
    const geo = new THREE.CapsuleGeometry(0.38, 1.05, 4, 8);
    const mat = new THREE.MeshStandardMaterial({
      color:     0x6699ff,
      emissive:  0x112244,
      roughness: 0.6,
      metalness: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.y = 0.9;
    root.add(mesh);

    // Small glow ring at feet
    const ringGeo = new THREE.TorusGeometry(0.45, 0.04, 6, 24);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x4477ff,
      emissive: 0x2244aa,
      roughness: 1,
      metalness: 0,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    root.add(ring);

    if (character.position) {
      root.position.set(character.position.x, character.position.y, character.position.z);
    }
    if (character.heading !== undefined) {
      root.rotation.y = THREE.MathUtils.degToRad(-character.heading);
    }

    scene.add(root);
    super(character.id, root);

    this._serverPos.copy(root.position);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current movement mode — read by ClickMoveController for WASD priority check. */
  get mode(): PlayerMoveMode { return this._mode; }

  /** Provide the heightmap for terrain-following during prediction. */
  setHeightmap(hm: HeightmapService | null): void { this._heightmap = hm; }

  /**
   * Provide the world root for wall-collision raycasting during prediction.
   *
   * Pre-computes bounding spheres for collision candidates, using a two-tier
   * approach to handle both small individual GLBs and large composite GLBs:
   *
   *   • **Small child** (radius ≤ 50 m, height ≥ 1 m) — added directly.
   *     A single building or structure in its own GLB.
   *
   *   • **Large child** (radius > 50 m) — drilled one level deeper.
   *     This is a composite like `buildings.glb` that packs many structures
   *     into one file.  Each sub-child gets its own bounding sphere, so the
   *     broad-phase can cull per-building, not per-zone.
   *     Groups named "terrain", "road", or "water" are skipped entirely.
   *
   *   • **Flat geometry** (Y extent < 1 m) — skipped at both levels.
   *     Roads, ground planes, and water surfaces would never be hit by the
   *     chest-level horizontal ray anyway.
   */
  setWorldRoot(root: THREE.Object3D | null): void {
    this._worldRoot = root;
    this._collisionCandidates = [];
    if (!root) return;

    const box    = new THREE.Box3();
    const sphere = new THREE.Sphere();

    for (const child of root.children) {
      box.setFromObject(child);
      if (box.isEmpty()) continue;
      box.getBoundingSphere(sphere);

      if (sphere.radius <= COLLISION_CANDIDATE_MAX_RADIUS) {
        // Small enough to be a single structure — check height and add.
        if (box.max.y - box.min.y < COLLISION_MIN_HEIGHT) continue;
        this._collisionCandidates.push({
          obj:    child,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      } else {
        // Large group (e.g. buildings.glb spanning the zone) — drill into
        // individual children so each building gets its own bounding sphere.
        // Skip groups that are definitely not collidable geometry.
        const name = child.name.toLowerCase();
        if (name.includes('terrain') || name.includes('road') || name.includes('water')) continue;

        for (const sub of child.children) {
          box.setFromObject(sub);
          if (box.isEmpty()) continue;
          if (box.max.y - box.min.y < COLLISION_MIN_HEIGHT) continue;
          box.getBoundingSphere(sphere);
          // Collider meshes (e.g. vault_wall_collider) are always included —
          // they span the whole vault but are specifically built for raycasting.
          if (sphere.radius > COLLISION_CANDIDATE_MAX_RADIUS
              && !sub.name.includes('collider')) continue;
          this._collisionCandidates.push({
            obj:    sub,
            center: sphere.center.clone(),
            radius: sphere.radius,
          });
        }
      }
    }

    console.log(
      `[PlayerEntity] ${this._collisionCandidates.length} collision candidates`
      + ` (of ${root.children.length} worldRoot children)`,
    );
  }

  /**
   * Called by WASDController every frame while movement keys are held.
   * Sets mode=WASD, applies terrain following + wall collision, then writes position.
   */
  drivePosition(x: number, y: number, z: number): void {
    this._mode = PlayerMoveMode.WASD;

    // 1. Terrain following — override Y with heightmap elevation
    if (this._heightmap) {
      const elev = this._heightmap.getElevation(x, z);
      if (elev !== null) y = elev;
    }

    // 2. Wall collision — clip movement if a wall is ahead
    const clipped = this._clipMovement(x, z);
    if (clipped) {
      x = clipped.x;
      z = clipped.z;
      // Re-sample heightmap at clipped position
      if (this._heightmap) {
        const elev = this._heightmap.getElevation(x, z);
        if (elev !== null) y = elev;
      }
    }

    // 3. Apply position
    this.object3d.position.x = x;
    this.object3d.position.z = z;
    // Lerp Y so terrain slope changes don't pop
    this.object3d.position.y = THREE.MathUtils.lerp(
      this.object3d.position.y, y, 0.15,
    );
  }

  /**
   * Called by WASDController when movement keys are released.
   * Entity starts lerping toward the latest server position.
   */
  stopWASD(): void {
    if (this._mode === PlayerMoveMode.WASD) {
      this._mode = PlayerMoveMode.IDLE;
    }
  }

  /**
   * Called by ClickMoveController after sending move_position to the server.
   * PlayerEntity predicts movement toward the target at the given speed.
   */
  startClickMove(target: THREE.Vector3, speedMPS: number): void {
    if (this._mode === PlayerMoveMode.WASD) return; // WASD has priority
    this._clickTarget = target.clone();
    this._speedMPS = speedMPS;
    this._mode = PlayerMoveMode.CLICK_MOVE;
  }

  /**
   * Cancels click-to-move prediction, returning to IDLE.
   */
  stopClickMove(): void {
    if (this._mode === PlayerMoveMode.CLICK_MOVE) {
      this._clickTarget = null;
      this._mode = PlayerMoveMode.IDLE;
    }
  }

  // ── Entity lifecycle ────────────────────────────────────────────────────────

  override update(dt: number): void {
    switch (this._mode) {
      case PlayerMoveMode.WASD:
        // Position already set by drivePosition() this frame — nothing to do.
        break;

      case PlayerMoveMode.CLICK_MOVE: {
        if (!this._clickTarget) { this._mode = PlayerMoveMode.IDLE; break; }

        // Advance toward click target at server speed
        const dx = this._clickTarget.x - this.object3d.position.x;
        const dz = this._clickTarget.z - this.object3d.position.z;
        const distXZ = Math.hypot(dx, dz);

        if (distXZ < 0.1) {
          // Arrived
          this._clickTarget = null;
          this._mode = PlayerMoveMode.IDLE;
          break;
        }

        const step = this._speedMPS * dt;
        let newX: number;
        let newZ: number;
        if (step >= distXZ) {
          newX = this._clickTarget.x;
          newZ = this._clickTarget.z;
        } else {
          newX = this.object3d.position.x + (dx / distXZ) * step;
          newZ = this.object3d.position.z + (dz / distXZ) * step;
        }

        // Wall collision — slide along walls toward click target
        const clipped = this._clipMovement(newX, newZ, this._clickTarget);
        if (clipped) {
          this.object3d.position.x = clipped.x;
          this.object3d.position.z = clipped.z;
        } else {
          this.object3d.position.x = newX;
          this.object3d.position.z = newZ;
        }

        // Terrain following — sample heightmap for Y
        let targetY = this._serverPos.y;
        if (this._heightmap) {
          const elev = this._heightmap.getElevation(
            this.object3d.position.x,
            this.object3d.position.z,
          );
          if (elev !== null) targetY = elev;
        }
        this.object3d.position.y = THREE.MathUtils.lerp(
          this.object3d.position.y,
          targetY,
          Math.min(this._lerpSpeed * dt, 1),
        );
        break;
      }

      case PlayerMoveMode.IDLE:
      default: {
        // Smoothly lerp toward the latest server position
        const target = this._serverPos;

        // If heightmap available, override Y with terrain elevation
        // so we stick to the rendered terrain even during idle reconciliation.
        let targetY = target.y;
        if (this._heightmap) {
          // Sample at the lerp destination (server pos), not current pos,
          // so we converge to the correct height.
          const elev = this._heightmap.getElevation(target.x, target.z);
          if (elev !== null) targetY = elev;
        }

        const alpha = Math.min(this._lerpSpeed * dt, 1);
        this.object3d.position.x = THREE.MathUtils.lerp(this.object3d.position.x, target.x, alpha);
        this.object3d.position.z = THREE.MathUtils.lerp(this.object3d.position.z, target.z, alpha);
        this.object3d.position.y = THREE.MathUtils.lerp(this.object3d.position.y, targetY, alpha);
        break;
      }
    }
  }

  /**
   * Called by EntityFactory on every server state_update.
   * Buffers the position internally; behaviour depends on current mode.
   */
  override setTargetPosition(
    position: THREE.Vector3,
    heading?: number,
    _durationMs?: number,
  ): void {
    this._bufferServerPosition(position, heading);
  }

  /** Predicted position used for camera follow (pre-reconciliation). */
  get cameraTarget(): THREE.Vector3 {
    return this.object3d.position;
  }

  // ── Client-side physics ──────────────────────────────────────────────────

  /**
   * Cast a short horizontal ray from the current position toward (newX, newZ).
   * If a wall is hit, slide along it (project remaining movement onto the wall
   * plane) so the player doesn't just stop dead.  Returns the adjusted position
   * or null if the path is completely clear.
   *
   * Uses a two-phase approach for performance:
   *   1. **Broad phase** — check pre-computed bounding spheres of worldRoot's
   *      top-level children.  Only candidates whose sphere overlaps the
   *      movement corridor are kept.  Terrain-scale meshes are already
   *      excluded at `setWorldRoot()` time.
   *   2. **Narrow phase** — raycast only against the nearby candidates.
   *
   * In open terrain with no buildings nearby the broad phase eliminates
   * everything and we return null with zero raycast cost.
   *
   * @param slideTarget  Optional destination the player is trying to reach
   *   (click-to-move target).  When the normal wall-slide projection is
   *   near-zero (head-on collision), the player slides along the wall
   *   tangent in the direction that reduces distance to this target —
   *   effectively "wall following" to navigate around buildings.
   *   WASD callers omit this so head-on hits feel like a solid stop.
   */
  private _clipMovement(
    newX: number,
    newZ: number,
    slideTarget?: { x: number; z: number },
  ): { x: number; z: number } | null {
    if (this._collisionCandidates.length === 0) return null;

    const curX = this.object3d.position.x;
    const curZ = this.object3d.position.z;
    const dx = newX - curX;
    const dz = newZ - curZ;
    const horizDist = Math.hypot(dx, dz);

    if (horizDist < 0.001) return null;

    const dirX = dx / horizDist;
    const dirZ = dz / horizDist;

    // ── Broad phase ──────────────────────────────────────────────────────
    // Sphere overlap test: player position vs each candidate's bounding
    // sphere, inflated by the movement distance + capsule radius + margin.
    const searchRadius = horizDist + CAPSULE_RADIUS + BROAD_PHASE_MARGIN;
    const nearby: THREE.Object3D[] = [];

    for (const c of this._collisionCandidates) {
      const cdx = c.center.x - curX;
      const cdz = c.center.z - curZ;
      const distSq = cdx * cdx + cdz * cdz;
      const combined = searchRadius + c.radius;
      if (distSq <= combined * combined) {
        nearby.push(c.obj);
      }
    }

    if (nearby.length === 0) return null;

    // ── Narrow phase ─────────────────────────────────────────────────────
    // Ray at chest height, horizontal direction only
    this._rayOrigin.set(curX, this.object3d.position.y + RAY_HEIGHT, curZ);
    this._rayDir.set(dirX, 0, dirZ);

    this._collisionRay.set(this._rayOrigin, this._rayDir);
    this._collisionRay.far = horizDist + CAPSULE_RADIUS;
    this._collisionRay.near = 0;

    const hits = this._collisionRay.intersectObjects(nearby, true);
    if (hits.length === 0) return null;

    const hit = hits[0]!;
    if (hit.distance >= horizDist + CAPSULE_RADIUS) return null;

    // ── Wall slide ────────────────────────────────────────────────────────
    // Project remaining movement onto the wall surface so the player slides
    // along it instead of stopping dead.  The hit face normal (in world
    // space) tells us which way the wall faces; we zero out Y to keep it 2D.
    const safeDist = Math.max(0, hit.distance - CAPSULE_RADIUS);
    const remainDist = horizDist - safeDist;

    // Start from the clipped (safe) position
    let slideX = curX + dirX * safeDist;
    let slideZ = curZ + dirZ * safeDist;

    if (hit.face && remainDist > 0.001) {
      // Transform face normal to world space (meshes may be rotated/scaled)
      const nWorld = hit.face.normal.clone()
        .transformDirection(hit.object.matrixWorld);
      const nx = nWorld.x;
      const nz = nWorld.z;
      const nLen = Math.hypot(nx, nz);

      if (nLen > 0.001) {
        const nnx = nx / nLen;
        const nnz = nz / nLen;

        // Remaining movement vector
        const remX = dirX * remainDist;
        const remZ = dirZ * remainDist;
        // Project onto wall plane: v - (v·n)*n
        const dot  = remX * nnx + remZ * nnz;
        const projX = remX - dot * nnx;
        const projZ = remZ - dot * nnz;
        const projLen = Math.hypot(projX, projZ);

        if (projLen > 0.01 * remainDist) {
          // Normal wall slide — enough lateral component
          slideX += projX;
          slideZ += projZ;
        } else if (slideTarget) {
          // Head-on into wall + click-to-move target available.
          // Slide along the wall tangent in whichever direction reduces
          // distance to the target — "wall following" to navigate around.
          const tx = -nnz;   // wall tangent: rotate normal 90° CW
          const tz =  nnx;
          const toTargetX = slideTarget.x - slideX;
          const toTargetZ = slideTarget.z - slideZ;
          const tangentDot = toTargetX * tx + toTargetZ * tz;
          const sign = tangentDot >= 0 ? 1 : -1;
          slideX += sign * tx * remainDist;
          slideZ += sign * tz * remainDist;
        }
        // else: WASD head-on — player stops at wall (natural feel)
      }
    }

    return { x: slideX, z: slideZ };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Stores the server position and applies mode-specific side effects:
   *   - Teleport: dist > 15m → snap and force IDLE
   *   - CLICK_MOVE: drift > 3m → cancel prediction, snap to server
   *   - WASD: no effect on object3d (just stored)
   *   - IDLE: _serverPos is the lerp target in update()
   */
  private _bufferServerPosition(position: THREE.Vector3, heading?: number): void {
    const dist = this.object3d.position.distanceTo(position);

    // Teleport detection — large jump (zone change, GM warp)
    if (dist > PlayerEntity.TELEPORT_DIST) {
      this.object3d.position.copy(position);
      this._serverPos.copy(position);
      this._clickTarget = null;
      this._mode = PlayerMoveMode.IDLE;
      if (heading !== undefined) {
        this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
      }
      return;
    }

    // Always keep _serverPos up-to-date
    this._serverPos.copy(position);

    // Mode-specific behaviour
    switch (this._mode) {
      case PlayerMoveMode.WASD:
        // Don't touch object3d — WASDController is driving it.
        // Just update heading if provided.
        if (heading !== undefined) {
          this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
        }
        break;

      case PlayerMoveMode.CLICK_MOVE:
        // If server disagrees significantly, cancel prediction
        if (dist > PlayerEntity.CLICK_DRIFT_MAX) {
          this.object3d.position.copy(position);
          this._clickTarget = null;
          this._mode = PlayerMoveMode.IDLE;
        }
        if (heading !== undefined) {
          this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
        }
        break;

      case PlayerMoveMode.IDLE:
      default:
        // _serverPos is the lerp target — update() handles movement.
        if (heading !== undefined) {
          this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
        }
        break;
    }
  }
}
