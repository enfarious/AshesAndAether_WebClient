import type { SocketClient } from '@/network/SocketClient';
import type { SessionState } from '@/state/SessionState';
import type { CharacterInfo } from '@/network/Protocol';
import { PreWorldTerminal } from '@/ui/PreWorldTerminal';

/**
 * CharacterSelect — lists characters, handles create + name-confirm flow.
 */
export class CharacterSelect {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly socket:  SocketClient,
    private readonly session: SessionState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);
    this._renderList(session.characters);

    const unsub1 = session.on('characterList', () => {
      this._renderList(session.characters);
      // Mirror into the terminal. The roster can arrive after this screen
      // mounts, and it changes after a create — without this the text view
      // would show a stale list (or none) while the visual one updated.
      if (this._term) this._writeCharacterList(this._term);
    });

    const unsub2 = session.on('characterConfirmName', (p) => {
      const payload = p as { name: string; message: string };
      this._showConfirmModal(payload.name, payload.message);
    });

    const unsub3 = session.on('characterError', (p) => {
      const payload = p as { message: string };
      this._setStatus(payload.message ?? 'Character error.', true);
    });

    this.cleanup.push(unsub1, unsub2, unsub3);
  }

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'char-select';
    el.innerHTML = `
      <style>
        #char-select {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          background: radial-gradient(ellipse at center, rgba(30,20,12,0.7) 0%, rgba(14,12,10,0.95) 70%);
          z-index: 20;
        }

        .cs-box {
          width: min(480px, 92vw);
          background: var(--ui-bg);
          border: 1px solid var(--ui-border);
          padding: 2.5rem 2rem;
          display: flex;
          flex-direction: column;
          gap: 1.2rem;
        }

        .cs-title {
          font-family: var(--font-display);
          font-size: 1.3rem;
          letter-spacing: 0.2em;
          color: var(--bone);
          text-align: center;
        }

        .cs-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 320px;
          overflow-y: auto;
        }

        .cs-char {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          background: rgba(30,24,18,0.6);
          border: 1px solid rgba(200,98,42,0.15);
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
          /* Button resets — these rows are <button> so they're keyboard
             reachable, which means undoing the UA's default look. */
          width: 100%;
          text-align: left;
          font: inherit;
          color: inherit;
          border-radius: 0;
        }

        .cs-char:hover {
          border-color: var(--ember);
          background: rgba(200,98,42,0.08);
        }

        /* Keyboard focus must be unmistakable: this list is the last step
           before entering the world and hover alone never fires for it. */
        .cs-char:focus-visible {
          outline: 2px solid var(--ember);
          outline-offset: 2px;
          border-color: var(--ember);
        }

        .cs-char-name {
          font-family: var(--font-display);
          font-size: 1rem;
          letter-spacing: 0.08em;
          color: var(--bone);
        }

        .cs-char-meta {
          font-size: 0.75rem;
          color: var(--muted);
          font-style: italic;
        }

        .cs-empty {
          text-align: center;
          color: var(--muted);
          font-style: italic;
          font-size: 0.85rem;
          padding: 1.5rem 0;
        }

        .cs-create-row {
          display: flex;
          gap: 8px;
        }

        .cs-create-fields {
          display: flex;
          flex-direction: column;
          gap: 6px;
          flex: 1;
        }

        .cs-create-input {
          flex: 1;
          background: rgba(30,24,18,0.8);
          border: 1px solid rgba(200,98,42,0.25);
          color: var(--bone);
          font-family: var(--font-body);
          font-size: 14px;
          padding: 8px 10px;
          outline: none;
        }

        .cs-create-input:focus { border-color: var(--ember); }

        .cs-create-input::placeholder { color: var(--muted); font-style: italic; }

        .cs-btn {
          padding: 8px 18px;
          background: rgba(200,98,42,0.12);
          border: 1px solid var(--ember);
          color: var(--ember);
          font-family: var(--font-display);
          font-size: 0.8rem;
          letter-spacing: 0.12em;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
          white-space: nowrap;
        }

        .cs-btn:hover:not(:disabled) {
          background: var(--ember);
          color: var(--ash);
        }

        .cs-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .cs-status {
          font-size: 0.78rem;
          text-align: center;
          font-style: italic;
          min-height: 1em;
        }

        .cs-status.error { color: #cc4444; }
        .cs-status.info  { color: var(--muted); }
      </style>

      <div class="cs-box">
        <div class="cs-title">Choose Your Vessel</div>
        <div class="cs-list" id="cs-list"></div>

        <div id="cs-create-section" class="cs-create-row" style="display:none">
          <div class="cs-create-fields">
            <input class="cs-create-input" id="cs-create-name" type="text"
              placeholder="character name" maxlength="24" />
            <input class="cs-create-input" id="cs-companion-name" type="text"
              placeholder="companion name (optional)" maxlength="24" />
          </div>
          <button class="cs-btn" id="cs-create-btn">CREATE</button>
        </div>

        <div class="cs-status info" id="cs-status"></div>
        <div id="cs-term-slot"></div>
      </div>
    `;

    el.querySelector('#cs-create-btn')?.addEventListener('click', () => {
      const name = el.querySelector<HTMLInputElement>('#cs-create-name')!.value.trim();
      if (!name) return;
      const companionName = el.querySelector<HTMLInputElement>('#cs-companion-name')!.value.trim();
      const companion = companionName ? { name: companionName } : undefined;
      this.socket.sendCharacterCreate(name, companion);
      this._setStatus('Creating character…');
    });

    const submitOnEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') el.querySelector<HTMLButtonElement>('#cs-create-btn')?.click();
    };
    el.querySelector<HTMLInputElement>('#cs-create-name')?.addEventListener('keydown', submitOnEnter);
    el.querySelector<HTMLInputElement>('#cs-companion-name')?.addEventListener('keydown', submitOnEnter);

    this._buildTerminal(el);

    return el;
  }

  /**
   * Command terminal for this screen.
   *
   * Logging in by command and then hitting a mouse-only character list would
   * be a door with no corridor behind it, so this stage needs the same
   * treatment. Commands drive the same socket calls the buttons do.
   */
  private _buildTerminal(el: HTMLElement): void {
    PreWorldTerminal.injectStyles();

    const term = new PreWorldTerminal({
      greeting: [
        'Character select. /help for commands.',
      ],
      help: [
        '/list                        — list your characters',
        '/char <name|number>          — enter the world as that character',
        '/create <name> [companion]   — create a new character',
      ],
      onCommand: (raw, t) => {
        const parts = raw.trim().split(/\s+/);
        const cmd = (parts[0] ?? '').toLowerCase();
        const chars = this.session.characters;

        switch (cmd) {
          case '/list':
          case '/chars': {
            this._writeCharacterList(t);
            return true;
          }

          case '/char':
          case '/play': {
            const arg = parts.slice(1).join(' ').trim();
            if (!arg) { t.write('Usage: /char <name or number>'); return true; }

            // Ordinal matches the numbering /list printed; otherwise match on
            // name, case-insensitively, so it can be typed as it reads.
            let hit: CharacterInfo | undefined;
            if (/^\d+$/.test(arg)) {
              hit = chars[Number.parseInt(arg, 10) - 1];
              if (!hit) { t.write(`No character #${arg}. Try /list.`); return true; }
            } else {
              const needle = arg.toLowerCase();
              hit = chars.find(c => c.name.toLowerCase() === needle)
                 ?? chars.find(c => c.name.toLowerCase().startsWith(needle));
              if (!hit) { t.write(`No character matching "${arg}". Try /list.`); return true; }
            }

            t.write(`Entering the world as ${hit.name}…`);
            this.session.selectCharacter(hit.id);
            this.socket.sendCharacterSelect(hit.id);
            this._setStatus('Entering world…');
            return true;
          }

          case '/create': {
            if (!this.session.canCreateCharacter) {
              t.write('You cannot create another character.');
              return true;
            }
            const name = parts[1];
            if (!name) {
              t.write('Usage: /create <name> [companion name]');
              return true;
            }
            const companionName = parts.slice(2).join(' ').trim();
            // Drive the same fields the button reads, so validation and the
            // name-confirmation flow behave identically either way.
            const nameEl = el.querySelector<HTMLInputElement>('#cs-create-name');
            const compEl = el.querySelector<HTMLInputElement>('#cs-companion-name');
            if (nameEl) nameEl.value = name;
            if (compEl) compEl.value = companionName;
            t.write(`Creating ${name}${companionName ? ` with companion ${companionName}` : ''}…`);
            el.querySelector<HTMLButtonElement>('#cs-create-btn')?.click();
            return true;
          }

          default:
            return false;
        }
      },
    });

    el.querySelector('#cs-term-slot')?.appendChild(term.el);
    this._term = term;

    // Show the roster immediately rather than making the player ask. Arriving
    // here already implies the question "which character" — the list is the
    // answer, so printing it saves a command and, for a screen reader, an
    // extra round trip through an aria-live region.
    this._writeCharacterList(term);
  }

  /**
   * Print the character roster into the terminal.
   *
   * Shared by the initial mount, the /list command and the characterList
   * event, so all three render identically — including the numbering that
   * /char accepts as an ordinal.
   */
  private _writeCharacterList(t: PreWorldTerminal): void {
    const chars = this.session.characters;
    if (chars.length === 0) {
      t.write(this.session.canCreateCharacter
        ? 'No characters yet. Use /create <name> [companion] to make one.'
        : 'No characters on this account.');
      return;
    }
    t.write(chars.length === 1 ? 'One character:' : `${chars.length} characters:`);
    chars.forEach((c, i) => {
      t.write(`  ${i + 1}. ${c.name} — level ${c.level}, ${c.location}`);
    });
    t.write('Enter with /char <name or number>.');
  }

  /** Terminal for this screen, so list changes can be announced into it. */
  private _term: PreWorldTerminal | null = null;

  private _renderList(characters: CharacterInfo[]): void {
    const listEl = this.root.querySelector<HTMLElement>('#cs-list')!;
    const createSection = this.root.querySelector<HTMLElement>('#cs-create-section')!;

    listEl.innerHTML = '';

    if (characters.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No characters yet. Create one below.';
      listEl.appendChild(empty);
    } else {
      for (const char of characters) {
        // Button, not a div. These were click-only divs with no role, no
        // tabindex and no accessible name — invisible to keyboard and screen
        // reader users, on the one screen you cannot skip.
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'cs-char';
        row.setAttribute('aria-label',
          `Enter world as ${char.name}, level ${char.level}, at ${char.location}`);
        row.innerHTML = `
          <div>
            <div class="cs-char-name">${this._esc(char.name)}</div>
            <div class="cs-char-meta">Level ${char.level} · ${this._esc(char.location)}</div>
          </div>
          <div class="cs-char-meta" aria-hidden="true">▶ ENTER</div>
        `;
        row.addEventListener('click', () => {
          this.session.selectCharacter(char.id);
          this.socket.sendCharacterSelect(char.id);
          this._setStatus('Entering world…');
        });
        listEl.appendChild(row);
      }
    }

    createSection.style.display = this.session.canCreateCharacter ? '' : 'none';
  }

  private _showConfirmModal(name: string, message: string): void {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: absolute; inset: 0;
      background: rgba(10,8,6,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 30; pointer-events: auto;
    `;
    modal.innerHTML = `
      <div style="
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        padding: 2rem; width: min(340px,85vw);
        display: flex; flex-direction: column; gap: 1rem;
      ">
        <div style="font-family: var(--font-display); letter-spacing: 0.15em; color: var(--bone);">
          Name Confirmation
        </div>
        <div style="font-size: 0.85rem; color: var(--muted); line-height: 1.5;">${message}</div>
        <div style="display: flex; gap: 8px;">
          <button class="cs-btn" id="cc-yes" style="flex:1">CONFIRM</button>
          <button class="cs-btn" id="cc-no" style="flex:1; background:transparent; color:var(--muted); border-color:rgba(200,98,42,0.3)">CANCEL</button>
        </div>
      </div>
    `;

    modal.querySelector('#cc-yes')?.addEventListener('click', () => {
      this.socket.sendCharacterNameConfirmed(name, true);
      this.session.clearCharacterConfirm();
      modal.remove();
      this._setStatus('Creating character…');
    });

    modal.querySelector('#cc-no')?.addEventListener('click', () => {
      this.socket.sendCharacterNameConfirmed(name, false);
      this.session.clearCharacterConfirm();
      modal.remove();
    });

    this.root.appendChild(modal);
  }

  private _setStatus(msg: string, isError = false): void {
    const el = this.root.querySelector<HTMLElement>('#cs-status');
    if (!el) return;
    el.textContent  = msg;
    el.className    = `cs-status ${isError ? 'error' : 'info'}`;
  }

  private _esc(s: string): string {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}
