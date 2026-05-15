/**
 * GamepadBindings — single source of truth for "which button does what."
 *
 * GamepadController reads `bindings.get('jump')` instead of hardcoding indices.
 * The Settings → Controls tab calls `bindings.set('jump', N)` on rebind and
 * persists to localStorage. Defaults match the original hardcoded mapping so
 * existing players see no change until they actively rebind.
 *
 * Bindable actions (8 total — fits within face + shoulder buttons):
 *   jump, dash, interact, confirm, cancel, lock_toggle,
 *   slot_modifier_low, slot_modifier_high
 *
 * Non-bindable inputs (state-routed, intentionally fixed):
 *   sticks       — movement + camera
 *   d-pad        — context-dependent (idle: tab target; targeted: cursor)
 *   start/select — reserved for future menu toggles
 */

export type GamepadAction =
  | 'jump'
  | 'dash'
  | 'sprint'
  | 'interact'
  | 'confirm'
  | 'cancel'
  | 'lock_toggle'
  | 'slot_modifier_low'
  | 'slot_modifier_high';

export const GAMEPAD_ACTIONS: readonly GamepadAction[] = [
  'jump',
  'dash',
  'sprint',
  'interact',
  'confirm',
  'cancel',
  'lock_toggle',
  'slot_modifier_low',
  'slot_modifier_high',
] as const;

/** Friendly labels for each action, shown in the Controls tab. */
export const ACTION_LABELS: Record<GamepadAction, string> = {
  jump:                'Jump',
  dash:                'Dash',
  sprint:              'Sprint (hold)',
  interact:            'Interact',
  confirm:             'Confirm / Fire',
  cancel:              'Cancel / Back',
  lock_toggle:         'Lock / Unlock Target',
  slot_modifier_low:   'Slot 1-4 Modifier',
  slot_modifier_high:  'Slot 5-8 Modifier',
};

/** Optional one-liner describing each action. */
export const ACTION_DESCRIPTIONS: Record<GamepadAction, string> = {
  jump:                'Synthesizes Space — same path as the keyboard jump.',
  dash:                'Synthesizes V — directional retreat using held WASD.',
  sprint:              'Hold to sprint while the left stick is deflected.',
  interact:            'Synthesizes F — proximity interact with the nearest object.',
  confirm:             'Locks soft target (idle), activates cursor (targeted), confirms armed cast.',
  cancel:              'Closes the top modal, aborts an armed cast, otherwise no-op.',
  lock_toggle:         'Toggles target lock on the current soft target.',
  slot_modifier_low:   'Hold + face button = direct slot 1-4 fire (ARPG fast path).',
  slot_modifier_high:  'Hold + face button = direct slot 5-8 fire.',
};

/** Standard Gamepad index → friendly label. */
export const BUTTON_LABELS: Record<number, string> = {
  0:  'A / Cross',
  1:  'B / Circle',
  2:  'X / Square',
  3:  'Y / Triangle',
  4:  'LB / L1',
  5:  'RB / R1',
  6:  'LT / L2',
  7:  'RT / R2',
  8:  'Back / Share',
  9:  'Start / Options',
  10: 'L3 (left stick click)',
  11: 'R3 (right stick click)',
  12: 'D-Pad Up',
  13: 'D-Pad Down',
  14: 'D-Pad Left',
  15: 'D-Pad Right',
  16: 'Guide / PS',
};

/** Buttons the user is allowed to bind to (excludes d-pad and guide). */
export const BINDABLE_INDICES: readonly number[] = [
  0, 1, 2, 3,   // face
  4, 5, 6, 7,   // shoulders + triggers
  8, 9,         // back / start
  10, 11,       // stick clicks
] as const;

/** Defaults match the pre-binding hardcoded layout for backward continuity. */
export const DEFAULT_BINDINGS: Record<GamepadAction, number> = {
  jump:                0,  // A
  cancel:              1,  // B
  confirm:             2,  // X
  interact:            3,  // Y
  lock_toggle:         4,  // LB
  dash:                5,  // RB
  slot_modifier_low:   6,  // LT
  slot_modifier_high:  7,  // RT
  sprint:              10, // L3 (left stick click)
};

const STORAGE_KEY = 'aa_gamepad_bindings_v1';

export function buttonLabel(index: number): string {
  return BUTTON_LABELS[index] ?? `Button ${index}`;
}

export class GamepadBindings {
  private map: Record<GamepadAction, number>;
  private listeners: Set<() => void> = new Set();

  // Active rebind capture. While set, GamepadController routes the next
  // button press here and suppresses normal input for one tick.
  private _capture: { action: GamepadAction; resolve: (idx: number | null) => void } | null = null;

  constructor() {
    this.map = this._load();
  }

  get(action: GamepadAction): number {
    return this.map[action];
  }

  set(action: GamepadAction, buttonIndex: number): void {
    if (this.map[action] === buttonIndex) return;
    this.map[action] = buttonIndex;
    this._save();
    this._notify();
  }

  reset(): void {
    this.map = { ...DEFAULT_BINDINGS };
    this._save();
    this._notify();
  }

  all(): Readonly<Record<GamepadAction, number>> {
    return this.map;
  }

  /** Subscribe to binding changes (UI uses this to refresh). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Rebind capture ─────────────────────────────────────────────────────

  /** Enter capture mode for `action`. Resolves with the index that was
   *  pressed, or null if cancelled. While capturing, GamepadController
   *  suppresses normal input. */
  captureNext(action: GamepadAction): Promise<number | null> {
    this.cancelCapture();
    return new Promise((resolve) => {
      this._capture = { action, resolve };
    });
  }

  cancelCapture(): void {
    if (!this._capture) return;
    const cap = this._capture;
    this._capture = null;
    cap.resolve(null);
  }

  capturingAction(): GamepadAction | null {
    return this._capture?.action ?? null;
  }

  /** Called by GamepadController on every button-press edge while capturing.
   *  Returns true if the press was consumed, false if it should be ignored
   *  (e.g. d-pad indices that aren't bindable). */
  applyCapture(buttonIdx: number): boolean {
    if (!this._capture) return false;
    if (!BINDABLE_INDICES.includes(buttonIdx)) return false;
    const action = this._capture.action;
    const resolve = this._capture.resolve;
    this._capture = null;
    this.set(action, buttonIdx);
    resolve(buttonIdx);
    return true;
  }

  private _notify(): void {
    this.listeners.forEach(fn => fn());
  }

  private _load(): Record<GamepadAction, number> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return { ...DEFAULT_BINDINGS };
      const parsed = JSON.parse(stored) as Partial<Record<GamepadAction, number>>;
      // Merge with defaults so newly-added actions fall back cleanly.
      return { ...DEFAULT_BINDINGS, ...parsed };
    } catch {
      return { ...DEFAULT_BINDINGS };
    }
  }

  private _save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map)); } catch { /* quota / disabled */ }
  }
}
