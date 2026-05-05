// ---------------------------------------------------------------------------
// CommandHelpPanel — slash-command reference modal
//
// Opened by /help (or /commands or /?). Server pushes a role-filtered list
// of commands; this panel renders them grouped by category. Players never
// see admin-tier commands because the server filters them out before send.
// ---------------------------------------------------------------------------

import type { CommandHelpListPayload, CommandHelpEntry } from '@/network/Protocol';

const CATEGORY_ORDER: CommandHelpEntry['category'][] = [
  'general', 'movement', 'combat', 'party', 'companion', 'social', 'travel', 'admin', 'debug',
];

const CATEGORY_LABELS: Record<CommandHelpEntry['category'], string> = {
  general:   'General',
  movement:  'Movement',
  combat:    'Combat',
  party:     'Party',
  companion: 'Companion',
  social:    'Social',
  travel:    'Travel',
  admin:     'Admin',
  debug:     'Debug',
};

export class CommandHelpPanel {
  private root:    HTMLElement;
  private visible = false;
  private filterText = '';

  constructor(private readonly uiRoot: HTMLElement) {
    this.root = this._build();
    uiRoot.appendChild(this.root);
  }

  show(payload: CommandHelpListPayload): void {
    this._renderList(payload);
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('chp-visible'));
    this.visible = true;
    // Focus the search input so the player can immediately start typing.
    requestAnimationFrame(() => {
      this.root.querySelector<HTMLInputElement>('#chp-search')?.focus();
    });
  }

  hide(): void {
    this.root.classList.remove('chp-visible');
    this.root.style.display = 'none';
    this.visible = false;
    this.filterText = '';
  }

  toggle(payload?: CommandHelpListPayload): void {
    if (this.visible) this.hide();
    else if (payload) this.show(payload);
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'command-help';
    el.innerHTML = `
      <style>
        #command-help {
          position: fixed; inset: 0;
          display: none;
          align-items: center; justify-content: center;
          z-index: 250; pointer-events: none;
        }
        #command-help.chp-visible { pointer-events: auto; }

        #chp-backdrop {
          position: absolute; inset: 0;
          background: rgba(8,6,4,0.65);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #command-help.chp-visible #chp-backdrop { opacity: 1; }

        #chp-panel {
          position: relative;
          width: min(640px, 94vw);
          max-height: 84vh;
          display: flex;
          flex-direction: column;
          background: rgba(20,15,10,0.98);
          border: 1px solid rgba(200,98,42,0.35);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8),
                      inset 0 0 60px rgba(30,15,5,0.5);
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #command-help.chp-visible #chp-panel {
          transform: translateY(0);
          opacity: 1;
        }

        #chp-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 18px 10px;
          border-bottom: 1px solid rgba(200,98,42,0.25);
        }
        #chp-title {
          font-family: var(--font-display, serif);
          font-size: 15px;
          color: rgba(200,145,60,0.95);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        #chp-close {
          background: none; border: none;
          color: rgba(200,145,60,0.55);
          font-family: var(--font-mono, monospace);
          font-size: 14px; cursor: pointer; padding: 0 2px;
          transition: color 0.12s;
        }
        #chp-close:hover { color: rgba(230,180,80,0.95); }

        #chp-search-row { padding: 10px 18px 8px; }
        #chp-search {
          width: 100%;
          background: rgba(14,10,6,0.85);
          border: 1px solid rgba(200,98,42,0.25);
          color: rgba(212,201,184,0.95);
          font-family: var(--font-body, serif);
          font-size: 13px;
          padding: 7px 10px;
          outline: none;
          box-sizing: border-box;
        }
        #chp-search:focus { border-color: rgba(200,98,42,0.55); }
        #chp-search::placeholder { color: rgba(150,120,80,0.55); font-style: italic; }

        #chp-body {
          flex: 1; min-height: 0;
          overflow-y: auto;
          padding: 4px 18px 14px;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.3) transparent;
        }

        .chp-category {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(200,145,60,0.75);
          letter-spacing: 0.16em;
          text-transform: uppercase;
          margin: 14px 0 6px;
          padding-bottom: 4px;
          border-bottom: 1px solid rgba(200,98,42,0.15);
        }
        .chp-category:first-child { margin-top: 4px; }

        .chp-cmd {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 4px 12px;
          padding: 7px 0;
          border-bottom: 1px dashed rgba(200,98,42,0.10);
          align-items: baseline;
        }
        .chp-cmd:last-child { border-bottom: none; }
        .chp-cmd-name {
          font-family: var(--font-mono, monospace);
          font-size: 12.5px;
          color: rgba(230,180,80,0.95);
          letter-spacing: 0.04em;
        }
        .chp-cmd-aliases {
          font-family: var(--font-mono, monospace);
          font-size: 10.5px;
          color: rgba(160,140,100,0.55);
          margin-left: 6px;
        }
        .chp-cmd-syntax {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(180,160,130,0.65);
          grid-column: 1;
          margin-top: 2px;
        }
        .chp-cmd-desc {
          font-size: 12px;
          color: rgba(200,180,150,0.85);
          line-height: 1.4;
          grid-column: 1 / -1;
          margin-top: 2px;
        }
        .chp-badges {
          display: flex; gap: 4px;
          grid-row: 1; grid-column: 2;
          align-items: center;
        }
        .chp-badge {
          font-family: var(--font-mono, monospace);
          font-size: 9.5px;
          padding: 2px 7px;
          border: 1px solid rgba(200,98,42,0.25);
          color: rgba(180,160,130,0.85);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          border-radius: 2px;
          background: rgba(8,6,4,0.4);
        }
        .chp-badge.chp-role-admin {
          color: rgba(220,130,40,0.95);
          border-color: rgba(220,130,40,0.45);
        }
        .chp-badge.chp-clientside {
          color: rgba(120,180,180,0.85);
          border-color: rgba(120,180,180,0.30);
        }

        .chp-empty {
          color: rgba(160,140,100,0.55);
          font-style: italic;
          font-size: 12px;
          text-align: center;
          padding: 32px 0;
        }

        #chp-footer-hint {
          padding: 8px 18px 12px;
          font-size: 11px;
          color: rgba(150,130,90,0.60);
          font-style: italic;
          border-top: 1px solid rgba(200,98,42,0.15);
        }
      </style>

      <div id="chp-backdrop"></div>
      <div id="chp-panel">
        <div id="chp-header">
          <div id="chp-title">Slash Commands</div>
          <button id="chp-close" title="Close">✕</button>
        </div>
        <div id="chp-search-row">
          <input id="chp-search" type="text" placeholder="filter — name or description…" />
        </div>
        <div id="chp-body"></div>
        <div id="chp-footer-hint">Esc to close. /help to reopen.</div>
      </div>
    `;

    el.querySelector('#chp-backdrop')?.addEventListener('click', () => this.hide());
    el.querySelector('#chp-close')?.addEventListener('click', () => this.hide());
    el.querySelector<HTMLInputElement>('#chp-search')?.addEventListener('input', (e) => {
      this.filterText = (e.target as HTMLInputElement).value.toLowerCase();
      this._applyFilter();
    });

    // Esc-to-close
    document.addEventListener('keydown', (e) => {
      if (this.visible && e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
    });

    return el;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private _renderList(payload: CommandHelpListPayload): void {
    const body = this.root.querySelector<HTMLElement>('#chp-body');
    if (!body) return;
    body.innerHTML = '';

    // Group by category, then iterate in our preferred order so admin/debug
    // sit at the bottom and player-relevant content floats up.
    const grouped = new Map<CommandHelpEntry['category'], CommandHelpEntry[]>();
    for (const c of payload.commands) {
      const arr = grouped.get(c.category);
      if (arr) arr.push(c);
      else grouped.set(c.category, [c]);
    }

    for (const cat of CATEGORY_ORDER) {
      const cmds = grouped.get(cat);
      if (!cmds || cmds.length === 0) continue;
      const header = document.createElement('div');
      header.className = 'chp-category';
      header.textContent = CATEGORY_LABELS[cat];
      body.appendChild(header);
      for (const cmd of cmds) {
        body.appendChild(this._renderCmd(cmd));
      }
    }

    if (body.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chp-empty';
      empty.textContent = 'No commands available.';
      body.appendChild(empty);
    }
  }

  private _renderCmd(cmd: CommandHelpEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chp-cmd';
    el.setAttribute('data-search-key', `${cmd.name} ${cmd.aliases.join(' ')} ${cmd.description}`.toLowerCase());

    const aliases = cmd.aliases.length > 0
      ? `<span class="chp-cmd-aliases">${cmd.aliases.map((a) => this._esc(a)).join(' · ')}</span>`
      : '';

    const badges: string[] = [];
    if (cmd.role === 'admin') badges.push('<span class="chp-badge chp-role-admin">admin</span>');
    if (cmd.clientSide)       badges.push('<span class="chp-badge chp-clientside">client</span>');

    el.innerHTML = `
      <div class="chp-cmd-name">${this._esc(cmd.name)}${aliases}</div>
      <div class="chp-badges">${badges.join('')}</div>
      <div class="chp-cmd-syntax">${this._esc(cmd.syntax)}</div>
      <div class="chp-cmd-desc">${this._esc(cmd.description)}</div>
    `;
    return el;
  }

  private _applyFilter(): void {
    const f = this.filterText.trim();
    const body = this.root.querySelector<HTMLElement>('#chp-body');
    if (!body) return;
    if (!f) {
      // Show everything, including category headers.
      body.querySelectorAll<HTMLElement>('.chp-cmd').forEach((el) => { el.style.display = ''; });
      body.querySelectorAll<HTMLElement>('.chp-category').forEach((el) => { el.style.display = ''; });
      return;
    }
    // Hide non-matching commands; hide category headers whose section is empty.
    const cmds = Array.from(body.querySelectorAll<HTMLElement>('.chp-cmd'));
    for (const cmd of cmds) {
      const key = cmd.getAttribute('data-search-key') ?? '';
      cmd.style.display = key.includes(f) ? '' : 'none';
    }
    // Walk siblings: a category header is visible iff any sibling .chp-cmd
    // before the next category header is visible.
    const cats = Array.from(body.querySelectorAll<HTMLElement>('.chp-category'));
    for (const cat of cats) {
      let any = false;
      let n = cat.nextElementSibling;
      while (n && !n.classList.contains('chp-category')) {
        if (n.classList.contains('chp-cmd') && (n as HTMLElement).style.display !== 'none') {
          any = true; break;
        }
        n = n.nextElementSibling;
      }
      cat.style.display = any ? '' : 'none';
    }
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
