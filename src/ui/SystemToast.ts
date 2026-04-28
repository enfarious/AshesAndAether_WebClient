export interface SystemToastPayload {
  message:  string;
  type:     'info' | 'success' | 'warning';
  duration?: number; // ms — default varies by type
}

/**
 * SystemToast — floating system notifications (zone builds, asset downloads, etc.)
 *
 * Positioned bottom-left to avoid overlapping with BeaconToast (top-right)
 * and HarvestToast (bottom-right).
 */
export class SystemToast {
  private root: HTMLElement;

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);
  }

  /** Show a toast that stays until the returned callback is called. */
  showPersistent(message: string, type: SystemToastPayload['type']): () => void {
    const color = TYPE_COLORS[type] ?? TYPE_COLORS['info']!;
    const icon  = TYPE_ICONS[type]  ?? TYPE_ICONS['info']!;
    const toast = this._buildToast(message, icon, color);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('st-visible'));
    return () => this._dismiss(toast);
  }

  show(payload: SystemToastPayload): void {
    const { message, type, duration } = payload;
    const color   = TYPE_COLORS[type] ?? TYPE_COLORS['info']!;
    const icon    = TYPE_ICONS[type]  ?? TYPE_ICONS['info']!;
    const timeout = duration ?? (type === 'info' ? 12_000 : 6_000);

    const toast = this._buildToast(message, icon, color);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('st-visible'));
    setTimeout(() => this._dismiss(toast), timeout);
  }

  dispose(): void {
    this.root.remove();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _dismiss(toast: HTMLElement): void {
    toast.classList.remove('st-visible');
    toast.classList.add('st-hiding');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }

  private _buildToast(message: string, icon: string, accentColor: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'st-toast';
    el.style.borderColor = accentColor;

    const iconEl = document.createElement('span');
    iconEl.className = 'st-icon';
    iconEl.style.color = accentColor;
    iconEl.textContent = icon;
    el.appendChild(iconEl);

    const textEl = document.createElement('span');
    textEl.className = 'st-text';
    textEl.textContent = message;
    el.appendChild(textEl);

    return el;
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'system-toast-stack';
    el.innerHTML = `
      <style>
        #system-toast-stack {
          position: fixed;
          bottom: 120px;
          left: 18px;
          display: flex;
          flex-direction: column-reverse;
          gap: 6px;
          align-items: flex-start;
          pointer-events: none;
          z-index: 290;
        }

        .st-toast {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          background: rgba(8, 6, 4, 0.92);
          border: 1px solid #c89030;
          box-shadow: 0 3px 14px rgba(0,0,0,0.65);
          max-width: 300px;
          padding: 8px 12px;
          pointer-events: auto;
          opacity: 0;
          transform: translateX(-10px);
          transition: opacity 0.3s ease, transform 0.3s ease;
        }

        .st-toast.st-visible {
          opacity: 1;
          transform: translateX(0);
        }

        .st-toast.st-hiding {
          opacity: 0;
          transform: translateX(-10px);
        }

        .st-icon {
          flex-shrink: 0;
          font-size: 13px;
          line-height: 1.5;
        }

        .st-text {
          font-family: var(--font-body, serif);
          font-size: 12px;
          line-height: 1.5;
          color: rgba(212, 201, 184, 0.9);
          letter-spacing: 0.03em;
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }
      </style>
    `;
    return el;
  }
}

const TYPE_COLORS: Record<string, string> = {
  info:    '#5090c8',
  success: '#50b050',
  warning: '#c89030',
};

const TYPE_ICONS: Record<string, string> = {
  info:    '⚙',
  success: '✓',
  warning: '⚠',
};
