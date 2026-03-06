/**
 * FpsWidget — preset FPS-limit buttons that sit next to the UI-scale widget.
 *
 * Small row: label "FPS" + button group [30] [60] [120] [144] [∞]
 * Active preset gets an amber highlight. Persists to localStorage.
 */

const FPS_STORAGE_KEY = 'aa_fps_limit';
const PRESETS: readonly (number)[] = [30, 60, 120, 144, 0]; // 0 = unlimited

export class FpsWidget {
  private root: HTMLElement;
  private buttons: HTMLButtonElement[] = [];

  constructor(
    mountEl: HTMLElement,
    private onSelect: (limit: number) => void,
  ) {
    // Read saved value
    const saved = parseInt(localStorage.getItem(FPS_STORAGE_KEY) ?? '0', 10);
    const initial = PRESETS.includes(saved) ? saved : 0;

    this.root = document.createElement('div');
    this._build(initial);
    mountEl.appendChild(this.root);

    // Fire initial value so app.ts gets it on startup
    this.onSelect(initial);
  }

  dispose(): void {
    this.root.remove();
  }

  private _build(active: number): void {
    const style = document.createElement('style');
    style.textContent = `
      #fps-widget {
        position: fixed;
        bottom: 10px;
        left: 180px;
        display: flex;
        align-items: center;
        gap: 4px;
        background: rgba(8, 6, 4, 0.68);
        border: 1px solid rgba(200, 145, 60, 0.18);
        padding: 5px 8px;
        pointer-events: auto;
        z-index: 900;
      }

      #fps-widget .fps-lbl {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.45);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        user-select: none;
        white-space: nowrap;
        margin-right: 4px;
      }

      #fps-widget .fps-btn {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.5);
        background: rgba(200, 145, 60, 0.08);
        border: 1px solid rgba(200, 145, 60, 0.15);
        padding: 2px 6px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        line-height: 1.2;
      }

      #fps-widget .fps-btn:hover {
        background: rgba(200, 145, 60, 0.18);
        color: rgba(212, 201, 184, 0.75);
      }

      #fps-widget .fps-btn.active {
        background: rgba(200, 145, 60, 0.28);
        color: rgba(212, 201, 184, 0.9);
        border-color: rgba(200, 145, 60, 0.45);
      }
    `;
    document.head.appendChild(style);

    this.root.id = 'fps-widget';

    const lbl = document.createElement('span');
    lbl.className = 'fps-lbl';
    lbl.textContent = 'FPS';
    this.root.appendChild(lbl);

    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'fps-btn';
      btn.textContent = preset === 0 ? '∞' : String(preset);
      if (preset === active) btn.classList.add('active');

      btn.addEventListener('click', () => {
        this._setActive(preset);
        localStorage.setItem(FPS_STORAGE_KEY, String(preset));
        this.onSelect(preset);
      });

      this.buttons.push(btn);
      this.root.appendChild(btn);
    }
  }

  private _setActive(value: number): void {
    for (let i = 0; i < PRESETS.length; i++) {
      this.buttons[i]!.classList.toggle('active', PRESETS[i] === value);
    }
  }
}
