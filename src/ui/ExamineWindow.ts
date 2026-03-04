import type { ExaminePeekPayload } from '@/network/Protocol';

/**
 * ExamineWindow — displays rich examine/peek results for an entity.
 *
 * Slides in from the left side when the player examines a target.
 * Shows entity details (name, type, level, health, description, etc.)
 * and auto-dismisses after a timeout.  Escape or clicking the close
 * button hides it immediately.
 */
export class ExamineWindow {
  private root: HTMLElement;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private onKeyHandler: (ev: KeyboardEvent) => void;

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    this.onKeyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !this.root.classList.contains('ew-hidden')) {
        ev.preventDefault();
        this.close();
      }
    };
    window.addEventListener('keydown', this.onKeyHandler);
  }

  show(data: ExaminePeekPayload): void {
    this._clearTimer();
    this._populate(data);
    this.root.classList.remove('ew-hidden');

    // Auto-dismiss after 12 seconds
    this.dismissTimer = setTimeout(() => this.close(), 12_000);
  }

  close(): void {
    this._clearTimer();
    this.root.classList.add('ew-hidden');
  }

  dispose(): void {
    this._clearTimer();
    window.removeEventListener('keydown', this.onKeyHandler);
    this.root.remove();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _clearTimer(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private _populate(d: ExaminePeekPayload): void {
    // Name
    this.root.querySelector<HTMLElement>('#ew-name')!.textContent = d.name;

    // Type badge
    const badge = this.root.querySelector<HTMLElement>('#ew-type')!;
    badge.textContent = this._typeLabel(d.entityType);
    badge.className   = `ew-type ew-type-${d.entityType}`;

    // Level
    const levelEl = this.root.querySelector<HTMLElement>('#ew-level')!;
    if (d.level != null) {
      levelEl.textContent = d.notorious ? 'Lv ??' : `Lv ${d.level}`;
      levelEl.style.display = '';
    } else {
      levelEl.style.display = 'none';
    }

    // Distance
    this.root.querySelector<HTMLElement>('#ew-range')!.textContent = `${d.range.toFixed(1)}m`;

    // Status tags
    const statusEl = this.root.querySelector<HTMLElement>('#ew-status')!;
    statusEl.innerHTML = '';
    if (!d.isAlive)  this._addTag(statusEl, 'Dead', 'dead');
    if (d.inCombat)  this._addTag(statusEl, 'In Combat', 'combat');
    if (d.notorious) this._addTag(statusEl, 'Notorious', 'notorious');
    if (d.growthStage) {
      const label = d.growthStage.charAt(0).toUpperCase() + d.growthStage.slice(1);
      this._addTag(statusEl, label, 'growth');
    }

    // Health bar
    const hpRow = this.root.querySelector<HTMLElement>('#ew-hp-row')!;
    if (d.healthPct != null) {
      const pct = Math.max(0, Math.min(100, d.healthPct));
      this.root.querySelector<HTMLElement>('#ew-hp-fill')!.style.transform = `scaleX(${pct / 100})`;
      this.root.querySelector<HTMLElement>('#ew-hp-pct')!.textContent = `${pct}%`;
      hpRow.style.display = '';
    } else {
      hpRow.style.display = 'none';
    }

    // Faction
    const factionEl = this.root.querySelector<HTMLElement>('#ew-faction')!;
    if (d.faction) {
      factionEl.textContent = d.faction.charAt(0).toUpperCase() + d.faction.slice(1);
      factionEl.style.display = '';
    } else {
      factionEl.style.display = 'none';
    }

    // Description
    const descEl = this.root.querySelector<HTMLElement>('#ew-desc')!;
    if (d.description) {
      descEl.textContent = d.description;
      descEl.style.display = '';
    } else {
      descEl.style.display = 'none';
    }
  }

  private _typeLabel(type: string): string {
    switch (type) {
      case 'player':    return 'Player';
      case 'npc':       return 'NPC';
      case 'companion': return 'Companion';
      case 'mob':       return 'Monster';
      case 'wildlife':  return 'Wildlife';
      case 'structure': return 'Structure';
      case 'plant':     return 'Flora';
      default:          return type;
    }
  }

  private _addTag(parent: HTMLElement, text: string, cls: string): void {
    const span = document.createElement('span');
    span.className = `ew-tag ew-tag-${cls}`;
    span.textContent = text;
    parent.appendChild(span);
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'examine-window';
    el.classList.add('ew-hidden');
    el.innerHTML = `
      <style>
        #examine-window {
          position: fixed;
          bottom: 80px;
          right: 18px;
          width: 260px;
          pointer-events: auto;
          user-select: none;
          z-index: 60;
          transition: transform 0.2s ease, opacity 0.2s ease;
        }

        #examine-window.ew-hidden {
          transform: translateX(calc(100% + 24px));
          opacity: 0;
          pointer-events: none;
        }

        .ew-panel {
          background: rgba(8, 6, 4, 0.88);
          border: 1px solid rgba(200, 145, 60, 0.35);
          box-shadow:
            0 3px 14px rgba(0,0,0,0.65),
            inset 0 1px 0 rgba(255,200,100,0.04);
          padding: 0;
        }

        /* ── Header ── */

        .ew-header {
          padding: 8px 10px 6px;
          border-bottom: 1px solid rgba(200, 145, 60, 0.18);
          display: flex;
          align-items: baseline;
          gap: 6px;
          flex-wrap: wrap;
        }

        .ew-name {
          font-family: var(--font-body);
          font-size: 16px;
          color: var(--ember, #c8823a);
          letter-spacing: 0.06em;
          font-style: italic;
          text-shadow: 0 1px 5px rgba(0,0,0,0.9);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }

        .ew-type {
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 1px 5px;
          border-radius: 2px;
          flex-shrink: 0;
          line-height: 1.4;
        }

        .ew-type-player    { color: #8ec6e8; border: 1px solid rgba(142,198,232,0.35); }
        .ew-type-npc       { color: #a8d4a0; border: 1px solid rgba(168,212,160,0.35); }
        .ew-type-companion { color: #d4c8a0; border: 1px solid rgba(212,200,160,0.35); }
        .ew-type-mob       { color: #e89090; border: 1px solid rgba(232,144,144,0.35); }
        .ew-type-wildlife  { color: #b8d0a0; border: 1px solid rgba(184,208,160,0.35); }
        .ew-type-structure { color: #c0b898; border: 1px solid rgba(192,184,152,0.35); }
        .ew-type-plant     { color: #55cc33; border: 1px solid rgba(85,204,51,0.35); }

        .ew-close {
          flex-shrink: 0;
          cursor: pointer;
          font-size: 14px;
          color: rgba(212, 190, 160, 0.4);
          line-height: 1;
          padding: 0 2px;
          transition: color 0.1s;
        }
        .ew-close:hover { color: rgba(212, 190, 160, 0.8); }

        /* ── Body ── */

        .ew-body {
          padding: 7px 10px 9px;
        }

        .ew-info-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 5px;
        }

        .ew-level, .ew-range, .ew-faction {
          font-family: var(--font-mono);
          font-size: 11px;
          color: rgba(212, 190, 160, 0.65);
          text-shadow: 0 1px 2px #000;
        }

        .ew-faction {
          color: rgba(200, 160, 100, 0.6);
          font-style: italic;
        }

        /* ── Status tags ── */

        .ew-status {
          display: flex;
          gap: 5px;
          flex-wrap: wrap;
          margin-bottom: 5px;
        }

        .ew-tag {
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 1px 5px;
          border-radius: 2px;
        }

        .ew-tag-dead     { color: #999; border: 1px solid rgba(150,150,150,0.3); }
        .ew-tag-combat   { color: #e8a060; border: 1px solid rgba(232,160,96,0.35); }
        .ew-tag-notorious { color: #e8d060; border: 1px solid rgba(232,208,96,0.35); }
        .ew-tag-growth    { color: #78be46; border: 1px solid rgba(120,190,70,0.35); }

        /* ── HP bar ── */

        .ew-hp-row {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-bottom: 6px;
        }

        .ew-hp-label {
          font-family: var(--font-mono);
          font-size: 9px;
          color: rgba(212,190,160,0.5);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          flex-shrink: 0;
          width: 18px;
        }

        .ew-hp-track {
          flex: 1;
          height: 5px;
          background: rgba(10,8,6,0.8);
          border: 1px solid rgba(180,60,40,0.25);
          position: relative;
          overflow: hidden;
        }

        .ew-hp-fill {
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, #5a0f0f, #8b2020);
          transform-origin: left;
          transition: transform 0.3s ease;
        }

        .ew-hp-pct {
          font-family: var(--font-mono);
          font-size: 10px;
          color: rgba(212,190,160,0.7);
          min-width: 28px;
          text-align: right;
          text-shadow: 0 1px 2px #000;
          flex-shrink: 0;
        }

        /* ── Description ── */

        .ew-desc {
          font-family: var(--font-body);
          font-size: 12px;
          color: rgba(212, 201, 184, 0.7);
          line-height: 1.45;
          font-style: italic;
          margin-top: 4px;
        }
      </style>

      <div class="ew-panel">
        <div class="ew-header">
          <div class="ew-name" id="ew-name"></div>
          <span class="ew-type" id="ew-type"></span>
          <span class="ew-close" id="ew-close">&times;</span>
        </div>
        <div class="ew-body">
          <div class="ew-info-row">
            <span class="ew-level" id="ew-level"></span>
            <span class="ew-range" id="ew-range"></span>
            <span class="ew-faction" id="ew-faction"></span>
          </div>
          <div class="ew-status" id="ew-status"></div>
          <div class="ew-hp-row" id="ew-hp-row">
            <span class="ew-hp-label">HP</span>
            <div class="ew-hp-track">
              <div class="ew-hp-fill" id="ew-hp-fill"></div>
            </div>
            <span class="ew-hp-pct" id="ew-hp-pct"></span>
          </div>
          <div class="ew-desc" id="ew-desc"></div>
        </div>
      </div>
    `;

    el.querySelector('#ew-close')!.addEventListener('click', () => this.close());

    return el;
  }
}
