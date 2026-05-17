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
  /** Carried for `channel === 'event'` entries so the chat renderer can
   *  colorize by event family (combat_hit red, combat_heal green, etc.)
   *  rather than dumping every combat line in the same warm grey. */
  eventType?: string;
  /** Resolved target id for combat events — lets the renderer decide
   *  incoming-vs-outgoing colouring (incoming damage/debuffs go red, the
   *  ones you deal stay default). Optional; absent for non-combat events. */
  targetId?: string;
}

/**
 * WorldState — zone data, proximity roster, chat log, and game events.
 *
 * Represents the "world around the player" rather than the player themselves.
 */
/** Fallback used only until the first server payload arrives (server tells us
 *  the real rate via zone.secsPerDay). */
const DEFAULT_SECS_PER_DAY = 2880;

export class WorldState {
  private _zone: ZoneInfo | null = null;
  private _proximity: ProximityRosterPayload | null = null;
  private _dangerState = false;
  private _season: string   = 'summer';
  private _dayOfYear: number = 180;
  /** Latest Aether Density 0..1 pushed by the server (clamped on the wire).
   *  Updated at 1 Hz; defaults to 0 before the first event. Consumers
   *  read freely from the render loop — no event subscription needed. */
  private _aetherDensity = 0;

  // ── TOD ───────────────────────────────────────────────────────────────────
  // Server is fully authoritative. We anchor the latest (value, time-received)
  // pair and lerp forward at the server-provided rate so the sun moves smoothly
  // between 1 Hz updates. Every server push snaps to the new value — no
  // bucket validation, no jitter rejection, no clever drift logic.
  private _todValue: number     = 0.33;
  private _todSyncAt: number    = 0;
  private _secsPerDay: number   = DEFAULT_SECS_PER_DAY;

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
  /** Latest Aether Density (0..1) — last value the server pushed.
   *  Read every frame by post-process / HUD; no subscription needed. */
  get aetherDensity(): number                   { return this._aetherDensity; }
  get chatLog():     ChatEntry[]                { return this._chatLog; }
  /** Current season ('spring' | 'summer' | 'fall' | 'winter'). */
  get season():      string                     { return this._season; }
  /** Current day of year 1–365. */
  get dayOfYear():   number                     { return this._dayOfYear; }
  /** Temperature normalised −1 (cold) → 1 (hot). null if not yet known. */
  get temperature(): number | null              { return this._zone?.temperature ?? null; }
  /** Surface wind, or null if no live weather data yet. */
  get wind(): { speed: number; direction: number } | null { return this._zone?.wind ?? null; }
  /** Name of the last player who whispered us (for /r, /reply). */
  get lastWhisperSender(): string | null        { return this._lastWhisperSender; }

  /** True when the current zone is a village instance (zone ID starts with "village:"). */
  get isVillage(): boolean {
    return this._zone?.id?.startsWith('village:') ?? false;
  }

  /** If in a village zone, returns the owner's character ID. */
  get villageOwnerId(): string | null {
    if (!this._zone?.id?.startsWith('village:')) return null;
    return this._zone.id.slice('village:'.length);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyZone(zone: ZoneInfo): void {
    this._zone = { ...zone };
    if (zone.season    !== undefined) this._season    = zone.season;
    if (zone.dayOfYear !== undefined) this._dayOfYear = zone.dayOfYear;
    if (zone.secsPerDay !== undefined && zone.secsPerDay > 0) {
      this._secsPerDay = zone.secsPerDay;
    }
    if (zone.timeOfDayValue !== undefined) {
      this._todValue  = zone.timeOfDayValue;
      this._todSyncAt = Date.now();
    }
    this._notifyZone();
  }

  applyZonePartial(partial: Partial<ZoneInfo>): void {
    if (!this._zone) return;
    this._zone = { ...this._zone, ...partial };
    if (partial.season    !== undefined) this._season    = partial.season;
    if (partial.dayOfYear !== undefined) this._dayOfYear = partial.dayOfYear;
    if (partial.secsPerDay !== undefined && partial.secsPerDay > 0) {
      this._secsPerDay = partial.secsPerDay;
    }
    if (partial.timeOfDayValue !== undefined) {
      this._todValue  = partial.timeOfDayValue;
      this._todSyncAt = Date.now();
    }
    this._notifyZone();
  }

  /**
   * Current normalised time-of-day (0–1), lerped forward from the last server
   * anchor at the server-provided rate.  Each server push snaps to truth.
   * 0 = midnight · 0.25 = 6 am · 0.5 = noon · 0.75 = 6 pm
   */
  getTimeOfDayNormalized(): number {
    if (this._todSyncAt === 0) return this._todValue;
    const elapsed = (Date.now() - this._todSyncAt) / 1000;
    return (this._todValue + elapsed / this._secsPerDay) % 1.0;
  }

  applyProximityRoster(payload: ProximityRosterPayload): void {
    this._proximity    = payload;
    this._dangerState  = payload.dangerState;
    this._notifyProximity();
  }

  /** Apply a fresh AD value from the server's 1 Hz push. Clamps to 0..1
   *  defensively even though the server already clamps on send. */
  setAetherDensity(value: number): void {
    if (!Number.isFinite(value)) return;
    this._aetherDensity = Math.max(0, Math.min(1, value));
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
        channel.lastSpeaker = channelDelta.lastSpeaker as string;
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
      const targetId = (payload.eventTypeData as { targetId?: string } | undefined)?.targetId;
      const entry: ChatEntry = {
        id:        `event-${++this._chatCounter}`,
        timestamp: payload.timestamp,
        channel:   'event',
        sender:    '',
        content:   payload.narrative,
        eventType: payload.eventType,
        ...(targetId ? { targetId } : {}),
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
    this._aetherDensity = 0;
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
