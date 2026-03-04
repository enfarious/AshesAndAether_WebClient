import type { SocketClient }      from '@/network/SocketClient';
import type { EditorOpenPayload, EditorResultPayload } from '@/network/Protocol';

/**
 * ScriptEditor — in-game Lua script editor for scripted object verbs.
 *
 * Opened by the server via `editor_open` (triggered by `/edit <object>:<verb>`).
 * Four action buttons: Save, Compile, Revert, Quit.
 * Error/warning panel with line numbers from the server compiler.
 */
export class ScriptEditor {
  private root:       HTMLElement;
  private visible     = false;
  private editorId:   string | null = null;
  private readOnly    = false;
  private dirty       = false;

  // DOM refs (set in _build)
  private titleEl!:    HTMLElement;
  private badgeEl!:    HTMLElement;
  private versionEl!:  HTMLElement;
  private textarea!:   HTMLTextAreaElement;
  private gutterEl!:   HTMLElement;
  private statusEl!:   HTMLElement;
  private diagPanel!:  HTMLElement;
  private saveBtn!:    HTMLButtonElement;
  private compileBtn!: HTMLButtonElement;
  private revertBtn!:  HTMLButtonElement;

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly socket: SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Open the editor with data from the server. */
  open(payload: EditorOpenPayload): void {
    this.editorId  = payload.editorId;
    this.readOnly  = payload.readOnly;
    this.dirty     = false;

    this.titleEl.textContent   = `${payload.objectName}:${payload.verb}`;
    this.versionEl.textContent = payload.version > 0 ? `v${payload.version}` : 'new';
    this.badgeEl.style.display = payload.readOnly ? '' : 'none';
    this.textarea.value        = payload.source;
    this.textarea.readOnly     = payload.readOnly;

    // Disable action buttons in read-only mode
    this.saveBtn.disabled    = payload.readOnly;
    this.compileBtn.disabled = payload.readOnly;
    this.revertBtn.disabled  = payload.readOnly;

    this._clearDiagnostics();
    this._setStatus(payload.origin === 'undo' ? 'Restored from previous version' : 'Ready');
    this._syncGutter();
    this.show();

    // Focus the textarea after transition
    requestAnimationFrame(() => this.textarea.focus());
  }

  /** Handle a compile/save result from the server. */
  handleResult(payload: EditorResultPayload): void {
    if (payload.editorId !== this.editorId) return;

    if (payload.version !== undefined) {
      this.versionEl.textContent = `v${payload.version}`;
    }

    this._renderDiagnostics(payload.errors, payload.warnings);

    if (payload.success) {
      this.dirty = false;
      const hasWarnings = payload.warnings.length > 0;
      this._setStatus(
        payload.version !== undefined
          ? `Saved v${payload.version}${hasWarnings ? ` (${payload.warnings.length} warning${payload.warnings.length !== 1 ? 's' : ''})` : ''}`
          : `Compiled OK${hasWarnings ? ` (${payload.warnings.length} warning${payload.warnings.length !== 1 ? 's' : ''})` : ''}`,
        'success',
      );
    } else {
      this._setStatus(
        `${payload.errors.length} error${payload.errors.length !== 1 ? 's' : ''}`,
        'error',
      );
    }
  }

  show(): void {
    this.root.style.display = 'flex';
    requestAnimationFrame(() => this.root.classList.add('se-visible'));
    this.visible = true;
  }

  hide(): void {
    this.root.classList.remove('se-visible');
    this.root.style.display = 'none';
    this.visible = false;
  }

  get isVisible(): boolean { return this.visible; }

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    this.root.remove();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'script-editor';
    el.innerHTML = `
      <style>
        #script-editor {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 850;
          pointer-events: none;
        }
        #script-editor.se-visible { pointer-events: auto; }

        #se-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.65);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
        #script-editor.se-visible #se-backdrop { opacity: 1; }

        #se-panel {
          position: relative;
          width: min(720px, 96vw);
          height: min(600px, 88vh);
          display: flex;
          flex-direction: column;
          background: rgba(8,6,4,0.97);
          border: 1px solid rgba(200,98,42,0.30);
          box-shadow: 0 8px 40px rgba(0,0,0,0.8),
                      inset 0 0 60px rgba(30,15,5,0.5);
          transform: translateY(20px);
          opacity: 0;
          transition: transform 0.18s ease, opacity 0.18s ease;
        }
        #script-editor.se-visible #se-panel {
          transform: translateY(0);
          opacity: 1;
        }

        /* ── Header ── */
        #se-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px 8px;
          border-bottom: 1px solid rgba(200,98,42,0.25);
          flex-shrink: 0;
        }
        #se-icon {
          font-size: 14px;
          color: rgba(200,145,60,0.80);
        }
        #se-title {
          font-family: var(--font-mono, monospace);
          font-size: 14px;
          color: rgba(212,201,184,0.95);
          letter-spacing: 0.04em;
        }
        #se-version {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(150,120,80,0.65);
        }
        #se-badge {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(200,98,42,0.80);
          border: 1px solid rgba(200,98,42,0.35);
          padding: 1px 6px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        #se-header-spacer { flex: 1; }
        #se-close-btn {
          font-family: var(--font-mono, monospace);
          font-size: 14px;
          background: none;
          border: none;
          color: rgba(200,145,60,0.50);
          cursor: pointer;
          padding: 0 2px;
          line-height: 1;
          transition: color 0.12s;
        }
        #se-close-btn:hover { color: rgba(230,180,80,0.95); }

        /* ── Editor area ── */
        #se-editor-wrap {
          flex: 1;
          min-height: 0;
          display: flex;
          position: relative;
          overflow: hidden;
        }

        #se-gutter {
          width: 40px;
          flex-shrink: 0;
          overflow: hidden;
          background: rgba(14,10,6,0.6);
          border-right: 1px solid rgba(200,98,42,0.12);
          padding: 8px 0;
          user-select: none;
        }
        .se-gutter-line {
          font-family: var(--font-mono, monospace);
          font-size: 13px;
          line-height: 1.45;
          height: calc(13px * 1.45);
          text-align: right;
          padding-right: 8px;
          color: rgba(150,120,80,0.40);
        }
        .se-gutter-line.se-gutter-error {
          color: rgba(220,80,60,0.90);
          font-weight: bold;
        }

        #se-textarea {
          flex: 1;
          min-width: 0;
          resize: none;
          background: rgba(14,10,6,0.4);
          color: rgba(212,201,184,0.92);
          font-family: var(--font-mono, monospace);
          font-size: 13px;
          line-height: 1.45;
          border: none;
          outline: none;
          padding: 8px 12px;
          tab-size: 2;
          white-space: pre;
          overflow-wrap: normal;
          overflow-x: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.25) transparent;
        }
        #se-textarea::placeholder {
          color: rgba(150,120,80,0.35);
        }
        #se-textarea:read-only {
          color: rgba(212,201,184,0.60);
        }

        /* ── Diagnostics panel ── */
        #se-diag {
          max-height: 120px;
          overflow-y: auto;
          border-top: 1px solid rgba(200,98,42,0.20);
          background: rgba(14,10,6,0.5);
          padding: 0;
          flex-shrink: 0;
          scrollbar-width: thin;
          scrollbar-color: rgba(200,98,42,0.2) transparent;
        }
        .se-diag-row {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          padding: 3px 12px;
          border-bottom: 1px solid rgba(200,98,42,0.08);
          cursor: pointer;
        }
        .se-diag-row:hover {
          background: rgba(200,98,42,0.08);
        }
        .se-diag-error {
          color: rgba(220,80,60,0.90);
        }
        .se-diag-warning {
          color: rgba(220,180,60,0.85);
        }
        .se-diag-line {
          color: rgba(150,120,80,0.65);
          margin-right: 6px;
        }

        /* ── Footer ── */
        #se-footer {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-top: 1px solid rgba(200,98,42,0.20);
          flex-shrink: 0;
        }
        #se-status {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(150,120,80,0.65);
          flex: 1;
        }
        #se-status.se-status-success { color: rgba(80,200,120,0.85); }
        #se-status.se-status-error   { color: rgba(220,80,60,0.85); }

        .se-btn {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          background: rgba(200,145,60,0.10);
          border: 1px solid rgba(200,145,60,0.30);
          color: rgba(200,145,60,0.85);
          cursor: pointer;
          padding: 5px 14px;
          transition: background 0.12s, color 0.12s;
        }
        .se-btn:hover:not(:disabled) {
          background: rgba(200,145,60,0.22);
          color: rgba(230,200,130,0.95);
        }
        .se-btn:disabled {
          opacity: 0.35;
          cursor: default;
        }
        .se-btn-quit {
          background: rgba(200,98,42,0.10);
          border-color: rgba(200,98,42,0.30);
          color: rgba(200,98,42,0.80);
        }
        .se-btn-quit:hover {
          background: rgba(200,98,42,0.22);
          color: rgba(230,120,60,0.95);
        }
      </style>

      <div id="se-backdrop"></div>
      <div id="se-panel">
        <div id="se-header">
          <span id="se-icon">{ }</span>
          <span id="se-title"></span>
          <span id="se-version"></span>
          <span id="se-badge" style="display:none">read-only</span>
          <span id="se-header-spacer"></span>
          <button id="se-close-btn">\u2715</button>
        </div>

        <div id="se-editor-wrap">
          <div id="se-gutter"></div>
          <textarea id="se-textarea"
                    spellcheck="false"
                    autocomplete="off"
                    autocapitalize="off"
                    placeholder="-- Your Lua code here"></textarea>
        </div>

        <div id="se-diag"></div>

        <div id="se-footer">
          <span id="se-status">Ready</span>
          <button class="se-btn" id="se-btn-save">Save</button>
          <button class="se-btn" id="se-btn-compile">Compile</button>
          <button class="se-btn" id="se-btn-revert">Revert</button>
          <button class="se-btn se-btn-quit" id="se-btn-quit">Quit</button>
        </div>
      </div>
    `;

    // Cache DOM refs
    this.titleEl    = el.querySelector('#se-title')!;
    this.badgeEl    = el.querySelector('#se-badge')!;
    this.versionEl  = el.querySelector('#se-version')!;
    this.textarea   = el.querySelector('#se-textarea')!;
    this.gutterEl   = el.querySelector('#se-gutter')!;
    this.statusEl   = el.querySelector('#se-status')!;
    this.diagPanel  = el.querySelector('#se-diag')!;
    this.saveBtn    = el.querySelector('#se-btn-save')!;
    this.compileBtn = el.querySelector('#se-btn-compile')!;
    this.revertBtn  = el.querySelector('#se-btn-revert')!;

    // ── Event wiring ──────────────────────────────────────────────────────

    el.querySelector('#se-backdrop')?.addEventListener('click', () => this._quit());
    el.querySelector('#se-close-btn')?.addEventListener('click', () => this._quit());
    el.querySelector('#se-btn-quit')?.addEventListener('click', () => this._quit());

    this.saveBtn.addEventListener('click', () => this._save());
    this.compileBtn.addEventListener('click', () => this._compile());
    this.revertBtn.addEventListener('click', () => this._revert());

    // Textarea: sync gutter on input/scroll, handle Tab key
    this.textarea.addEventListener('input', () => {
      this.dirty = true;
      this._syncGutter();
    });
    this.textarea.addEventListener('scroll', () => this._syncGutterScroll());
    this.textarea.addEventListener('keydown', (e) => this._onTextareaKey(e));

    // Diagnostic row click → jump to line
    this.diagPanel.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('.se-diag-row') as HTMLElement | null;
      if (!row) return;
      const line = Number(row.dataset.line);
      if (line > 0) this._jumpToLine(line);
    });

    // Global keyboard handler
    window.addEventListener('keydown', this._onKeyDown);

    return el;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private _save(): void {
    if (!this.editorId || this.readOnly) return;
    this._setStatus('Saving...', 'pending');
    this.socket.sendEditorSave(this.editorId, this.textarea.value);
  }

  private _compile(): void {
    if (!this.editorId || this.readOnly) return;
    this._setStatus('Compiling...', 'pending');
    this.socket.sendEditorCompile(this.editorId, this.textarea.value);
  }

  private _revert(): void {
    if (!this.editorId || this.readOnly) return;
    this._setStatus('Reverting...', 'pending');
    this.socket.sendEditorRevert(this.editorId);
  }

  private _quit(): void {
    if (this.dirty && !this.readOnly) {
      if (!confirm('You have unsaved changes. Quit without saving?')) return;
    }
    if (this.editorId) {
      this.socket.sendEditorClose(this.editorId);
      this.editorId = null;
    }
    this.hide();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (!this.visible) return;
    if (e.key === 'Escape') { this._quit(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this._save();
    }
  };

  private _onTextareaKey(e: KeyboardEvent): void {
    // Tab inserts two spaces instead of moving focus
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = this.textarea;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      this.dirty = true;
      this._syncGutter();
    }
  }

  // ── Gutter ──────────────────────────────────────────────────────────────────

  private _errorLines = new Set<number>();

  private _syncGutter(): void {
    const lineCount = this.textarea.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      const cls = this._errorLines.has(i) ? 'se-gutter-line se-gutter-error' : 'se-gutter-line';
      html += `<div class="${cls}">${i}</div>`;
    }
    this.gutterEl.innerHTML = html;
    this._syncGutterScroll();
  }

  private _syncGutterScroll(): void {
    this.gutterEl.scrollTop = this.textarea.scrollTop;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  private _clearDiagnostics(): void {
    this.diagPanel.innerHTML = '';
    this._errorLines.clear();
    this._syncGutter();
  }

  private _renderDiagnostics(
    errors:   Array<{ line?: number; col?: number; message: string }>,
    warnings: Array<{ line?: number; message: string }>,
  ): void {
    this._errorLines.clear();
    let html = '';

    for (const err of errors) {
      if (err.line) this._errorLines.add(err.line);
      const loc = err.line ? `<span class="se-diag-line">L${err.line}${err.col ? `:${err.col}` : ''}</span>` : '';
      html += `<div class="se-diag-row se-diag-error" data-line="${err.line ?? 0}">${loc}${this._esc(err.message)}</div>`;
    }

    for (const warn of warnings) {
      const loc = warn.line ? `<span class="se-diag-line">L${warn.line}</span>` : '';
      html += `<div class="se-diag-row se-diag-warning" data-line="${warn.line ?? 0}">${loc}${this._esc(warn.message)}</div>`;
    }

    this.diagPanel.innerHTML = html;
    this._syncGutter();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _setStatus(text: string, kind: 'success' | 'error' | 'pending' | '' = ''): void {
    this.statusEl.textContent = text;
    this.statusEl.className = '';
    if (kind === 'success') this.statusEl.classList.add('se-status-success');
    if (kind === 'error')   this.statusEl.classList.add('se-status-error');
  }

  private _jumpToLine(line: number): void {
    const lines = this.textarea.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      pos += (lines[i]?.length ?? 0) + 1;
    }
    this.textarea.focus();
    this.textarea.selectionStart = pos;
    this.textarea.selectionEnd   = pos + (lines[line - 1]?.length ?? 0);
    // Scroll the textarea so the line is visible
    const lineHeight = 13 * 1.45;
    this.textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  private _esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
