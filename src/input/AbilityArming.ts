import type { PlayerState } from '@/state/PlayerState';
import type { AoeShape }    from '@/network/Protocol';

/** Probe used by the arming flow to inspect a slotted ability. */
export interface AbilityProbe {
  name:       string;
  targetType: string | undefined;  // 'self' | 'enemy' | 'ally' | 'aoe' | undefined
  /** AoE footprint when the ability has one — used by AoEPreviewIndicator. */
  aoe?:       AoeShape;
}

/** Callbacks the arming flow needs to drive enemy/ally sub-target picking.
 *  Provided by the app glue (TabTargetService + PlayerState.setTarget). */
export interface ArmingPickerCallbacks {
  cycleEnemy:          (direction: 1 | -1) => void;
  cycleAlly:           (direction: 1 | -1) => void;
  hasValidEnemyTarget: () => boolean;
  hasValidAllyTarget:  () => boolean;
}

type Mode = 'idle' | 'self' | 'pick-enemy' | 'pick-ally';

/** Snapshot of the ability currently armed — used by the AoE preview to
 *  know which shape to render and where to anchor it. */
export interface ArmedAbility {
  name:       string;
  targetType: string | undefined;
  aoe:        AoeShape | undefined;
}

/**
 * AbilityArming — gamepad-only intermediary between "press slot" and "fire".
 *
 * fb3 on a focused slot calls `arm(slotIdx)`. The arming controller decides
 * which mode to enter based on the ability's targetType:
 *
 *   • enemy / ally  — picker mode. d-pad cycles candidates (via the supplied
 *                     cycleEnemy/cycleAlly callbacks), fb3 confirms (fires on
 *                     the picked target), fb2 cancels (restores the prior
 *                     main target). Pre-positioned to the existing target if
 *                     it's already a valid candidate of the right kind,
 *                     otherwise cycles to the first one.
 *
 *   • self / aoe / untyped — single-confirm armed state. fb3 confirms, fb2
 *                     aborts. Prevents accidental self-casts on a missed slot
 *                     tap; no cycling needed.
 *
 * The controller exposes `isArming` so GamepadController can route d-pad +
 * fb2/fb3 here while armed. App glue passes the picker callbacks once at
 * construction.
 */
export class AbilityArming {
  private _mode: Mode = 'idle';
  private _slotIdx: number | null = null;
  private _toastEl: HTMLElement | null = null;
  /** Snapshot of the armed ability — populated when entering any armed mode
   *  (self / picker), cleared on reset. Read by AoEPreviewIndicator. */
  private _armed: ArmedAbility | null = null;

  // Snapshot of the player's main target at arm-time. Restored on abort so
  // cancelling a picker doesn't strand the player on whoever they cycled to.
  // Not needed for confirm — ActionBar's own auto-return snap-back handles it.
  private _restoreTargetId:   string | null = null;
  private _restoreTargetName: string | null = null;

  private _picker: ArmingPickerCallbacks | null = null;

  constructor(
    private readonly _player: PlayerState,
    private readonly mountEl: HTMLElement,
    private readonly probe:   (slotIdx: number) => AbilityProbe | null,
    private readonly fire:    (slotIdx: number) => void,
  ) {}

  /** App glue calls this once to wire in the picker behaviour. Until set, the
   *  arming flow falls back to immediate-fire for enemy/ally (legacy path). */
  setPickerCallbacks(cb: ArmingPickerCallbacks): void {
    this._picker = cb;
  }

  get isArming(): boolean { return this._mode !== 'idle'; }
  /** True only while in a sub-target picker — used by visual cues that should
   *  only light up during enemy/ally pick (not during the self/AoE confirm). */
  get isPicking(): boolean { return this._mode === 'pick-enemy' || this._mode === 'pick-ally'; }
  /** Which kind of picker is active. null when not in a picker. Used by the
   *  SubTargetIndicator to switch colour (blue for ally, red/yellow for enemy). */
  get pickKind(): 'enemy' | 'ally' | null {
    if (this._mode === 'pick-enemy') return 'enemy';
    if (this._mode === 'pick-ally')  return 'ally';
    return null;
  }

  /** Read-only snapshot of the armed ability. null when not armed. */
  get armedAbility(): ArmedAbility | null { return this._armed; }

  /** Called by gamepad fb3 when a focused slot wants to fire. */
  arm(slotIdx: number): void {
    if (this._mode !== 'idle') return;  // Shouldn't happen — gamepad routes to confirm() instead
    const info = this.probe(slotIdx);
    if (!info) return;

    const tt = info.targetType;
    const needsPick = tt === 'enemy' || tt === 'ally';

    if (needsPick && this._picker) {
      this._enterPicker(slotIdx, info, tt as 'enemy' | 'ally');
      return;
    }

    if (needsPick) {
      // No picker wired — fire on the existing main target. Server fallback
      // chain handles missing sub. (Legacy path, primarily for unit tests.)
      this.fire(slotIdx);
      return;
    }

    // Self / AoE / untyped — single-confirm armed state.
    this._mode = 'self';
    this._slotIdx = slotIdx;
    this._armed = { name: info.name, targetType: tt, aoe: info.aoe };
    this._showToast(`Confirm ${info.name} — press X to cast, B to cancel`);
  }

  /** Enter picker mode for an enemy/ally ability. */
  private _enterPicker(slotIdx: number, info: AbilityProbe, kind: 'enemy' | 'ally'): void {
    const abilityName = info.name;
    const picker = this._picker!;

    // Snapshot for abort restore.
    this._restoreTargetId   = this._player.targetId;
    this._restoreTargetName = this._player.targetName;

    // Pre-position: keep current target if it already matches the kind, else
    // cycle to find the first valid candidate.
    const alreadyValid = kind === 'enemy'
      ? picker.hasValidEnemyTarget()
      : picker.hasValidAllyTarget();
    if (!alreadyValid) {
      if (kind === 'enemy') picker.cycleEnemy(1);
      else                  picker.cycleAlly(1);
    }

    // If still no target (e.g. empty world), abort with feedback.
    if (!this._player.targetId) {
      this._flashTransientToast(`No ${kind === 'enemy' ? 'hostile' : 'friendly'} targets in range`);
      this._restoreTargetId = null;
      this._restoreTargetName = null;
      return;
    }

    this._mode = kind === 'enemy' ? 'pick-enemy' : 'pick-ally';
    this._slotIdx = slotIdx;
    this._armed = { name: info.name, targetType: kind, aoe: info.aoe };
    this._showToast(`Pick ${kind === 'enemy' ? 'target' : 'ally'} — D-pad cycles · X cast · B cancel — ${abilityName}`);
    // Body class drives the TargetWindow pulse + any other surface that wants
    // to react. Cleared in _reset() so it never lingers.
    document.body.classList.add('aa-picking', kind === 'enemy' ? 'aa-picking-enemy' : 'aa-picking-ally');
  }

  /** Called by gamepad d-pad while in picker mode. Direction +1 = next, -1 = prev. */
  cyclePick(direction: 1 | -1): void {
    if (!this._picker) return;
    if (this._mode === 'pick-enemy')      this._picker.cycleEnemy(direction);
    else if (this._mode === 'pick-ally')  this._picker.cycleAlly(direction);
  }

  /** Called by gamepad fb3 while armed. */
  confirm(): void {
    if (this._mode === 'idle' || this._slotIdx === null) return;
    const slot = this._slotIdx;
    // Drop the restore snapshot — picker is confirming, ActionBar's auto-return
    // owns post-cast target state.
    this._reset(/* restoreTarget */ false);
    this.fire(slot);
  }

  /** Called by gamepad fb2 while armed. */
  abort(): void {
    if (this._mode === 'idle') return;
    this._reset(/* restoreTarget */ true);
  }

  private _reset(restoreTarget: boolean): void {
    if (restoreTarget && (this._mode === 'pick-enemy' || this._mode === 'pick-ally')) {
      this._player.setTarget(this._restoreTargetId, this._restoreTargetName);
    }
    this._mode = 'idle';
    this._slotIdx = null;
    this._armed = null;
    this._restoreTargetId = null;
    this._restoreTargetName = null;
    this._hideToast();
    document.body.classList.remove('aa-picking', 'aa-picking-enemy', 'aa-picking-ally');
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

  /** Short-lived toast used when arming fails (no valid candidates). */
  private _flashTransientToast(msg: string): void {
    this._showToast(msg);
    const el = this._toastEl;
    if (!el) return;
    setTimeout(() => {
      if (this._toastEl === el) this._hideToast();
    }, 1500);
  }
}
