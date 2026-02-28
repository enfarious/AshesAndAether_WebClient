import type {
  ZoneInfo,
  EventPayload,
  CommunicationPayload,
  ProximityRosterPayload,
  ProximityRosterDeltaPayload,
  ProximityChannels,
} from '@/network/Protocol';

type Listener = () => void;
type ChatListener = (entry: ChatEntry) => void;
type EventListener = (event: EventPayload) => void;

export interface ChatEntry {
  id:        string;
  timestamp: number;
  channel:   string;
  sender:    string;
  content:   string;
  distance?: number;
}

/**
 * WorldState — zone data, proximity roster, chat log, and game events.
 *
 * Represents the "world around the player" rather than the player themselves.
 */
export class WorldState {
  private _zone: ZoneInfo | null = null;
  private _proximity: ProximityRosterPayload | null = null;
  private _dangerState = false;

  private _chatLog: ChatEntry[] = [];
  private _chatCounter = 0;

  private readonly MAX_CHAT = 200;

  private zoneListeners      = new Set<Listener>();
  private proximityListeners = new Set<Listener>();
  private chatListeners      = new Set<ChatListener>();
  private eventListeners     = new Set<EventListener>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get zone():        ZoneInfo | null            { return this._zone; }
  get proximity():   ProximityRosterPayload | null { return this._proximity; }
  get dangerState(): boolean                    { return this._dangerState; }
  get chatLog():     ChatEntry[]                { return this._chatLog; }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyZone(zone: ZoneInfo): void {
    this._zone = { ...zone };
    this._notifyZone();
  }

  applyZonePartial(partial: Partial<ZoneInfo>): void {
    if (!this._zone) return;
    this._zone = { ...this._zone, ...partial };
    this._notifyZone();
  }

  applyProximityRoster(payload: ProximityRosterPayload): void {
    this._proximity    = payload;
    this._dangerState  = payload.dangerState;
    this._notifyProximity();
  }

  applyProximityDelta(delta: ProximityRosterDeltaPayload): void {
    if (!this._proximity) return;

    if (delta.dangerState !== undefined) {
      this._dangerState = delta.dangerState;
    }

    if (!delta.channels) {
      this._notifyProximity();
      return;
    }

    const channels = { ...this._proximity.channels } as ProximityChannels;

    for (const [key, channelDelta] of Object.entries(delta.channels)) {
      const k = key as keyof ProximityChannels;
      if (!channelDelta) continue;

      let channel = { ...channels[k] };
      const entityMap = new Map(channel.entities.map(e => [e.id, e]));

      if (channelDelta.removed) {
        for (const id of channelDelta.removed) entityMap.delete(id);
      }
      if (channelDelta.added) {
        for (const e of channelDelta.added) entityMap.set(e.id, e);
      }
      if (channelDelta.updated) {
        for (const upd of channelDelta.updated) {
          const existing = entityMap.get(upd.id);
          if (existing) {
            entityMap.set(upd.id, {
              ...existing,
              bearing:   upd.bearing   ?? existing.bearing,
              elevation: upd.elevation ?? existing.elevation,
              range:     upd.range     ?? existing.range,
            });
          }
        }
      }
      if (channelDelta.count   !== undefined) channel.count   = channelDelta.count;
      if (channelDelta.sample  !== undefined) channel.sample  = channelDelta.sample;
      if (channelDelta.lastSpeaker !== undefined) {
        channel.lastSpeaker = channelDelta.lastSpeaker ?? undefined;
      }

      channel.entities = Array.from(entityMap.values());
      channels[k] = channel;
    }

    this._proximity = { channels, dangerState: this._dangerState };
    this._notifyProximity();
  }

  /**
   * Push a synthetic message directly into the chat log.
   * Used for server feedback (command responses, system errors) that
   * don't arrive via the normal communication channel.
   */
  pushMessage(channel: string, content: string, sender = ''): void {
    const entry: ChatEntry = {
      id:        `sys-${++this._chatCounter}`,
      timestamp: Date.now(),
      channel,
      sender,
      content,
    };
    this._chatLog.push(entry);
    if (this._chatLog.length > this.MAX_CHAT) this._chatLog.shift();
    this.chatListeners.forEach(fn => fn(entry));
  }

  onCommunication(payload: CommunicationPayload): void {
    const entry: ChatEntry = {
      id:        `chat-${++this._chatCounter}`,
      timestamp: payload.timestamp,
      channel:   payload.channel,
      sender:    payload.senderName,
      content:   payload.content,
      distance:  payload.distance,
    };
    this._chatLog.push(entry);
    if (this._chatLog.length > this.MAX_CHAT) {
      this._chatLog.shift();
    }
    this.chatListeners.forEach(fn => fn(entry));
  }

  onGameEvent(payload: EventPayload): void {
    if (payload.narrative) {
      const entry: ChatEntry = {
        id:        `event-${++this._chatCounter}`,
        timestamp: payload.timestamp,
        channel:   'event',
        sender:    '',
        content:   payload.narrative,
      };
      this._chatLog.push(entry);
      if (this._chatLog.length > this.MAX_CHAT) this._chatLog.shift();
      this.chatListeners.forEach(fn => fn(entry));
    }
    this.eventListeners.forEach(fn => fn(payload));
  }

  clear(): void {
    this._zone       = null;
    this._proximity  = null;
    this._dangerState = false;
    this._chatLog    = [];
    this._notifyZone();
    this._notifyProximity();
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  onZoneChange(fn: Listener):      () => void { this.zoneListeners.add(fn);      return () => this.zoneListeners.delete(fn); }
  onProximityChange(fn: Listener): () => void { this.proximityListeners.add(fn); return () => this.proximityListeners.delete(fn); }
  onChat(fn: ChatListener):        () => void { this.chatListeners.add(fn);      return () => this.chatListeners.delete(fn); }
  onEvent(fn: EventListener):      () => void { this.eventListeners.add(fn);     return () => this.eventListeners.delete(fn); }

  private _notifyZone():      void { this.zoneListeners.forEach(fn => fn()); }
  private _notifyProximity(): void { this.proximityListeners.forEach(fn => fn()); }
}
