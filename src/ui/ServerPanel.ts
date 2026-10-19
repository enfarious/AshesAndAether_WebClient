import type { SocketClient } from '@/network/SocketClient';

/**
 * ServerPanel — the generic server-built window (`open_village_panel`).
 *
 * Web twin of the UE client's AA_VillageWidget. Deliberately dumb: the
 * server decides what to show and sends titled sections of text lines and
 * command buttons; every button is just a slash command, so the panel can
 * never drift from the commands. One window serves every server view —
 * player villages, the guild panel, quest journal / NPC talk, bug reports,
 * building inspection, trades …
 *
 * Payload:
 *   { title, subtitle?, reopen, panelId?, close?, anchor?,
 *     sections: [{ heading, lines?: [..], buttonsPerRow?,
 *                  buttons?: [{ label, command, enabled?, width?, inputs? }] }] }
 *
 *   reopen=false   a refresh after an action: redrawn only if already open.
 *   close=true     the server takes the view down (only if `panelId` matches
 *                  what's showing, or no panelId given).
 *   inputs         [{ key, label, maxLength?, placeholder?, uppercase? }] —
 *                  the button opens a small form; its command is a template
 *                  whose {key}s are filled from the fields.
 *   anchor         { x, y, z, range } server metres — the view belongs to a
 *                  thing in the world and closes once you walk `range` away.
 *   `@place <piece> <building|decor> <sizeX> <sizeZ> <grid>` commands start
 *                  ghost placement on the client instead of going to the server.
 */

export interface PanelInput  { key: string; label: string; maxLength?: number; placeholder?: string; uppercase?: boolean }
export interface PanelButton { label: string; command: string; enabled?: boolean; width?: number; inputs?: PanelInput[] }
export interface PanelSection { heading?: string; lines?: string[]; buttons?: PanelButton[]; buttonsPerRow?: number }
export interface ServerPanelPayload {
  title?:    string;
  subtitle?: string;
  reopen?:   boolean;
  panelId?:  string;
  close?:    boolean;
  anchor?:   { x: number; y?: number; z: number; range: number };
  sections?: PanelSection[];
}

export interface ServerPanelHooks {
  /** Local player's ground position (server metres) — for anchored views. */
  getPlayerXZ: () => { x: number; z: number } | null;
  /** `@place` buttons: start client-side ghost placement. */
  startPlacement?: (piece: string, isBuilding: boolean, sizeX: number, sizeZ: number, grid: number) => void;
}

export class ServerPanel {
  private root:    HTMLElement;
  private box:     HTMLElement;
  private body:    HTMLElement;
  private form:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _open = false;
  private _title = '';
  private _panelId = '';
  private anchor: { x: number; z: number; range: number } | null = null;
  private anchorTimer: number | null = null;

  constructor(
    private readonly mountEl: HTMLElement,
    private readonly socket:  SocketClient,
    private readonly hooks:   ServerPanelHooks,
  ) {
    this.root = document.createElement('div');
    this.box  = document.createElement('div');
    this.body = document.createElement('div');
    this.form = document.createElement('div');
    this._build();
    this.mountEl.appendChild(this.root);

    this.socket.on('open_village_panel', (payload: unknown) => {
      this._onPayload(payload as ServerPanelPayload);
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !this._open) return;
      e.preventDefault();
      if (this.form.style.display !== 'none') this._closeForm();
      else this.hide();
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
  }

  get isVisible(): boolean { return this._open; }
  /** Title of the view showing ("Journal", a village, an NPC …). */
  get title(): string { return this._title; }
  /** Server's id for the view showing ('guild', 'reports' …), '' if unset. */
  get panelId(): string { return this._panelId; }

  hide(): void {
    this._open = false;
    this.root.style.display = 'none';
    this._closeForm();
    this._setAnchor(null);
  }

  close(): void { this.hide(); }

  dispose(): void {
    this._setAnchor(null);
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Payload ─────────────────────────────────────────────────────────────

  private _onPayload(p: ServerPanelPayload): void {
    if (p.close) {
      if (this._open && (!p.panelId || p.panelId === this._panelId)) this.hide();
      return;
    }
    if (!this._open && !p.reopen) return;   // refresh for a window the player closed

    this._title   = p.title ?? '';
    this._panelId = p.panelId ?? '';
    this._setAnchor(p.anchor && p.anchor.range > 0 ? { x: p.anchor.x, z: p.anchor.z, range: p.anchor.range } : null);
    this._render(p);
    if (!this._open) {
      this._open = true;
      this.root.style.display = 'block';
    }
  }

  private _render(p: ServerPanelPayload): void {
    this._closeForm();
    this.body.replaceChildren();

    const h = document.createElement('h2');
    h.textContent = p.title || 'Villages';
    this.body.appendChild(h);
    if (p.subtitle) {
      const s = document.createElement('div');
      s.className = 'sp-sub';
      s.textContent = p.subtitle;
      this.body.appendChild(s);
    }

    for (const sec of p.sections ?? []) {
      if (sec.heading) {
        const hd = document.createElement('div');
        hd.className = 'sp-heading';
        hd.textContent = sec.heading;
        this.body.appendChild(hd);
      }
      for (const line of sec.lines ?? []) {
        const l = document.createElement('div');
        l.className = 'sp-line';
        l.textContent = line;
        this.body.appendChild(l);
      }
      const buttons = (sec.buttons ?? []).filter(b => b.command);   // empty command would close
      if (buttons.length === 0) continue;
      const perRow = Math.max(1, Math.floor(sec.buttonsPerRow ?? 4));
      let row: HTMLElement | null = null;
      buttons.forEach((b, i) => {
        if (!row || i % perRow === 0) {
          row = document.createElement('div');
          row.className = 'sp-row';
          this.body.appendChild(row);
        }
        row.appendChild(this._makeButton(b));
      });
    }

    const foot = document.createElement('div');
    foot.className = 'sp-foot';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sp-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    foot.appendChild(closeBtn);
    this.body.appendChild(foot);
  }

  private _makeButton(b: PanelButton): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'sp-btn';
    btn.textContent = b.label;
    btn.style.minWidth = `${Math.max(60, b.width ?? 96)}px`;
    btn.disabled = b.enabled === false;
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (b.inputs && b.inputs.length > 0) { this._openForm(b); return; }
      this._run(b.command);
    });
    return btn;
  }

  private _run(command: string): void {
    if (command.startsWith('@place ')) {
      const p = command.trim().split(/\s+/);
      if (p.length >= 6 && this.hooks.startPlacement) {
        this.hooks.startPlacement(p[1]!, p[2] === 'building', Number(p[3]), Number(p[4]), Number(p[5]));
        this.hide();   // out of the way of the view
      }
      return;
    }
    // Send and wait: the server answers with a fresh payload that repaints
    // us, or a chat line saying why not.
    this.socket.sendCommand(command);
  }

  // ── Typed-text form (buttons with `inputs`) ─────────────────────────────

  private _openForm(b: PanelButton): void {
    const fields = (b.inputs ?? []).filter(f => f.key);
    if (fields.length === 0) return;
    this.form.replaceChildren();

    const h = document.createElement('div');
    h.className = 'sp-heading';
    h.textContent = b.label.replace('…', '').trim();
    this.form.appendChild(h);

    const boxes: HTMLInputElement[] = [];
    for (const f of fields) {
      const lab = document.createElement('label');
      lab.className = 'sp-field';
      lab.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = 'text';
      if (f.maxLength && f.maxLength > 0) inp.maxLength = f.maxLength;
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.uppercase) inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); });
      // Keep typing out of the game's key bindings.
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') this._closeForm();
      });
      lab.appendChild(inp);
      this.form.appendChild(lab);
      boxes.push(inp);
    }
    const err = document.createElement('div');
    err.className = 'sp-err';
    this.form.appendChild(err);

    const submit = (): void => {
      let cmd = b.command;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!;
        let v = boxes[i]!.value.trim();
        if (f.uppercase) v = v.toUpperCase();
        if (f.maxLength && f.maxLength > 0) v = v.slice(0, f.maxLength);
        if (!v) { err.textContent = `${f.label} is empty.`; boxes[i]!.focus(); return; }
        cmd = cmd.split(`{${f.key}}`).join(v);
      }
      this._closeForm();
      this.socket.sendCommand(cmd);
    };

    const row = document.createElement('div');
    row.className = 'sp-row';
    const ok = document.createElement('button');
    ok.className = 'sp-btn';
    ok.textContent = 'OK';
    ok.addEventListener('click', submit);
    const cancel = document.createElement('button');
    cancel.className = 'sp-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this._closeForm());
    row.append(ok, cancel);
    this.form.appendChild(row);

    this.form.style.display = 'flex';
    boxes[0]?.focus();
  }

  private _closeForm(): void {
    this.form.style.display = 'none';
    this.form.replaceChildren();
  }

  // ── Anchor ──────────────────────────────────────────────────────────────

  private _setAnchor(a: { x: number; z: number; range: number } | null): void {
    this.anchor = a;
    if (a && this.anchorTimer === null) {
      this.anchorTimer = window.setInterval(() => this._checkAnchor(), 250);
    } else if (!a && this.anchorTimer !== null) {
      window.clearInterval(this.anchorTimer);
      this.anchorTimer = null;
    }
  }

  private _checkAnchor(): void {
    const a = this.anchor;
    if (!a || !this._open) { this._setAnchor(null); return; }
    const me = this.hooks.getPlayerXZ();
    if (me && Math.hypot(me.x - a.x, me.z - a.z) > a.range) this.hide();
  }

  // ── Build (one-time) ────────────────────────────────────────────────────

  private _build(): void {
    this.root.id = 'server-panel';
    this.root.style.display = 'none';
    const style = document.createElement('style');
    style.textContent = `
      #server-panel {
        position: fixed;
        top: 12vh;
        right: 6vw;
        z-index: 840;
        pointer-events: auto;
      }
      #sp-box {
        position: relative;
        background: var(--ui-bg, #0e1622);
        border: 1px solid #2d4860;
        width: clamp(360px, 32vw, 520px);
        max-height: 76vh;
        overflow-y: auto;
        padding: 16px 20px 14px;
        box-shadow: 0 0 24px rgba(0,0,0,0.6);
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        color: rgba(220,235,245,0.92);
      }
      #sp-box h2 {
        margin: 0 0 2px;
        text-align: center;
        font-family: var(--font-display, serif);
        font-size: 20px;
        color: #6fc6f0;
        letter-spacing: 0.04em;
        cursor: move;
        user-select: none;
      }
      #sp-box .sp-sub { text-align: center; color: rgba(200,220,235,0.6); font-size: 12px; }
      #sp-box .sp-heading {
        margin: 12px 0 4px;
        padding-bottom: 2px;
        border-bottom: 1px solid rgba(70,110,150,0.35);
        color: #9fd3ef;
        font-weight: 600;
        letter-spacing: 0.03em;
      }
      #sp-box .sp-line { line-height: 1.45; white-space: pre-wrap; }
      #sp-box .sp-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
      #sp-box .sp-foot { display: flex; justify-content: center; margin-top: 14px; }
      #sp-box .sp-btn {
        padding: 5px 10px;
        background: rgba(30, 56, 80, 0.8);
        border: 1px solid rgba(90, 140, 185, 0.55);
        color: rgba(225,240,250,0.95);
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      #sp-box .sp-btn:hover:not(:disabled) { background: rgba(48, 86, 120, 0.9); }
      #sp-box .sp-btn:disabled { opacity: 0.4; cursor: default; }
      #sp-form {
        position: absolute;
        inset: 0;
        background: rgba(10, 18, 28, 0.96);
        padding: 18px 20px;
        flex-direction: column;
        gap: 8px;
      }
      #sp-form .sp-field { display: flex; flex-direction: column; gap: 3px; color: rgba(200,220,235,0.8); }
      #sp-form input {
        background: rgba(18,30,44,0.9);
        border: 1px solid rgba(90,140,185,0.55);
        color: #e6f2fa;
        padding: 5px 7px;
        font-family: inherit;
        font-size: 13px;
      }
      #sp-form .sp-err { color: #f08a6f; min-height: 1em; }
    `;
    this.root.appendChild(style);

    this.box.id = 'sp-box';
    this.form.id = 'sp-form';
    this.form.style.display = 'none';
    this.box.append(this.body, this.form);
    this.root.appendChild(this.box);

    // Drag by the title.
    let drag: { dx: number; dy: number } | null = null;
    this.box.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLElement) || e.target.tagName !== 'H2') return;
      const r = this.root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    const onMove = (e: MouseEvent): void => {
      if (!drag) return;
      this.root.style.left  = `${Math.max(0, e.clientX - drag.dx)}px`;
      this.root.style.top   = `${Math.max(0, e.clientY - drag.dy)}px`;
      this.root.style.right = 'auto';
    };
    const onUp = (): void => { drag = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    this.cleanup.push(() => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    });
  }
}
