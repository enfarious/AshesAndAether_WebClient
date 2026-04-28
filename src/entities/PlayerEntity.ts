import * as THREE from 'three';
import { EntityObject } from './EntityObject';
import type { CharacterState } from '@/network/Protocol';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * PlayerMoveMode — exactly one position source has authority per mode.
 *
 *   IDLE — lerp toward the latest server position (like RemoteEntity).
 *          Click-to-move uses this mode: client sends the click to the
 *          server and lerps verbatim to the resulting position broadcasts.
 *   WASD — WASDController drives position directly each frame.
 */
export const enum PlayerMoveMode {
  IDLE = 0,
  WASD = 1,
  /** Client-predicts a deterministic jump arc using captured (heading, speed)
   *  at jump-start. Server runs the same math, so prediction is exact except
   *  when collision diverges (wall stops server, client kept going). Server
   *  state_updates are watched for drift > snap threshold and corrected. */
  JUMPING = 2,
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
const COLLISION_MIN_HEIGHT      = 1.0;
const COLLISION_MIN_HEIGHT_ROAD = 0.2;

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
 *   ANY → IDLE (snap)  server position > 15m away (teleport detection)
 */
export class PlayerEntity extends EntityObject {
  // ── Mode state ────────────────────────────────────────────────────────────
  private _mode: PlayerMoveMode = PlayerMoveMode.IDLE;

  /** Latest server-authoritative position — always kept up-to-date. */
  private _serverPos     = new THREE.Vector3();
  private _serverPosTime = 0;

  /** Previous server-authoritative position — used for snapshot interpolation. */
  private _prevServerPos     = new THREE.Vector3();
  private _prevServerTime    = 0;

  /**
   * Click-launch kick: when the player clicks from rest, walk locally toward
   * the click target at walk speed for the brief window before the server's
   * first response arrives. Eliminates the launch hesitation; the snapshot
   * interp catches us up smoothly to the (faster) server pace once snapshots
   * resume.
   */
  private _kickActive    = false;
  private _kickTarget:    THREE.Vector3 | null = null;
  private _kickSpeedMPS  = 0;

  /**
   * Render this many ms behind real-time so we always have two snapshots
   * bracketing render time. Tuned just over the server tick interval (100 ms)
   * with a small jitter buffer.
   */
  private static readonly RENDER_DELAY_MS = 130;

  /** Server tick interval — used to synthesize a fresh prev_time after idle. */
  private static readonly TICK_MS = 100;

  /** Don't kick if we received a server snapshot more recently than this. */
  private static readonly KICK_IDLE_THRESHOLD_MS = 200;

  /** Teleport threshold — snap + force IDLE if server pos > this. */
  private static readonly TELEPORT_DIST = 15;

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

  /**
   * Terrain objects stored separately for downward-ray height sampling.
   * Used as fallback when the DEM heightmap returns null (zone edges).
   */
  private _terrainObjects: THREE.Object3D[] = [];

  /**
   * Returns XZ positions of in-range trees within the given squared radius.
   * Injected by app.ts from ForestRenderer — null until wired.
   */
  private _treeQuery: ((x: number, z: number, rSq: number) => Array<{ x: number; z: number }>) | null = null;

  /** Combined trunk + player exclusion radius — must match server CollisionSystem. */
  private static readonly TREE_EXCL_R    = 1.0;  // TREE_TRUNK_RADIUS(0.5) + PLAYER_RADIUS(0.5)
  private static readonly TREE_SEARCH_SQ = 4.0;  // search 2 m around proposed position

  /** Reusable raycaster for wall collision — avoids per-frame allocation. */
  private _collisionRay = new THREE.Raycaster();

  /** Visible body mesh — its `position.y` is offset during jump animations
   *  while the root Object3D's Y stays anchored to terrain. Means the jump
   *  visual doesn't fight the snapshot interp / heightmap follow code. */
  private _bodyMesh: THREE.Mesh | null = null;
  /** Y offset baseline for the body mesh (capsule centre). */
  private static readonly BODY_BASE_Y = 0.9;
  /** Jump animation: parabolic Y arc applied to `_bodyMesh.position.y`. */
  private _jumpStartedAt = 0;
  private _jumpDurationMs = 0;
  private _jumpApex      = 0;
  /** Captured XZ velocity at jump-start. Used by the JUMPING update branch
   *  to advance the entity each frame at the same rate the server is
   *  advancing it. Zero means "jump in place" (idle jump). */
  private _jumpVelX = 0;
  private _jumpVelZ = 0;
  /** Exponential drift-correction rate during JUMPING. Higher = pulls toward
   *  server faster. 8 means ~80% of drift closes over 200ms. Wall collisions
   *  (large drift) read as a brief rubber-band rather than a teleport. */
  private static readonly JUMP_DRIFT_RATE = 8;

  /** Drift threshold below which we don't correct at all (squared metres).
   *  Client begins prediction the instant `/jump` is sent; server begins
   *  ~RTT/2 later when the message arrives. So even with perfect math both
   *  sides, the client trails server's prediction by `vel × RTT/2` ≈ 0.25m
   *  at run speed in the direction of motion. Pulling back from this is
   *  visible jitter for nothing — it's a fundamental head-start, not real
   *  divergence. 1.0m² (1m linear) tolerates that and only kicks in on real
   *  divergence (wall collision). */
  private static readonly JUMP_DRIFT_TOLERANCE_SQ = 1.0;

  /** Reusable downward raycaster for terrain-mesh height fallback. */
  private _downRay = new THREE.Raycaster(
    new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 8000,
  );

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
    mesh.position.y = PlayerEntity.BODY_BASE_Y;
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
    // Body mesh ref for the jump arc animation. Children[0] is the capsule
    // we just added above; capturing it here avoids re-querying the scene.
    this._bodyMesh = mesh;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current movement mode — read by ClickMoveController for WASD priority check. */
  get mode(): PlayerMoveMode { return this._mode; }

  /** Provide the heightmap for terrain-following during prediction. */
  setHeightmap(hm: HeightmapService | null): void { this._heightmap = hm; }

  /** Wire up the tree position query from ForestRenderer. */
  setTreeQuery(fn: (x: number, z: number, rSq: number) => Array<{ x: number; z: number }>): void {
    this._treeQuery = fn;
  }

  /**
   * Analytical cylinder push-out for tree trunks.
   * Mirrors the server's CollisionSystem.resolveMovement tree check exactly.
   */
  private _resolveTreeCollision(x: number, z: number): { x: number; z: number } {
    if (!this._treeQuery) return { x, z };
    const R   = PlayerEntity.TREE_EXCL_R;
    const RSq = R * R;
    for (const t of this._treeQuery(x, z, PlayerEntity.TREE_SEARCH_SQ)) {
      const dx = x - t.x, dz = z - t.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < RSq) {
        const dist = distSq > 1e-8 ? Math.sqrt(distSq) : 0.001;
        x = t.x + (dx / dist) * R;
        z = t.z + (dz / dist) * R;
      }
    }
    return { x, z };
  }

  /**
   * Provide the world root for wall-collision raycasting during prediction.
   *
   * Pre-computes bounding spheres for collision candidates, using a two-tier
   * approach to handle both small individual GLBs and large composite GLBs:
   *
   *   • **Small child** (radius ≤ 50 m, height ≥ 1 m) — added directly.
   *     A single building or structure in its own GLB.
   *
   *   • **Large child** (radius > 50 m) — recursively drilled via `_drillCandidates`.
   *     Handles GLBs with "Scene" wrapper groups, merged building meshes, and
   *     deeply nested per-building hierarchies.  Recursion stops at depth 4 or
   *     when a leaf node is reached; large leaf nodes are added directly.
   *     Groups named "terrain" or "water" are skipped entirely.
   *
   *   • **Flat geometry** (Y extent < 1 m) — skipped at both levels.
   *     Roads, ground planes, and water surfaces would never be hit by the
   *     chest-level horizontal ray anyway.
   */
  setWorldRoot(root: THREE.Object3D | null): void {
    this._worldRoot            = root;
    this._collisionCandidates  = [];
    this._terrainObjects       = [];
    if (!root) return;

    const box    = new THREE.Box3();
    const sphere = new THREE.Sphere();

    for (const child of root.children) {
      const name = child.name.toLowerCase();

      // Terrain meshes are kept aside for downward-ray height fallback but
      // excluded from wall-collision candidates (heightmap handles Y).
      if (name.includes('terrain')) {
        this._terrainObjects.push(child);
        continue;
      }

      // Water surfaces are never obstacles.
      if (name.includes('water')) continue;

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
        // Large composite GLB (buildings, roads spanning the zone) — recurse
        // until we reach individual structures or leaf meshes.
        // Roads use a lower height threshold (0.2 m) so segments that barely
        // crest a hill still register as collision candidates.
        const minH = name.includes('road') ? COLLISION_MIN_HEIGHT_ROAD : COLLISION_MIN_HEIGHT;
        this._drillCandidates(child, box, sphere, 0, minH);
      }
    }

    console.log(
      `[PlayerEntity] ${this._collisionCandidates.length} collision candidates,`
      + ` ${this._terrainObjects.length} terrain object(s)`
      + ` (of ${root.children.length} worldRoot children)`,
    );
  }

  /**
   * Recursively walks `parent`'s hierarchy, adding collision candidates.
   *
   * Strategy:
   *  - Small node (radius ≤ COLLISION_CANDIDATE_MAX_RADIUS) with sufficient height → add directly.
   *  - Group/Scene wrapper (named "scene", "root", etc.) → recurse one level.
   *  - Large group (has children) → recurse into children.
   *  - Large leaf mesh (no children, big radius, named 'collider') → add directly.
   *  - Otherwise (large leaf, not a collider) → add anyway so we never miss geometry.
   *
   * Flat geometry (Y extent < COLLISION_MIN_HEIGHT) is always skipped.
   */
  private _drillCandidates(
    parent:    THREE.Object3D,
    box:       THREE.Box3,
    sphere:    THREE.Sphere,
    depth    = 0,
    minHeight = COLLISION_MIN_HEIGHT,
  ): void {
    for (const node of parent.children) {
      box.setFromObject(node);
      if (box.isEmpty()) continue;
      if (box.max.y - box.min.y < minHeight) continue;
      box.getBoundingSphere(sphere);

      if (sphere.radius <= COLLISION_CANDIDATE_MAX_RADIUS) {
        // Individual structure — add directly.
        this._collisionCandidates.push({
          obj:    node,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      } else if (node.children.length > 0 && depth < 4) {
        // Group with children — recurse deeper.
        this._drillCandidates(node, box, sphere, depth + 1, minHeight);
      } else {
        // Leaf mesh or deep node with a large footprint — add directly so
        // the horizontal raycast can still hit it (correctness over perf).
        this._collisionCandidates.push({
          obj:    node,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      }
    }
  }

  /**
   * Called by WASDController every frame while movement keys are held.
   * Sets mode=WASD, applies terrain following + wall collision, then writes position.
   */
  drivePosition(x: number, y: number, z: number): void {
    this._mode = PlayerMoveMode.WASD;

    // 1. Terrain following — override Y with ground elevation (DEM → mesh fallback)
    const elev0 = this._getGroundHeight(x, z);
    if (elev0 !== null) y = elev0;

    // 2. Wall collision — clip movement if a wall is ahead
    const clipped = this._clipMovement(x, z);
    if (clipped) {
      x = clipped.x;
      z = clipped.z;
      // Re-sample at clipped position
      const elevC = this._getGroundHeight(x, z);
      if (elevC !== null) y = elevC;
    }

    // 3. Tree collision — analytical cylinder push-out (matches server)
    ({ x, z } = this._resolveTreeCollision(x, z));

    // 4. Apply position
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
   * Click-to-move is handled server-side. The client sends the click via
   * SocketClient.sendMovePosition(); the server pathfinds and ticks the
   * player along it, broadcasting state_updates at 10 Hz. The IDLE branch
   * below lerps to those positions verbatim.
   *
   * For instant launch feedback when clicking from rest, the client also
   * runs a brief walk-speed kick toward the click target — see
   * kickClickPredict() and the IDLE update branch.
   */

  /**
   * Kick off a brief walk-speed local prediction toward `target`. Only fires
   * if we've been idle (no server motion) for at least KICK_IDLE_THRESHOLD_MS;
   * during continuous movement the snapshot interp is already smooth and a
   * kick would fight it.
   */
  kickClickPredict(target: THREE.Vector3, walkSpeedMPS: number): void {
    if (this._mode === PlayerMoveMode.WASD) return;
    const now = performance.now();
    if (now - this._serverPosTime < PlayerEntity.KICK_IDLE_THRESHOLD_MS) return;
    this._kickTarget = target.clone();
    this._kickSpeedMPS = walkSpeedMPS;
    this._kickActive = true;
  }

  /** Trigger a parabolic Y arc on the body mesh AND begin client-prediction
   *  of XZ via captured velocity (matching the server's jump branch math).
   *  `velX`/`velZ` are world-space metres/sec; defaults to zero (jump in
   *  place from idle). Server advances by the same captured velocity, so
   *  prediction is deterministic except for collision divergence. */
  playJump(velX = 0, velZ = 0, durationMs = 800, apexHeight = 1.0): void {
    this._jumpStartedAt   = performance.now();
    this._jumpDurationMs  = durationMs;
    this._jumpApex        = apexHeight;
    this._jumpVelX        = velX;
    this._jumpVelZ        = velZ;
    this._mode            = PlayerMoveMode.JUMPING;
  }

  /** True while the jump arc is in flight. WASDController consults this to
   *  suppress client-side movement prediction — during a jump the server
   *  is authoritative for XZ (it applies captured velocity), so predicting
   *  local moves would just visually fight the snap-back. */
  get isJumping(): boolean {
    return this._jumpDurationMs > 0
      && (performance.now() - this._jumpStartedAt) < this._jumpDurationMs;
  }

  /** Abort an in-flight jump arc — used by the WASDController's tap-promotion
   *  flow when a single tap (jump) becomes a double tap (dash). Snaps the
   *  body mesh straight back to its base Y; will look harsh until we have
   *  proper meshes and an animation blend layer. */
  cancelJump(): void {
    if (this._bodyMesh) this._bodyMesh.position.y = PlayerEntity.BODY_BASE_Y;
    this._jumpDurationMs = 0;
  }

  /** Apply the current jump arc to the body mesh's local Y. Called from
   *  update() after every move-mode branch so it stacks on whichever
   *  movement system set XZ this frame. */
  private _tickJumpArc(): void {
    if (!this._bodyMesh) return;
    if (this._jumpDurationMs <= 0) return;
    const t = (performance.now() - this._jumpStartedAt) / this._jumpDurationMs;
    if (t >= 1) {
      // Snap back to base, end the arc.
      this._bodyMesh.position.y = PlayerEntity.BODY_BASE_Y;
      this._jumpDurationMs      = 0;
      return;
    }
    // sin(πt) — peaks at t=0.5, returns to 0 at t=1. Cheap parabola.
    const arcY = Math.sin(t * Math.PI) * this._jumpApex;
    this._bodyMesh.position.y = PlayerEntity.BODY_BASE_Y + arcY;
  }

  // ── Entity lifecycle ────────────────────────────────────────────────────────

  override update(dt: number): void {
    // Jump arc runs alongside whatever movement mode applies — purely
    // local-mesh Y, doesn't interact with the position/snapshot systems.
    this._tickJumpArc();


    switch (this._mode) {
      case PlayerMoveMode.WASD:
        // Position already set by drivePosition() this frame — nothing to do.
        break;

      case PlayerMoveMode.JUMPING: {
        // Predict the same captured-velocity advance the server is running.
        this.object3d.position.x += this._jumpVelX * dt;
        this.object3d.position.z += this._jumpVelZ * dt;
        // Y stays terrain-bound; mesh-local arc handles the visual hop.
        const elev = this._getGroundHeight(this.object3d.position.x, this.object3d.position.z);
        if (elev !== null) this.object3d.position.y = elev;

        // Smooth drift correction — but project the latest server snapshot
        // forward to "now" using the velocity between the last two snapshots
        // before comparing. Otherwise the lerp targets a stale point (one
        // server-tick + network latency old) which at run speed is ~0.5m
        // behind reality, creating a constant phantom drift the prediction
        // fights against = jitter.
        //
        // Projection by snapshot-derived velocity, not assumed jump velocity:
        //   - Identical math both sides → projected server ≈ client → no pull.
        //   - Wall hit → server velocity collapses to ~0 → projection sticks
        //     at the snapshot → lerp naturally pulls client back to wall.
        if (
          this._serverPosTime > this._jumpStartedAt
          && this._prevServerTime > this._jumpStartedAt
        ) {
          const span = this._serverPosTime - this._prevServerTime;
          let projectedX = this._serverPos.x;
          let projectedZ = this._serverPos.z;
          if (span > 0) {
            const serverVelX = (this._serverPos.x - this._prevServerPos.x) / (span / 1000);
            const serverVelZ = (this._serverPos.z - this._prevServerPos.z) / (span / 1000);
            const elapsedSinceSnap = (performance.now() - this._serverPosTime) / 1000;
            projectedX += serverVelX * elapsedSinceSnap;
            projectedZ += serverVelZ * elapsedSinceSnap;
          }
          const dx = projectedX - this.object3d.position.x;
          const dz = projectedZ - this.object3d.position.z;
          const driftSq = dx * dx + dz * dz;
          // Threshold gate: ignore drift inside the RTT-head-start tolerance.
          // Real divergence (wall hit) grows past it and triggers a smooth
          // rubber-band toward the server position.
          if (driftSq > PlayerEntity.JUMP_DRIFT_TOLERANCE_SQ) {
            const alpha = 1 - Math.exp(-dt * PlayerEntity.JUMP_DRIFT_RATE);
            this.object3d.position.x += dx * alpha;
            this.object3d.position.z += dz * alpha;
          }
        }

        // Arc finished? Drop back to IDLE so snapshot interp picks up if
        // the player lands stationary; WASDController will re-establish
        // WASD mode on the first post-jump frame with held input.
        if (!this.isJumping) {
          this._mode = PlayerMoveMode.IDLE;
          this._jumpVelX = 0;
          this._jumpVelZ = 0;
          // Anchor the snapshot buffer to the landed position so the IDLE
          // branch doesn't yank us back to a stale pre-jump _serverPos.
          this._prevServerPos.copy(this.object3d.position);
          this._serverPos.copy(this.object3d.position);
          this._prevServerTime = performance.now() - PlayerEntity.TICK_MS;
          this._serverPosTime  = performance.now();
        }
        break;
      }

      case PlayerMoveMode.IDLE:
      default: {
        // Click-launch kick: walk locally toward the click target at walk
        // speed until the server's first response arrives (handled in
        // _bufferServerPosition by anchoring prev to the rendered position).
        if (this._kickActive && this._kickTarget) {
          const dx = this._kickTarget.x - this.object3d.position.x;
          const dz = this._kickTarget.z - this.object3d.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist >= 0.05) {
            const step = Math.min(this._kickSpeedMPS * dt, dist);
            let newX = this.object3d.position.x + (dx / dist) * step;
            let newZ = this.object3d.position.z + (dz / dist) * step;
            const clipped = this._clipMovement(newX, newZ, this._kickTarget);
            if (clipped) { newX = clipped.x; newZ = clipped.z; }
            ({ x: newX, z: newZ } = this._resolveTreeCollision(newX, newZ));
            const elev = this._getGroundHeight(newX, newZ);
            const newY = elev !== null ? elev : this.object3d.position.y;
            this.object3d.position.set(newX, newY, newZ);
          }
          break;
        }

        // Snapshot interpolation: lerp linearly between the two most-recent
        // server positions over the actual time delta they represent. Render
        // RENDER_DELAY_MS behind real-time so we always have a future
        // snapshot to interpolate toward — no extrapolation, no jitter at
        // update boundaries.
        const renderTime = performance.now() - PlayerEntity.RENDER_DELAY_MS;

        let x = this._serverPos.x;
        let z = this._serverPos.z;

        if (this._prevServerTime > 0 && this._serverPosTime > this._prevServerTime) {
          const span = this._serverPosTime - this._prevServerTime;
          const t = (renderTime - this._prevServerTime) / span;
          if (t <= 0) {
            x = this._prevServerPos.x;
            z = this._prevServerPos.z;
          } else if (t < 1) {
            x = this._prevServerPos.x + (this._serverPos.x - this._prevServerPos.x) * t;
            z = this._prevServerPos.z + (this._serverPos.z - this._prevServerPos.z) * t;
          }
          // t >= 1: fall through to the latest server pos already in x/z
        }

        // Y from terrain at the rendered XZ — never lerped against server Y
        // (which is the stale spawn value) so we always sit on the ground.
        const elevI = this._getGroundHeight(x, z);
        const y = elevI !== null ? elevI : this._serverPos.y;

        this.object3d.position.set(x, y, z);
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
    _from?: THREE.Vector3,
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

  /**
   * Sample ground elevation (metres) at world XZ.
   * Primary source: DEM heightmap.  Falls back to a downward raycast against
   * the terrain mesh when the heightmap returns null (zone edges / no DEM).
   */
  private _getGroundHeight(x: number, z: number): number | null {
    if (this._heightmap) {
      const h = this._heightmap.getElevation(x, z);
      if (h !== null) return h;
    }
    return this._sampleTerrainHeight(x, z);
  }

  /** Downward raycast against terrain GLB meshes — used outside DEM bounds. */
  private _sampleTerrainHeight(x: number, z: number): number | null {
    if (this._terrainObjects.length === 0) return null;
    this._downRay.ray.origin.set(x, 4000, z);
    const hits = this._downRay.intersectObjects(this._terrainObjects, true);
    return hits.length > 0 ? (hits[0]?.point.y ?? null) : null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Stores the server position and applies mode-specific side effects:
   *   - Teleport: XZ dist > 15m → snap and force IDLE
   *   - WASD: no effect on object3d (just stored)
   *   - IDLE: _serverPos is the lerp target in update()
   *
   * Distance checks use XZ-only so they are not polluted by the server's
   * stale Y (the server never updates Y during movement — it stays at the
   * character's DB spawn value).  The client always derives Y from the
   * heightmap / terrain mesh instead.
   */
  private _bufferServerPosition(position: THREE.Vector3, heading?: number): void {
    const xzDist = Math.hypot(
      position.x - this.object3d.position.x,
      position.z - this.object3d.position.z,
    );

    const now = performance.now();

    // Teleport detection — large XZ jump (zone change, GM warp).
    // Do NOT snap Y: substitute terrain height so the player lands on the
    // ground at the new location instead of at the server's stale Y. Reset
    // both snapshot slots so we don't interpolate across the teleport.
    if (xzDist > PlayerEntity.TELEPORT_DIST) {
      const snapY = this._getGroundHeight(position.x, position.z) ?? position.y;
      this.object3d.position.set(position.x, snapY, position.z);
      this._serverPos.set(position.x, snapY, position.z);
      this._serverPosTime = now;
      this._prevServerPos.copy(this._serverPos);
      this._prevServerTime = now;
      this._mode = PlayerMoveMode.IDLE;
      this._kickActive = false;
      this._kickTarget  = null;
      if (heading !== undefined) {
        this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
      }
      return;
    }

    // Roll the snapshot buffer: current → previous, new → current.
    // Replace Y with terrain height so the interp target sits on the ground,
    // not at the server's stale spawn Y.
    const terrainY = this._getGroundHeight(position.x, position.z);

    // Handoff: if we were kicking (or have been idle) the historical
    // _serverPos is stale and would cause a snap. Anchor prev to the current
    // rendered position with a fresh tick-ago timestamp so the upcoming
    // interp lerps smoothly from where we look right now.
    const idleGap = now - this._serverPosTime;
    const handoff = this._kickActive || idleGap > PlayerEntity.KICK_IDLE_THRESHOLD_MS;

    if (handoff) {
      this._prevServerPos.set(
        this.object3d.position.x,
        this.object3d.position.y,
        this.object3d.position.z,
      );
      this._prevServerTime = now - PlayerEntity.TICK_MS;
      this._kickActive = false;
      this._kickTarget  = null;
    } else {
      this._prevServerPos.copy(this._serverPos);
      this._prevServerTime = this._serverPosTime;
    }

    this._serverPos.set(position.x, terrainY ?? position.y, position.z);
    this._serverPosTime = now;

    if (heading !== undefined) {
      this.object3d.rotation.y = THREE.MathUtils.degToRad(-heading);
    }
  }
}
