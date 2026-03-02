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
/** Real seconds for one full in-game day — must match server DAY_CYCLE_SECS. */
const DAY_CYCLE_SECS = 1440;

/** Returns the midpoint (0–1) of the named TOD bucket, used when an exact
 *  timeOfDayValue is unavailable. */
function _todBucketMidpoint(tod: string): number {
  switch (tod) {
    case 'dawn':  return 0.208; // midpoint of [0.167, 0.25)
    case 'day':   return 0.500; // midpoint of [0.25,  0.75)
    case 'dusk':  return 0.792; // midpoint of [0.75,  0.833)
    default:      return 0.042; // night — near midnight
  }
}

/** Returns true if value falls inside the expected range for tod string. */
function _todValueInBucket(value: number, tod: string): boolean {
  switch (tod) {
    case 'dawn':  return value >= 0.167 && value < 0.25;
    case 'day':   return value >= 0.25  && value < 0.75;
    case 'dusk':  return value >= 0.75  && value < 0.833;
    default:      return value >= 0.833 || value < 0.167; // night
  }
}

export class WorldState {
  private _zone: ZoneInfo | null = null;
  private _proximity: ProximityRosterPayload | null = null;
  private _dangerState = false;

  // ── Local TOD interpolation ───────────────────────────────────────────────
  // The server sends timeOfDayValue on zone updates; we advance it locally
  // each second so the clock stays accurate between server broadcasts.
  private _todValue: number   = 0.33;
  private _todSyncAt: number  = 0;

  private _chatLog: ChatEntry[] = [];
  private _chatCounter = 0;
  /** Name of the last player who whispered us — used for /r and /reply. */
  private _lastWhisperSender: string | null = null;

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
  /** Name of the last player who whispered us (for /r, /reply). */
  get lastWhisperSender(): string | null        { return this._lastWhisperSender; }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyZone(zone: ZoneInfo): void {
    this._zone = { ...zone };
    if (zone.timeOfDayValue !== undefined) {
      // If the float value and the string bucket disagree (e.g. gateway sent the
      // default 0.33 fallback but the scene string is 'dusk'), trust the string.
      if (zone.timeOfDay && !_todValueInBucket(zone.timeOfDayValue, zone.timeOfDay)) {
        this._todValue = _todBucketMidpoint(zone.timeOfDay);
      } else {
        this._todValue = zone.timeOfDayValue;
      }
      this._todSyncAt = Date.now();
    } else if (zone.timeOfDay) {
      this._todValue  = _todBucketMidpoint(zone.timeOfDay);
      this._todSyncAt = Date.now();
    }
    this._notifyZone();
  }

  applyZonePartial(partial: Partial<ZoneInfo>): void {
    if (!this._zone) return;
    const prevTod = this._zone.timeOfDay;
    this._zone = { ...this._zone, ...partial };
    if (partial.timeOfDayValue !== undefined) {
      // Cross-validate float vs current string bucket (same logic as applyZone).
      const currentTod = this._zone.timeOfDay;
      if (currentTod && !_todValueInBucket(partial.timeOfDayValue, currentTod)) {
        this._todValue = _todBucketMidpoint(currentTod);
      } else {
        this._todValue = partial.timeOfDayValue;
      }
      this._todSyncAt = Date.now();
    } else if (partial.timeOfDay !== undefined && partial.timeOfDay !== prevTod) {
      // Bucket changed but no exact value — snap to bucket midpoint so the
      // HUD clock stays consistent with the scene lighting.
      this._todValue  = _todBucketMidpoint(partial.timeOfDay);
      this._todSyncAt = Date.now();
    }
    this._notifyZone();
  }

  /**
   * Returns the current normalised time-of-day (0–1), interpolated forward
   * from the last server sync using the known day-cycle rate.
   * 0 = midnight · 0.25 = 6 am · 0.5 = noon · 0.75 = 6 pm
   */
  getTimeOfDayNormalized(): number {
    if (this._todSyncAt === 0) return this._todValue;
    const elapsed = (Date.now() - this._todSyncAt) / 1000;
    return (this._todValue + elapsed / DAY_CYCLE_SECS) % 1.0;
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
    console.log(`[WorldState] onCommunication channel="${payload.channel}" sender="${payload.senderName}" content="${payload.content}"`);
    // Track last whisper sender for /r and /reply
    if (payload.channel === 'whisper' && payload.senderName) {
      this._lastWhisperSender = payload.senderName;
    }
    const entry: ChatEntry = {
      id:        `chat-${++this._chatCounter}`,
      timestamp: payload.timestamp,
      channel:   payload.channel,
      sender:    payload.senderName,
      content:   payload.content,
      ...(payload.distance !== undefined ? { distance: payload.distance } : {}),
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
