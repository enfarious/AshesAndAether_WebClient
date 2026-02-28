import * as THREE from 'three';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * OrbitCamera — 3/4 perspective camera that follows a target point.
 *
 * - Elevation is fixed (configurable, default ~58°)
 * - Yaw is free (mouse drag or programmatic)
 * - Zoom is camera distance from target
 * - Far plane is set to 10km to cover real-world-scale zones
 */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;

  private yaw      = 0;
  private distance = ClientConfig.cameraDistance;
  private elevation = ClientConfig.cameraElevation; // degrees

  private target     = new THREE.Vector3();
  private targetLerp = new THREE.Vector3();

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.5,     // near — 0.5m
      10000,   // far  — 10km, covers the largest real-world zone
    );
    window.addEventListener('resize', this._onResize);
    this._applyTransform();
  }

  // ── Target tracking ───────────────────────────────────────────────────────

  follow(playerPosition: THREE.Vector3, dt: number): void {
    const lerpFactor = Math.min(8 * dt, 1);
    this.targetLerp.lerp(playerPosition, lerpFactor);
    this.target.copy(this.targetLerp);
    this._applyTransform();
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
    this.yaw = (this.yaw + deltaRadians) % (Math.PI * 2);
    this._applyTransform();
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

  // ── Transform ─────────────────────────────────────────────────────────────

  private _applyTransform(): void {
    const elevRad = THREE.MathUtils.degToRad(this.elevation);
    const x = this.distance * Math.sin(this.yaw)  * Math.cos(elevRad);
    const y = this.distance *                        Math.sin(elevRad);
    const z = this.distance * Math.cos(this.yaw)  * Math.cos(elevRad);

    this.camera.position.set(
      this.target.x + x,
      this.target.y + y,
      this.target.z + z,
    );
    this.camera.lookAt(this.target);
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
