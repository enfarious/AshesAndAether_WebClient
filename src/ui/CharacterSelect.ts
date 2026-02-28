import type { SocketClient } from '@/network/SocketClient';
import type { SessionState } from '@/state/SessionState';
import type { CharacterInfo } from '@/network/Protocol';

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
        }

        .cs-char:hover {
          border-color: var(--ember);
          background: rgba(200,98,42,0.08);
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
          <input class="cs-create-input" id="cs-create-name" type="text"
            placeholder="new character name" maxlength="32" />
          <button class="cs-btn" id="cs-create-btn">CREATE</button>
        </div>

        <div class="cs-status info" id="cs-status"></div>
      </div>
    `;

    el.querySelector('#cs-create-btn')?.addEventListener('click', () => {
      const input = el.querySelector<HTMLInputElement>('#cs-create-name')!;
      const name  = input.value.trim();
      if (!name) return;
      this.socket.sendCharacterCreate(name);
      this._setStatus('Creating character…');
    });

    el.querySelector<HTMLInputElement>('#cs-create-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.querySelector<HTMLButtonElement>('#cs-create-btn')?.click();
    });

    return el;
  }

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
        const row = document.createElement('div');
        row.className = 'cs-char';
        row.innerHTML = `
          <div>
            <div class="cs-char-name">${this._esc(char.name)}</div>
            <div class="cs-char-meta">Level ${char.level} · ${this._esc(char.location)}</div>
          </div>
          <div class="cs-char-meta">▶ ENTER</div>
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
