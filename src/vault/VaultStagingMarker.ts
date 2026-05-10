import * as THREE from 'three';
import type { MessageRouter } from '@/network/MessageRouter';
import type {
  VaultStagingActivePayload,
  VaultStagingBrokenPayload,
} from '@/network/Protocol';

/**
 * VaultStagingMarker
 *
 * Visual for the vault staging zone — the 5m-radius "Get Ready" area at the
 * vault entrance. Active until any party member steps outside the radius,
 * at which point the server broadcasts vault_staging_broken and we dispose.
 *
 * Geometry (three pieces in one Group):
 *   1. A flat, translucent disc filling the staging area — soft amber.
 *   2. A bright ring at the boundary so the limit is visible from inside
 *      and outside. Same amber, higher alpha.
 *   3. A waist-height billboard quad with rasterized "Get Ready" text,
 *      rotated around Y each frame so the text reads from any angle.
 *
 * Lifetime is keyed by instanceId — re-entering staging in a different
 * vault disposes the previous marker before spawning a new one.
 */
export class VaultStagingMarker {
  /** Active marker, if any. Null when staging isn't up. */
  private group:        THREE.Group | null  = null;
  private banner:       THREE.Mesh  | null  = null;
  private bannerTexture: THREE.Texture | null = null;
  /** instanceId of the active staging zone, used to ignore stale broken events. */
  private activeInstanceId: string | null = null;
  /** Subscription teardowns. */
  private teardowns: Array<() => void> = [];

  constructor(
    private readonly scene:  THREE.Scene,
    private readonly router: MessageRouter,
  ) {
    this.teardowns.push(this.router.onVaultStagingActive(p => this._onActive(p)));
    this.teardowns.push(this.router.onVaultStagingBroken(p => this._onBroken(p)));
  }

  /** Per-frame tick from the app's animate loop. Spins the banner around Y
   *  so the text faces every direction over a few seconds. No-op when no
   *  marker is active. */
  update(dt: number): void {
    if (this.banner) {
      // Half a turn per second — slow enough to read from any angle without
      // smearing the text into a blur.
      this.banner.rotation.y += dt * Math.PI;
    }
  }

  /** Tear down the active marker and unsubscribe. Called on app shutdown. */
  dispose(): void {
    this._clearMarker();
    for (const off of this.teardowns) off();
    this.teardowns = [];
  }

  // ── Event handlers ────────────────────────────────────────────────────

  private _onActive(payload: VaultStagingActivePayload): void {
    this._clearMarker();
    this.activeInstanceId = payload.instanceId;

    const { x, z, radius } = payload.stagingPoint;
    const group = new THREE.Group();
    group.name = `vault_staging:${payload.instanceId}`;
    // Y = 0 is the vault floor (tile grid is flat). Lift the disc slightly
    // to avoid z-fighting with floor geometry.
    group.position.set(x, 0.05, z);
    // Tag the entire group as non-collidable so PlayerEntity / OrbitCamera
    // candidate-builders skip it if it ever ends up under worldRoot. The
    // marker is meant to be a pure visual: players walk through it freely
    // (boundary crossing is detected server-side via distance polling, not
    // client-side collision). Setting on the group propagates to children
    // via the candidate-builder's `userData.nonCollidable` walk.
    group.userData['nonCollidable'] = true;

    // 1. Inner fill — soft amber disc, subtly visible from inside.
    const fillGeom = new THREE.CircleGeometry(radius, 64);
    const fillMat  = new THREE.MeshBasicMaterial({
      color:       0xffaa44,
      transparent: true,
      opacity:     0.18,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    const fill = new THREE.Mesh(fillGeom, fillMat);
    fill.rotation.x = -Math.PI / 2;
    group.add(fill);

    // 2. Boundary ring — same amber, brighter, so the edge reads cleanly.
    const ringGeom = new THREE.RingGeometry(radius - 0.15, radius, 64);
    const ringMat  = new THREE.MeshBasicMaterial({
      color:       0xffaa44,
      transparent: true,
      opacity:     0.85,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01; // sit just above the fill to defeat z-fighting
    group.add(ring);

    // 3. Banner — Canvas2D-rendered text on a billboard quad at waist height.
    const banner = this._buildBanner();
    banner.position.y = 1.2;
    group.add(banner);
    this.banner = banner;

    this.scene.add(group);
    this.group = group;
  }

  private _onBroken(payload: VaultStagingBrokenPayload): void {
    if (this.activeInstanceId !== payload.instanceId) return;
    this._clearMarker();
  }

  // ── Build helpers ─────────────────────────────────────────────────────

  /** Rasterize "Get Ready" into a Canvas2D texture and slap it on a quad.
   *  Quad is double-sided so the text reads from both faces while spinning. */
  private _buildBanner(): THREE.Mesh {
    const W = 512;
    const H = 128;
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Transparent background; warm amber stroke so the letters glow.
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffaa44';
    ctx.font      = 'bold 78px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor   = '#000';
    ctx.shadowBlur    = 6;
    ctx.fillText('Get Ready', W / 2, H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.bannerTexture = tex;

    // Quad sized so text reads at typical camera distance — 4m wide × 1m tall.
    const geom = new THREE.PlaneGeometry(4, 1);
    const mat  = new THREE.MeshBasicMaterial({
      map:         tex,
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    return new THREE.Mesh(geom, mat);
  }

  /** Tear down geometry + textures + material for the active marker. */
  private _clearMarker(): void {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach(mm => mm.dispose());
          else m.dispose();
        }
      });
      this.group = null;
    }
    if (this.bannerTexture) {
      this.bannerTexture.dispose();
      this.bannerTexture = null;
    }
    this.banner = null;
    this.activeInstanceId = null;
  }
}
