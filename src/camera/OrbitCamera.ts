import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * OrbitCamera — 3/4 perspective camera that follows a target point.
 *
 * - Elevation (pitch) is adjustable within a configurable range
 * - Yaw is free (mouse drag, arrow keys, or programmatic)
 * - Zoom is camera distance from target
 * - Far plane is matched to draw distance + fog fade margin
 */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;

  private yaw: number      = 0;
  private distance: number = ClientConfig.cameraDistance;
  private elevation: number = ClientConfig.cameraElevation; // degrees

  private target     = new THREE.Vector3();
  private targetLerp = new THREE.Vector3();

  /**
   * Sky-look engagement (0 = ground view, 1 = full sky tilt). Two phases:
   *   1. Dwell — while pinned at min elevation, the camera does NOT move
   *      for SKY_DWELL_SEC. Hint is visible. Player can release with no
   *      visual disturbance.
   *   2. Ramp — after dwell expires, _skyEngagement eases toward 1 over
   *      ~2 s. Releasing mid-ramp eases back to 0 in ~0.7 s.
   */
  private _skyEngagement       = 0;   // actual eased value (0=ground, 1=full sky)
  private _skyTargetEngagement = 0;   // target value the eased engagement chases
  private _pinnedDuration      = 0;   // seconds; reset to 0 when user stops actively pushing into floor
  private _skyLatched          = false; // toggled by dwell-completion at the relevant floor
  /** performance.now() of the last addPitch call that pushed against the relevant floor. */
  private _lastFloorPushTime   = 0;
  /** Degrees of tolerance above minElevation that still counts as "pinned." */
  private static readonly SKY_PIN_TOLERANCE = 0.5;
  /** Last-push staleness threshold — beyond this we treat input as released. */
  private static readonly FLOOR_PUSH_TIMEOUT_MS = 150;
  /** How long the user must actively press into the floor before sky-look ramps in. */
  private static readonly SKY_DWELL_SEC      = 1.0;
  /** Per-second rate when engaging (full engage takes ~1/rate seconds). */
  private static readonly SKY_ENGAGE_RATE    = 0.5;   // ~2.0s to fully engage
  private static readonly SKY_DISENGAGE_RATE = 1.5;   // ~0.7s to fully release

  // ── Collision (spring-arm) ─────────────────────────────────────────────────
  /** World geometry the camera should not pass through. Set per-zone. */
  private _worldRoot: THREE.Object3D | null = null;
  /** Pre-computed bounding spheres for broad-phase culling — same filter as PlayerEntity. */
  private _collisionCandidates: { obj: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];
  private _camRay = new THREE.Raycaster();
  /** How far to back off from a hit point so the camera isn't kissing the wall. */
  private static readonly CAMERA_BUFFER = 0.4;
  /** Don't treat terrain-scale meshes as walls (heightmap handles ground). */
  private static readonly COLLISION_MAX_RADIUS = 50;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.5,     // near — 0.5m
      2000,    // far  — 2km, fog hides the clip boundary
    );
    window.addEventListener('resize', this._onResize);
    this._applyTransform();
  }

  // ── Target tracking ───────────────────────────────────────────────────────

  follow(playerPosition: THREE.Vector3, dt: number): void {
    const lerpFactor = Math.min(8 * dt, 1);
    this.targetLerp.lerp(playerPosition, lerpFactor);
    this.target.copy(this.targetLerp);

    // Symmetric dwell-and-latch state machine:
    //   GROUND view:  press into elevation floor → dwell → latch ON → sky view
    //                 (engagement ramps 0 → 1, then user controls it via pitch input)
    //   SKY view:     press into engagement floor (0) → dwell → latch OFF → ground
    //                 (engagement eases back to 0; elevation control resumes)
    //
    // "pressing" = active push downward at the floor of the current mode.
    // Releasing input cancels dwell immediately (no visual disturbance).
    const minElev    = ClientConfig.cameraMinElevation;
    const elevAtMin  = this.elevation <= minElev + OrbitCamera.SKY_PIN_TOLERANCE;
    const engAtFloor = this._skyTargetEngagement <= 0.001;
    const activePush = (performance.now() - this._lastFloorPushTime) < OrbitCamera.FLOOR_PUSH_TIMEOUT_MS;
    const pressing   = activePush && (this._skyLatched ? engAtFloor : elevAtMin);

    if (pressing) {
      this._pinnedDuration += dt;
    } else {
      this._pinnedDuration = 0;
    }

    // Toggle the latch when dwell completes. Reset timers so the next mode
    // requires a fresh press to re-toggle.
    if (this._pinnedDuration >= OrbitCamera.SKY_DWELL_SEC) {
      this._skyLatched = !this._skyLatched;
      this._skyTargetEngagement = this._skyLatched ? 1 : 0;
      this._pinnedDuration = 0;
      this._lastFloorPushTime = 0;
    }

    // Ground view: clamp target to 0 (sky always rests at zero outside latch).
    if (!this._skyLatched) this._skyTargetEngagement = 0;

    const targetEngage = this._skyTargetEngagement;

    const rate = targetEngage > this._skyEngagement
      ? OrbitCamera.SKY_ENGAGE_RATE
      : OrbitCamera.SKY_DISENGAGE_RATE;
    const step = rate * dt;
    const diff = targetEngage - this._skyEngagement;
    this._skyEngagement = Math.abs(diff) <= step
      ? targetEngage
      : this._skyEngagement + Math.sign(diff) * step;

    this._applyTransform();
  }

  /** Current sky engagement (0–1). Polled by the UI hint. */
  getSkyEngagement(): number { return this._skyEngagement; }
  /** True while in sky-view (latched). */
  isSkyLatched(): boolean { return this._skyLatched; }
  /**
   * Whether the user is actively pressing into the floor of the current
   * mode (ground view = elevation floor; sky view = engagement floor).
   * Drives the dwell hint.
   */
  isSkyTargetActive(): boolean {
    const elevAtMin  = this.elevation <= ClientConfig.cameraMinElevation + OrbitCamera.SKY_PIN_TOLERANCE;
    const engAtFloor = this._skyTargetEngagement <= 0.001;
    const activePush = (performance.now() - this._lastFloorPushTime) < OrbitCamera.FLOOR_PUSH_TIMEOUT_MS;
    return activePush && (this._skyLatched ? engAtFloor : elevAtMin);
  }

  snapToTarget(position: THREE.Vector3): void {
    this.target.copy(position);
    this.targetLerp.copy(position);
    this._applyTransform();
  }

  /**
   * Fit the camera so the loaded world geometry is visible.
   * Targets the world center, sets a distance that shows the terrain.
   * Called once after world assets load.
   */
  fitToBox(box: THREE.Box3): void {
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    // Use horizontal extent to compute a distance that shows the whole area,
    // then scale way down — we want to be in the world, not above it like a map.
    const maxExtent = Math.max(size.x, size.z);
    const fovRad    = THREE.MathUtils.degToRad(this.camera.fov);
    const fullFit   = (maxExtent / 2) / Math.tan(fovRad / 2);

    // 3–5% of the full-fit distance gives a good "street level" feel
    const streetLevel = THREE.MathUtils.clamp(
      fullFit * 0.04,
      ClientConfig.cameraMinDistance,
      ClientConfig.cameraMaxDistance,
    );

    this.distance = streetLevel;

    // Target the box center at near-ground height
    this.target.set(center.x, box.min.y + 2, center.z);
    this.targetLerp.copy(this.target);
    this._applyTransform();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  addYaw(deltaRadians: number): void {
    this.yaw = (this.yaw + deltaRadians * this._skyMotionScale()) % (Math.PI * 2);
    this._applyTransform();
  }

  addPitch(deltaDegrees: number): void {
    const minElev = ClientConfig.cameraMinElevation;
    const maxElev = ClientConfig.cameraMaxElevation;

    if (this._skyLatched) {
      // Sky view: pitch input modifies sky-engagement target. Mapping is
      // INVERTED relative to ground (pitch UP brings the camera DOWN out of
      // the sky) so exit is the natural inverse of entry: enter by pitching
      // down at the floor, exit by pitching up at the engagement floor.
      // No skyMotionScale here — pitch needs full traversal speed for
      // adjustment, even though yaw stays slowed.
      const elevRange   = maxElev - minElev;
      const engDelta    = -deltaDegrees / elevRange;
      const wasAtFloor  = this._skyTargetEngagement <= 0.001;
      this._skyTargetEngagement = THREE.MathUtils.clamp(
        this._skyTargetEngagement + engDelta,
        0,
        1,
      );
      // Push-toward-floor at engagement floor → register exit-dwell intent.
      // engDelta < 0 here corresponds to pitching UP (positive deltaDegrees).
      if (engDelta < 0 && wasAtFloor) {
        this._lastFloorPushTime = performance.now();
      }
      this._applyTransform();
      return;
    }

    // Ground view: pitch input modifies elevation (existing behavior).
    const wasAtFloor   = this.elevation <= minElev + OrbitCamera.SKY_PIN_TOLERANCE;
    const scaledDelta  = deltaDegrees * this._skyMotionScale();
    this.elevation = THREE.MathUtils.clamp(
      this.elevation + scaledDelta,
      minElev,
      maxElev,
    );
    if (scaledDelta < 0 && wasAtFloor) {
      this._lastFloorPushTime = performance.now();
    }
    this._applyTransform();
  }

  /**
   * Camera motion scaling based on sky engagement. At full sky-view the
   * camera motion is slow (~20% of normal) so panning around the sky doesn't
   * feel whippy. Linear blend between the two.
   */
  private _skyMotionScale(): number {
    return 1 - 0.8 * this._skyEngagement;
  }

  addZoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(
      this.distance - delta,
      ClientConfig.cameraMinDistance,
      ClientConfig.cameraMaxDistance,
    );
    this._applyTransform();
  }

  setYaw(radians: number): void {
    this.yaw = radians;
    this._applyTransform();
  }

  setDistance(d: number): void {
    this.distance = THREE.MathUtils.clamp(d, ClientConfig.cameraMinDistance, ClientConfig.cameraMaxDistance);
    this._applyTransform();
  }

  getYaw(): number { return this.yaw; }

  /** Camera's forward look direction as a server-convention heading (degrees,
   *  0 = +Z, atan2(dx, dz)). Used by Tab targeting so the cone gates on what
   *  the camera is pointing at, not where the character is facing. */
  getForwardHeading(): number {
    // Camera sits at (sin(yaw), _, cos(yaw)) relative to target, looking
    // back at it — so the look direction is (-sin(yaw), -cos(yaw)) on XZ.
    // atan2(dx, dz) gives our server heading. Equivalent to (yaw + 180°) mod 360.
    let deg = (this.yaw * 180 / Math.PI) + 180;
    while (deg >= 360) deg -= 360;
    while (deg < 0)    deg += 360;
    return deg;
  }

  // ── Collision (spring-arm) ─────────────────────────────────────────────────

  /**
   * Set the world root the camera should not pass through. Pre-computes
   * bounding spheres for collidable nodes — drills into composite groups
   * (e.g. vault renderers, where the whole vault is one child whose sphere
   * exceeds COLLISION_MAX_RADIUS) so per-tile walls are picked up.
   * Call once per zone load.
   */
  setWorldRoot(root: THREE.Object3D | null): void {
    this._worldRoot = root;
    this._collisionCandidates = [];
    if (!root) return;

    const box    = new THREE.Box3();
    const sphere = new THREE.Sphere();
    for (const child of root.children) {
      const name = child.name.toLowerCase();
      // Terrain & water are not camera obstacles (heightmap handles ground).
      if (name.includes('terrain') || name.includes('water')) continue;
      box.setFromObject(child);
      if (box.isEmpty()) continue;
      box.getBoundingSphere(sphere);
      if (sphere.radius <= OrbitCamera.COLLISION_MAX_RADIUS) {
        this._collisionCandidates.push({
          obj:    child,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      } else {
        // Composite group (vault, multi-building zone) — drill into children.
        this._drillCandidates(child, box, sphere, 0);
      }
    }
  }

  private _drillCandidates(
    parent: THREE.Object3D,
    box:    THREE.Box3,
    sphere: THREE.Sphere,
    depth:  number,
  ): void {
    for (const node of parent.children) {
      box.setFromObject(node);
      if (box.isEmpty()) continue;
      box.getBoundingSphere(sphere);
      if (sphere.radius <= OrbitCamera.COLLISION_MAX_RADIUS) {
        this._collisionCandidates.push({
          obj:    node,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      } else if (node.children.length > 0 && depth < 4) {
        this._drillCandidates(node, box, sphere, depth + 1);
      } else {
        // Large leaf — add anyway so we never miss geometry.
        this._collisionCandidates.push({
          obj:    node,
          center: sphere.center.clone(),
          radius: sphere.radius,
        });
      }
    }
  }

  // ── Transform ─────────────────────────────────────────────────────────────

  private _applyTransform(): void {
    const elevRad = THREE.MathUtils.degToRad(this.elevation);
    const offsetX = Math.sin(this.yaw)  * Math.cos(elevRad);
    const offsetY =                       Math.sin(elevRad);
    const offsetZ = Math.cos(this.yaw)  * Math.cos(elevRad);

    // Spring-arm collision: ray from target outward, clamp distance to wall.
    const actualDist = this._resolveCameraDistance(offsetX, offsetY, offsetZ);

    this.camera.position.set(
      this.target.x + offsetX * actualDist,
      this.target.y + offsetY * actualDist,
      this.target.z + offsetZ * actualDist,
    );

    // Sky-look: tilt the look target upward by the eased engagement value.
    const lookUp = this._skyEngagement * 200;
    this.camera.lookAt(this.target.x, this.target.y + lookUp, this.target.z);
  }

  /**
   * Spring-arm: cast from target outward, clamp to wall hit if any. Uses
   * broad-phase sphere overlap to avoid raycasting the whole worldRoot
   * every frame.
   *
   * Cast origin is chest-height (target.y + RAY_ORIGIN_LIFT) so floor decals
   * and roads can't block the ray.
   *
   * Hits are filtered: only opaque, non-decorative meshes block. Transparent
   * effects (beacon beams, portal rings, magic FX) and named decoratives
   * pass through.
   */
  private static readonly RAY_ORIGIN_LIFT = 0.9;
  private _rayOrigin = new THREE.Vector3();

  private _resolveCameraDistance(dirX: number, dirY: number, dirZ: number): number {
    if (this._collisionCandidates.length === 0) return this.distance;

    const reach = this.distance + OrbitCamera.CAMERA_BUFFER;

    // Broad phase: candidates whose bounding sphere intersects the ray-band.
    const nearby: THREE.Object3D[] = [];
    for (const c of this._collisionCandidates) {
      const cdx = c.center.x - this.target.x;
      const cdy = c.center.y - this.target.y;
      const cdz = c.center.z - this.target.z;
      const distSq = cdx * cdx + cdy * cdy + cdz * cdz;
      const r = reach + c.radius;
      if (distSq <= r * r) nearby.push(c.obj);
    }
    if (nearby.length === 0) return this.distance;

    // Narrow phase: actual ray vs meshes.
    this._rayOrigin.set(
      this.target.x,
      this.target.y + OrbitCamera.RAY_ORIGIN_LIFT,
      this.target.z,
    );
    this._camRay.set(this._rayOrigin, new THREE.Vector3(dirX, dirY, dirZ));
    this._camRay.far = reach;
    const hits = this._camRay.intersectObjects(nearby, true);

    // Walk hits in order; return first one that should block the camera.
    for (const hit of hits) {
      if (OrbitCamera._shouldBlockCamera(hit.object)) {
        return Math.max(0.5, hit.distance - OrbitCamera.CAMERA_BUFFER);
      }
    }
    return this.distance;
  }

  /** Skip patterns for camera collision — flat or decorative objects. */
  private static readonly CAMERA_IGNORE_NAME_PATTERNS = [
    'road',     // flat overworld roads
    'beacon',   // ward beacon beams/rings
    'portal',   // vault portal effects
    'banner',   // decorative banners
    'light',    // light columns / lamps that aren't structural
    'fx', 'vfx', 'effect', 'glow', 'particle',
  ];

  private static _shouldBlockCamera(obj: THREE.Object3D): boolean {
    // Skip transparent materials — beacons, portal rings, magic FX use these.
    const mesh = obj as THREE.Mesh;
    const mat  = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      const isTransparent = Array.isArray(mat)
        ? mat.some(m => m.transparent)
        : mat.transparent;
      if (isTransparent) return false;
    }

    // Skip by name pattern (walk up the parent chain since the hit may be a
    // leaf mesh whose semantic identity lives on its parent group).
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const name = cur.name?.toLowerCase() ?? '';
      if (name) {
        for (const pat of OrbitCamera.CAMERA_IGNORE_NAME_PATTERNS) {
          if (name.includes(pat)) return false;
        }
      }
      cur = cur.parent;
    }

    // userData opt-out for explicitly tagged meshes.
    if (mesh.userData?.['cameraIgnore']) return false;

    return true;
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  getRay(screenX: number, screenY: number): THREE.Ray {
    const ndc = new THREE.Vector2(
      (screenX / window.innerWidth)  * 2 - 1,
      -(screenY / window.innerHeight) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.ray;
  }

  getCamera(): THREE.PerspectiveCamera { return this.camera; }

  dispose(): void {
    window.removeEventListener('resize', this._onResize);
  }

  private _onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };
}
