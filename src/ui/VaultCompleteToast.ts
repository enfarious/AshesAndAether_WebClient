/**
 * VaultCompleteToast — celebratory center-screen banner shown when a vault
 * is cleared. Bigger and more dramatic than SystemToast: scales in, holds
 * a few seconds, fades. Player still sees the chat message and the spawned
 * exit portal afterward.
 */
export interface VaultCompleteToastData {
  goldAwarded: number;
  hasPortal:   boolean;
}

export class VaultCompleteToast {
  private root: HTMLElement;

  constructor(uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);
  }

  show(data: VaultCompleteToastData): void {
    const toast = this._buildToast(data);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('vct-visible'));
    setTimeout(() => this._dismiss(toast), 5500);
  }

  dispose(): void {
    this.root.remove();
  }

  private _dismiss(toast: HTMLElement): void {
    toast.classList.remove('vct-visible');
    toast.classList.add('vct-hiding');
    setTimeout(() => toast.remove(), 700);
  }

  private _buildToast(data: VaultCompleteToastData): HTMLElement {
    const el = document.createElement('div');
    el.className = 'vct-toast';

    const headline = document.createElement('div');
    headline.className = 'vct-headline';
    headline.textContent = 'VAULT CLEARED';
    el.appendChild(headline);

    const sub = document.createElement('div');
    sub.className = 'vct-sub';
    sub.textContent = data.goldAwarded > 0
      ? `+${data.goldAwarded.toLocaleString()} gold`
      : 'The vault is yours.';
    el.appendChild(sub);

    if (data.hasPortal) {
      const portalHint = document.createElement('div');
      portalHint.className = 'vct-portal-hint';
      portalHint.textContent = 'An exit portal has appeared in the boss chamber.';
      el.appendChild(portalHint);
    }

    return el;
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'vault-complete-toast-stack';
    el.innerHTML = `
      <style>
        #vault-complete-toast-stack {
          position: fixed;
          top: 18%;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          pointer-events: none;
          z-index: 320;
        }

        .vct-toast {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 22px 56px;
          background: radial-gradient(ellipse at center, rgba(28, 16, 40, 0.95), rgba(8, 4, 12, 0.92));
          border: 2px solid #b070d8;
          box-shadow:
            0 0 40px rgba(176, 112, 216, 0.6),
            0 8px 32px rgba(0, 0, 0, 0.75),
            inset 0 0 28px rgba(176, 112, 216, 0.18);
          opacity: 0;
          transform: scale(0.82) translateY(8px);
          transition: opacity 0.55s ease, transform 0.55s cubic-bezier(0.2, 1.4, 0.3, 1);
        }

        .vct-toast.vct-visible {
          opacity: 1;
          transform: scale(1) translateY(0);
        }

        .vct-toast.vct-hiding {
          opacity: 0;
          transform: scale(1.04) translateY(-12px);
          transition: opacity 0.65s ease, transform 0.65s ease;
        }

        .vct-headline {
          font-family: var(--font-heading, 'Cinzel', serif);
          font-size: 44px;
          font-weight: 700;
          letter-spacing: 0.22em;
          color: #ecc8ff;
          text-shadow:
            0 0 18px rgba(176, 112, 216, 0.8),
            0 2px 8px rgba(0, 0, 0, 0.95);
        }

        .vct-sub {
          margin-top: 6px;
          font-family: var(--font-body, serif);
          font-size: 20px;
          color: #ffe6a8;
          letter-spacing: 0.1em;
          text-shadow: 0 1px 5px rgba(0,0,0,0.9);
        }

        .vct-portal-hint {
          margin-top: 10px;
          font-family: var(--font-body, serif);
          font-size: 13px;
          color: rgba(220, 200, 240, 0.85);
          letter-spacing: 0.08em;
          font-style: italic;
          text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        }
      </style>
    `;
    return el;
  }
}
