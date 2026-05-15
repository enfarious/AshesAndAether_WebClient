/**
 * ModalStack — central registry for modal-style UI panels.
 *
 * Replaces the scattered `panel.isVisible` flag-checking that used to live in
 * a hardcoded closure inside App. Every modal panel registers itself here on
 * construction; the gamepad / state-machine layer asks the stack whether any
 * panel is open instead of OR'ing a list of flags.
 *
 * Phase 1 contract:
 *   - Panels expose an `isVisible` getter (boolean).
 *   - `anyOpen` answers "is any registered panel currently shown?"
 *   - `top` returns the most-recently-shown visible panel (when a panel calls
 *     `notifyShown`) or any visible panel as a fallback. Used in later phases
 *     to route fb2 (cancel) and fb3 (confirm) to the active panel.
 *
 * Panels that want to opt into z-order routing call `notifyShown(this)` from
 * their `show()` method. Panels that don't are still queried for `anyOpen` —
 * they just lose to better-behaved panels when a confirm/cancel must pick one.
 */
export interface ModalLike {
  readonly isVisible: boolean;
  /** Optional close hook — called when fb2 / Esc fires while this panel is the top. */
  close?(): void;
}

export class ModalStack {
  private panels: ModalLike[] = [];
  private order: ModalLike[] = [];
  /** Monotonic z-index assigned by bringToFront. Baseline 1000 stays above
   *  general HUD elements but below the ultra-high-z items like toasts. */
  private _zCounter = 1000;

  register(panel: ModalLike): void {
    if (!this.panels.includes(panel)) this.panels.push(panel);
    this._wrapShowForZOrder(panel);
  }

  /** Bump a panel's root element to the top of the modal z-stack. */
  bringToFront(root: HTMLElement): void {
    root.style.zIndex = String(++this._zCounter);
  }

  /** Monkey-patch the panel's show() once at register time so every call
   *  bumps the z-index of its root element. Avoids per-panel edits — every
   *  modal panel in this codebase has a `root` HTMLElement field, accessible
   *  at runtime regardless of TypeScript's compile-time `private`. */
  private _wrapShowForZOrder(panel: ModalLike): void {
    const carrier = panel as { root?: HTMLElement; show?: (...args: unknown[]) => unknown; _zWrapped?: true };
    if (carrier._zWrapped) return;            // idempotent
    const root = carrier.root;
    const orig = carrier.show;
    if (!root || typeof orig !== 'function') return;
    const bound = orig.bind(panel);
    carrier.show = (...args: unknown[]) => {
      const result = bound(...args);
      this.bringToFront(root);
      return result;
    };
    carrier._zWrapped = true;
  }

  unregister(panel: ModalLike): void {
    this.panels = this.panels.filter(p => p !== panel);
    this.order  = this.order.filter(p => p !== panel);
  }

  /** Claim the top of the z-stack. Panels call this from their show() method. */
  notifyShown(panel: ModalLike): void {
    this.order = this.order.filter(p => p !== panel);
    this.order.push(panel);
  }

  get anyOpen(): boolean {
    return this.panels.some(p => p.isVisible);
  }

  /** Most-recently-shown visible panel, with any-visible as fallback. */
  get top(): ModalLike | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const p = this.order[i];
      if (p && p.isVisible) return p;
    }
    return this.panels.find(p => p.isVisible) ?? null;
  }

  /** Close the top visible panel. Prefers an explicit `close()` hook; falls
   *  back to a duck-typed `hide()` so panels that only implement the legacy
   *  show/hide pair still respond to the gamepad menu-button "close any
   *  modal" shortcut without each needing a `close` alias. */
  closeTop(): boolean {
    const top = this.top;
    if (!top) return false;
    if (top.close) { top.close(); return true; }
    const hideable = top as { hide?: () => void };
    if (typeof hideable.hide === 'function') { hideable.hide(); return true; }
    return false;
  }
}
