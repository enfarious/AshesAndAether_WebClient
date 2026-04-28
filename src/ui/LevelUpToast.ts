/**
 * LevelUpToast — celebratory center-screen banner for level-ups.
 *
 * Larger and more prominent than SystemToast: centered, large gold text,
 * scales in, holds, fades. Auto-dismisses after ~3 seconds.
 */
export interface LevelUpToastData {
  level:    number;
  gainedAp: number;
  gainedSp: number;
}

export class LevelUpToast {
  private root: HTMLElement;

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);
  }

  show(data: LevelUpToastData): void {
    const toast = this._buildToast(data);
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('lut-visible'));
    setTimeout(() => this._dismiss(toast), 2800);
  }

  dispose(): void {
    this.root.remove();
  }

  private _dismiss(toast: HTMLElement): void {
    toast.classList.remove('lut-visible');
    toast.classList.add('lut-hiding');
    setTimeout(() => toast.remove(), 600);
  }

  private _buildToast(data: LevelUpToastData): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lut-toast';

    const headline = document.createElement('div');
    headline.className = 'lut-headline';
    headline.textContent = 'LEVEL UP!';
    el.appendChild(headline);

    const sub = document.createElement('div');
    sub.className = 'lut-sub';
    sub.textContent = `You are now level ${data.level}`;
    el.appendChild(sub);

    if (data.gainedSp > 0 || data.gainedAp > 0) {
      const grants = document.createElement('div');
      grants.className = 'lut-grants';
      const parts: string[] = [];
      if (data.gainedSp > 0) parts.push(`+${data.gainedSp} Stat Points`);
      if (data.gainedAp > 0) parts.push(`+${data.gainedAp} Ability Points`);
      grants.textContent = parts.join('   ·   ');
      el.appendChild(grants);
    }

    return el;
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'level-up-toast-stack';
    el.innerHTML = `
      <style>
        #level-up-toast-stack {
          position: fixed;
          top: 22%;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          pointer-events: none;
          z-index: 320;
        }

        .lut-toast {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 18px 48px;
          background: radial-gradient(ellipse at center, rgba(40, 28, 12, 0.95), rgba(8, 6, 4, 0.92));
          border: 2px solid #d4a04a;
          box-shadow:
            0 0 32px rgba(212, 160, 74, 0.55),
            0 6px 24px rgba(0, 0, 0, 0.7),
            inset 0 0 24px rgba(212, 160, 74, 0.18);
          opacity: 0;
          transform: scale(0.85) translateY(8px);
          transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.2, 1.4, 0.3, 1);
        }

        .lut-toast.lut-visible {
          opacity: 1;
          transform: scale(1) translateY(0);
        }

        .lut-toast.lut-hiding {
          opacity: 0;
          transform: scale(1.04) translateY(-12px);
          transition: opacity 0.55s ease, transform 0.55s ease;
        }

        .lut-headline {
          font-family: var(--font-heading, 'Cinzel', serif);
          font-size: 36px;
          font-weight: 700;
          letter-spacing: 0.18em;
          color: #f4d488;
          text-shadow:
            0 0 14px rgba(212, 160, 74, 0.7),
            0 2px 6px rgba(0, 0, 0, 0.9);
        }

        .lut-sub {
          margin-top: 4px;
          font-family: var(--font-body, serif);
          font-size: 18px;
          color: rgba(232, 218, 188, 0.95);
          letter-spacing: 0.08em;
          text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
        }

        .lut-grants {
          margin-top: 8px;
          font-family: var(--font-body, serif);
          font-size: 14px;
          color: rgba(180, 220, 160, 0.95);
          letter-spacing: 0.06em;
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
        }
      </style>
    `;
    return el;
  }
}
