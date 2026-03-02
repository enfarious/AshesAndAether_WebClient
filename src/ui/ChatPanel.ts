import type { WorldState, ChatEntry } from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';

/**
 * ChatPanel — scrolling chat log with a text input for /say, /shout, /emote etc.
 *
 * Channels are colour-coded to match the dark fantasy aesthetic.
 */
export class ChatPanel {
  private root:     HTMLElement;
  private log:      HTMLElement;
  private input:    HTMLInputElement;
  private cleanup:  (() => void)[] = [];

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly world:  WorldState,
    private readonly socket: SocketClient,
  ) {
    this.root  = document.createElement('div');
    this.log   = document.createElement('div');
    this.input = document.createElement('input');
    this._build();
    uiRoot.appendChild(this.root);

    // Replay existing chat log
    for (const entry of world.chatLog) {
      this._appendEntry(entry);
    }

    const unsub = world.onChat(entry => this._appendEntry(entry));
    this.cleanup.push(unsub);
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
      .chat-line.world  { color: #c090d0; }
      .chat-line.event  { color: #a09070; font-style: italic; }
      .chat-line.cfh    { color: #e04040; }
      .chat-line.whisper { color: #d0a0d0; font-style: italic; }
      .chat-line.system  { color: #7090a8; font-style: italic; }

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

    this.input.id          = 'chat-input';
    this.input.type        = 'text';
    this.input.placeholder = 'say, /shout, /emote, /p, /w, /r…';
    this.input.maxLength   = 512;
    this.input.addEventListener('keydown', this._onInputKey);

    this.root.appendChild(this.log);
    this.root.appendChild(this.input);
  }

  private _onInputKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this._sendChat(text);
  };

  private _sendChat(text: string): void {
    console.log(`[ChatPanel] _sendChat → "${text}"`);
    if (text.startsWith('/shout ')) {
      this.socket.sendChat('shout', text.slice(7));
    } else if (text.startsWith('/emote ') || text.startsWith('/me ')) {
      this.socket.sendChat('emote', text.startsWith('/me ') ? text.slice(4) : text.slice(7));
    } else if (text.startsWith('/p ') && !text.startsWith('/party')) {
      // /p <message> — party chat shorthand.
      this.socket.sendChat('party', text.slice(3));
    } else if (text.startsWith('/party ') || text === '/party') {
      // /party is a server command (invite, accept, decline, leave, kick, lead, list).
      this.socket.sendCommand(text);
    } else if (text.startsWith('/r ') || text.startsWith('/reply ')) {
      // /r or /reply — whisper to the last person who told us.
      const prefix  = text.startsWith('/r ') ? '/r ' : '/reply ';
      const message = text.slice(prefix.length);
      const target  = this.world.lastWhisperSender;
      if (!target) {
        this.world.pushMessage('system', 'No one has whispered you yet.');
        return;
      }
      this.socket.sendCommand(`/tell ${target} ${message}`);
    } else if (text.startsWith('/w ')) {
      // /w <name> <message> — whisper shorthand, routed as /tell.
      const parts   = text.slice(3).split(' ');
      const target  = parts.shift() ?? '';
      const message = parts.join(' ');
      this.socket.sendCommand(`/tell ${target} ${message}`);
    } else if (text.startsWith('/')) {
      // Send as a slash command — server CommandParser requires the leading '/'.
      this.socket.sendCommand(text);
    } else {
      this.socket.sendChat('say', text);
    }
  }

  private _appendEntry(entry: ChatEntry): void {
    const line = document.createElement('div');
    line.className = `chat-line ${entry.channel}`;

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
