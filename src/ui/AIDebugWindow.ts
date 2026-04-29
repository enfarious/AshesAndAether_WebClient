import type { MessageRouter } from '@/network/MessageRouter';
import type { SocketClient }  from '@/network/SocketClient';
import type {
  AIDebugTickPayload,
  AIDebugDecision,
  AIDebugAATransition,
  AIDebugSnapshotEntity,
  AIDebugConsideredAbility,
} from '@/network/Protocol';

const LOG_RING_SIZE      = 120;
const AA_LOG_RING_SIZE   = 80;
const POS_STORAGE_KEY    = 'ai_debug_window_pos';

/**
 * AIDebugWindow — floating diagnostic panel for companion AI tuning.
 *
 * Top section: live snapshot table (player + companions). Updates each tick.
 * Bottom section: tabbed log — BT decisions or autoAttackTarget transitions.
 *
 * Auto-shows on first `ai_debug_tick`, hidden by default. Toggle via /aidebug
 * slash command (server side controls subscription). Draggable; position
 * remembered in localStorage.
 *
 * Designed for archetype + range + ability-firing diagnosis: shows what the
 * BT WANTS (preferred range, scored abilities, chosen) vs what actually
 * happens (auto-attack target, current distance). Mismatches surface
 * Zone-overrides and disengage stickiness.
 */
export class AIDebugWindow {
  private root!:           HTMLElement;
  private dragHandle!:     HTMLElement;
  private snapshotBody!:   HTMLTableSectionElement;
  private logBody!:        HTMLTableSectionElement;
  private aaLogBody!:      HTMLTableSectionElement;
  private filterSelect!:   HTMLSelectElement;
  private pauseBtn!:       HTMLButtonElement;
  private clearBtn!:       HTMLButtonElement;
  private tabDecisions!:   HTMLButtonElement;
  private tabAA!:          HTMLButtonElement;
  private logSection!:     HTMLElement;
  private aaLogSection!:   HTMLElement;

  private unsub: (() => void) | null = null;
  private decisions:     AIDebugDecision[]      = [];
  private aaTransitions: AIDebugAATransition[]  = [];
  private latestSnapshot: AIDebugTickPayload | null = null;

  private _visible = false;
  private _paused  = false;
  private _filter: 'all' | string = 'all';
  private _activeTab: 'decisions' | 'aa' = 'decisions';
  /** When true, decision log hides ticks that didn't fire an ability
   *  (gcd_blocked, no_usable_ability, no_target_resolved). Defaults on so
   *  the panel stays focused on real choices instead of churn. */
  private _firingsOnly = true;
  /** Wall-clock of the last received tick. Auto-show fires only when the
   *  gap exceeds AUTO_SHOW_GAP_MS, i.e. the tick stream just resumed after
   *  /aidebug on. Within-stream ticks don't reopen the panel after X click. */
  private _lastTickAt = 0;
  private _rafId: number | null = null;

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly router: MessageRouter,
    private readonly socket: SocketClient,
  ) {
    this._injectStyles();
    this._build();
    this._restorePosition();
    this._wireDrag();

    this.unsub = router.onAIDebugTick((p) => this._onTick(p));
  }

  show(): void {
    this._visible = true;
    this.root.classList.remove('aidebug-hidden');
    this._scheduleRefresh();
  }

  hide(): void {
    this._visible = false;
    this.root.classList.add('aidebug-hidden');
  }

  toggle(): void {
    this._visible ? this.hide() : this.show();
  }

  get isVisible(): boolean { return this._visible; }

  dispose(): void {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this.unsub?.();
    this.root.remove();
  }

  // ── Inbound tick ────────────────────────────────────────────────────────

  private _onTick(p: AIDebugTickPayload): void {
    const now = performance.now();
    const gap = now - this._lastTickAt;
    this._lastTickAt = now;

    this.latestSnapshot = p;

    // Auto-show only on a fresh subscription stream (long gap = user just
    // typed /aidebug on). Within an active stream, ticks at 10Hz arrive
    // every ~100ms; X click stays sticky. AUTO_SHOW_GAP_MS = 2000.
    if (!this._visible && gap > 2000) this.show();

    if (this._paused) {
      this._scheduleRefresh(); // still refresh snapshot row freshness header
      return;
    }

    for (const d of p.decisions) {
      this.decisions.push(d);
      if (this.decisions.length > LOG_RING_SIZE) this.decisions.shift();
    }
    for (const t of p.aaTransitions) {
      this.aaTransitions.push(t);
      if (this.aaTransitions.length > AA_LOG_RING_SIZE) this.aaTransitions.shift();
    }

    this._refreshFilterOptions();
    this._scheduleRefresh();
  }

  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._refresh();
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private _refresh(): void {
    if (!this._visible || !this.latestSnapshot) return;
    this._renderSnapshot();
    if (this._activeTab === 'decisions') this._renderDecisionLog();
    else                                  this._renderAALog();
  }

  private _renderSnapshot(): void {
    const snap = this.latestSnapshot;
    if (!snap) return;
    const rows: HTMLTableRowElement[] = [];

    rows.push(this._snapshotRow(snap.player, snap));
    for (const c of snap.companions) {
      rows.push(this._snapshotRow(c, snap));
    }

    this.snapshotBody.replaceChildren(...rows);
  }

  private _snapshotRow(e: AIDebugSnapshotEntity, _snap: AIDebugTickPayload): HTMLTableRowElement {
    const tr = document.createElement('tr');
    if (e.type === 'companion') tr.classList.add('aidebug-row-companion');

    // Server resolves target name + distance even for mobs (which the client
    // snapshot doesn't carry), so use those directly.
    const target = e.targetName;
    const range  = e.targetDistance;

    const isCompanion = e.type === 'companion';
    const bandLabel   = isCompanion && e.preferredRange ? this._rangeBandLabel(e.preferredRange) : '—';
    const rangeCell   = range !== null ? `${range.toFixed(1)}m` : '—';
    const rangeOk     = !isCompanion || !e.preferredRange || range === null
      ? true
      : this._rangeWithinBand(range, e.preferredRange);

    const cells = [
      this._mkCell(e.name + (e.type === 'companion' && e.archetype ? ` (${e.archetype})` : '')),
      this._mkBarCell(e.hp, e.maxHp, '#c84040'),
      this._mkBarCell(e.mp, e.maxMp, '#4070c8'),
      this._mkBarCell(e.stam, e.maxStam, '#88c050'),
      this._mkCell(e.engagementMode ?? (e.inCombat ? 'combat' : 'idle')),
      this._mkCell(bandLabel),
      this._mkCell(rangeCell + (rangeOk ? '' : ' ⚠'), rangeOk ? undefined : 'aidebug-warn'),
      this._mkCell(target ?? '—'),
    ];
    tr.append(...cells);
    return tr;
  }

  private _renderDecisionLog(): void {
    const rows: HTMLTableRowElement[] = [];
    let filtered = this._filter === 'all'
      ? this.decisions
      : this.decisions.filter(d => d.selfId === this._filter);

    if (this._firingsOnly) {
      // Anything that started with 'fired' (fired, fired_heal, fired_ooc_heal)
      // is a real action. Everything else is churn.
      filtered = filtered.filter(d => d.reason.startsWith('fired'));
    }

    // Show newest first — easier to read live.
    const recent = filtered.slice(-LOG_RING_SIZE).reverse();
    for (const d of recent) {
      rows.push(this._decisionRow(d));
    }
    this.logBody.replaceChildren(...rows);
  }

  private _decisionRow(d: AIDebugDecision): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const t  = new Date(d.tickAt);
    const time = `${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${(d.tickAt % 1000).toString().padStart(3, '0').slice(0, 1)}`;

    const entityName = this._resolveDisplayName(d.selfId, this.latestSnapshot) ?? d.selfId.slice(0, 8);

    // Server-resolved names take precedence (handles mobs, since they aren't
    // in the snapshot table). Fall back to the snapshot lookup, then to a
    // short id if all else fails (entity left zone between tick + emit).
    const chosenTargetName = d.chosen
      ? (d.chosen.targetName
        ?? this._resolveDisplayName(d.chosen.targetId, this.latestSnapshot)
        ?? d.chosen.targetId.slice(0, 8))
      : null;
    const chosenStr = d.chosen ? `${d.chosen.abilityId} → ${chosenTargetName}` : '—';

    const range = d.target ? `${d.target.distance.toFixed(1)}m` : '—';
    const tgt   = d.target
      ? (d.target.name
        ?? this._resolveDisplayName(d.target.id, this.latestSnapshot)
        ?? d.target.id.slice(0, 8))
      : '—';

    // Considered list — top 3 by score, with skip reasons.
    const consideredCell = this._consideredCell(d.considered);

    const reasonClass = d.reason.startsWith('fired')      ? 'aidebug-good'
                      : d.reason.startsWith('gcd')        ? 'aidebug-dim'
                      : d.reason === 'no_usable_ability'  ? 'aidebug-warn'
                      : '';

    tr.append(
      this._mkCell(time, 'aidebug-dim'),
      this._mkCell(entityName),
      this._mkCell(d.state + (d.emergencyHeal ? ' 🚑' : '')),
      this._mkCell(tgt),
      this._mkCell(range),
      this._mkCell(chosenStr),
      this._mkCell(d.reason, reasonClass),
      consideredCell,
    );
    return tr;
  }

  private _consideredCell(items: AIDebugConsideredAbility[]): HTMLTableCellElement {
    const td = document.createElement('td');
    if (items.length === 0) {
      td.textContent = '—';
      td.classList.add('aidebug-dim');
      return td;
    }

    // Sort: eligible first by score desc, skipped after by ability id.
    const sorted = items.slice().sort((a, b) => {
      const aSkipped = a.skipReason !== null;
      const bSkipped = b.skipReason !== null;
      if (aSkipped !== bSkipped) return aSkipped ? 1 : -1;
      if (!aSkipped && !bSkipped) return b.score - a.score;
      return a.abilityId.localeCompare(b.abilityId);
    });

    const lines: HTMLElement[] = [];
    for (const c of sorted) {
      const span = document.createElement('span');
      span.className = 'aidebug-considered-line';
      if (c.skipReason !== null) {
        span.classList.add('aidebug-considered-skipped');
        span.textContent = `${c.abilityId}: ${c.skipReason}`;
      } else {
        span.classList.add('aidebug-considered-eligible');
        span.textContent = `${c.abilityId}: ${c.score.toFixed(2)} (${c.category})`;
      }
      lines.push(span);
    }
    td.append(...lines);
    return td;
  }

  private _renderAALog(): void {
    const rows: HTMLTableRowElement[] = [];
    const recent = this.aaTransitions.slice(-AA_LOG_RING_SIZE).reverse();
    for (const t of recent) {
      const tr = document.createElement('tr');
      const dt = new Date(t.at);
      const time = `${dt.getMinutes().toString().padStart(2, '0')}:${dt.getSeconds().toString().padStart(2, '0')}.${(t.at % 1000).toString().padStart(3, '0').slice(0, 1)}`;

      const entity = this._resolveDisplayName(t.entityId, this.latestSnapshot) ?? t.entityId.slice(0, 8);
      const prev   = t.prev ? (this._resolveDisplayName(t.prev, this.latestSnapshot) ?? t.prev.slice(0, 8)) : '—';
      const next   = t.next ? (this._resolveDisplayName(t.next, this.latestSnapshot) ?? t.next.slice(0, 8)) : '—';

      tr.append(
        this._mkCell(time, 'aidebug-dim'),
        this._mkCell(entity),
        this._mkCell(prev),
        this._mkCell('→'),
        this._mkCell(next),
        this._mkCell(t.reason, 'aidebug-mono'),
      );
      rows.push(tr);
    }
    this.aaLogBody.replaceChildren(...rows);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private _mkCell(text: string, klass?: string): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text;
    if (klass) td.classList.add(klass);
    return td;
  }

  private _mkBarCell(cur: number, max: number, color: string): HTMLTableCellElement {
    const td = document.createElement('td');
    const pct = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
    td.classList.add('aidebug-bar-cell');
    td.innerHTML = `
      <div class="aidebug-bar">
        <div class="aidebug-bar-fill" style="width:${(pct * 100).toFixed(1)}%; background:${color};"></div>
        <span class="aidebug-bar-label">${Math.round(cur)}/${Math.round(max)}</span>
      </div>
    `;
    return td;
  }

  private _resolveDisplayName(id: string | null, snap: AIDebugTickPayload | null): string | null {
    if (!id || !snap) return null;
    if (snap.player.id === id) return snap.player.name;
    for (const c of snap.companions) {
      if (c.id === id) return c.name;
    }
    return id.slice(0, 8); // unknown id (mob etc.) — short fallback
  }

  private _rangeBandLabel(pref: string): string {
    if (pref === 'close') return 'close (0-1-3m)';
    if (pref === 'mid')   return 'mid (2-4-6m)';
    if (pref === 'long')  return 'long (8-15-20m)';
    return pref;
  }

  private _rangeWithinBand(range: number, pref: string): boolean {
    // Match server NPCCombatProfile.RANGE_DISTANCES.
    if (pref === 'close') return range >= 0 && range <= 3;
    if (pref === 'mid')   return range >= 2 && range <= 6;
    if (pref === 'long')  return range >= 8 && range <= 20;
    return true;
  }

  private _refreshFilterOptions(): void {
    if (!this.latestSnapshot) return;
    const desired = ['all', this.latestSnapshot.player.id, ...this.latestSnapshot.companions.map(c => c.id)];
    const existing = Array.from(this.filterSelect.options).map(o => o.value);
    if (desired.length === existing.length && desired.every((v, i) => v === existing[i])) return;

    this.filterSelect.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All';
    this.filterSelect.appendChild(allOpt);
    const playerOpt = document.createElement('option');
    playerOpt.value = this.latestSnapshot.player.id; playerOpt.textContent = `${this.latestSnapshot.player.name} (you)`;
    this.filterSelect.appendChild(playerOpt);
    for (const c of this.latestSnapshot.companions) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name}${c.archetype ? ` — ${c.archetype}` : ''}`;
      this.filterSelect.appendChild(opt);
    }
    this.filterSelect.value = this._filter === 'all' || desired.includes(this._filter) ? this._filter : 'all';
  }

  // ── Build / drag ────────────────────────────────────────────────────────

  private _build(): void {
    const root = document.createElement('div');
    root.id = 'ai-debug-window';
    root.classList.add('aidebug-hidden');

    root.innerHTML = `
      <div class="aidebug-header">
        <span class="aidebug-title">AI Debug</span>
        <div class="aidebug-controls">
          <select class="aidebug-filter" title="Filter decision log by entity"></select>
          <button class="aidebug-btn aidebug-firings aidebug-active" title="Hide non-firing ticks (GCD-blocked, no usable ability)">🎯 Firings</button>
          <button class="aidebug-btn aidebug-pause" title="Pause log accumulation">⏸ Pause</button>
          <button class="aidebug-btn aidebug-clear" title="Clear log">Clear</button>
          <button class="aidebug-btn aidebug-close" title="Hide panel (server still emits)">×</button>
        </div>
      </div>

      <table class="aidebug-snapshot">
        <thead>
          <tr>
            <th>Entity</th>
            <th>HP</th>
            <th>MP</th>
            <th>Stam</th>
            <th>Mode</th>
            <th>Pref Range</th>
            <th>Actual</th>
            <th>AA Target</th>
          </tr>
        </thead>
        <tbody class="aidebug-snapshot-body"></tbody>
      </table>

      <div class="aidebug-tabs">
        <button class="aidebug-tab aidebug-tab-active" data-tab="decisions">Decisions</button>
        <button class="aidebug-tab" data-tab="aa">AA Transitions</button>
      </div>

      <div class="aidebug-log-section">
        <table class="aidebug-log">
          <thead>
            <tr>
              <th>Time</th>
              <th>Entity</th>
              <th>State</th>
              <th>Tgt</th>
              <th>Range</th>
              <th>Chose</th>
              <th>Reason</th>
              <th>Considered</th>
            </tr>
          </thead>
          <tbody class="aidebug-log-body"></tbody>
        </table>
      </div>

      <div class="aidebug-aa-section" style="display:none">
        <table class="aidebug-log">
          <thead>
            <tr>
              <th>Time</th>
              <th>Entity</th>
              <th>Prev</th>
              <th></th>
              <th>Next</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody class="aidebug-aa-body"></tbody>
        </table>
      </div>
    `;

    this.uiRoot.appendChild(root);
    this.root          = root;
    this.dragHandle    = root.querySelector('.aidebug-header')!;
    this.snapshotBody  = root.querySelector('.aidebug-snapshot-body')!;
    this.logBody       = root.querySelector('.aidebug-log-body')!;
    this.aaLogBody     = root.querySelector('.aidebug-aa-body')!;
    this.filterSelect  = root.querySelector('.aidebug-filter')!;
    this.pauseBtn      = root.querySelector('.aidebug-pause')!;
    this.clearBtn      = root.querySelector('.aidebug-clear')!;
    const firingsBtn   = root.querySelector('.aidebug-firings') as HTMLButtonElement;
    this.tabDecisions  = root.querySelector('.aidebug-tab[data-tab="decisions"]')!;
    this.tabAA         = root.querySelector('.aidebug-tab[data-tab="aa"]')!;
    this.logSection    = root.querySelector('.aidebug-log-section')!;
    this.aaLogSection  = root.querySelector('.aidebug-aa-section')!;

    this.filterSelect.addEventListener('change', () => {
      this._filter = this.filterSelect.value;
      this._scheduleRefresh();
    });

    this.pauseBtn.addEventListener('click', () => {
      this._paused = !this._paused;
      this.pauseBtn.textContent = this._paused ? '▶ Resume' : '⏸ Pause';
      this.pauseBtn.classList.toggle('aidebug-active', this._paused);
    });

    firingsBtn.addEventListener('click', () => {
      this._firingsOnly = !this._firingsOnly;
      firingsBtn.classList.toggle('aidebug-active', this._firingsOnly);
      firingsBtn.textContent = this._firingsOnly ? '🎯 Firings' : '🎯 All';
      this._scheduleRefresh();
    });

    this.clearBtn.addEventListener('click', () => {
      this.decisions     = [];
      this.aaTransitions = [];
      this._refresh();
    });

    root.querySelector('.aidebug-close')!.addEventListener('click', () => {
      // Tell the server to stop emitting too — saves bandwidth and means
      // the user doesn't have to type /aidebug off after closing.
      this.socket.sendCommand('/aidebug off');
      this.hide();
    });

    this.tabDecisions.addEventListener('click', () => this._setTab('decisions'));
    this.tabAA.addEventListener('click',        () => this._setTab('aa'));

    // All-options default — refilled when first packet arrives.
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All';
    this.filterSelect.appendChild(allOpt);
  }

  private _setTab(tab: 'decisions' | 'aa'): void {
    this._activeTab = tab;
    this.tabDecisions.classList.toggle('aidebug-tab-active', tab === 'decisions');
    this.tabAA.classList.toggle('aidebug-tab-active',        tab === 'aa');
    this.logSection.style.display   = tab === 'decisions' ? '' : 'none';
    this.aaLogSection.style.display = tab === 'aa'        ? '' : 'none';
    this._scheduleRefresh();
  }

  private _wireDrag(): void {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    this.dragHandle.addEventListener('mousedown', (e) => {
      // Don't start drag if user clicked a control.
      if ((e.target as HTMLElement).tagName.match(/BUTTON|SELECT|INPUT/)) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.root.getBoundingClientRect();
      startLeft = rect.left;
      startTop  = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - 200, startLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - 100, startTop  + dy));
      this.root.style.left = `${newLeft}px`;
      this.root.style.top  = `${newTop}px`;
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      this._savePosition();
    });
  }

  private _savePosition(): void {
    try {
      const rect = this.root.getBoundingClientRect();
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch { /* localStorage may be unavailable */ }
  }

  private _restorePosition(): void {
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (!raw) return;
      const { left, top } = JSON.parse(raw) as { left: number; top: number };
      if (typeof left === 'number' && typeof top === 'number') {
        this.root.style.left = `${left}px`;
        this.root.style.top  = `${top}px`;
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
      }
    } catch { /* ignore */ }
  }

  // ── Styles ──────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('ai-debug-window-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-debug-window-styles';
    style.textContent = `
      #ai-debug-window {
        position: fixed;
        top: 60px;
        right: 18px;
        width: 760px;
        max-height: 70vh;
        background: rgba(8, 6, 4, 0.92);
        border: 1px solid rgba(200, 145, 60, 0.32);
        box-shadow: 0 4px 18px rgba(0,0,0,0.7);
        font-family: ui-monospace, 'Cascadia Mono', 'Menlo', monospace;
        font-size: 11px;
        color: #d8d2c0;
        z-index: 90;
        display: flex;
        flex-direction: column;
        user-select: none;
        pointer-events: auto;
      }
      #ai-debug-window.aidebug-hidden { display: none; }

      .aidebug-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        background: rgba(60, 40, 20, 0.6);
        border-bottom: 1px solid rgba(200, 145, 60, 0.24);
        cursor: move;
      }
      .aidebug-title {
        font-family: var(--font-display, serif);
        font-size: 13px;
        color: #e8c890;
        letter-spacing: 0.5px;
      }
      .aidebug-controls { display: flex; gap: 6px; align-items: center; }
      .aidebug-filter {
        background: rgba(0,0,0,0.4);
        color: #d8d2c0;
        border: 1px solid rgba(200,145,60,0.2);
        padding: 2px 4px;
        font-size: 11px;
        max-width: 180px;
      }
      .aidebug-btn {
        background: rgba(40, 28, 14, 0.7);
        color: #d8d2c0;
        border: 1px solid rgba(200, 145, 60, 0.24);
        padding: 2px 8px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .aidebug-btn:hover { background: rgba(80, 54, 26, 0.8); }
      .aidebug-btn.aidebug-active { background: rgba(120, 80, 40, 0.9); color: #ffe8c0; }
      .aidebug-close { padding: 2px 6px; }

      .aidebug-snapshot, .aidebug-log {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .aidebug-snapshot th, .aidebug-log th {
        text-align: left;
        padding: 4px 6px;
        background: rgba(40, 28, 14, 0.5);
        color: #b89868;
        font-weight: normal;
        border-bottom: 1px solid rgba(200, 145, 60, 0.2);
      }
      .aidebug-snapshot td, .aidebug-log td {
        padding: 3px 6px;
        border-bottom: 1px solid rgba(80, 56, 30, 0.2);
        vertical-align: middle;
      }
      .aidebug-row-companion td:first-child { color: #88c0e0; }

      .aidebug-bar-cell {
        min-width: 96px;
      }
      .aidebug-bar {
        position: relative;
        background: rgba(0,0,0,0.5);
        border: 1px solid rgba(80,56,30,0.4);
        height: 14px;
        width: 100%;
      }
      .aidebug-bar-fill {
        height: 100%;
        transition: width 0.15s linear;
      }
      .aidebug-bar-label {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        text-align: center;
        line-height: 14px;
        font-size: 10px;
        color: #fff;
        text-shadow: 0 0 2px rgba(0,0,0,0.9);
      }

      .aidebug-tabs {
        display: flex;
        gap: 0;
        background: rgba(40, 28, 14, 0.4);
        border-bottom: 1px solid rgba(200, 145, 60, 0.16);
      }
      .aidebug-tab {
        background: transparent;
        color: #a89878;
        border: none;
        border-right: 1px solid rgba(80,56,30,0.3);
        padding: 4px 14px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .aidebug-tab:hover { color: #e8c890; }
      .aidebug-tab.aidebug-tab-active {
        background: rgba(80, 54, 26, 0.5);
        color: #ffe8c0;
      }

      .aidebug-log-section, .aidebug-aa-section {
        flex: 1;
        overflow-y: auto;
        max-height: 380px;
      }

      .aidebug-considered-line {
        display: block;
        line-height: 14px;
        font-size: 10px;
      }
      .aidebug-considered-eligible { color: #88c050; }
      .aidebug-considered-skipped  { color: #806848; }

      .aidebug-good { color: #88c050; }
      .aidebug-warn { color: #e0a040; }
      .aidebug-dim  { color: #888070; }
      .aidebug-mono { font-family: ui-monospace, monospace; color: #c0a878; }
    `;
    document.head.appendChild(style);
  }
}
