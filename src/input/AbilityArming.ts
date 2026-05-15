import type { PlayerState } from '@/state/PlayerState';

/** Probe used by the arming flow to inspect a slotted ability. */
export interface AbilityProbe {
  name:       string;
  targetType: string | undefined;  // 'self' | 'enemy' | 'ally' | 'aoe' | undefined
}

/**
 * AbilityArming — gamepad-only intermediary between "press slot" and "fire".
 *
 * fb3 on a focused slot calls `arm(slotIdx)`. The arming controller decides:
 *
 *   • enemy / ally  — sub-target picker not built yet (Phase 4b); fires
 *                     immediately on the existing main target via the server's
 *                     fallback chain. Slot still cooldown-validates client-side.
 *
 *   • self / aoe / untyped — enters a single-confirm armed state. A toast
 *                     prompts for fb3 again; fb2 cancels. Prevents accidental
 *                     self-casts on a missed slot tap.
 *
 * The controller exposes `isArming` so GamepadController can route d-pad U/D
 * (cycle, no-op for self) + fb3 (confirm) + fb2 (abort) here while armed.
 */
export class AbilityArming {
  private _armed = false;
  private _slotIdx: number | null = null;
  private _toastEl: HTMLElement | null = null;

  constructor(
    private readonly _player: PlayerState,
    private readonly mountEl: HTMLElement,
    private readonly probe:   (slotIdx: number) => AbilityProbe | null,
    private readonly fire:    (slotIdx: number) => void,
  ) {}

  get isArming(): boolean { return this._armed; }

  /** Called by gamepad fb3 when a focused slot wants to fire. */
  arm(slotIdx: number): void {
    if (this._armed) return;  // Shouldn't happen — state should route to confirm() instead
    const info = this.probe(slotIdx);
    if (!info) return;

    const tt = info.targetType;
    const needsPick = tt === 'enemy' || tt === 'ally';

    if (needsPick) {
      // Phase 4b deferred: sub-target picker for enemy/ally. For now fire on
      // the existing main target — server fallback chain handles missing subs.
      this.fire(slotIdx);
      return;
    }

    // Self / AoE / untyped — single-confirm armed state.
    this._armed = true;
    this._slotIdx = slotIdx;
    this._showToast(`Confirm ${info.name} — press X to cast, B to cancel`);
  }

  /** Called by gamepad fb3 while armed. */
  confirm(): void {
    if (!this._armed || this._slotIdx === null) return;
    const slot = this._slotIdx;
    this._reset();
    this.fire(slot);
  }

  /** Called by gamepad fb2 while armed. */
  abort(): void {
    if (!this._armed) return;
    this._reset();
  }

  private _reset(): void {
    this._armed = false;
    this._slotIdx = null;
    this._hideToast();
  }

  // ── Toast ────────────────────────────────────────────────────────────────

  private _showToast(msg: string): void {
    this._hideToast();
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:      'fixed',
      bottom:        '180px',
      left:          '50%',
      transform:     'translateX(-50%)',
      padding:       '8px 18px',
      background:    'rgba(30, 24, 16, 0.92)',
      color:         '#e8cc88',
      border:        '1px solid rgba(220, 165, 80, 0.75)',
      borderRadius:  '4px',
      fontFamily:    'var(--font-body, serif)',
      fontSize:      '14px',
      letterSpacing: '0.04em',
      zIndex:        '9999',
      pointerEvents: 'none',
      boxShadow:     '0 0 12px rgba(220, 165, 80, 0.45)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.mountEl.appendChild(el);
    this._toastEl = el;
  }

  private _hideToast(): void {
    this._toastEl?.remove();
    this._toastEl = null;
  }
}
