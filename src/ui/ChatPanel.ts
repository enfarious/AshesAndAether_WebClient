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
        width: clamp(260px, 28vw, 400px);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      #chat-log {
        height: clamp(120px, 20vh, 240px);
        overflow-y: auto;
        padding: 6px 8px;
        background: var(--ui-bg);
        border: 1px solid var(--ui-border);
        display: flex;
        flex-direction: column;
        gap: 2px;
        scrollbar-width: thin;
        scrollbar-color: var(--ember) transparent;
      }

      #chat-log::-webkit-scrollbar { width: 4px; }
      #chat-log::-webkit-scrollbar-thumb { background: var(--ember); border-radius: 2px; }

      .chat-line {
        font-size: 15px;
        line-height: 1.45;
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
        font-size: 15px;
        padding: 6px 8px;
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
    this.input.placeholder = 'say, /shout, /emote, /party…';
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
    if (text.startsWith('/shout ')) {
      this.socket.sendChat('shout', text.slice(7));
    } else if (text.startsWith('/emote ') || text.startsWith('/me ')) {
      this.socket.sendChat('emote', text.startsWith('/me ') ? text.slice(4) : text.slice(7));
    } else if (text.startsWith('/party ')) {
      this.socket.sendChat('party', text.slice(7));
    } else if (text.startsWith('/w ')) {
      const parts   = text.slice(3).split(' ');
      const target  = parts.shift() ?? '';
      const message = parts.join(' ');
      this.socket.sendChat('whisper', message, target);
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

    const content = document.createTextNode(
      entry.channel === 'emote' ? ` ${entry.content}` : entry.content
    );
    line.appendChild(content);

    this.log.appendChild(line);
    this.log.scrollTop = this.log.scrollHeight;
  }
}
