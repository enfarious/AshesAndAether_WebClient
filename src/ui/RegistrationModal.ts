import type { PlayerState }  from '@/state/PlayerState';
import type { SocketClient } from '@/network/SocketClient';
import type { MessageRouter } from '@/network/MessageRouter';

/**
 * RegistrationModal — lets a guest player claim their account in-world.
 *
 * Triggered by /register in chat or programmatically via show().
 * Submits via register_account socket event and reflects the result inline.
 */
export class RegistrationModal {
  private root:      HTMLElement;
  private form:      HTMLElement;
  private errorEl:   HTMLElement;
  private submitBtn: HTMLButtonElement;
  private usernameIn: HTMLInputElement;
  private emailIn:    HTMLInputElement;
  private passwordIn: HTMLInputElement;
  private confirmIn:  HTMLInputElement;
  private cleanup:   (() => void)[] = [];

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly router:  MessageRouter,
  ) {
    this.root       = document.createElement('div');
    this.form       = document.createElement('div');
    this.errorEl    = document.createElement('div');
    this.submitBtn  = document.createElement('button');
    this.usernameIn = document.createElement('input');
    this.emailIn    = document.createElement('input');
    this.passwordIn = document.createElement('input');
    this.confirmIn  = document.createElement('input');
    this._build();
    this.root.style.display = 'none'; // hidden until show() is called
    this.mountEl.appendChild(this.root);

    const unsub = this.router.onRegisterResult(r => this._onResult(r));
    this.cleanup.push(unsub);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.root.style.display !== 'none') this.hide();
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  show(): void {
    this._resetForm();
    this.root.style.display = 'flex'; // flex for centering
    requestAnimationFrame(() => this.usernameIn.focus());
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'reg-modal';

    const style = document.createElement('style');
    style.textContent = `
      #reg-modal {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.75);
        z-index: 900;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }

      #reg-box {
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        width: clamp(320px, 40vw, 480px);
        padding: 28px 32px 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      #reg-box h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 22px;
        color: var(--ember);
        letter-spacing: 0.05em;
      }

      #reg-box p.reg-sub {
        margin: -8px 0 0;
        font-size: 14px;
        color: var(--muted);
        font-family: var(--font-body);
        line-height: 1.5;
      }

      .reg-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .reg-field label {
        font-size: 13px;
        font-family: var(--font-body);
        color: var(--bone);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .reg-field input {
        background: rgba(0,0,0,0.4);
        border: 1px solid var(--ui-border);
        color: var(--bone);
        font-family: var(--font-body);
        font-size: 17px;
        padding: 8px 10px;
        outline: none;
        width: 100%;
        box-sizing: border-box;
      }

      .reg-field input:focus {
        border-color: var(--ember);
      }

      #reg-error {
        color: #e04040;
        font-size: 14px;
        font-family: var(--font-body);
        min-height: 20px;
        display: none;
      }

      #reg-error.visible {
        display: block;
      }

      .reg-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }

      .reg-actions button {
        font-family: var(--font-body);
        font-size: 15px;
        padding: 8px 20px;
        border: 1px solid var(--ui-border);
        cursor: pointer;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      #reg-submit {
        background: var(--ember);
        color: #0a0806;
        border-color: var(--ember);
      }

      #reg-submit:hover { filter: brightness(1.15); }
      #reg-submit:disabled { opacity: 0.5; cursor: not-allowed; }

      #reg-cancel {
        background: transparent;
        color: var(--muted);
      }

      #reg-cancel:hover { color: var(--bone); }
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'reg-box';

    const title = document.createElement('h2');
    title.textContent = 'Register Your Account';
    box.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'reg-sub';
    sub.textContent =
      'Claim this character permanently. Your current position, inventory, and progress are preserved.';
    box.appendChild(sub);

    box.appendChild(this._field('Username', this.usernameIn, 'text', 'DesiredName'));
    box.appendChild(this._field('Email',    this.emailIn,    'email', 'you@example.com'));
    box.appendChild(this._field('Password', this.passwordIn, 'password', 'Min. 8 characters'));
    box.appendChild(this._field('Confirm Password', this.confirmIn, 'password', 'Repeat password'));

    this.errorEl.id = 'reg-error';
    box.appendChild(this.errorEl);

    const actions = document.createElement('div');
    actions.className = 'reg-actions';

    const cancel = document.createElement('button');
    cancel.id = 'reg-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.hide());

    this.submitBtn.id = 'reg-submit';
    this.submitBtn.textContent = 'Create Account';
    this.submitBtn.addEventListener('click', () => this._submit());

    actions.appendChild(cancel);
    actions.appendChild(this.submitBtn);
    box.appendChild(actions);

    // Stop modal backdrop clicks from propagating to the game
    box.addEventListener('mousedown', e => e.stopPropagation());

    // Enter key submits from any field
    for (const inp of [this.usernameIn, this.emailIn, this.passwordIn, this.confirmIn]) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._submit();
      });
    }

    this.root.appendChild(box);
    this.form = box;
  }

  private _field(label: string, input: HTMLInputElement, type: string, placeholder: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'reg-field';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    input.type        = type;
    input.placeholder = placeholder;
    input.autocomplete = type === 'password' ? 'new-password' : 'off';
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return wrap;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private _resetForm(): void {
    this.usernameIn.value = '';
    this.emailIn.value    = '';
    this.passwordIn.value = '';
    this.confirmIn.value  = '';
    this._clearError();
    this.submitBtn.disabled = false;
    this.submitBtn.textContent = 'Create Account';
  }

  private _showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.classList.add('visible');
  }

  private _clearError(): void {
    this.errorEl.textContent = '';
    this.errorEl.classList.remove('visible');
  }

  private _submit(): void {
    this._clearError();

    const username = this.usernameIn.value.trim();
    const email    = this.emailIn.value.trim();
    const password = this.passwordIn.value;
    const confirm  = this.confirmIn.value;

    // Client-side pre-checks (server also validates, but catch obvious errors early)
    if (!username || !email || !password || !confirm) {
      this._showError('All fields are required.');
      return;
    }
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
      this._showError('Username must be 3–20 characters: letters, numbers, _ or -.');
      return;
    }
    if (password.length < 8) {
      this._showError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      this._showError('Passwords do not match.');
      return;
    }

    this.submitBtn.disabled = true;
    this.submitBtn.textContent = 'Registering…';
    this.socket.sendRegisterAccount(username, email, password);
  }

  private _onResult(result: { success: boolean; username?: string; error?: string }): void {
    if (result.success) {
      this.hide();
      // System chat message is pushed by MessageRouter on success
    } else {
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = 'Create Account';
      this._showError(result.error ?? 'Registration failed. Please try again.');
    }
  }
}
