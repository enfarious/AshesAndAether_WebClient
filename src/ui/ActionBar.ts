/**
 * ActionBar — 8-slot hotbar for active abilities.
 *
 * Positioned bottom-center, directly above the HUD vitals.
 * Keys 1-8 (or click) fire the slotted ability via sendCombatAction.
 * Client-side cooldown overlay ticks down each frame via tick(dt).
 */

import type { PlayerState }       from '@/state/PlayerState';
import type { SocketClient }      from '@/network/SocketClient';
import type { AbilityNodeSummary } from '@/network/Protocol';

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

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
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

  // ── Frame tick (cooldowns) ─────────────────────────────────────────────────

  tick(dt: number): void {
    if (this.cooldowns.size === 0) return;

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

  // ── Activation (key press or click) ────────────────────────────────────────

  activateSlot(index: number): void {
    if (!this.player.isAlive) return;

    const nodeId = this.player.activeLoadout[index];
    if (!nodeId) return;
    if (this.cooldowns.has(index)) return;

    const node = this._manifestMap().get(nodeId);
    if (!node) return;

    const targetId = this.player.targetId ?? '';
    this.socket.sendCombatAction(nodeId, targetId);

    // Client-side cooldown (server enforces the real one)
    if (node.cooldown && node.cooldown > 0) {
      this.cooldowns.set(index, { remaining: node.cooldown, total: node.cooldown });
    }

    // Flash feedback
    const el = this.slotEls[index]!;
    el.classList.remove('ab-flash');
    void el.offsetWidth;          // force reflow to restart animation
    el.classList.add('ab-flash');
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

      /* Flash on activation */
      @keyframes ab-flash {
        0%   { background: rgba(200, 145, 60, 0.4); }
        100% { background: transparent; }
      }
      #action-bar .ab-slot.ab-flash {
        animation: ab-flash 0.2s ease-out;
      }

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
