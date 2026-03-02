/**
 * UIScaleWidget — a small temporary slider for adjusting overall UI zoom.
 *
 * Sits bottom-left. Applies CSS `zoom` to `#ui-root` so every overlay panel,
 * clock, chat log, and vitals bar scales uniformly. Value persists to
 * localStorage so it survives page refreshes.
 *
 * Replace with a proper settings window when that exists.
 */

const STORAGE_KEY = 'aa_ui_scale';
const MIN  = 0.6;
const MAX  = 1.6;
const STEP = 0.05;
const DEFAULT = 1.0;

export class UIScaleWidget {
  private root:    HTMLElement;
  private slider:  HTMLInputElement;
  private label:   HTMLElement;
  private uiRoot:  HTMLElement;

  constructor(mountEl: HTMLElement, uiRoot: HTMLElement) {
    this.uiRoot = uiRoot;

    // Restore saved scale immediately before building the widget.
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY) ?? String(DEFAULT));
    const initial = isFinite(saved) ? Math.min(MAX, Math.max(MIN, saved)) : DEFAULT;
    this._applyScale(initial);

    this.root   = document.createElement('div');
    this.slider = document.createElement('input');
    this.label  = document.createElement('span');
    this._build(initial);
    mountEl.appendChild(this.root);
  }

  dispose(): void {
    this.root.remove();
  }

  private _build(initial: number): void {
    const style = document.createElement('style');
    style.textContent = `
      #ui-scale-widget {
        position: fixed;
        bottom: 10px;
        left: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(8, 6, 4, 0.68);
        border: 1px solid rgba(200, 145, 60, 0.18);
        padding: 5px 10px 5px 9px;
        pointer-events: auto;
        z-index: 900;
      }

      #ui-scale-widget .scale-lbl {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.45);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        user-select: none;
        white-space: nowrap;
      }

      #ui-scale-widget .scale-val {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.55);
        letter-spacing: 0.06em;
        min-width: 3ch;
        text-align: right;
        user-select: none;
      }

      #ui-scale-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 90px;
        height: 3px;
        background: rgba(200, 145, 60, 0.2);
        outline: none;
        cursor: pointer;
      }

      #ui-scale-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: rgba(200, 145, 60, 0.75);
        cursor: pointer;
      }

      #ui-scale-slider::-moz-range-thumb {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: rgba(200, 145, 60, 0.75);
        border: none;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);

    this.root.id = 'ui-scale-widget';

    const lbl = document.createElement('span');
    lbl.className   = 'scale-lbl';
    lbl.textContent = 'UI';

    this.slider.id    = 'ui-scale-slider';
    this.slider.type  = 'range';
    this.slider.min   = String(MIN);
    this.slider.max   = String(MAX);
    this.slider.step  = String(STEP);
    this.slider.value = String(initial);

    this.label.className   = 'scale-val';
    this.label.textContent = this._fmt(initial);

    this.slider.addEventListener('input', () => {
      const v = parseFloat(this.slider.value);
      this._applyScale(v);
      this.label.textContent = this._fmt(v);
      localStorage.setItem(STORAGE_KEY, String(v));
    });

    this.root.appendChild(lbl);
    this.root.appendChild(this.slider);
    this.root.appendChild(this.label);
  }

  private _applyScale(v: number): void {
    (this.uiRoot.style as any).zoom = String(v);
  }

  private _fmt(v: number): string {
    return `${Math.round(v * 100)}%`;
  }
}
