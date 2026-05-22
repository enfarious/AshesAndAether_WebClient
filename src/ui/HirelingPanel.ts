import type { SocketClient } from '@/network/SocketClient';

/**
 * HirelingPanel — modal mission-console UI for the vault entry obelisk.
 *
 * Opened by the server (via `open_hireling_panel`) when the player presses F
 * on the entry-room obelisk. Lets the player hire one of 8 archetype NPCs
 * and dismiss existing hires. Buttons send `/hire <archetype>` and
 * `/dismiss <name>` slash commands — same path as the in-chat versions, so
 * future text-client compatibility is preserved (per slash-commands-first).
 *
 * The panel auto-closes when the squad steps outside the staging zone
 * (`vault_staging_broken`) — no last-minute swaps after committing.
 */

interface ArchetypeOption {
  archetype: HirelingArchetype;
  available: boolean;
  cost:      number;
}

interface CurrentHire {
  id:               string;
  name:             string;
  archetype:        HirelingArchetype;
  level:            number;
  ownerCharacterId: string;
}

export interface HirelingPanelPayload {
  stagingActive:   boolean;
  /** True only for dungeon-entry staging — surfaces the "Begin Descent"
   *  button. False for vault staging and inside the dungeon proper. */
  canDescend:      boolean;
  humans:          number;
  companions:      number;
  hirelingsActive: number;
  partyCap:        number;
  slotsRemaining:  number;
  archetypes:      ArchetypeOption[];
  currentHires:    CurrentHire[];
}

type HirelingArchetype =
  | 'tank'
  | 'melee_phys_dd'
  | 'ranged_phys_dd'
  | 'melee_magic_dd'
  | 'ranged_magic_dd'
  | 'healer'
  | 'support'
  | 'control';

// Human-readable archetype labels + single-symbol role tags, matching the
// party-panel convention. Stub roles (everything but tank/healer/r-magic)
// route to nearest live archetype on the server; the panel surfaces this
// with a "(routes to nearest)" badge so players aren't surprised.
const ARCHETYPE_INFO: Record<HirelingArchetype, { label: string; role: string; live: boolean; blurb: string }> = {
  tank:            { label: 'Tank',            role: 'T',  live: true,  blurb: 'Holds the line. Taunts, soaks hits.' },
  healer:          { label: 'Healer',          role: 'H',  live: true,  blurb: 'Keeps the squad standing.' },
  ranged_magic_dd: { label: 'Caster',          role: 'R♦', live: true,  blurb: 'Ranged elemental damage.' },
  melee_phys_dd:   { label: 'Melee',           role: 'M',  live: false, blurb: 'In-close physical damage.' },
  ranged_phys_dd:  { label: 'Ranged',          role: 'R',  live: false, blurb: 'Bow / firearm physical damage.' },
  melee_magic_dd:  { label: 'Battle Mage',     role: 'M♦', live: false, blurb: 'Rune-blade hybrid melee.' },
  support:         { label: 'Support',         role: 'Su', live: false, blurb: 'Buffs, utility, sustain.' },
  control:         { label: 'Control',         role: 'C',  live: false, blurb: 'CC, slows, lockdown.' },
};

const ARCHETYPE_ORDER: HirelingArchetype[] = [
  'tank', 'healer', 'ranged_magic_dd',
  'melee_phys_dd', 'ranged_phys_dd', 'melee_magic_dd',
  'support', 'control',
];

export class HirelingPanel {
  private root:    HTMLElement;
  private bodyEl:  HTMLElement;
  private titleEl: HTMLElement;
  private subEl:   HTMLElement;
  private descendBtn!: HTMLButtonElement;
  private cleanup: (() => void)[] = [];
  private _open = false;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root    = document.createElement('div');
    this.bodyEl  = document.createElement('div');
    this.titleEl = document.createElement('h2');
    this.subEl   = document.createElement('div');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    // Server pushes panel state on F-press, on hire success, and on dismiss
    // success — calling show() with the payload either opens fresh or
    // refreshes an already-open panel.
    this.socket.on('open_hireling_panel', (payload: unknown) => {
      this.show(payload as HirelingPanelPayload);
    });

    // Squad has stepped out — commit point hit, no more roster changes.
    this.socket.on('vault_staging_broken', () => this.hide());
    // Leaving the vault zone for any reason closes the panel.
    this.socket.on('vault_complete',      () => this.hide());
    this.socket.on('vault_failed',        () => this.hide());
    this.socket.on('vault_player_left',   () => this.hide());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._open) {
        e.preventDefault();
        this.hide();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  show(payload: HirelingPanelPayload): void {
    this._open = true;
    this._render(payload);
    this.root.style.display = 'flex';
  }

  hide(): void {
    this._open = false;
    this.root.style.display = 'none';
  }

  close(): void { this.hide(); }

  get isVisible(): boolean { return this._open; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build (one-time) ──────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'hireling-panel';
    const style = document.createElement('style');
    style.textContent = `
      #hireling-panel {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 850;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      #hp-box {
        background: var(--ui-bg, #1a140d);
        border: 1px solid var(--ui-border, #5a4226);
        width: clamp(420px, 56vw, 720px);
        max-height: 84vh;
        padding: 22px 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        box-shadow: 0 0 24px rgba(0,0,0,0.6);
      }
      #hp-box h2 {
        margin: 0;
        font-family: var(--font-display, serif);
        font-size: 22px;
        color: var(--ember, #ffb060);
        letter-spacing: 0.04em;
      }
      #hp-box .hp-sub {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(220,205,180,0.7);
        letter-spacing: 0.04em;
      }
      .hp-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .hp-card {
        background: rgba(20, 14, 8, 0.65);
        border: 1px solid rgba(120, 90, 55, 0.4);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: var(--font-sans, sans-serif);
        color: rgba(230,215,190,0.92);
        font-size: 13px;
      }
      .hp-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hp-card-role {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 22px;
        background: rgba(255,170,80,0.18);
        border: 1px solid rgba(255,170,80,0.55);
        color: rgba(255,220,180,0.95);
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.02em;
      }
      .hp-card-name {
        flex: 1;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: rgba(255,225,195,0.96);
      }
      .hp-card-stub {
        font-size: 10px;
        letter-spacing: 0.06em;
        color: rgba(220,170,100,0.7);
      }
      .hp-card-blurb {
        font-size: 12px;
        color: rgba(200,185,160,0.78);
      }
      .hp-card button {
        align-self: flex-end;
        background: rgba(120, 80, 38, 0.6);
        color: rgba(255,235,210,0.95);
        border: 1px solid rgba(200,150,80,0.55);
        padding: 4px 12px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .hp-card button:hover:not(:disabled) {
        background: rgba(160, 105, 50, 0.7);
      }
      .hp-card button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .hp-roster {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .hp-roster-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: rgba(30, 22, 14, 0.6);
        border: 1px solid rgba(120, 90, 55, 0.25);
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: rgba(225,210,185,0.92);
      }
      .hp-roster-name {
        flex: 1;
      }
      .hp-roster-row button {
        background: rgba(120, 60, 50, 0.5);
        color: rgba(255,225,205,0.95);
        border: 1px solid rgba(200,100,80,0.55);
        padding: 3px 10px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        letter-spacing: 0.06em;
      }
      .hp-roster-row button:hover { background: rgba(155, 78, 65, 0.65); }
      .hp-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(120, 90, 55, 0.25);
      }
      .hp-footer button {
        background: transparent;
        border: 1px solid rgba(180,140,90,0.4);
        color: rgba(220,205,180,0.85);
        padding: 5px 14px;
        cursor: pointer;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hp-footer button:hover { background: rgba(100, 75, 50, 0.4); }
      .hp-footer .hp-descend {
        background: rgba(255,140,50,0.85);
        border-color: rgba(255,190,120,0.9);
        color: #1a140d;
        font-weight: 700;
      }
      .hp-footer .hp-descend:hover { background: rgba(255,165,80,0.95); }
      .hp-empty {
        font-size: 12px;
        color: rgba(180,165,140,0.55);
        font-style: italic;
        padding: 6px 0;
      }
    `;
    this.root.appendChild(style);

    const box = document.createElement('div');
    box.id = 'hp-box';
    this.titleEl.textContent = 'Mission Console';
    box.appendChild(this.titleEl);
    box.appendChild(this.subEl);
    this.subEl.className = 'hp-sub';
    box.appendChild(this.bodyEl);

    // Footer: Begin Descent (dungeon staging only) + Close (Esc also works).
    const footer = document.createElement('div');
    footer.className = 'hp-footer';

    // Begin Descent — shown only for dungeon-entry staging (canDescend).
    // Fires /dungeon descend; the server gates it to the party leader and
    // tells non-leaders why. Closes the panel — descent teleports the party.
    this.descendBtn = document.createElement('button');
    this.descendBtn.className = 'hp-descend';
    this.descendBtn.textContent = 'Begin Descent';
    this.descendBtn.addEventListener('click', () => {
      this.socket.sendCommand('/dungeon descend');
      this.hide();
    });
    footer.appendChild(this.descendBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    footer.appendChild(closeBtn);
    box.appendChild(footer);

    this.root.appendChild(box);
  }

  // ── Render (per show / refresh) ───────────────────────────────────────────

  private _render(p: HirelingPanelPayload): void {
    const used = p.partyCap - p.slotsRemaining;
    this.subEl.textContent =
      `${used}/${p.partyCap} squad slots used — ${p.slotsRemaining} remaining   ` +
      `(humans ${p.humans} · companions ${p.companions} · hirelings ${p.hirelingsActive})` +
      (p.stagingActive ? '' : '   ⚠ staging committed — roster locked');

    // Begin Descent button — dungeon-entry staging only.
    this.descendBtn.style.display = p.canDescend ? '' : 'none';

    this.bodyEl.innerHTML = '';

    // Archetype cards (ordered: live trinity first, then stubs)
    const grid = document.createElement('div');
    grid.className = 'hp-grid';
    const canHire = p.stagingActive && p.slotsRemaining > 0;
    for (const arche of ARCHETYPE_ORDER) {
      const info = ARCHETYPE_INFO[arche];
      const card = document.createElement('div');
      card.className = 'hp-card';

      const head = document.createElement('div');
      head.className = 'hp-card-head';
      const role = document.createElement('span');
      role.className = 'hp-card-role';
      role.textContent = info.role;
      const name = document.createElement('span');
      name.className = 'hp-card-name';
      name.textContent = info.label;
      head.appendChild(role);
      head.appendChild(name);
      if (!info.live) {
        const stub = document.createElement('span');
        stub.className = 'hp-card-stub';
        stub.textContent = '(routes to nearest)';
        head.appendChild(stub);
      }
      card.appendChild(head);

      const blurb = document.createElement('div');
      blurb.className = 'hp-card-blurb';
      blurb.textContent = info.blurb;
      card.appendChild(blurb);

      const btn = document.createElement('button');
      btn.textContent = 'Hire';
      btn.disabled   = !canHire;
      btn.addEventListener('click', () => {
        this.socket.sendCommand(`/hire ${arche}`);
      });
      card.appendChild(btn);

      grid.appendChild(card);
    }
    this.bodyEl.appendChild(grid);

    // Current hires section
    const roster = document.createElement('div');
    roster.className = 'hp-roster';
    if (p.currentHires.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hp-empty';
      empty.textContent = 'No hirelings under contract.';
      roster.appendChild(empty);
    } else {
      for (const hire of p.currentHires) {
        const info = ARCHETYPE_INFO[hire.archetype];
        const row  = document.createElement('div');
        row.className = 'hp-roster-row';
        const role = document.createElement('span');
        role.className = 'hp-card-role';
        role.textContent = info?.role ?? '?';
        const lbl  = document.createElement('span');
        lbl.className = 'hp-roster-name';
        lbl.textContent = `${hire.name}  (lv ${hire.level} ${info?.label ?? hire.archetype})`;
        const btn  = document.createElement('button');
        btn.textContent = 'Dismiss';
        btn.disabled   = !p.stagingActive;
        btn.addEventListener('click', () => {
          this.socket.sendCommand(`/dismiss ${hire.name}`);
        });
        row.appendChild(role);
        row.appendChild(lbl);
        row.appendChild(btn);
        roster.appendChild(row);
      }
    }
    this.bodyEl.appendChild(roster);
  }
}
