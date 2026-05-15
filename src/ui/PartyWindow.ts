import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { SocketClient }   from '@/network/SocketClient';
import type { Entity }         from '@/network/Protocol';

/** One row in the party panel — could be a player, their companion, or a hireling. */
interface PartyRow {
  kind:      'player' | 'companion' | 'hireling';
  id:        string;
  name:      string;
  role:      string;        // single-symbol tag: T/M/M♦/R/R♦/C/H/Su/?/*
  ownerId:   string | null; // null for player rows; the owner's id for companions/hirelings
  isLeader:  boolean;
  isSelf:    boolean;
  /** True for the first row in a player-cluster — only player rows have up/down arrows. */
  showSortControls: boolean;
  /** Cluster index in the current ordered cluster list — used by up/down handlers. */
  clusterIndex: number;
  /** Total number of clusters — used to disable end-of-list arrows. */
  totalClusters: number;
}

/** A cluster groups one player with their summoned companion + hirelings.
 *  Pets always render directly below their owner; only the owner is sortable. */
interface PartyCluster {
  ownerId: string;
  ownerName: string;
  isSelf: boolean;
  isLeader: boolean;
  rows: PartyRow[];
}

/**
 * PartyWindow — compact party roster, bottom-right corner.
 *
 * Shows party members + their summoned companions + their hirelings (the
 * "extended party") with HP / stamina / mana bars and a single-symbol role
 * tag (T/M/R/H/Su/C, diamond suffix for magic flavor).
 *
 * Auto-shows when there's anyone to display (party member, summoned
 * companion, or active hireling). 'P' key toggles visibility. Player
 * cluster order is sortable via up/down arrows on each player row;
 * persisted to localStorage so the layout survives reloads.
 */
export class PartyWindow {
  private root:    HTMLElement;
  private cleanup: (() => void)[] = [];
  private _visible = false;
  private _userHidden = false;   // player manually toggled off with 'P'
  private _lastSig:   string = '';   // structural signature of the last render
  private _rafId: number | null = null;
  /** User-arranged order of player cluster owners. New owners append at the
   *  end; missing owners drop. Persisted per (selfId × partyId|solo) key. */
  private _clusterOrder: string[] = [];

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly socket:   SocketClient,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubPlayer = player.onChange(() => this._scheduleRefresh());
    // Refresh whenever an entity that COULD be in the panel changes — that's
    // any player, companion, or hireling. The panel itself filters down to
    // just the relevant rows. The rAF debounce in _scheduleRefresh keeps
    // this cheap even with many entities.
    const isPanelKind = (e: Entity) => {
      const t = (e.type ?? '').toLowerCase();
      return t === 'player' || t === 'companion' || t === 'hireling';
    };
    const unsubAdd    = entities.onAdd(e    => { if (isPanelKind(e)) this._scheduleRefresh(); });
    const unsubUpdate = entities.onUpdate(e => { if (isPanelKind(e)) this._scheduleRefresh(); });
    const unsubRemove = entities.onRemove(_ => this._scheduleRefresh());
    // Vitals stream (separate from onUpdate) — pet HP/MP/Stamina deltas
    // arrive on a dedicated channel that doesn't trigger position lerps.
    const unsubVitals = entities.onVitalsUpdate(e => { if (isPanelKind(e)) this._scheduleRefresh(); });
    this.cleanup.push(unsubPlayer, unsubAdd, unsubUpdate, unsubRemove, unsubVitals);

    this._loadClusterOrder();
    this._wireRosterDelegation();
    this._refresh();
  }

  /** One delegated click listener on the roster container handles target +
   *  focus + sort for every row, regardless of whether the card was just
   *  built or has been around for many refreshes. Removes the class of bug
   *  where a per-row listener silently fails to attach (which manifested
   *  as one specific row swallowing clicks). */
  private _wireRosterDelegation(): void {
    const roster = this.root.querySelector<HTMLElement>('#pw-roster');
    if (!roster) return;
    roster.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Sort arrows — handle and bail. dataset['sortDir'] is '-1' or '1'.
      const sortBtn = target.closest<HTMLElement>('.pw-sort-btn');
      if (sortBtn && !sortBtn.hasAttribute('disabled')) {
        e.stopPropagation();
        const card    = sortBtn.closest<HTMLElement>('.pw-member');
        const ownerId = card?.dataset['memberId'];
        const dir     = sortBtn.dataset['sortDir'] === '-1' ? -1 : 1;
        if (ownerId) this._moveCluster(ownerId, dir);
        return;
      }

      // Row click — find the .pw-member ancestor.
      const card = target.closest<HTMLElement>('.pw-member');
      if (!card) return;
      const id   = card.dataset['memberId'];
      const name = card.dataset['memberName'] ?? '';
      if (!id) return;

      // Self can't be focused (Ctrl+click is a no-op for self) — falls
      // through to plain target so clicking your own row lands you on yourself.
      const isSelf = id === this.player.id;
      if (e.ctrlKey && !isSelf) {
        if (this.player.focusTargetId === id) this.player.clearFocusTarget();
        else                                   this.player.setFocusTarget(id, name);
      } else {
        this.player.setTarget(id, name);
      }
    });
  }

  get isVisible(): boolean { return this._visible; }

  show(): void {
    this._userHidden = false;
    this._refresh();
  }

  hide(): void {
    this.root.style.display = 'none';
    this._visible = false;
  }

  toggle(): void {
    // Allow toggle whenever the panel could show — any extended-party row
    // (party member, summoned companion, hireling) OR a pending invite.
    const flatCount = this._buildClusters().reduce((n, c) => n + c.rows.length, 0);
    const hasAnyone = flatCount > 1 || this.player.pendingInvite !== null;
    if (!hasAnyone) return;
    this._userHidden = !this._userHidden;
    this._refresh();
  }

  /** Public: ordered ally ids in panel order (self → own pets → next player → …).
   *  Used by TabTargetService so Ctrl+Tab cycles in the same order the player
   *  sees the panel. */
  getOrderedAllyIds(): string[] {
    const ids: string[] = [];
    for (const cluster of this._buildClusters()) {
      for (const row of cluster.rows) ids.push(row.id);
    }
    return ids;
  }

  dispose(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'party-window';
    el.innerHTML = `
      <style>
        #party-window {
          position: fixed;
          bottom: 80px;
          right: 18px;
          width: 200px;
          pointer-events: none;
          z-index: 60;
        }

        .pw-panel {
          background: rgba(8, 6, 4, 0.78);
          border: 1px solid rgba(200, 145, 60, 0.18);
          box-shadow: 0 2px 12px rgba(0,0,0,0.6);
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          pointer-events: auto;
        }

        .pw-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 4px;
          border-bottom: 1px solid rgba(200,145,60,0.12);
        }

        .pw-title {
          font-family: var(--font-display, serif);
          font-size: 13px;
          color: rgba(212,201,184,0.7);
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .pw-count {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: rgba(212,201,184,0.4);
        }

        /* ── Invite banner ────────────────────────────────────────────── */
        .pw-invite {
          background: rgba(60,40,10,0.6);
          border: 1px solid rgba(200,145,60,0.3);
          padding: 6px 8px;
          font-family: var(--font-body, serif);
          font-size: 11px;
          color: rgba(220,190,140,0.9);
          line-height: 1.4;
          text-align: center;
        }

        .pw-invite-name {
          color: var(--ember, #c86a2a);
          font-style: italic;
        }

        .pw-invite-btns {
          display: flex;
          gap: 6px;
          margin-top: 5px;
          justify-content: center;
        }

        .pw-invite-btn {
          font-family: var(--font-body, serif);
          font-size: 11px;
          padding: 3px 12px;
          border: 1px solid rgba(200,145,60,0.3);
          background: rgba(30,20,8,0.7);
          color: rgba(212,201,184,0.85);
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
        }
        .pw-invite-btn:hover {
          background: rgba(60,40,10,0.8);
          border-color: var(--ember, #c86a2a);
        }
        .pw-invite-btn.accept {
          color: rgba(160,210,130,0.95);
          border-color: rgba(100,160,60,0.35);
        }
        .pw-invite-btn.accept:hover {
          background: rgba(30,50,15,0.7);
          border-color: rgba(100,160,60,0.6);
        }
        .pw-invite-btn.decline {
          color: rgba(210,130,130,0.85);
          border-color: rgba(160,60,60,0.3);
        }
        .pw-invite-btn.decline:hover {
          background: rgba(50,15,15,0.7);
          border-color: rgba(160,60,60,0.55);
        }

        /* ── Member card ──────────────────────────────────────────────── */
        .pw-member {
          display: flex;
          flex-direction: column;
          gap: 2px;
          cursor: pointer;
          padding: 3px 0;
        }
        .pw-member:hover .pw-name {
          color: var(--ember, #c86a2a);
        }
        .pw-member.focused {
          background: rgba(140, 200, 240, 0.06);
          box-shadow: inset 2px 0 0 rgba(140, 200, 240, 0.55);
          padding-left: 4px;
        }
        .pw-member.focused .pw-name::before {
          content: '◆ ';
          color: rgba(140, 200, 240, 0.85);
          font-size: 10px;
        }
        /* Current main target — distinct from focus/sub-target above. Ember
         * highlight on the leading edge plus a brightened name. */
        .pw-member.targeted {
          background: rgba(220, 165, 80, 0.10);
          box-shadow: inset 3px 0 0 rgba(220, 165, 80, 0.85);
          padding-left: 4px;
        }
        .pw-member.targeted .pw-name {
          color: #e8cc88;
        }
        /* If a row is both targeted and focused, stack the indicators by
         * letting targeted's inset shadow override the left edge while
         * focused's diamond glyph still appears next to the name. */
        .pw-member.targeted.focused {
          box-shadow: inset 3px 0 0 rgba(220, 165, 80, 0.85);
        }

        .pw-name-row {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .pw-crown {
          font-size: 11px;
          color: rgba(220,180,60,0.8);
        }

        /* Single-symbol role tag (T, H, R, M♦, etc.). */
        .pw-role {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(212,201,184,0.55);
          background: rgba(40,30,15,0.7);
          border: 1px solid rgba(200,145,60,0.18);
          padding: 0 4px;
          border-radius: 2px;
          min-width: 16px;
          text-align: center;
        }
        .pw-member.kind-companion .pw-role,
        .pw-member.kind-hireling  .pw-role {
          color: rgba(255,170,68,0.8);
        }

        .pw-name {
          flex: 1;
          font-family: var(--font-body, serif);
          font-size: 12px;
          color: rgba(212,201,184,0.85);
          letter-spacing: 0.04em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          transition: color 0.15s;
        }

        /* Pets (companions + hirelings) nested visually under their owner. */
        .pw-member.kind-companion,
        .pw-member.kind-hireling {
          padding-left: 12px;
          border-left: 1px solid rgba(200,145,60,0.15);
          margin-left: 4px;
        }
        .pw-member.kind-companion .pw-name,
        .pw-member.kind-hireling  .pw-name {
          font-size: 11px;
          color: rgba(212,201,184,0.7);
        }

        /* Up/down sort arrows on player rows — hidden until hover. */
        .pw-sort {
          display: flex;
          flex-direction: column;
          gap: 1px;
          opacity: 0;
          transition: opacity 0.12s;
        }
        .pw-member:hover .pw-sort { opacity: 1; }
        .pw-sort-btn {
          font-family: var(--font-mono, monospace);
          font-size: 9px;
          line-height: 1;
          padding: 1px 3px;
          background: rgba(30,20,8,0.7);
          border: 1px solid rgba(200,145,60,0.25);
          color: rgba(212,201,184,0.7);
          cursor: pointer;
        }
        .pw-sort-btn:hover { background: rgba(60,40,10,0.9); border-color: var(--ember, #c86a2a); }
        .pw-sort-btn:disabled { opacity: 0.3; cursor: default; }

        .pw-hp-pct {
          font-family: var(--font-mono, monospace);
          font-size: 10px;
          color: rgba(212,201,184,0.55);
          min-width: 32px;
          text-align: right;
        }

        /* ── Bars ─────────────────────────────────────────────────────── */
        .pw-bars {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .pw-bar {
          height: 5px;
          background: rgba(10,8,6,0.6);
          position: relative;
          overflow: hidden;
        }

        .pw-bar-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          transition: transform 0.25s ease;
        }

        .pw-bar-fill.hp   { background: linear-gradient(90deg, #5a0f0f, #8b2020); }
        /* MP gets a more solid (less gradient-y) blue per the playtest note —
         * the healer's bar needs to read clearly so tanks know not to charge
         * forward when they're out of resources. */
        .pw-bar-fill.mp   { background: #2a5aba; }
        .pw-bar-fill.st   { background: linear-gradient(90deg, #152e0a, #2d5a1e); }

        /* Stamina is the least load-bearing bar — slimmer so HP + MP read
         * first. Anyone not playing a stamina build can ignore it. */
        .pw-bar-st { height: 3px; }

        .pw-member.dead .pw-name {
          color: rgba(120,80,80,0.6);
          text-decoration: line-through;
        }
        .pw-member.dead .pw-hp-pct {
          color: rgba(120,80,80,0.5);
        }
      </style>

      <div class="pw-panel">
        <div class="pw-header">
          <span class="pw-title">Party</span>
          <span class="pw-count" id="pw-count"></span>
        </div>
        <div id="pw-invite"></div>
        <div id="pw-roster"></div>
      </div>
    `;

    return el;
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._refresh();
    });
  }

  private _refresh(): void {
    const clusters = this._buildClusters();
    const flatRows: PartyRow[] = [];
    for (const c of clusters) for (const r of c.rows) flatRows.push(r);

    const hasInvite = this.player.pendingInvite !== null;
    // Show panel whenever there's anyone to see (extended party has more
    // than just self) or an invite is pending. Solo with no companion + no
    // hireling collapses cleanly.
    const hasAnyone = flatRows.length > 1 || hasInvite;

    if (hasAnyone && !this._userHidden) {
      this.root.style.display = 'block';
      this._visible = true;
    } else {
      this.root.style.display = 'none';
      this._visible = false;
      if (!hasAnyone) this._userHidden = false;
      if (!hasAnyone) { this._lastSig = ''; return; }
      return;
    }

    // ── Invite banner ──────────────────────────────────────────────────────
    const inviteEl = this.root.querySelector<HTMLElement>('#pw-invite')!;
    const invite = this.player.pendingInvite;
    if (invite) {
      inviteEl.innerHTML = `
        <div class="pw-invite">
          <span class="pw-invite-name">${this._esc(invite.fromName)}</span> invites you
          <div class="pw-invite-btns">
            <button class="pw-invite-btn accept" data-action="accept">Accept</button>
            <button class="pw-invite-btn decline" data-action="decline">Decline</button>
          </div>
        </div>
      `;
      inviteEl.querySelector('[data-action="accept"]')!.addEventListener('click', () => {
        this.socket.sendCommand('/party accept');
      });
      inviteEl.querySelector('[data-action="decline"]')!.addEventListener('click', () => {
        this.socket.sendCommand('/party decline');
      });
    } else {
      inviteEl.innerHTML = '';
    }

    // ── Count ──────────────────────────────────────────────────────────────
    const countEl = this.root.querySelector<HTMLElement>('#pw-count')!;
    const playerCount = clusters.length;
    countEl.textContent = playerCount > 0 ? `${playerCount}` : '';

    // ── Roster ─────────────────────────────────────────────────────────────
    // Structural signature: row identities + ordering. If only HP/role
    // changed, skip the full DOM rebuild and just patch the bars/tags.
    const sig = flatRows.map(r => `${r.kind}:${r.id}:${r.clusterIndex}`).join('|');
    const needsRebuild = sig !== this._lastSig;
    this._lastSig = sig;

    const roster = this.root.querySelector<HTMLElement>('#pw-roster')!;
    const allies = this.player.partyAllies;

    if (needsRebuild) {
      roster.innerHTML = '';
      for (const row of flatRows) {
        roster.appendChild(this._buildMemberCard(row));
      }
    }

    // Disable sort arrows that would walk off either end. Recomputed every
    // refresh so reordering updates the disabled state immediately.
    const cardsArr = Array.from(roster.querySelectorAll<HTMLElement>('.pw-member'));
    cardsArr.forEach(card => {
      const idx = parseInt(card.dataset['clusterIndex'] ?? '-1', 10);
      const tot = parseInt(card.dataset['totalClusters'] ?? '0', 10);
      const up   = card.querySelector<HTMLButtonElement>('.pw-sort-btn.up');
      const down = card.querySelector<HTMLButtonElement>('.pw-sort-btn.down');
      if (up)   up.disabled   = idx <= 0;
      if (down) down.disabled = idx >= tot - 1;
    });

    // Update bars in-place every refresh, even when DOM didn't rebuild.
    const cards = roster.querySelectorAll<HTMLElement>('.pw-member');
    cards.forEach(card => {
      const id = card.dataset['memberId']!;
      const isSelf = id === this.player.id;
      const entity = this.entities.get(id);
      const ally   = allies.find(a => a.entityId === id);

      // ── Vitals resolution ─────────────────────────────────────────────
      //   Self  → PlayerState.health/mana/stamina (live, server-pushed via
      //           state_update.character)
      //   Pet   → entity.health/mana/stamina (server pushes vitals on
      //           companion/hireling entity payloads — see Zone broadcasts)
      //   Other → entity.health for in-zone HP; ally.{hp,mana,stamina}Pct
      //           fallback for cross-zone party members
      let hpPct: number | null = null;
      let mpPct: number | null = null;
      let stPct: number | null = null;
      let isAlive = true;

      if (isSelf) {
        const ph = this.player.health, pm = this.player.mana, ps = this.player.stamina;
        if (ph.max > 0) hpPct = ph.current / ph.max;
        if (pm.max > 0) mpPct = pm.current / pm.max;
        if (ps.max > 0) stPct = ps.current / ps.max;
      } else if (entity) {
        const eh = entity.health, em = entity.mana, es = entity.stamina;
        if (eh && eh.max > 0) hpPct = eh.current / eh.max;
        if (em && em.max > 0) mpPct = em.current / em.max;
        if (es && es.max > 0) stPct = es.current / es.max;
        isAlive = entity.isAlive !== false;
      }
      // Cross-zone fallback for party members not in this zone's registry.
      if (!entity && !isSelf && ally) {
        if (ally.hpPct      !== undefined) hpPct = ally.hpPct      / 100;
        if (ally.manaPct    !== undefined) mpPct = ally.manaPct    / 100;
        if (ally.staminaPct !== undefined) stPct = ally.staminaPct / 100;
        isAlive = ally.isAlive !== false;
      }

      card.classList.toggle('dead', !isAlive);
      card.classList.toggle('focused', this.player.focusTargetId === id);
      // Main-target highlight — reflects whatever the player has currently
      // targeted (mouse click, Tab cycle, d-pad U/D). Updates automatically
      // because the constructor wires _scheduleRefresh to player.onChange.
      card.classList.toggle('targeted', this.player.targetId === id);

      // Role tag — refresh on every pass since players' role changes when
      // they re-slot passives (PASSIVE_LOADOUT_CHANGED → entity update).
      const roleEl = card.querySelector<HTMLElement>('.pw-role');
      if (roleEl && entity?.role) roleEl.textContent = entity.role;

      const hpPctEl = card.querySelector<HTMLElement>('.pw-hp-pct');
      if (hpPctEl) hpPctEl.textContent = hpPct !== null ? `${Math.round(hpPct * 100)}%` : '';

      this._setBar(card, '.pw-bar-hp', '.pw-bar-fill.hp', hpPct);
      this._setBar(card, '.pw-bar-mp', '.pw-bar-fill.mp', mpPct);
      this._setBar(card, '.pw-bar-st', '.pw-bar-fill.st', stPct);
    });
  }

  /** Show + scale a bar when pct is non-null, hide otherwise. */
  private _setBar(
    card: HTMLElement,
    barSelector: string,
    fillSelector: string,
    pct: number | null,
  ): void {
    const bar  = card.querySelector<HTMLElement>(barSelector);
    const fill = card.querySelector<HTMLElement>(fillSelector);
    if (!bar || !fill) return;
    if (pct === null) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
  }

  // ── Cluster building ─────────────────────────────────────────────────────

  /** Build the ordered cluster list. Clusters group {owner → their pets}.
   *  Self is always one cluster. Other party members are clusters too.
   *  Order is _clusterOrder, with new owners appended and missing ones dropped. */
  private _buildClusters(): PartyCluster[] {
    const selfId   = this.player.id;
    const selfName = this.player.name || 'You';
    const leaderId = this.player.partyLeaderId;
    const members  = this.player.partyMembers;

    // Owner roster. In a party, members already includes self; solo: just self.
    const owners: { id: string; name: string }[] = [];
    if (members.length > 0) {
      owners.push(...members.map(m => ({ id: m.id, name: m.name })));
    } else {
      owners.push({ id: selfId, name: selfName });
    }

    // Reconcile saved order with current owners. Append unknowns at end,
    // drop owners no longer present. _saveClusterOrder if anything shifted.
    const ordered: string[] = [];
    for (const id of this._clusterOrder) {
      if (owners.some(o => o.id === id)) ordered.push(id);
    }
    for (const o of owners) {
      if (!ordered.includes(o.id)) ordered.push(o.id);
    }
    if (ordered.length !== this._clusterOrder.length || ordered.some((id, i) => id !== this._clusterOrder[i])) {
      this._clusterOrder = ordered;
      this._saveClusterOrder();
    }

    // Index pets by owner id (single pass over the entity registry).
    const petsByOwner = new Map<string, Entity[]>();
    for (const e of this.entities.getAll()) {
      const t = (e.type ?? '').toLowerCase();
      if (t !== 'companion' && t !== 'hireling') continue;
      const owner = e.ownerCharacterId;
      if (!owner) continue;
      const list = petsByOwner.get(owner) ?? [];
      list.push(e);
      petsByOwner.set(owner, list);
    }

    const clusters: PartyCluster[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const ownerId   = ordered[i]!;
      const ownerInfo = owners.find(o => o.id === ownerId)!;
      const isSelf    = ownerId === selfId;
      const isLeader  = ownerId === leaderId;
      const ownerEntity = this.entities.get(ownerId);
      const ownerRole   = ownerEntity?.role ?? '?';

      const ownerRow: PartyRow = {
        kind:             'player',
        id:               ownerId,
        name:             ownerInfo.name,
        role:             ownerRole,
        ownerId:          null,
        isLeader,
        isSelf,
        showSortControls: true,
        clusterIndex:     i,
        totalClusters:    ordered.length,
      };
      const rows: PartyRow[] = [ownerRow];

      // Pets: companion before hirelings, hirelings in stable id order.
      const pets = (petsByOwner.get(ownerId) ?? []).slice();
      pets.sort((a, b) => {
        const ta = (a.type ?? '').toLowerCase();
        const tb = (b.type ?? '').toLowerCase();
        if (ta !== tb) return ta === 'companion' ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
      for (const pet of pets) {
        const kind = (pet.type ?? '').toLowerCase() === 'companion' ? 'companion' : 'hireling';
        rows.push({
          kind,
          id:               pet.id,
          name:             pet.name,
          role:             pet.role ?? '?',
          ownerId,
          isLeader:         false,
          isSelf:           false,
          showSortControls: false,
          clusterIndex:     i,
          totalClusters:    ordered.length,
        });
      }

      clusters.push({ ownerId, ownerName: ownerInfo.name, isSelf, isLeader, rows });
    }

    return clusters;
  }

  // ── Cluster sort persistence ─────────────────────────────────────────────

  private _storageKey(): string {
    const partyKey = this.player.partyId ?? 'solo';
    return `partyOrder:${this.player.id}:${partyKey}`;
  }

  private _loadClusterOrder(): void {
    try {
      const raw = localStorage.getItem(this._storageKey());
      this._clusterOrder = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      this._clusterOrder = [];
    }
  }

  private _saveClusterOrder(): void {
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._clusterOrder));
    } catch {
      /* localStorage full / disabled — non-fatal, order just won't persist. */
    }
  }

  private _moveCluster(ownerId: string, dir: -1 | 1): void {
    const idx = this._clusterOrder.indexOf(ownerId);
    if (idx === -1) return;
    const next = idx + dir;
    if (next < 0 || next >= this._clusterOrder.length) return;
    const arr = [...this._clusterOrder];
    [arr[idx], arr[next]] = [arr[next]!, arr[idx]!];
    this._clusterOrder = arr;
    this._saveClusterOrder();
    this._lastSig = ''; // force a structural rebuild
    this._refresh();
  }

  // ── Card builder ─────────────────────────────────────────────────────────

  private _buildMemberCard(row: PartyRow): HTMLElement {
    const card = document.createElement('div');
    card.className = `pw-member kind-${row.kind}`;
    card.dataset['memberId']      = row.id;
    card.dataset['memberName']    = row.name;
    card.dataset['clusterIndex']  = String(row.clusterIndex);
    card.dataset['totalClusters'] = String(row.totalClusters);

    // Sort buttons carry their direction in dataset so the delegated click
    // handler on #pw-roster can read it without a per-button listener.
    const sortBtns = row.showSortControls && row.totalClusters > 1
      ? `<div class="pw-sort">
           <button class="pw-sort-btn up"   data-sort-dir="-1" title="Move up">▲</button>
           <button class="pw-sort-btn down" data-sort-dir="1"  title="Move down">▼</button>
         </div>`
      : '';

    const crown = row.isLeader ? '<span class="pw-crown" title="Party Leader">&#9733;</span>' : '';
    const role  = row.role || '?';

    card.innerHTML = `
      <div class="pw-name-row">
        ${crown}
        <span class="pw-role" title="Role">${this._esc(role)}</span>
        <span class="pw-name">${this._esc(row.name)}</span>
        <span class="pw-hp-pct"></span>
        ${sortBtns}
      </div>
      <div class="pw-bars">
        <div class="pw-bar pw-bar-hp" title="Health"  style="display:none"><div class="pw-bar-fill hp"></div></div>
        <div class="pw-bar pw-bar-mp" title="Mana"    style="display:none"><div class="pw-bar-fill mp"></div></div>
        <div class="pw-bar pw-bar-st" title="Stamina" style="display:none"><div class="pw-bar-fill st"></div></div>
      </div>
    `;

    return card;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
