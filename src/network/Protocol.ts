/**
 * Protocol types — mirrors the server's src/network/protocol/types.ts.
 * Keep in sync. The server is the source of truth.
 */

export type ClientType = 'text' | '2d' | '3d' | 'vr';
export type AuthMethod  = 'guest' | 'credentials' | 'token' | 'airlock';
export type MoveMethod  = 'heading' | 'position' | 'compass';
export type MovementSpeed     = 'walk' | 'jog' | 'run' | 'stop';
export type CompassDirection  = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type ContentRating     = 'T' | 'M' | 'AO';
export type CorruptionState   = 'CLEAN' | 'STAINED' | 'WARPED' | 'LOST';
export type CommunicationChannel = 'say' | 'shout' | 'emote' | 'cfh' | 'whisper' | 'party' | 'world';
export type InteractionAction = 'talk' | 'trade' | 'attack' | 'use' | 'examine';
export type AnimationAction   =
  | 'idle' | 'sitting' | 'emoting'
  | 'walking' | 'running' | 'jumping'
  | 'attacking' | 'casting' | 'channeling' | 'hit' | 'knockback' | 'dying' | 'dead'
  | 'talking' | 'trading';

export interface Vector3 { x: number; y: number; z: number; }

// ── Handshake ────────────────────────────────────────────────────────────────

export interface HandshakePayload {
  protocolVersion: string;
  clientType: ClientType;
  clientVersion: string;
  capabilities: {
    graphics: boolean;
    audio: boolean;
    input: string[];
    maxUpdateRate: number;
  };
}

export interface HandshakeAckPayload {
  protocolVersion: string;
  serverVersion: string;
  compatible: boolean;
  sessionId: string;
  timestamp: number;
  requiresAuth: boolean;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthPayload {
  method: AuthMethod;
  guestName?: string;
  username?: string;
  email?: string;
  password?: string;
  token?: string;
}

export interface CharacterInfo {
  id: string;
  name: string;
  level: number;
  lastPlayed: number;
  location: string;
}

export interface AuthSuccessPayload {
  accountId: string;
  token: string;
  characters: CharacterInfo[];
  canCreateCharacter: boolean;
  maxCharacters: number;
  isEphemeral?: boolean;
  ephemeralMessage?: string;
}

export interface AuthErrorPayload {
  reason: string;
  message: string;
  canRetry: boolean;
}

export interface AuthConfirmNamePayload {
  username: string;
  message: string;
}

// ── Characters ───────────────────────────────────────────────────────────────

export interface CharacterListPayload {
  characters: CharacterInfo[];
  maxCharacters: number;
  emptySlots: number;
  canCreateCharacter: boolean;
}

export interface CharacterConfirmNamePayload {
  name: string;
  message: string;
}

export interface CharacterErrorPayload {
  code: string;
  message: string;
  action: 'create' | 'delete' | 'list' | 'select' | 'update' | 'unknown';
}

// ── World Entry ──────────────────────────────────────────────────────────────

export interface StatBar { current: number; max: number; }

export interface CoreStats {
  strength: number; vitality: number; dexterity: number;
  agility: number; intelligence: number; wisdom: number;
}

export interface CorruptionStatus {
  current: number;
  state: CorruptionState;
  isolationMinutes: number;
  contributionPoints: number;
}

export interface CorruptionBenefits {
  cacheDetectionBonus: number;
  hazardResistBonus: number;
  deadSystemInterface: boolean;
}

export interface CharacterState {
  id: string;
  name: string;
  level: number;
  experience: number;
  isAlive: boolean;
  position: Vector3;
  heading: number;
  rotation: Vector3;
  currentSpeed?: MovementSpeed;
  health: StatBar;
  stamina: StatBar;
  mana: StatBar;
  corruption: CorruptionStatus;
  corruptionBenefits: CorruptionBenefits;
  unlockedFeats: string[];
  unlockedAbilities: string[];
  activeLoadout: string[];
  passiveLoadout: string[];
  specialLoadout: string[];
}

export interface ZoneInfo {
  id: string;
  name: string;
  description: string;
  weather: string;
  timeOfDay: string;
  lighting: string;
  contentRating: ContentRating;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  position: Vector3;
  description: string;
  isAlive?: boolean;
  health?: StatBar;
  interactive?: boolean;
  hostile?: boolean;
  animation?: string;
  currentAction?: AnimationAction;
  movementDuration?: number;
  movementSpeed?: number;
  heading?: number;
}

export interface Exit {
  direction: string;
  name: string;
  description: string;
}

export interface WorldEntryPayload {
  characterId: string;
  timestamp: number;
  character: CharacterState;
  zone: ZoneInfo;
  entities: Entity[];
  exits: Exit[];
}

// ── State Updates ─────────────────────────────────────────────────────────────

export interface EntityUpdates {
  updated?: Partial<Entity>[];
  added?: Entity[];
  removed?: string[];
}

export interface StateUpdatePayload {
  timestamp: number;
  entities?: EntityUpdates;
  character?: {
    health?: StatBar;
    stamina?: StatBar;
    mana?: StatBar;
  };
  combat?: {
    atb?: StatBar;
    autoAttack?: StatBar;
    inCombat?: boolean;
    autoAttackTarget?: string;
    specialCharges?: Record<string, number>;
  };
  allies?: Array<{
    entityId: string;
    atb?: StatBar;
    staminaPct?: number;
    manaPct?: number;
  }>;
  zone?: Partial<ZoneInfo>;
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface EventPayload {
  eventType: string;
  timestamp: number;
  narrative?: string;
  animation?: string;
  sound?: string;
  [key: string]: unknown;
}

// ── Communication ─────────────────────────────────────────────────────────────

export interface CommunicationPayload {
  channel: 'say' | 'shout' | 'emote' | 'cfh';
  senderId: string;
  senderName: string;
  senderType: 'player' | 'npc' | 'companion';
  content: string;
  distance: number;
  timestamp: number;
}

// ── Proximity ─────────────────────────────────────────────────────────────────

export interface ProximityEntity {
  id: string;
  name: string;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife';
  isMachine: boolean;
  isAlive: boolean;
  bearing: number;
  elevation: number;
  range: number;
  speciesId?: string;
}

export interface ProximityChannel {
  count: number;
  sample?: string[];
  entities: ProximityEntity[];
  lastSpeaker?: string;
}

export interface ProximityChannels {
  touch: ProximityChannel;
  say: ProximityChannel;
  shout: ProximityChannel;
  emote: ProximityChannel;
  see: ProximityChannel;
  hear: ProximityChannel;
  cfh: ProximityChannel;
}

export interface ProximityRosterPayload {
  channels: ProximityChannels;
  dangerState: boolean;
}

export interface ProximityEntityDelta {
  id: string;
  bearing?: number;
  elevation?: number;
  range?: number;
}

export interface ProximityChannelDelta {
  added?: ProximityEntity[];
  removed?: string[];
  updated?: ProximityEntityDelta[];
  count?: number;
  sample?: string[];
  lastSpeaker?: string | null;
}

export interface ProximityRosterDeltaPayload {
  channels?: Partial<Record<keyof ProximityChannels, ProximityChannelDelta>>;
  dangerState?: boolean;
}

// ── Command response ──────────────────────────────────────────────────────────

export interface CommandResponsePayload {
  success:    boolean;
  command:    string;
  message?:   string;   // human-readable feedback on success
  error?:     string;   // human-readable feedback on failure
  data?:      unknown;  // optional structured payload (not shown in chat)
  timestamp:  number;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export interface ErrorPayload {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
}

// ── Corruption ────────────────────────────────────────────────────────────────

export interface CorruptionUpdatePayload {
  corruption: number;
  state: CorruptionState;
  previousState?: CorruptionState;
  delta: number;
  reason?: string;
  timestamp: number;
}
