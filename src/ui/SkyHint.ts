/**
 * SkyHint — subtle center-bottom hint shown while the camera is engaging
 * sky-look (pitch pinned at floor, easing toward full tilt). Reassures the
 * player they're holding a latch, not breaking the camera.
 *
 * Driven from the per-frame app loop by polling OrbitCamera state. Visible
 * during the engagement transition and fades out once fully engaged or
 * released.
 */
export class SkyHint {
  private root: HTMLElement;
  private el:   HTMLElement;
  private _visible = false;

  constructor(uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    this.el   = this._buildLabel();
    this.root.appendChild(this.el);
    uiRoot.appendChild(this.root);
  }

  /**
   * Update visibility + label based on camera state.
   * - In ground view, pressing into the floor → "Hold to look up"
   * - In sky view, pressing into engagement-0 floor → "Hold to return"
   * Visible while pressing OR while engagement is mid-ramp so the player
   * sees the message during the transition.
   */
  update(engagement: number, targetActive: boolean, latched: boolean): void {
    const shouldShow = targetActive || (engagement > 0.02 && engagement < 0.98);
    const wantedText = latched ? 'Hold to return' : 'Hold to look up';
    if (this.el.textContent !== wantedText) this.el.textContent = wantedText;
    if (shouldShow !== this._visible) {
      this._visible = shouldShow;
      this.el.classList.toggle('sh-visible', shouldShow);
    }
  }

  dispose(): void {
    this.root.remove();
  }

  private _buildLabel(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sh-hint';
    el.textContent = 'Hold to look up';
    return el;
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'sky-hint-root';
    el.innerHTML = `
      <style>
        #sky-hint-root {
          position: fixed;
          bottom: 28%;
          left: 50%;
          transform: translateX(-50%);
          pointer-events: none;
          z-index: 280;
        }

        .sh-hint {
          font-family: var(--font-body, serif);
          font-size: 13px;
          color: rgba(232, 218, 188, 0.78);
          letter-spacing: 0.08em;
          padding: 4px 14px;
          background: rgba(8, 6, 4, 0.55);
          border: 1px solid rgba(212, 160, 74, 0.35);
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.4s ease, transform 0.4s ease;
          text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        }

        .sh-hint.sh-visible {
          opacity: 1;
          transform: translateY(0);
        }
      </style>
    `;
    return el;
  }
}
