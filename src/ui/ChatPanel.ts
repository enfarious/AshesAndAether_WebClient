import type { WorldState, ChatEntry } from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';
import type { PlayerState } from '@/state/PlayerState';

/**
 * ChatPanel — scrolling chat log with a text input for /say, /shout, /emote etc.
 *
 * Channels are colour-coded to match the dark fantasy aesthetic.
 */
export class ChatPanel {
  private root:     HTMLElement;
  private tabBar:   HTMLElement;
  private log:      HTMLElement;
  private input:    HTMLInputElement;
  private cleanup:  (() => void)[] = [];

  /** Active tab id; affects which CSS class is on the root. */
  private _activeTab: 'all' | 'chat' | 'events' | 'system' = 'all';
  /** Per-tab unread counts (cleared when that tab becomes active). */
  private _unread: Record<'chat' | 'events' | 'system', number> = { chat: 0, events: 0, system: 0 };
  private registerCallback:      (() => void) | null = null;
  private quitCallback:          (() => void) | null = null;
  private shutdownCallback:      (() => void) | null = null;
  private companionChatCallback: ((message: string) => void) | null = null;
  private telegraphToggleCallback: ((on: boolean) => void) | null = null;

  setRegisterCallback(fn: () => void): void      { this.registerCallback = fn; }
  setQuitCallback(fn: () => void): void           { this.quitCallback = fn; }
  setShutdownCallback(fn: () => void): void       { this.shutdownCallback = fn; }
  setCompanionChatCallback(fn: (message: string) => void): void { this.companionChatCallback = fn; }
  setTelegraphToggleCallback(fn: (on: boolean) => void): void { this.telegraphToggleCallback = fn; }

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly world:  WorldState,
    private readonly socket: SocketClient,
    private readonly player: PlayerState,
  ) {
    this.root   = document.createElement('div');
    this.tabBar = document.createElement('div');
    this.log    = document.createElement('div');
    this.input  = document.createElement('input');
    this._build();
    uiRoot.appendChild(this.root);

    // Replay existing chat log
    for (const entry of world.chatLog) {
      this._appendEntry(entry);
    }

    const unsub = world.onChat(entry => this._appendEntry(entry));
    this.cleanup.push(unsub);

    window.addEventListener('keydown', this._onGlobalKey);
    this.cleanup.push(() => window.removeEventListener('keydown', this._onGlobalKey));
  }

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    this.root.remove();
  }

  private _build(): void {
    this.root.id = 'chat-panel';

    const style = document.createElement('style');
    style.textContent = `
      #chat-panel {
        position: absolute;
        bottom: 72px;
        left: 16px;
        width: clamp(320px, 34vw, 520px);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      #chat-log {
        height: clamp(160px, 22vh, 320px);
        overflow-y: auto;
        padding: 8px 10px;
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        display: flex;
        flex-direction: column;
        gap: 3px;
        scrollbar-width: thin;
        scrollbar-color: var(--ember) transparent;
      }

      /* ── Tabs ─────────────────────────────────────────────────────────── */
      #chat-tabs {
        display: flex;
        gap: 2px;
      }
      .chat-tab {
        flex: 1;
        padding: 4px 8px;
        background: rgba(8, 6, 4, 0.78);
        border: 1px solid var(--ui-border);
        border-bottom: none;
        color: rgba(212, 201, 184, 0.75);
        font-family: var(--font-body);
        font-size: 13px;
        letter-spacing: 0.06em;
        text-align: center;
        cursor: pointer;
        position: relative;
        user-select: none;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .chat-tab:hover { background: rgba(20, 14, 6, 0.9); color: rgba(232, 218, 188, 0.95); }
      .chat-tab.active {
        background: var(--ui-bg);
        color: #f4d488;
        border-color: var(--ember);
      }
      .chat-tab .chat-tab-dot {
        display: none;
        width: 6px; height: 6px;
        border-radius: 50%;
        background: #d4a04a;
        margin-left: 6px;
        vertical-align: middle;
      }
      .chat-tab.has-unread .chat-tab-dot { display: inline-block; }

      /* Tab filtering — root carries an active class; CSS hides lines that
         don't belong. Single underlying log preserves chronological order. */
      #chat-panel.tab-active-chat   .chat-line:not(.tab-chat)   { display: none; }
      #chat-panel.tab-active-events .chat-line:not(.tab-events) { display: none; }
      #chat-panel.tab-active-system .chat-line:not(.tab-system) { display: none; }
      /* tab-active-all shows everything (no rule needed) */

      #chat-log::-webkit-scrollbar { width: 4px; }
      #chat-log::-webkit-scrollbar-thumb { background: var(--ember); border-radius: 2px; }

      .chat-line {
        font-size: 19px;
        line-height: 1.5;
        font-family: var(--font-body);
        word-break: break-word;
      }

      .chat-line .sender {
        font-weight: 600;
        margin-right: 4px;
      }

      .chat-line.say    { color: #c8c0b0; }
      .chat-line.shout  { color: #e08040; }
      .chat-line.emote  { color: #90a870; font-style: italic; }
      .chat-line.party  { color: #70a0d0; }
      .chat-line.guild  { color: #60c890; }
      .chat-line.world  { color: #c090d0; }
      /* Base event line — warm grey italic. Overridden by per-family
         modifiers below so heal lines read green, hits red, etc. */
      .chat-line.event  { color: #a09070; font-style: italic; }
      .chat-line.event-hit    { color: #e87060; }              /* damage dealt/taken */
      .chat-line.event-miss   { color: #808080; }              /* whiff / dodge / parry */
      .chat-line.event-heal   { color: #70d088; }              /* heals */
      .chat-line.event-buff   { color: #f0c870; }              /* positive buff applied */
      .chat-line.event-debuff { color: #c878d8; }              /* debuff applied */
      .chat-line.event-death  { color: #c0c0c0; font-weight: 700; } /* "X has died" */
      .chat-line.cfh    { color: #e04040; }
      .chat-line.whisper { color: #d0a0d0; font-style: italic; }
      .chat-line.system    { color: #7090a8; font-style: italic; }
      .chat-line.companion { color: #50c8c8; }

      #chat-input {
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        color: var(--bone);
        font-family: var(--font-body);
        font-size: 19px;
        padding: 8px 10px;
        outline: none;
        width: 100%;
      }

      #chat-input:focus {
        border-color: var(--ember);
      }

      #chat-input::placeholder {
        color: var(--muted);
        font-style: italic;
      }
    `;
    document.head.appendChild(style);

    this.log.id = 'chat-log';

    // Tab bar
    this.tabBar.id = 'chat-tabs';
    const tabs: { id: 'all' | 'chat' | 'events' | 'system'; label: string }[] = [
      { id: 'all',    label: 'All' },
      { id: 'chat',   label: 'Chat' },
      { id: 'events', label: 'Events' },
      { id: 'system', label: 'System' },
    ];
    for (const t of tabs) {
      const btn = document.createElement('div');
      btn.className = 'chat-tab';
      btn.dataset['tab'] = t.id;
      btn.innerHTML = `<span class="chat-tab-label">${t.label}</span><span class="chat-tab-dot"></span>`;
      btn.addEventListener('click', () => this._switchTab(t.id));
      this.tabBar.appendChild(btn);
    }

    this.input.id          = 'chat-input';
    this.input.type        = 'text';
    this.input.placeholder = 'say, /shout, /emote, /p, /w, /r, /cc…';
    this.input.maxLength   = 512;
    this.input.addEventListener('keydown', this._onInputKey);

    this.root.appendChild(this.tabBar);
    this.root.appendChild(this.log);
    this.root.appendChild(this.input);

    this._switchTab('all');
  }

  /** Map a chat channel to which tabs the entry should appear in. */
  private _tabsForChannel(channel: string): Array<'chat' | 'events' | 'system'> {
    switch (channel) {
      case 'say': case 'shout': case 'emote':
      case 'party': case 'guild': case 'world':
      case 'whisper': case 'companion':
        return ['chat'];
      case 'event': case 'cfh':
        return ['events'];
      case 'system':
        return ['system'];
      default:
        // Unknown channel — surface in System so it's not silently filtered.
        return ['system'];
    }
  }

  private _switchTab(id: 'all' | 'chat' | 'events' | 'system'): void {
    this._activeTab = id;
    this.root.classList.remove('tab-active-all', 'tab-active-chat', 'tab-active-events', 'tab-active-system');
    this.root.classList.add(`tab-active-${id}`);
    // Mark active button + clear unread
    const buttons = this.tabBar.querySelectorAll('.chat-tab');
    buttons.forEach(btn => {
      const tabId = (btn as HTMLElement).dataset['tab'];
      btn.classList.toggle('active', tabId === id);
      if (tabId === id && id !== 'all') {
        btn.classList.remove('has-unread');
        if (id === 'chat' || id === 'events' || id === 'system') {
          this._unread[id] = 0;
        }
      }
    });
    // Scroll log to bottom on tab switch.
    this.log.scrollTop = this.log.scrollHeight;
  }

  private _bumpUnread(tabs: Array<'chat' | 'events' | 'system'>): void {
    for (const t of tabs) {
      if (t === this._activeTab) continue;
      this._unread[t] += 1;
      const btn = this.tabBar.querySelector(`.chat-tab[data-tab="${t}"]`);
      btn?.classList.add('has-unread');
    }
  }

  private _onInputKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.input.value = '';
      this.input.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const text = this.input.value.trim();
    this.input.value = '';
    this.input.blur(); // return focus to game so WASD resumes
    if (text) this._sendChat(text);
  };

  // ── Global hot-keys that open chat ────────────────────────────────────────
  // '/' focuses and seeds the command prefix. (Enter and Space were previously
  // also chat openers, but Enter is now reserved for the TargetWindow menu's
  // "fire selected action" affordance — Tab Tab Enter to engage a target.
  // To open chat, press '/' or click the input.)
  private _onGlobalKey = (e: KeyboardEvent): void => {
    if (this.root.style.display === 'none') return;
    if (this._isTypingTarget(e.target)) return;

    if (e.key === '/') {
      // Let the '/' propagate naturally — the browser will insert it once the
      // input is focused (keypress / input fire after keydown).
      this.input.focus();
    }
  };

  private _isTypingTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return (
      el instanceof HTMLInputElement    ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable
    );
  }

  private _sendChat(text: string): void {
    console.log(`[ChatPanel] _sendChat → "${text}"`);
    if (text === '/register') {
      this.registerCallback?.();
      return;
    }

    // /logout — graceful return to character select (keep socket alive)
    if (text === '/logout') {
      this.world.pushMessage('system', 'Returning to character select…');
      this.socket.sendLogout();
      return;
    }

    // /quit — return to login screen (switch accounts)
    if (text === '/quit' || text === '/exit') {
      this.world.pushMessage('system', 'Returning to login…');
      this.quitCallback?.();
      return;
    }

    // /shutdown — close the client entirely
    if (text === '/shutdown') {
      this.world.pushMessage('system', 'Shutting down…');
      this.shutdownCallback?.();
      return;
    }

    // /telegraphs on|off — client-side render toggle for AoE warning rings.
    // No server round-trip: telegraphs are emitted to everyone in zone; this
    // just hides the local renderer for players who find them noisy.
    if (text === '/telegraphs' || text.startsWith('/telegraphs ')) {
      const arg = text.slice('/telegraphs'.length).trim().toLowerCase();
      const on  = arg === '' ? true : (arg === 'on' || arg === '1' || arg === 'true');
      this.telegraphToggleCallback?.(on);
      this.world.pushMessage('system', `AoE telegraphs ${on ? 'shown' : 'hidden'}.`);
      return;
    }

    // /xpinfo — print the last kill's XP breakdown for live tuning.
    if (text === '/xpinfo') {
      const b = this.player.lastXpBreakdown;
      if (!b) {
        this.world.pushMessage('system', 'No kill XP recorded yet.');
      } else {
        const delta = b.mobLevel - b.recipientLevel;
        const sign  = delta >= 0 ? '+' : '';
        this.world.pushMessage(
          'system',
          `XP: ${b.awardedXp} from ${b.mobName} (Lv ${b.mobLevel}, you Lv ${b.recipientLevel}, ${sign}${delta}) — ` +
          `base ${b.baseXp} × con ${b.conMult.toFixed(2)} × party ${b.partyMult.toFixed(2)} (size ${b.partySize})`,
        );
      }
      return;
    }

    // /cc <message> — companion chat (private, BYOLLM client-side)
    if (text.startsWith('/cc ')) {
      const raw = text.slice(4).trim();
      if (!raw) {
        this.world.pushMessage('system', 'Usage: /cc <message>  —  placeholders: <t> target, <n> your name');
        return;
      }
      const expanded = this._expandPlaceholders(raw);
      // Echo locally so the player sees their own message in the chat log
      this.world.pushMessage('companion', expanded, this.player.name);

      if (this.companionChatCallback) {
        this.companionChatCallback(expanded);
      } else {
        // Legacy fallback: send to server
        this.socket.sendChat('companion', expanded);
      }
      return;
    }

    if (text.startsWith('/say ')) {
      this.socket.sendChat('say', text.slice(5));
    } else if (text.startsWith('/s ') && !text.startsWith('/shout')) {
      this.socket.sendChat('say', text.slice(3));
    } else if (text.startsWith('/shout ')) {
      this.socket.sendChat('shout', text.slice(7));
    } else if (text.startsWith('/emote ') || text.startsWith('/me ')) {
      this.socket.sendChat('emote', text.startsWith('/me ') ? text.slice(4) : text.slice(7));
    } else if (text.startsWith('/p ') && !text.startsWith('/party')) {
      // /p <message> — party chat shorthand.
      this.socket.sendChat('party', text.slice(3));
    } else if (text.startsWith('/party ') || text === '/party') {
      // /party is a server command (invite, accept, decline, leave, kick, lead, list).
      this.socket.sendCommand(text, this._targetContext());
    } else if (text.startsWith('/r ') || text.startsWith('/reply ')) {
      // /r or /reply — whisper to the last person who told us.
      const prefix  = text.startsWith('/r ') ? '/r ' : '/reply ';
      const message = text.slice(prefix.length);
      const target  = this.world.lastWhisperSender;
      if (!target) {
        this.world.pushMessage('system', 'No one has whispered you yet.');
        return;
      }
      this.socket.sendCommand(`/tell ${target} ${message}`, this._targetContext());
    } else if (text.startsWith('/w ')) {
      // /w <name> <message> — whisper shorthand, routed as /tell.
      const parts   = text.slice(3).split(' ');
      const target  = parts.shift() ?? '';
      const message = parts.join(' ');
      this.socket.sendCommand(`/tell ${target} ${message}`, this._targetContext());
    } else if (text.startsWith('/')) {
      // Send as a slash command — server CommandParser requires the leading '/'.
      this.socket.sendCommand(text, this._targetContext());
    } else {
      this.socket.sendChat('say', text);
    }
  }

  /** Build target context payload for sendCommand. */
  private _targetContext(): { currentTarget?: string; focusTarget?: string } {
    const ctx: { currentTarget?: string; focusTarget?: string } = {};
    if (this.player.targetId)      ctx.currentTarget = this.player.targetId;
    if (this.player.focusTargetId) ctx.focusTarget   = this.player.focusTargetId;
    return ctx;
  }

  /** Replace <t>, <n> etc. with live game-state values. */
  private _expandPlaceholders(text: string): string {
    return text
      .replace(/<t>/gi, this.player.targetName ?? 'no target')
      .replace(/<n>/gi, this.player.name || 'unknown');
  }

  private _appendEntry(entry: ChatEntry): void {
    const line = document.createElement('div');
    const tabs = this._tabsForChannel(entry.channel);
    const tabClasses = tabs.map(t => `tab-${t}`).join(' ');
    // Event entries also get a modifier class for the event family so the
    // chat renderer can color heals green, hits red, etc. instead of the
    // single warm-grey treatment all events used to share. Modifier is
    // additive — the base `.event` class still applies (font-style etc.).
    //
    // Damage and debuffs only colorize when INCOMING to the local player
    // (target = me). Outgoing hits and debuffs stay default-coloured so
    // the chat doesn't drown in red when you're the one swinging. Heals
    // and buffs stay always-coloured since they only land on allies.
    const isIncoming = entry.targetId !== undefined && entry.targetId === this.player.id;
    const eventClass = entry.channel === 'event' && entry.eventType
      ? ` ${eventTypeToCssClass(entry.eventType, isIncoming)}`
      : '';
    line.className = `chat-line ${entry.channel}${eventClass} ${tabClasses}`;
    // Bump unread on tabs that aren't currently active.
    this._bumpUnread(tabs);

    if (entry.sender) {
      const sender = document.createElement('span');
      sender.className = 'sender';
      sender.textContent = entry.channel === 'emote'
        ? entry.sender
        : `${entry.sender}:`;
      line.appendChild(sender);
    }

    // Split on newlines so multi-line messages (e.g. /look descriptions) render
    // with proper line breaks without using innerHTML.
    const text  = entry.channel === 'emote' ? ` ${entry.content}` : entry.content;
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      line.appendChild(document.createTextNode(parts[i]!));
      if (i < parts.length - 1) line.appendChild(document.createElement('br'));
    }

    this.log.appendChild(line);
    this.log.scrollTop = this.log.scrollHeight;
  }
}

/** Map a server-side `eventType` to a CSS modifier class on the chat line.
 *  Damage and debuffs only colorize when the local player is the target —
 *  outgoing damage stays default so the chat doesn't drown in red when
 *  you're the aggressor. Heals and buffs colorize regardless (they only
 *  land on allies anyway). Unknown types fall back to the base `.event`
 *  style — new server event families don't break the renderer. */
function eventTypeToCssClass(eventType: string, isIncoming: boolean): string {
  switch (eventType) {
    case 'combat_hit':       return isIncoming ? 'event-hit' : '';
    case 'combat_debuff':    return isIncoming ? 'event-debuff' : '';
    case 'combat_miss':      return 'event-miss';
    case 'combat_heal':      return 'event-heal';
    case 'combat_buff':      return 'event-buff';
    case 'combat_death':
    case 'entity_death':     return 'event-death';
    default:                 return '';
  }
}
