import type { SocketClient } from '@/network/SocketClient';
import type { SessionState } from '@/state/SessionState';

/**
 * LoginScreen — guest or credentials auth flow.
 * Handles the auth_confirm_name modal inline.
 */
export class LoginScreen {
  private root: HTMLElement;
  private cleanup: (() => void)[] = [];
  private confirmModal: HTMLElement | null = null;

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly socket:   SocketClient,
    private readonly session:  SessionState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsub1 = session.on('authError', (p) => {
      const payload = p as { message: string };
      this._setError(payload.message ?? 'Authentication failed.');
      this._setLoading(false);
    });

    const unsub2 = session.on('authConfirmName', (p) => {
      const payload = p as { username: string; message: string };
      this._showConfirmModal(payload.username, payload.message);
    });

    const unsub3 = session.on('connectionStatus', () => {
      const status = session.connectionStatus;
      if (status === 'error') {
        this._setError(session.connectionError ?? 'Connection error.');
        this._setLoading(false);
      }
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
    el.id = 'login-screen';
    el.innerHTML = `
      <style>
        #login-screen {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          background: radial-gradient(ellipse at center, rgba(30,20,12,0.7) 0%, rgba(14,12,10,0.95) 70%);
          z-index: 20;
        }

        .login-box {
          width: min(380px, 90vw);
          background: var(--ui-bg);
          border: 1px solid var(--ui-border);
          padding: 2.5rem 2rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .login-title {
          font-family: var(--font-display);
          font-size: 1.4rem;
          letter-spacing: 0.2em;
          color: var(--bone);
          text-align: center;
          margin-bottom: 0.5rem;
        }

        .login-label {
          font-family: var(--font-body);
          font-size: 0.75rem;
          letter-spacing: 0.1em;
          color: var(--muted);
          margin-bottom: 3px;
        }

        .login-input {
          width: 100%;
          background: rgba(30,24,18,0.8);
          border: 1px solid rgba(200,98,42,0.25);
          color: var(--bone);
          font-family: var(--font-body);
          font-size: 14px;
          padding: 8px 10px;
          outline: none;
          transition: border-color 0.2s;
        }

        .login-input:focus { border-color: var(--ember); }

        .login-btn {
          width: 100%;
          padding: 10px;
          background: rgba(200,98,42,0.15);
          border: 1px solid var(--ember);
          color: var(--ember);
          font-family: var(--font-display);
          font-size: 0.85rem;
          letter-spacing: 0.15em;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
        }

        .login-btn:hover:not(:disabled) {
          background: var(--ember);
          color: var(--ash);
        }

        .login-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .login-btn.secondary {
          background: transparent;
          border-color: rgba(200,98,42,0.3);
          color: var(--muted);
          font-family: var(--font-body);
          font-size: 0.8rem;
        }

        .login-btn.secondary:hover:not(:disabled) {
          border-color: var(--ember);
          color: var(--bone);
          background: transparent;
        }

        .login-divider {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--muted);
          font-size: 0.7rem;
          letter-spacing: 0.1em;
        }

        .login-divider::before,
        .login-divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: rgba(200,98,42,0.2);
        }

        .login-error {
          color: #cc4444;
          font-size: 0.78rem;
          text-align: center;
          font-style: italic;
          min-height: 1.2em;
        }

        .login-status {
          color: var(--muted);
          font-size: 0.75rem;
          text-align: center;
          font-style: italic;
          min-height: 1.2em;
        }
      </style>

      <div class="login-box">
        <div class="login-title">Enter the World</div>

        <div>
          <div class="login-label">USERNAME</div>
          <input class="login-input" id="login-username" type="text" autocomplete="username" placeholder="name or email" />
        </div>
        <div>
          <div class="login-label">PASSWORD</div>
          <input class="login-input" id="login-password" type="password" autocomplete="current-password" placeholder="••••••••" />
        </div>

        <button class="login-btn" id="login-submit">ENTER</button>

        <div class="login-divider">or</div>

        <button class="login-btn secondary" id="login-guest">Continue as Guest</button>

        <div class="login-error" id="login-error"></div>
        <div class="login-status" id="login-status"></div>
      </div>
    `;

    const submitBtn = el.querySelector<HTMLButtonElement>('#login-submit')!;
    const guestBtn  = el.querySelector<HTMLButtonElement>('#login-guest')!;
    const userInput = el.querySelector<HTMLInputElement>('#login-username')!;
    const passInput = el.querySelector<HTMLInputElement>('#login-password')!;

    submitBtn.addEventListener('click', () => {
      const username = userInput.value.trim();
      const password = passInput.value;
      if (!username || !password) {
        this._setError('Username and password are required.');
        return;
      }
      this._setError('');
      this._setLoading(true);
      this._setStatus('Connecting…');
      this.socket.requestAuth({ method: 'credentials', username, password });
    });

    guestBtn.addEventListener('click', () => {
      this._setError('');
      this._setLoading(true);
      this._setStatus('Connecting as guest…');
      this.socket.requestAuth({ method: 'guest' });
    });

    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitBtn.click();
    });

    return el;
  }

  private _showConfirmModal(username: string, message: string): void {
    if (this.confirmModal) this.confirmModal.remove();

    const modal = document.createElement('div');
    modal.style.cssText = `
      position: absolute; inset: 0;
      background: rgba(10,8,6,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 30;
    `;
    modal.innerHTML = `
      <div style="
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        padding: 2rem; width: min(340px,85vw);
        display: flex; flex-direction: column; gap: 1rem;
      ">
        <div style="font-family: var(--font-display); font-size: 1rem; letter-spacing: 0.15em; color: var(--bone);">
          Create Account?
        </div>
        <div style="font-size: 0.85rem; color: var(--muted); line-height: 1.5;">${message}</div>
        <div style="display: flex; gap: 8px;">
          <button class="login-btn" id="confirm-yes" style="flex:1">CONFIRM</button>
          <button class="login-btn secondary" id="confirm-no" style="flex:1">CANCEL</button>
        </div>
      </div>
    `;

    modal.querySelector('#confirm-yes')?.addEventListener('click', () => {
      const uEl = this.root.querySelector<HTMLInputElement>('#login-username');
      const pEl = this.root.querySelector<HTMLInputElement>('#login-password');
      this.socket.sendAuthNameConfirmed(
        uEl?.value.trim() ?? username,
        pEl?.value ?? '',
        true,
      );
      this.session.clearAuthConfirm();
      modal.remove();
      this.confirmModal = null;
      this._setStatus('Creating account…');
    });

    modal.querySelector('#confirm-no')?.addEventListener('click', () => {
      this.socket.sendAuthNameConfirmed(username, '', false);
      this.session.clearAuthConfirm();
      modal.remove();
      this.confirmModal = null;
      this._setLoading(false);
      this._setStatus('');
    });

    this.root.appendChild(modal);
    this.confirmModal = modal;
  }

  private _setError(msg: string): void {
    const el = this.root.querySelector<HTMLElement>('#login-error');
    if (el) el.textContent = msg;
  }

  private _setStatus(msg: string): void {
    const el = this.root.querySelector<HTMLElement>('#login-status');
    if (el) el.textContent = msg;
  }

  private _setLoading(loading: boolean): void {
    const submitBtn = this.root.querySelector<HTMLButtonElement>('#login-submit');
    const guestBtn  = this.root.querySelector<HTMLButtonElement>('#login-guest');
    if (submitBtn) submitBtn.disabled = loading;
    if (guestBtn)  guestBtn.disabled  = loading;
  }
}
