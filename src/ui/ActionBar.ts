/**
 * ActionBar — 8-slot hotbar for active abilities.
 *
 * Positioned bottom-center, directly above the HUD vitals.
 * Keys 1-8 (or click) fire the slotted ability via sendCombatAction.
 * Client-side cooldown overlay ticks down each frame via tick(dt).
 */

import type { PlayerState }        from '@/state/PlayerState';
import type { SocketClient }       from '@/network/SocketClient';
import type { EntityRegistry }     from '@/state/EntityRegistry';
import type { AbilityNodeSummary, CombatHitData, CombatErrorPayload } from '@/network/Protocol';

// ── Constants ────────────────────────────────────────────────────────────────

const SLOT_COUNT = 8;

const SECTOR_HUE: Record<string, string> = {
  tank:    '36',
  phys:    '15',
  control: '210',
  magic:   '270',
  healer:  '140',
  support: '175',
};

/** localStorage flag for the post-cast snap-back behaviour. Default true.
 *  Toggle via console: `localStorage.setItem('aa_auto_return_after_cast', 'false')`.
 *  A proper SettingsWindow toggle lands when we add a Gameplay tab. */
const KEY_AUTO_RETURN_AFTER_CAST = 'aa_auto_return_after_cast';
function autoReturnEnabled(): boolean {
  return localStorage.getItem(KEY_AUTO_RETURN_AFTER_CAST) !== 'false';
}

interface CooldownEntry {
  remaining: number;  // seconds left
  total:     number;  // total duration
}

// ── ActionBar ────────────────────────────────────────────────────────────────

export class ActionBar {
  private root:     HTMLElement;
  private tooltip:  HTMLElement;
  private slotEls:  HTMLElement[] = [];
  private cooldowns = new Map<number, CooldownEntry>();
  private cleanup:  (() => void)[] = [];

  private _lastLoadoutKey = '';
  private _rafId: number | null = null;

  // Last slot the player pressed — used to target combat_error flashes back at the right slot.
  private _lastCastSlot: number | null = null;
  private _lastCastAt   = 0;

  // Gamepad slot-focus cursor. Null = no focus rendered (idle / target-unlocked).
  // d-pad L/R in the `targeted` state walks this; fb3 fires `activateSlot(focused)`.
  private _focusedSlot: number | null = null;

  /** Optional callback for showing validation feedback (e.g. chat system message). */
  onValidationError: ((msg: string) => void) | null = null;

  constructor(
    private readonly mountEl:   HTMLElement,
    private readonly player:    PlayerState,
    private readonly socket:    SocketClient,
    private readonly entities:  EntityRegistry,
  ) {
    this.root    = document.createElement('div');
    this.tooltip = document.createElement('div');
    this._injectStyles();
    this._buildDOM();
    this.mountEl.appendChild(this.root);

    const unsub = this.player.onChange(() => this._schedulePlayerChange());
    this.cleanup.push(unsub);

    this._refresh();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  show(): void  { this.root.style.display = ''; }
  hide(): void  { this.root.style.display = 'none'; }

  get isVisible(): boolean { return this.root.style.display !== 'none'; }

  dispose(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.cleanup.forEach(fn => fn());
    this.root.remove();
    this.tooltip.remove();
  }

  // ── Frame tick (cooldowns + GCD sweep) ─────────────────────────────────────

  tick(dt: number): void {
    // Per-ability cooldowns
    if (this.cooldowns.size > 0) {
      for (const [idx, cd] of this.cooldowns) {
        cd.remaining -= dt;

        const el      = this.slotEls[idx]!;
        const overlay = el.querySelector<HTMLElement>('.ab-cd-overlay')!;
        const textEl  = el.querySelector<HTMLElement>('.ab-cd-text')!;

        if (cd.remaining <= 0) {
          this.cooldowns.delete(idx);
          overlay.style.transform = 'scaleY(0)';
          textEl.textContent = '';
        } else {
          const pct = cd.remaining / cd.total;
          overlay.style.transform = `scaleY(${pct})`;
          textEl.textContent = cd.remaining >= 1
            ? `${Math.ceil(cd.remaining)}`
            : cd.remaining.toFixed(1);
        }
      }
    }

    // Per-slot readiness (ready glow vs. blocked desat). Runs every frame —
    // cheap (8 slots × a few comparisons), and keeps the bar honest as
    // resources tick or the target changes.
    //
    // Intentionally does NOT consult combat.atb: in v2 that gauge doesn't
    // actually represent the global cooldown the way it did in v1, so keying
    // off it produced misleading dim/un-dim during fights.  See memory
    // `project_combat_hud_gauges.md`.
    this._recomputeReadiness();
  }

  private _recomputeReadiness(): void {
    const loadout  = this.player.activeLoadout;
    const manifest = this._manifestMap();
    const alive    = this.player.isAlive;
    const targetId = this.player.targetId ?? '';

    for (let i = 0; i < SLOT_COUNT; i++) {
      const el     = this.slotEls[i]!;
      const nodeId = loadout[i] ?? null;
      const node   = nodeId ? manifest.get(nodeId) : undefined;

      // Empty slot — never highlight either way.
      if (!node) {
        if (el.classList.contains('ab-ready'))   el.classList.remove('ab-ready');
        if (el.classList.contains('ab-blocked')) el.classList.remove('ab-blocked');
        continue;
      }

      const onCd    = this.cooldowns.has(i);
      const lowMana = node.manaCost    ? this.player.mana.current    < node.manaCost    : false;
      const lowSta  = node.staminaCost ? this.player.stamina.current < node.staminaCost : false;
      const badTgt  = this._validateTarget(node, targetId) !== null;
      const blocked = !alive || onCd || lowMana || lowSta || badTgt;

      el.classList.toggle('ab-blocked', blocked);
      el.classList.toggle('ab-ready',   !blocked);
    }
  }

  /** Remove a slot's cooldown — the data entry AND its overlay/text DOM.
   *  tick()'s natural-expiry path resets the overlay; any OUT-OF-BAND clear
   *  (cast/channel cancel, blocked-cast rejection) must reset it the same
   *  way, or the overlay element freezes at its last-painted scaleY — tick()
   *  never repaints a slot that's no longer in the map — and the slot looks
   *  stuck on cooldown forever even though it's perfectly usable. */
  private _clearCooldown(slot: number): void {
    this.cooldowns.delete(slot);
    const el = this.slotEls[slot];
    if (!el) return;
    const overlay = el.querySelector<HTMLElement>('.ab-cd-overlay');
    const textEl  = el.querySelector<HTMLElement>('.ab-cd-text');
    if (overlay) overlay.style.transform = 'scaleY(0)';
    if (textEl)  textEl.textContent = '';
  }

  // ── Gamepad slot-focus cursor ──────────────────────────────────────────────

  /** Move focus to the previous slot (wraps). Wakes from null at slot 0. */
  focusSlotPrev(): void {
    this._focusedSlot = this._focusedSlot === null
      ? 0
      : (this._focusedSlot - 1 + SLOT_COUNT) % SLOT_COUNT;
    this._updateFocusVisual();
  }

  /** Move focus to the next slot (wraps). Wakes from null at slot 0. */
  focusSlotNext(): void {
    this._focusedSlot = this._focusedSlot === null
      ? 0
      : (this._focusedSlot + 1) % SLOT_COUNT;
    this._updateFocusVisual();
  }

  /** Fire the focused slot via the existing activateSlot path. No-op when no focus. */
  fireFocusedSlot(): void {
    if (this._focusedSlot === null) return;
    this.activateSlot(this._focusedSlot);
  }

  /** Hide the focus ring. Called when leaving the `targeted` input state. */
  clearFocus(): void {
    if (this._focusedSlot === null) return;
    this._focusedSlot = null;
    this._updateFocusVisual();
  }

  /** Current focused slot index, or null if no focus is rendered. */
  getFocusedSlot(): number | null { return this._focusedSlot; }

  /** Slot-level lookup for the arming flow — returns name + targetType + AoE
   *  shape (when set), or null when the slot is empty or the ability is
   *  unknown to the local manifest. */
  probeSlot(index: number): { name: string; targetType: string | undefined; aoe: AbilityNodeSummary['aoe'] } | null {
    const nodeId = this.player.activeLoadout[index];
    if (!nodeId) return null;
    const node = this._manifestMap().get(nodeId);
    if (!node) return null;
    return { name: node.name, targetType: node.targetType, aoe: node.aoe };
  }

  private _updateFocusVisual(): void {
    for (let i = 0; i < this.slotEls.length; i++) {
      const el = this.slotEls[i];
      if (!el) continue;
      el.classList.toggle('ab-focused', i === this._focusedSlot);
    }
  }

  // ── Activation (key press or click) ────────────────────────────────────────

  activateSlot(index: number): void {
    if (!this.player.isAlive) return;

    const nodeId = this.player.activeLoadout[index];
    if (!nodeId) return;
    if (this.cooldowns.has(index)) return;

    const node = this._manifestMap().get(nodeId);
    if (!node) return;

    // ── Target validation ──────────────────────────────────────────────────
    // Send both the main target (typed enemy/structure click or Tab pick) and
    // the sub-target (Ctrl+Tab cycling, future). Server applies the fallback
    // chain in `_resolveAbilityTarget` based on ability.targetType.
    const targetId    = this.player.targetId      ?? '';
    const subTargetId = this.player.focusTargetId ?? undefined;
    const err = this._validateTarget(node, targetId);
    if (err) {
      this.onValidationError?.(err);
      return;
    }

    this.socket.sendCombatAction(nodeId, targetId, subTargetId);

    // Auto-return after cast: snap main target back to the lock or auto-attack
    // target so the player doesn't have to manually retarget after healing /
    // buffing an ally. Lock wins over auto-attack (deliberate > implicit).
    // Toggle via localStorage: aa_auto_return_after_cast = "false" disables.
    if (autoReturnEnabled()) {
      const lockedId = this.player.lockedTargetId;
      const aaId     = this.player.combat.autoAttackTarget ?? null;
      const snapId   = this._pickSnapBackTarget(lockedId, aaId, targetId);
      if (snapId) {
        const ent = this.entities.get(snapId);
        if (ent && ent.isAlive !== false) {
          this.player.setTarget(snapId, ent.name ?? snapId);
        }
      }
    }

    // Remember this for combat_error feedback — the server only sends {code, message},
    // so we use the most-recent press to know which slot to red-flash.
    this._lastCastSlot = index;
    this._lastCastAt   = performance.now();

    // Client-side cooldown (server enforces the real one)
    if (node.cooldown && node.cooldown > 0) {
      this.cooldowns.set(index, { remaining: node.cooldown, total: node.cooldown });
    }

    // Optimistic local flash — overwritten by flashOutcome when the server confirms.
    this._flashSlot(index, 'ab-flash');
  }

  // ── Public feedback API (driven by MessageRouter) ──────────────────────────

  /** Flash a slot with outcome-tinted color when the server confirms a player cast.
   *  Also snaps the slot's cooldown to the server-authoritative value if present —
   *  no waiting for the user to mash and trigger an `on_cooldown` rejection. */
  flashOutcome(data: CombatHitData): void {
    if (data.attackerId !== this.player.id) return;

    // Resolve slot: prefer abilityId match, fall back to _lastCastSlot if recent.
    // The fallback covers drift between the canonical abilityId the server emits
    // (e.g. 'shadow_bolt') and the slot/loadout key the client knows about
    // (e.g. 'active_magic_t1').
    let slot = this.player.activeLoadout.indexOf(data.abilityId);
    if (slot < 0 && this._lastCastSlot !== null && performance.now() - this._lastCastAt < 3000) {
      slot = this._lastCastSlot;
    }
    if (slot < 0) return;

    const cls =
      data.isHeal                                             ? 'ab-flash-heal'
      : data.outcome === 'miss' || data.outcome === 'deflected' ? 'ab-flash-miss'
      : data.critical || data.outcome === 'crit'              ? 'ab-flash-crit'
      : data.outcome === 'glance'                             ? 'ab-flash-glance'
      :                                                         'ab-flash-hit';
    this._flashSlot(slot, cls);

    // Server-authoritative CD snap. Falls back to the manifest's static cooldown
    // when the server hasn't been updated to send cooldownMs yet. If neither is
    // present, leave any optimistic CD already set by activateSlot alone.
    let duration: number | null = null;
    if (data.cooldownMs !== undefined && data.cooldownMs > 0) {
      duration = data.cooldownMs / 1000;
    } else {
      const node = this._manifestMap().get(data.abilityId);
      if (node?.cooldown && node.cooldown > 0) duration = node.cooldown;
    }
    if (duration !== null) {
      this.cooldowns.set(slot, { remaining: duration, total: duration });
    }
  }

  /**
   * Red shake on the most-recently-pressed slot when the server rejects the cast.
   * Reacts to the error code:
   *   - on_cooldown → keep/snap the slot's CD: the ability genuinely IS on
   *     cooldown. Prefer the server's remainingMs, else the manifest cooldown.
   *   - every OTHER rejection (on_gcd, casting, channeling, out_of_range,
   *     insufficient_resources, …) → CLEAR the optimistic CD set on press. A
   *     blocked cast never fired, so the ability must not look like it went
   *     on cooldown — and the GCD is a global lockout, not this ability's
   *     own cooldown, so painting it as a per-slot CD misreads as "the
   *     ability I pressed went on cooldown."
   */
  flashError(error: CombatErrorPayload): void {
    if (this._lastCastSlot === null) return;
    if (performance.now() - this._lastCastAt > 3000) return;  // stale press

    const slot = this._lastCastSlot;
    this._flashSlot(slot, 'ab-flash-error');

    if (error.code === 'on_cooldown') {
      // Prefer the server-authoritative remainingMs when present; fall back to
      // the manifest's declared cooldown, then to a 2 s placeholder.
      let duration: number;
      if (error.remainingMs !== undefined && error.remainingMs > 0) {
        duration = error.remainingMs / 1000;
      } else {
        const nodeId = this.player.activeLoadout[slot];
        const node   = nodeId ? this._manifestMap().get(nodeId) : undefined;
        duration = (node?.cooldown && node.cooldown > 0) ? node.cooldown : 2;
      }
      this.cooldowns.set(slot, { remaining: duration, total: duration });
    } else {
      this._clearCooldown(slot);
    }
  }

  /** Clear an optimistic cooldown when the server reports the cast/channel
   *  was cancelled (cast_break / channel_break). A cancelled cast committed
   *  no server-side cooldown, so the optimistic CD set on press must be
   *  dropped — otherwise the slot reads as on-cooldown for the full invented
   *  duration and activateSlot's `cooldowns.has` guard locks it out. Slot
   *  resolved like flashOutcome (abilityId → loadout, recent-press fallback
   *  for canonical-id drift). */
  clearCooldownOnCancel(abilityId: string): void {
    let slot = this.player.activeLoadout.indexOf(abilityId);
    if (slot < 0 && this._lastCastSlot !== null && performance.now() - this._lastCastAt < 3000) {
      slot = this._lastCastSlot;
    }
    if (slot < 0) return;
    this._clearCooldown(slot);
  }

  private _flashSlot(index: number, className: string): void {
    const el = this.slotEls[index];
    if (!el) return;
    // Strip every flash variant before re-adding so back-to-back flashes restart cleanly.
    el.classList.remove('ab-flash', 'ab-flash-hit', 'ab-flash-crit', 'ab-flash-glance', 'ab-flash-miss', 'ab-flash-heal', 'ab-flash-error');
    void el.offsetWidth;  // force reflow to restart animation
    el.classList.add(className);
  }

  // ── Target validation ───────────────────────────────────────────────────

  /**
   * Pre-flight check before sending a combat action.
   * Returns an error string if the cast should be blocked, or null if OK.
   *
   * These are UX guardrails — the server always validates authoritatively.
   */
  /**
   * Pick the snap-back target after a cast. Priority:
   *   1. Locked main target — explicit player intent ("this is my main")
   *   2. Auto-attack target — implicit engagement
   *   3. null — leave main target wherever it landed
   *
   * Skips if the candidate is the same as what was just cast on (no-op snap)
   * or if the candidate is the caster themselves.
   */
  private _pickSnapBackTarget(
    lockedId: string | null,
    autoAttackId: string | null,
    castTargetId: string,
  ): string | null {
    const skip = (id: string | null): boolean => !id || id === castTargetId || id === this.player.id;
    if (!skip(lockedId))     return lockedId;
    if (!skip(autoAttackId)) return autoAttackId;
    return null;
  }

  private _validateTarget(node: AbilityNodeSummary, targetId: string): string | null {
    const tt = node.targetType;  // 'self' | 'enemy' | 'ally' | 'aoe' | undefined

    // Self-cast and AoE don't need a target entity
    if (!tt || tt === 'self' || tt === 'aoe') return null;

    // ── Enemy-targeted abilities ─────────────────────────────────────────
    // The server applies a fallback chain (mainTarget → subTarget). Client
    // guard mirrors that: if main is bad, check sub before refusing to send.
    if (tt === 'enemy') {
      const subId = this.player.focusTargetId ?? '';
      const candidates = [targetId, subId].filter(Boolean);
      if (candidates.length === 0) return 'You need a hostile target.';

      let validHostile = false;
      for (const id of candidates) {
        if (id === this.player.id) continue;
        const ent = this.entities.get(id);
        if (!ent || ent.isAlive === false) continue;
        if (this._isAlly(id)) continue;
        validHostile = true;
        break;
      }
      if (!validHostile) return 'You need a hostile target.';
      return null;
    }

    // ── Ally-targeted abilities (heals, buffs) ───────────────────────────
    if (tt === 'ally') {
      // Server falls back to caster as last resort, so an ally cast is always
      // valid as long as caster is alive — let the server resolve which slot.
      const subId = this.player.focusTargetId ?? '';
      const candidates = [subId, targetId, this.player.id].filter(Boolean);
      let validFriendly = false;
      for (const id of candidates) {
        if (id === this.player.id) { validFriendly = true; break; }
        const ent = this.entities.get(id);
        if (!ent || ent.isAlive === false) continue;
        if (ent.hostile) continue;
        validFriendly = true;
        break;
      }
      if (!validFriendly) return 'You need a friendly target.';
      return null;
    }

    return null;
  }

  /** Check if an entity ID is the player, a party member, or the player's companion. */
  private _isAlly(id: string): boolean {
    if (id === this.player.id) return true;

    // Party members
    if (this.player.partyMembers.some(m => m.id === id)) return true;

    // Player's companion
    if (this.player.companion?.companionId === id) return true;

    return false;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #action-bar {
        position: absolute;
        bottom: 104px;
        left: calc(50% - min(250px, 45vw));
        width: min(500px, 90vw);
        display: flex;
        gap: 3px;
        pointer-events: auto;
        z-index: 50;
      }

      /* ── Slot ── */
      #action-bar .ab-slot {
        flex: 1;
        height: 48px;
        background: rgba(10, 8, 6, 0.75);
        border: 1px solid rgba(200, 98, 42, 0.2);
        border-left-width: 1px;
        position: relative;
        overflow: hidden;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-family: var(--font-mono);
        transition: border-color 0.12s, background 0.12s;
      }
      #action-bar .ab-slot:hover {
        border-color: rgba(200, 145, 60, 0.5);
        background: rgba(30, 18, 8, 0.85);
      }
      #action-bar .ab-slot.ab-empty {
        cursor: default;
      }
      #action-bar .ab-slot.ab-empty:hover {
        border-color: rgba(200, 98, 42, 0.2);
        background: rgba(10, 8, 6, 0.75);
      }

      /* Gamepad focus ring — pulses to make the cursor unmissable */
      #action-bar .ab-slot.ab-focused {
        border-color: rgba(220, 165, 80, 0.95);
        box-shadow:
          0 0 0 1px rgba(220, 165, 80, 0.85),
          0 0 12px rgba(220, 165, 80, 0.55);
        z-index: 2;
      }
      /* Stop the ready-pulse animation while focused — otherwise its
       * box-shadow keyframes mask the static focus ring on any slot that
       * has an ability (i.e. has .ab-ready). Empty slots have no ab-ready
       * and were the only ones where the ring was visible before. */
      #action-bar .ab-slot.ab-focused.ab-ready,
      #action-bar .ab-slot.ab-focused.ab-ready.ab-capstone {
        animation: none;
      }

      /* Capstone (slot 8) */
      #action-bar .ab-slot.ab-capstone {
        border-color: rgba(160, 80, 220, 0.25);
        background: rgba(20, 8, 30, 0.75);
      }
      #action-bar .ab-slot.ab-capstone:hover {
        border-color: rgba(160, 80, 220, 0.55);
      }
      #action-bar .ab-slot.ab-capstone.ab-empty:hover {
        border-color: rgba(160, 80, 220, 0.25);
        background: rgba(20, 8, 30, 0.75);
      }

      /* Keybind label */
      #action-bar .ab-keybind {
        position: absolute;
        top: 2px; left: 4px;
        font-size: 9px;
        color: rgba(212, 201, 184, 0.3);
        letter-spacing: 0.04em;
        pointer-events: none;
      }

      /* Ability name */
      #action-bar .ab-name {
        font-size: 9px;
        color: rgba(212, 201, 184, 0.8);
        text-align: center;
        padding: 0 4px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
        line-height: 1.2;
        pointer-events: none;
      }

      /* Empty dot */
      #action-bar .ab-empty-dot {
        font-size: 16px;
        color: rgba(212, 201, 184, 0.08);
        pointer-events: none;
      }

      /* ── Cooldown overlay ── */
      #action-bar .ab-cd-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        pointer-events: none;
        transform-origin: top;
        transform: scaleY(0);
      }
      #action-bar .ab-cd-text {
        position: absolute;
        bottom: 2px; right: 3px;
        font-size: 10px;
        color: rgba(212, 201, 184, 0.7);
        text-shadow: 0 1px 3px #000;
        pointer-events: none;
      }

      /* ── Readiness (ready = subtle warm pulse, blocked = desat) ── */
      @keyframes ab-ready-pulse {
        0%, 100% { box-shadow: inset 0 0 6px rgba(220, 165, 80, 0.20); }
        50%      { box-shadow: inset 0 0 9px rgba(220, 165, 80, 0.38); }
      }
      #action-bar .ab-slot.ab-ready {
        animation: ab-ready-pulse 1.6s ease-in-out infinite;
        border-color: rgba(220, 165, 80, 0.55);
      }
      #action-bar .ab-slot.ab-ready.ab-capstone {
        border-color: rgba(180, 110, 230, 0.55);
      }
      @keyframes ab-ready-pulse-cap {
        0%, 100% { box-shadow: inset 0 0 6px rgba(180, 110, 230, 0.22); }
        50%      { box-shadow: inset 0 0 10px rgba(180, 110, 230, 0.42); }
      }
      #action-bar .ab-slot.ab-ready.ab-capstone {
        animation: ab-ready-pulse-cap 1.6s ease-in-out infinite;
      }
      #action-bar .ab-slot.ab-blocked .ab-name {
        filter: saturate(0.25);
        opacity: 0.55;
      }
      #action-bar .ab-slot.ab-blocked {
        opacity: 0.78;
      }

      /* ── Flash variants (local press + server-confirmed outcome) ── */
      @keyframes ab-flash {
        0%   { background: rgba(200, 145, 60, 0.4); }
        100% { background: transparent; }
      }
      @keyframes ab-flash-hit {
        0%   { background: rgba(200, 145, 60, 0.55); box-shadow: inset 0 0 14px rgba(200,145,60,0.5); }
        100% { background: transparent;              box-shadow: none; }
      }
      @keyframes ab-flash-crit {
        0%   { background: rgba(255, 220, 120, 0.85); box-shadow: inset 0 0 22px rgba(255,210,90,0.85), 0 0 16px rgba(255,200,80,0.7); }
        50%  { background: rgba(255, 220, 120, 0.55); box-shadow: inset 0 0 18px rgba(255,210,90,0.55), 0 0 10px rgba(255,200,80,0.45); }
        100% { background: transparent;               box-shadow: none; }
      }
      @keyframes ab-flash-glance {
        0%   { background: rgba(180, 160, 110, 0.4); }
        100% { background: transparent; }
      }
      @keyframes ab-flash-miss {
        0%   { background: rgba(120, 120, 120, 0.45); box-shadow: inset 0 0 10px rgba(80,80,80,0.5); }
        100% { background: transparent;               box-shadow: none; }
      }
      @keyframes ab-flash-heal {
        0%   { background: rgba(80, 200, 110, 0.55); box-shadow: inset 0 0 14px rgba(80, 200, 110, 0.55); }
        100% { background: transparent;              box-shadow: none; }
      }
      @keyframes ab-flash-error {
        0%   { background: rgba(200, 60, 60, 0.55); box-shadow: inset 0 0 14px rgba(220,60,60,0.7); transform: translateX(0); }
        25%  { transform: translateX(-2px); }
        50%  { background: rgba(200, 60, 60, 0.35); transform: translateX(2px); }
        75%  { transform: translateX(-1px); }
        100% { background: transparent;             box-shadow: none; transform: translateX(0); }
      }

      #action-bar .ab-slot.ab-flash         { animation: ab-flash       0.2s ease-out; }
      #action-bar .ab-slot.ab-flash-hit     { animation: ab-flash-hit   0.35s ease-out; }
      #action-bar .ab-slot.ab-flash-crit    { animation: ab-flash-crit  0.55s ease-out; }
      #action-bar .ab-slot.ab-flash-glance  { animation: ab-flash-glance 0.25s ease-out; }
      #action-bar .ab-slot.ab-flash-miss    { animation: ab-flash-miss  0.4s ease-out; }
      #action-bar .ab-slot.ab-flash-heal    { animation: ab-flash-heal  0.35s ease-out; }
      #action-bar .ab-slot.ab-flash-error   { animation: ab-flash-error 0.45s ease-out; }

      /* ── Tooltip ── */
      #action-bar-tooltip {
        position: fixed;
        pointer-events: none;
        z-index: 900;
        max-width: 240px;
        background: rgba(8, 6, 4, 0.96);
        border: 1px solid rgba(200, 145, 60, 0.3);
        padding: 8px 10px;
        font-family: var(--font-mono);
        display: none;
      }
      #action-bar-tooltip .abt-name {
        font-size: 12px;
        margin-bottom: 4px;
      }
      #action-bar-tooltip .abt-meta {
        font-size: 9.5px;
        color: rgba(212, 201, 184, 0.4);
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      #action-bar-tooltip .abt-effect {
        font-size: 10px;
        color: rgba(200, 145, 60, 0.75);
        line-height: 1.4;
        margin-bottom: 4px;
      }
      #action-bar-tooltip .abt-costs {
        font-size: 9.5px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      #action-bar-tooltip .abt-costs span {
        color: rgba(212, 201, 184, 0.5);
      }
      #action-bar-tooltip .abt-keybind {
        margin-top: 5px;
        font-size: 9px;
        color: rgba(212, 201, 184, 0.25);
      }
    `;
    document.head.appendChild(style);

    this.tooltip.id = 'action-bar-tooltip';
    document.body.appendChild(this.tooltip);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private _buildDOM(): void {
    this.root.id = 'action-bar';

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = document.createElement('div');
      slot.className = 'ab-slot' + (i === 7 ? ' ab-capstone' : '');

      const keybind = document.createElement('span');
      keybind.className = 'ab-keybind';
      keybind.textContent = String(i + 1);
      slot.appendChild(keybind);

      const name = document.createElement('span');
      name.className = 'ab-name';
      slot.appendChild(name);

      const emptyDot = document.createElement('span');
      emptyDot.className = 'ab-empty-dot';
      emptyDot.textContent = '\u00b7';
      slot.appendChild(emptyDot);

      const cdOverlay = document.createElement('div');
      cdOverlay.className = 'ab-cd-overlay';
      slot.appendChild(cdOverlay);

      const cdText = document.createElement('span');
      cdText.className = 'ab-cd-text';
      slot.appendChild(cdText);

      slot.addEventListener('click', () => this.activateSlot(i));
      slot.addEventListener('mouseenter', (e) => this._showTooltip(e, i));
      slot.addEventListener('mousemove',  (e) => this._positionTooltip(e));
      slot.addEventListener('mouseleave', ()  => this._hideTooltip());
      // Strip any one-shot flash class on completion so the ready-pulse
      // animation can resume without its `animation` property being shadowed.
      slot.addEventListener('animationend', (ev) => {
        const name = (ev as AnimationEvent).animationName;
        if (name.startsWith('ab-flash')) {
          slot.classList.remove('ab-flash', 'ab-flash-hit', 'ab-flash-crit', 'ab-flash-glance', 'ab-flash-miss', 'ab-flash-heal', 'ab-flash-error');
        }
      });

      this.slotEls.push(slot);
      this.root.appendChild(slot);
    }
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _schedulePlayerChange(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._onPlayerChange();
    });
  }

  private _onPlayerChange(): void {
    const key = this.player.activeLoadout.join('|');
    if (key === this._lastLoadoutKey) return;

    // Clear cooldowns for slots whose ability changed
    const oldParts = this._lastLoadoutKey.split('|');
    const loadout  = this.player.activeLoadout;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (oldParts[i] !== (loadout[i] ?? '')) {
        this.cooldowns.delete(i);
      }
    }

    this._lastLoadoutKey = key;
    this._refresh();
  }

  private _refresh(): void {
    const loadout  = this.player.activeLoadout;
    const manifest = this._manifestMap();

    for (let i = 0; i < SLOT_COUNT; i++) {
      const el       = this.slotEls[i]!;
      const nodeId   = loadout[i] ?? null;
      const node     = nodeId ? manifest.get(nodeId) : undefined;
      const isCapstone = i === 7;

      const nameEl = el.querySelector<HTMLElement>('.ab-name')!;
      const dotEl  = el.querySelector<HTMLElement>('.ab-empty-dot')!;

      if (node) {
        const hue = SECTOR_HUE[node.sector] ?? '36';
        el.classList.remove('ab-empty');
        el.style.borderLeftColor = `hsla(${hue}, 55%, 55%, 0.5)`;
        el.style.borderLeftWidth = '3px';

        nameEl.textContent = node.name;
        nameEl.style.color = `hsla(${hue}, 55%, 65%, 0.85)`;
        nameEl.style.display = '';
        dotEl.style.display = 'none';
      } else {
        el.classList.add('ab-empty');
        el.style.borderLeftColor = '';
        el.style.borderLeftWidth = '';
        nameEl.style.display = 'none';
        dotEl.style.display = '';
      }

      // Reset capstone border on the non-left sides when populated
      if (isCapstone && !node) {
        el.style.borderLeftColor = '';
        el.style.borderLeftWidth = '';
      }

      // Clear CD overlay if no cooldown active for this slot
      if (!this.cooldowns.has(i)) {
        const overlay = el.querySelector<HTMLElement>('.ab-cd-overlay')!;
        const cdText  = el.querySelector<HTMLElement>('.ab-cd-text')!;
        overlay.style.transform = 'scaleY(0)';
        cdText.textContent = '';
      }
    }
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  private _showTooltip(e: MouseEvent, slotIndex: number): void {
    const nodeId = this.player.activeLoadout[slotIndex];
    if (!nodeId) return;

    const node = this._manifestMap().get(nodeId);
    if (!node) return;

    const o   = this.tooltip;
    const hue = SECTOR_HUE[node.sector] ?? '36';
    o.innerHTML = '';

    // Name
    const name = document.createElement('div');
    name.className = 'abt-name';
    name.style.color = `hsla(${hue}, 55%, 70%, 0.9)`;
    name.textContent = node.name;
    o.appendChild(name);

    // Meta: sector, target type, range
    const meta = document.createElement('div');
    meta.className = 'abt-meta';
    const parts: string[] = [node.sector];
    if (node.targetType) parts.push(node.targetType);
    if (node.range)      parts.push(`${node.range}m`);
    meta.textContent = parts.join(' \u00b7 ');
    o.appendChild(meta);

    // Effect
    if (node.effectDescription) {
      const eff = document.createElement('div');
      eff.className = 'abt-effect';
      eff.textContent = node.effectDescription;
      o.appendChild(eff);
    }

    // Costs
    const costs = document.createElement('div');
    costs.className = 'abt-costs';
    if (node.staminaCost) this._costSpan(costs, `${node.staminaCost} STA`);
    if (node.manaCost)    this._costSpan(costs, `${node.manaCost} MP`);
    if (node.cooldown)    this._costSpan(costs, `${node.cooldown}s CD`);
    if (node.castTime)    this._costSpan(costs, `${node.castTime}s Cast`);
    if (costs.childElementCount > 0) o.appendChild(costs);

    // Keybind
    const kb = document.createElement('div');
    kb.className = 'abt-keybind';
    kb.textContent = `Keybind: ${slotIndex + 1}`;
    o.appendChild(kb);

    o.style.display = 'block';
    this._positionTooltip(e);
  }

  private _costSpan(parent: HTMLElement, text: string): void {
    const s = document.createElement('span');
    s.textContent = text;
    parent.appendChild(s);
  }

  private _positionTooltip(e: MouseEvent): void {
    const o    = this.tooltip;
    const marg = 12;
    const vw   = window.innerWidth;
    const w    = o.offsetWidth  || 240;
    const h    = o.offsetHeight || 120;
    // Default: above cursor (bar is at screen bottom)
    let x = e.clientX + marg;
    let y = e.clientY - h - marg;
    if (x + w > vw) x = e.clientX - w - marg;
    if (y < 0)      y = e.clientY + marg;
    o.style.left = `${x}px`;
    o.style.top  = `${y}px`;
  }

  private _hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _manifestMap(): Map<string, AbilityNodeSummary> {
    const m = new Map<string, AbilityNodeSummary>();
    for (const node of this.player.abilityManifest) m.set(node.id, node);
    return m;
  }
}
