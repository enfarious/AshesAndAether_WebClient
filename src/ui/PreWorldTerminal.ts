/**
 * PreWorldTerminal — a command line for the screens that exist before the
 * world does.
 *
 * The login and character-select screens were mouse-only. The in-world chat
 * input doesn't exist yet at that point, so a text client, a screen-reader
 * user, or an agent could not get past them at all — every command we added
 * in-world was unreachable because the door itself needed a mouse.
 *
 * Shared rather than duplicated so both screens behave identically: same
 * prompt, same unknown-command feedback, same announcement, same focus
 * handling. A user who learns it on the login screen already knows it on the
 * next one.
 *
 * Callers supply a handler and a greeting; everything else — markup, styling,
 * history, the masked-input mode — lives here.
 */

export interface TerminalHost {
  /** Handle one submitted line. Return false for "unknown command" so the
   *  terminal can print consistent feedback rather than each screen
   *  inventing its own. */
  onCommand(raw: string, term: PreWorldTerminal): boolean;
  /** Lines printed when the terminal mounts. */
  greeting: string[];
  /** Shown by /help. */
  help: string[];
}

export class PreWorldTerminal {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly history: string[] = [];
  private historyIdx = -1;

  /** Set while awaiting a masked value (a password). */
  private maskedResolve: ((value: string) => void) | null = null;

  constructor(private readonly host: TerminalHost) {
    this.el = document.createElement('div');
    this.el.className = 'pw-term';
    this.el.innerHTML = `
      <div class="pw-term-log" role="log" aria-live="polite"></div>
      <div class="pw-term-row">
        <span class="pw-term-prompt" aria-hidden="true">&gt;</span>
        <input class="pw-term-input" type="text" autocomplete="off" spellcheck="false"
               aria-label="Command terminal. Type slash help for a list of commands."
               placeholder="/help" />
      </div>
    `;
    this.log = this.el.querySelector('.pw-term-log')!;
    this.input = this.el.querySelector('.pw-term-input')!;

    for (const line of host.greeting) this.write(line);

    this.input.addEventListener('keydown', (e) => this._onKey(e));
  }

  /** Print a line. */
  write(text: string): void {
    const line = document.createElement('div');
    line.className = 'pw-term-line';
    line.textContent = text;
    this.log.appendChild(line);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Move keyboard focus to the input. */
  focus(): void {
    this.input.focus();
  }

  /**
   * Prompt for a value with the input masked, resolving when submitted.
   *
   * Used for passwords. Taking a password as a command argument — the MUD
   * convention — writes it into the visible log and the command history,
   * where it stays for anyone who later looks at the screen. Masking keeps
   * the flow fully keyboard-reachable without that.
   */
  askMasked(label: string, ariaLabel: string): Promise<string> {
    this.write(label);
    this.input.type = 'password';
    this.input.placeholder = '';
    this.input.setAttribute('aria-label', ariaLabel);
    this.focus();
    return new Promise((resolve) => { this.maskedResolve = resolve; });
  }

  private _endMasked(): void {
    this.maskedResolve = null;
    this.input.type = 'text';
    this.input.placeholder = '/help';
    this.input.setAttribute('aria-label',
      'Command terminal. Type slash help for a list of commands.');
  }

  private _onKey(e: KeyboardEvent): void {
    // History recall. Skipped in masked mode so a password can never be
    // recalled with an arrow key by whoever sits down next.
    if (!this.maskedResolve && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (this.history.length === 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        this.historyIdx = this.historyIdx < 0
          ? this.history.length - 1
          : Math.max(0, this.historyIdx - 1);
      } else {
        this.historyIdx = this.historyIdx < 0
          ? -1
          : Math.min(this.history.length - 1, this.historyIdx + 1);
      }
      this.input.value = this.historyIdx >= 0 ? (this.history[this.historyIdx] ?? '') : '';
      return;
    }

    if (e.key !== 'Enter') return;
    const raw = this.input.value;
    this.input.value = '';
    this.historyIdx = -1;

    if (this.maskedResolve) {
      const resolve = this.maskedResolve;
      this._endMasked();
      resolve(raw);
      return;
    }

    if (!raw.trim()) return;
    this.history.push(raw);
    this.write(`> ${raw}`);

    const cmd = raw.trim().split(/\s+/)[0]!.toLowerCase();
    if (cmd === '/help' || cmd === '/?') {
      for (const line of this.host.help) this.write(line);
      return;
    }

    if (!this.host.onCommand(raw, this)) {
      this.write(`Unknown command "${cmd}". Type /help for the list.`);
    }
  }

  /** Styles, injected once per document. */
  static injectStyles(): void {
    if (document.getElementById('pw-term-styles')) return;
    const style = document.createElement('style');
    style.id = 'pw-term-styles';
    style.textContent = `
      .pw-term {
        margin-top: 10px;
        border: 1px solid rgba(190,150,90,0.22);
        background: rgba(0,0,0,0.35);
        border-radius: 2px;
        padding: 6px 8px;
      }
      .pw-term-log {
        font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
        font-size: 0.68rem;
        line-height: 1.45;
        color: rgba(200,185,160,0.72);
        max-height: 108px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .pw-term-line { padding: 1px 0; }
      .pw-term-row {
        display: flex; align-items: center; gap: 6px;
        margin-top: 4px;
        border-top: 1px solid rgba(190,150,90,0.14);
        padding-top: 5px;
      }
      .pw-term-prompt {
        font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
        color: rgba(210,150,70,0.85);
        font-size: 0.75rem;
      }
      .pw-term-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: var(--text, #d8cdb8);
        font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
        font-size: 0.75rem; padding: 2px 0;
      }
      .pw-term-input::placeholder { color: rgba(200,185,160,0.32); }
      /* Visible focus ring: for keyboard-only users this is the only route
         through these screens, so focus must never be ambiguous. */
      .pw-term-input:focus-visible {
        outline: 1px solid rgba(210,150,70,0.6);
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  }
}
