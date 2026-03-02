import * as THREE from 'three';
import type { SocketClient } from '@/network/SocketClient';
import type { VillagePlacementModePayload } from '@/network/Protocol';

/**
 * PlacementMode — interactive structure placement in the village.
 *
 * When activated, shows a ghost box mesh on the terrain that follows the cursor,
 * snapped to the village grid. Green = valid, red = invalid (overlapping).
 * Click to confirm → sendVillagePlaceConfirm(). R to rotate 90°. Escape to cancel.
 */
export class PlacementMode {
  private active = false;
  private ghostMesh: THREE.Mesh | null = null;
  private payload: VillagePlacementModePayload | null = null;
  private rotation = 0; // 0, 90, 180, 270

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // UI overlay
  private overlayEl: HTMLElement | null = null;

  // Bound handlers (so we can remove them)
  private _onMouseMove: ((e: MouseEvent) => void) | null = null;
  private _onClick:     ((e: MouseEvent) => void) | null = null;
  private _onKeyDown:   ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly scene:  THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly socket: SocketClient,
    private readonly uiRoot: HTMLElement,
  ) {}

  get isActive(): boolean { return this.active; }

  enter(payload: VillagePlacementModePayload): void {
    if (this.active) this.exit();

    this.active  = true;
    this.payload = payload;
    this.rotation = 0;

    // Build ghost mesh (sized to structure footprint)
    const sizeX = payload.sizeX;
    const sizeZ = payload.sizeZ;
    const geometry = new THREE.BoxGeometry(sizeX, 2, sizeZ);
    const material = new THREE.MeshBasicMaterial({
      color: 0x44cc44,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(geometry, material);
    this.ghostMesh.position.set(0, 1, 0);
    this.scene.add(this.ghostMesh);

    // Create instructions overlay
    this._showOverlay(payload.displayName, payload.goldCost);

    // Bind input handlers
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onClick     = (e) => this._handleClick(e);
    this._onKeyDown   = (e) => this._handleKeyDown(e);

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('click', this._onClick, true); // capture phase — fire before ClickMoveController
    window.addEventListener('keydown', this._onKeyDown);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;

    if (this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      (this.ghostMesh.material as THREE.Material).dispose();
      this.ghostMesh = null;
    }

    this._hideOverlay();

    if (this._onMouseMove) this.canvas.removeEventListener('mousemove', this._onMouseMove);
    if (this._onClick)     this.canvas.removeEventListener('click', this._onClick, true);
    if (this._onKeyDown)   window.removeEventListener('keydown', this._onKeyDown);

    this._onMouseMove = null;
    this._onClick     = null;
    this._onKeyDown   = null;
    this.payload = null;
  }

  dispose(): void {
    this.exit();
  }

  // ── Input handlers ──────────────────────────────────────────────────────────

  private _handleMouseMove(e: MouseEvent): void {
    if (!this.ghostMesh || !this.payload) return;

    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast against a ground plane at y=0
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(groundPlane, hit);

    if (hit) {
      const gridSize = this.payload.gridSize;
      // Snap to grid
      const snappedX = Math.round(hit.x / gridSize) * gridSize;
      const snappedZ = Math.round(hit.z / gridSize) * gridSize;
      this.ghostMesh.position.set(snappedX, 1, snappedZ);
      this.ghostMesh.rotation.y = (this.rotation * Math.PI) / 180;
    }
  }

  private _handleClick(e: MouseEvent): void {
    if (!this.ghostMesh || !this.payload) return;

    // Stop the click from reaching ClickMoveController (which would move the player)
    e.stopImmediatePropagation();
    e.preventDefault();

    const pos = this.ghostMesh.position;
    this.socket.sendVillagePlaceConfirm(
      this.payload.catalogId,
      pos.x,
      pos.z,
      this.rotation,
    );

    this.exit();
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.exit();
    } else if (e.key === 'r' || e.key === 'R') {
      this.rotation = (this.rotation + 90) % 360;
      if (this.ghostMesh) {
        this.ghostMesh.rotation.y = (this.rotation * Math.PI) / 180;
      }
    }
  }

  // ── Overlay ─────────────────────────────────────────────────────────────────

  private _showOverlay(displayName: string, goldCost: number): void {
    this._hideOverlay();
    const el = document.createElement('div');
    el.id = 'placement-overlay';
    el.innerHTML = `
      <style>
        #placement-overlay {
          position: fixed;
          bottom: 80px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(8, 6, 4, 0.88);
          border: 1px solid rgba(200, 145, 60, 0.35);
          border-radius: 4px;
          padding: 8px 18px;
          font-family: var(--font-body, serif);
          color: rgba(210, 185, 140, 0.95);
          font-size: 13px;
          z-index: 400;
          text-align: center;
          pointer-events: none;
          box-shadow: 0 2px 12px rgba(0,0,0,0.5);
        }
        #placement-overlay .pm-title {
          font-size: 14px;
          font-weight: 600;
          color: rgba(240, 210, 150, 0.95);
          margin-bottom: 4px;
        }
        #placement-overlay .pm-hint {
          font-size: 11px;
          color: rgba(180, 160, 120, 0.70);
        }
      </style>
      <div class="pm-title">Placing: ${displayName} (${goldCost}g)</div>
      <div class="pm-hint">Click to place &middot; R to rotate &middot; Esc to cancel</div>
    `;
    this.uiRoot.appendChild(el);
    this.overlayEl = el;
  }

  private _hideOverlay(): void {
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }
}
