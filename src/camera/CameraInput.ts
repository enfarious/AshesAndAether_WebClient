import type { OrbitCamera } from './OrbitCamera';
import { ClientConfig } from '@/config/ClientConfig';

/**
 * CameraInput — handles mouse drag (yaw) and scroll wheel (zoom) for the camera.
 * Does NOT own the canvas directly — receives it to attach listeners.
 */
export class CameraInput {
  private dragging       = false;
  private lastMouseX     = 0;
  private lastMouseY     = 0;
  private middleMouseDown = false;
  private lastMiddleX    = 0;

  constructor(
    private readonly camera:  OrbitCamera,
    private readonly canvas:  HTMLElement,
  ) {
    canvas.addEventListener('mousedown',  this._onMouseDown);
    canvas.addEventListener('mousemove',  this._onMouseMove);
    canvas.addEventListener('mouseup',    this._onMouseUp);
    canvas.addEventListener('mouseleave', this._onMouseUp);
    canvas.addEventListener('wheel',      this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  dispose(): void {
    this.canvas.removeEventListener('mousedown',   this._onMouseDown);
    this.canvas.removeEventListener('mousemove',   this._onMouseMove);
    this.canvas.removeEventListener('mouseup',     this._onMouseUp);
    this.canvas.removeEventListener('mouseleave',  this._onMouseUp);
    this.canvas.removeEventListener('wheel',       this._onWheel);
  }

  private _onMouseDown = (e: MouseEvent): void => {
    // Right mouse or middle mouse drags yaw
    if (e.button === 2) {
      this.dragging   = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.middleMouseDown = true;
      this.lastMiddleX     = e.clientX;
    }
  };

  private _onMouseMove = (e: MouseEvent): void => {
    if (this.dragging) {
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.camera.addYaw(-dx * ClientConfig.cameraYawSensitivity);
      this.camera.addPitch(-dy * ClientConfig.cameraPitchSensitivity);
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }
    if (this.middleMouseDown) {
      const dx = e.clientX - this.lastMiddleX;
      this.camera.addYaw(-dx * ClientConfig.cameraYawSensitivity);
      this.lastMiddleX = e.clientX;
    }
  };

  private _onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2 || e.type === 'mouseleave') this.dragging        = false;
    if (e.button === 1 || e.type === 'mouseleave') this.middleMouseDown = false;
  };

  private _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalize wheel delta — browsers vary
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL
      ? e.deltaY * 0.01
      : e.deltaY;
    this.camera.addZoom(-delta * 0.5);
  };
}
