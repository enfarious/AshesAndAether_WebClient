// ---------------------------------------------------------------------------
// ChoiceModal — generic server-driven prompt / list-select modal.
//
// Server sends `open_choice` with { token, prompt, body?, choices }. Modal
// renders prompt + body + one button per choice + persistent close (X).
// On click / dismiss, sends `/choose <token> <value>` (value `__cancel__`
// for dismissal). Server's ChoiceRegistry resolves and runs the executor.
//
// One modal handles ALL choice flows — yes/no, bounty selection, NPC
// dialog branches, beacon ignition confirmations, etc. Single component,
// single allowlist event, single reply path.
//
// Multiple `open_choice` events override each other — newest wins. The
// previous prompt is cancelled (sends `/choose <oldToken> __cancel__`)
// so the server's executor runs its cancel branch before being replaced.
// ---------------------------------------------------------------------------

import type { SocketClient } from '@/network/SocketClient';

interface ChoiceOption {
  label: string;
  value: string;
}

interface OpenChoicePayload {
  token:    string;
  prompt:   string;
  body?:    string;
  choices:  ChoiceOption[];
}

/** Sentinel echoed back to server when the player dismisses the modal. */
const CHOICE_CANCELLED = '__cancel__';

export class ChoiceModal {
  private root:        HTMLElement;
  private titleEl:     HTMLElement;
  private bodyEl:      HTMLElement;
  private choicesEl:   HTMLElement;
  private closeEl:     HTMLElement;
  private _activeToken: string | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
  ) {
    this.root      = document.createElement('div');
    this.titleEl   = document.createElement('h2');
    this.bodyEl    = document.createElement('div');
    this.choicesEl = document.createElement('div');
    this.closeEl   = document.createElement('button');
    this._build();
    this.root.style.display = 'none';
    this.mountEl.appendChild(this.root);

    this.socket.on('open_choice', (payload: unknown) => {
      this._open(payload as OpenChoicePayload);
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this._activeToken) {
        e.preventDefault();
        this._dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  /** ModalLike contract — used by ModalStack to know whether to route
   *  fb2 / Esc to us, and to dim the world while this is on top. */
  get isVisible(): boolean {
    return this._activeToken !== null;
  }

  /** ModalLike close hook — fired by ModalStack on closeTop / fb2 / Esc. */
  close(): void { this._dismiss(); }

  dispose(): void {
    if (this._activeToken) {
      // Tell the server we're tearing down with an unresolved prompt
      // so its executor's cancel branch runs.
      this.socket.sendCommand(`/choose ${this._activeToken} ${CHOICE_CANCELLED}`);
      this._activeToken = null;
    }
    this.cleanup.forEach((fn) => fn());
    this.cleanup.length = 0;
    this.root.remove();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private _open(payload: OpenChoicePayload): void {
    if (!payload?.token || !Array.isArray(payload.choices)) return;

    // Replace any existing prompt — server's cancel executor runs for
    // the old token so it doesn't leak past the new prompt.
    if (this._activeToken && this._activeToken !== payload.token) {
      this.socket.sendCommand(`/choose ${this._activeToken} ${CHOICE_CANCELLED}`);
    }
    this._activeToken = payload.token;

    this.titleEl.textContent = payload.prompt;
    this.bodyEl.textContent  = payload.body ?? '';
    this.bodyEl.style.display = payload.body ? '' : 'none';

    // Build buttons fresh per open so stale handlers from a previous
    // prompt can't fire.
    this.choicesEl.innerHTML = '';
    let firstBtn: HTMLButtonElement | null = null;
    for (const choice of payload.choices) {
      const btn = document.createElement('button');
      btn.className   = 'choice-btn';
      btn.textContent = choice.label;
      btn.addEventListener('click', () => this._select(choice.value));
      this.choicesEl.appendChild(btn);
      if (!firstBtn) firstBtn = btn;
    }

    this.root.style.display = 'flex';
    // Focus the first choice so Enter / gamepad-A activates it without
    // any pointer movement. Info-only modals (no choices) leave focus
    // unset — Esc / X / backdrop click still dismiss.
    if (firstBtn) firstBtn.focus();
  }

  private _select(value: string): void {
    if (!this._activeToken) return;
    this.socket.sendCommand(`/choose ${this._activeToken} ${value}`);
    this._activeToken = null;
    this.root.style.display = 'none';
  }

  private _dismiss(): void {
    if (!this._activeToken) return;
    this.socket.sendCommand(`/choose ${this._activeToken} ${CHOICE_CANCELLED}`);
    this._activeToken = null;
    this.root.style.display = 'none';
  }

  private _build(): void {
    this.root.id = 'choice-modal';
    this.root.innerHTML = `
      <style>
        /* Backdrop — semi-opaque overlay that captures clicks outside
         * the modal frame so the player has to make a deliberate choice
         * (or X). Esc still works regardless. */
        #choice-modal {
          position: fixed;
          inset: 0;
          z-index: 4000;
          background: rgba(0, 0, 0, 0.55);
          display: none;
          align-items: center;
          justify-content: center;
          font-family: var(--font-body, serif);
          /* uiRoot has pointer-events: none and children opt in. Without
           * this, clicks fall through to the game canvas (camera grabs
           * them) and the modal never receives them. */
          pointer-events: auto;
        }
        #choice-modal .cm-frame {
          position: relative;
          min-width: 320px;
          max-width: 460px;
          background: rgba(20, 14, 8, 0.96);
          border: 1px solid rgba(200, 145, 60, 0.45);
          box-shadow: 0 6px 24px rgba(0,0,0,0.65);
          padding: 18px 22px 16px;
          color: rgba(220, 200, 170, 0.92);
        }
        #choice-modal .cm-close {
          position: absolute;
          top: 6px;
          right: 8px;
          width: 22px;
          height: 22px;
          background: transparent;
          border: none;
          color: rgba(200, 145, 60, 0.6);
          font-family: var(--font-mono, monospace);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        #choice-modal .cm-close:hover { color: var(--ember, #c86a2a); }
        #choice-modal .cm-title {
          margin: 0 0 8px;
          font-family: var(--font-body, serif);
          font-size: 16px;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: rgba(240, 215, 175, 0.95);
        }
        #choice-modal .cm-body {
          font-size: 13px;
          line-height: 1.5;
          color: rgba(210, 195, 170, 0.78);
          margin-bottom: 14px;
          /* Server sends multi-paragraph bodies with newline separators.
           * pre-wrap preserves them while still wrapping long lines. */
          white-space: pre-wrap;
        }
        #choice-modal .choice-btn:focus {
          outline: none;
          background: rgba(70, 45, 18, 0.85);
          border-color: var(--ember, #c86a2a);
          color: rgba(255, 230, 195, 1);
        }
        #choice-modal .cm-choices {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        #choice-modal .choice-btn {
          font-family: var(--font-body, serif);
          font-size: 14px;
          letter-spacing: 0.02em;
          padding: 8px 14px;
          background: rgba(40, 28, 14, 0.75);
          border: 1px solid rgba(200, 145, 60, 0.35);
          color: rgba(230, 210, 180, 0.92);
          cursor: pointer;
          text-align: left;
          transition: background 0.15s, border-color 0.15s;
        }
        #choice-modal .choice-btn:hover {
          background: rgba(70, 45, 18, 0.85);
          border-color: var(--ember, #c86a2a);
          color: rgba(255, 230, 195, 1);
        }
      </style>
      <div class="cm-frame">
        <button class="cm-close" aria-label="Close" title="Close (Esc)">×</button>
        <h2 class="cm-title"></h2>
        <div class="cm-body"></div>
        <div class="cm-choices"></div>
      </div>
    `;

    const frame = this.root.querySelector<HTMLElement>('.cm-frame')!;
    const oldTitle   = this.titleEl;
    const oldBody    = this.bodyEl;
    const oldChoices = this.choicesEl;
    const oldClose   = this.closeEl;
    this.titleEl   = frame.querySelector<HTMLElement>('.cm-title')!;
    this.bodyEl    = frame.querySelector<HTMLElement>('.cm-body')!;
    this.choicesEl = frame.querySelector<HTMLElement>('.cm-choices')!;
    this.closeEl   = frame.querySelector<HTMLElement>('.cm-close')!;
    // Discard the placeholder refs from the ctor — they were never
    // mounted, just hold the field types while innerHTML runs.
    void oldTitle; void oldBody; void oldChoices; void oldClose;

    this.closeEl.addEventListener('click', () => this._dismiss());
    // Backdrop click — clicking outside the frame counts as dismiss.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this._dismiss();
    });
  }
}
