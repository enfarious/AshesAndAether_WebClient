import type { HarvestResultPayload } from '@/network/Protocol';

/**
 * HarvestToast — floating notification showing harvest results.
 *
 * Slides in from the right near the bottom of the screen (above the action bar).
 * Auto-dismisses after 4 seconds. Multiple toasts stack vertically.
 */
export class HarvestToast {
  private root: HTMLElement;

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._buildRoot();
    uiRoot.appendChild(this.root);
  }

  show(data: HarvestResultPayload): void {
    const toast = this._buildToast(data);
    this.root.appendChild(toast);

    // Slide in
    requestAnimationFrame(() => toast.classList.add('ht-visible'));

    // Auto-dismiss after 4 seconds
    setTimeout(() => this._dismiss(toast), 4000);
  }

  dispose(): void {
    this.root.remove();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _dismiss(toast: HTMLElement): void {
    toast.classList.remove('ht-visible');
    toast.classList.add('ht-hiding');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal if transitionend never fires
    setTimeout(() => toast.remove(), 400);
  }

  private _buildToast(data: HarvestResultPayload): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ht-toast';

    const header = document.createElement('div');
    header.className = 'ht-header';
    header.textContent = data.plantName;
    el.appendChild(header);

    if (data.items.length > 0) {
      const list = document.createElement('div');
      list.className = 'ht-items';
      for (const item of data.items) {
        const row = document.createElement('div');
        row.className = 'ht-item';
        row.innerHTML = `<span class="ht-item-name">${this._esc(item.name)}</span><span class="ht-item-qty">&times;${item.quantity}</span>`;
        list.appendChild(row);
      }
      el.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'ht-empty';
      empty.textContent = 'Nothing useful.';
      el.appendChild(empty);
    }

    return el;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private _buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'harvest-toast-stack';
    el.innerHTML = `
      <style>
        #harvest-toast-stack {
          position: fixed;
          bottom: 120px;
          right: 18px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          align-items: flex-end;
          pointer-events: none;
          z-index: 290;
        }

        .ht-toast {
          background: rgba(8, 6, 4, 0.88);
          border: 1px solid rgba(100, 170, 60, 0.35);
          box-shadow: 0 3px 14px rgba(0,0,0,0.65);
          width: 220px;
          pointer-events: auto;
          opacity: 0;
          transform: translateX(12px);
          transition: opacity 0.25s ease, transform 0.25s ease;
        }

        .ht-toast.ht-visible {
          opacity: 1;
          transform: translateX(0);
        }

        .ht-toast.ht-hiding {
          opacity: 0;
          transform: translateX(12px);
        }

        .ht-header {
          padding: 6px 10px 5px;
          border-bottom: 1px solid rgba(100, 170, 60, 0.18);
          font-family: var(--font-body, serif);
          font-size: 12px;
          color: rgba(120, 190, 70, 0.9);
          letter-spacing: 0.06em;
          font-style: italic;
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }

        .ht-items {
          padding: 6px 10px 8px;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .ht-item {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }

        .ht-item-name {
          font-family: var(--font-body, serif);
          font-size: 11px;
          color: rgba(212, 201, 184, 0.85);
          letter-spacing: 0.04em;
        }

        .ht-item-qty {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(120, 190, 70, 0.7);
          letter-spacing: 0.06em;
        }

        .ht-empty {
          padding: 6px 10px 8px;
          font-family: var(--font-body, serif);
          font-size: 11px;
          color: rgba(212, 201, 184, 0.5);
          font-style: italic;
        }
      </style>
    `;
    return el;
  }
}
