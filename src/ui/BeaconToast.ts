import type { BeaconAlertPayload, LibraryAssaultPayload } from '@/network/Protocol';

/**
 * BeaconToast — floating notifications for guild beacon & library assault alerts.
 *
 * Positioned top-right so they don't overlap with HarvestToast (bottom-right).
 * Color-coded by severity. Auto-dismisses after 6 seconds.
 */
export class BeaconToast {
  private root: HTMLElement;

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);
  }

  show(data: BeaconAlertPayload): void {
    const color = BEACON_COLORS[data.alertType] ?? '#c89030';
    const toast = this._buildToast(data.message, color);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('bt-visible'));
    setTimeout(() => this._dismiss(toast), 6000);
  }

  showLibraryAssault(data: LibraryAssaultPayload): void {
    let color: string;
    if (data.phase === 'started') {
      color = '#9060c0';
    } else {
      color = data.wasDefended ? '#50b050' : '#a03030';
    }
    const toast = this._buildToast(data.message, color);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('bt-visible'));
    setTimeout(() => this._dismiss(toast), 6000);
  }

  dispose(): void {
    this.root.remove();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _dismiss(toast: HTMLElement): void {
    toast.classList.remove('bt-visible');
    toast.classList.add('bt-hiding');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }

  private _buildToast(message: string, accentColor: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'bt-toast';
    el.style.borderColor = accentColor;

    const icon = document.createElement('span');
    icon.className = 'bt-icon';
    icon.style.color = accentColor;
    icon.textContent = '\u{1F525}'; // fire emoji
    el.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'bt-text';
    text.textContent = message;
    el.appendChild(text);

    return el;
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'beacon-toast-stack';
    el.innerHTML = `
      <style>
        #beacon-toast-stack {
          position: fixed;
          top: 80px;
          right: 18px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          align-items: flex-end;
          pointer-events: none;
          z-index: 290;
        }

        .bt-toast {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          background: rgba(8, 6, 4, 0.90);
          border: 1px solid #c89030;
          box-shadow: 0 3px 14px rgba(0,0,0,0.65);
          max-width: 320px;
          padding: 8px 12px;
          pointer-events: auto;
          opacity: 0;
          transform: translateX(12px);
          transition: opacity 0.3s ease, transform 0.3s ease;
        }

        .bt-toast.bt-visible {
          opacity: 1;
          transform: translateX(0);
        }

        .bt-toast.bt-hiding {
          opacity: 0;
          transform: translateX(12px);
        }

        .bt-icon {
          flex-shrink: 0;
          font-size: 14px;
          line-height: 1.4;
        }

        .bt-text {
          font-family: var(--font-body, serif);
          font-size: 12px;
          line-height: 1.4;
          color: rgba(212, 201, 184, 0.9);
          letter-spacing: 0.03em;
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }
      </style>
    `;
    return el;
  }
}

const BEACON_COLORS: Record<string, string> = {
  LOW_FUEL:     '#c89030',
  CRITICAL_FUEL:'#d04040',
  EXTINGUISHED: '#a03030',
  RELIT:        '#50b050',
};
