/**
 * Protocol types — mirrors the server's src/network/protocol/types.ts.
 * Keep in sync. The server is the source of truth.
 */

export type ClientType = 'text' | '2d' | '3d' | 'vr';
export type AuthMethod  = 'guest' | 'credentials' | 'token' | 'airlock';
export type MoveMethod  = 'heading' | 'position' | 'compass';
export type MovementSpeed     = 'channel' | 'walk' | 'jog' | 'sprint' | 'stop';

/** Mirrors server SPEED_MULTIPLIERS — applied to base movement speed.
 *  At base 7 m/s: channel 1.225 / walk 2.45 / jog 8.05 / sprint 12.95 m/s.
 *  `channel` is a server-applied clamp during channeling, not a client-selectable tier. */
export const SPEED_MULTIPLIERS: Record<MovementSpeed, number> = {
  channel: 0.175,
  walk:    0.35,
  jog:     1.15,
  sprint:  1.85,
  stop:    0.0,
};

export type CompassDirection  = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type ContentRating     = 'T' | 'M' | 'AO';
export type CorruptionState   = 'CLEAN' | 'STAINED' | 'WARPED' | 'LOST';
export type CommunicationChannel = 'say' | 'shout' | 'emote' | 'cfh' | 'whisper' | 'party' | 'guild' | 'world' | 'companion';
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

export interface DerivedStats {
  // Resources
  maxHp: number; maxStamina: number; maxMana: number; carryingCapacity: number;
  // Physical combat
  attackRating: number; defenseRating: number; physicalAccuracy: number;
  evasion: number; damageAbsorption: number; glancingBlowChance: number;
  criticalHitChance: number; penetratingBlowChance: number; deflectedBlowChance: number;
  // Magic combat
  magicAttack: number; magicDefense: number; magicAccuracy: number;
  magicEvasion: number; magicAbsorption: number;
  // Speed & timing
  initiative: number; movementSpeed: number; attackSpeedBonus: number;
  // Caster resilience — subtracts from damage-interrupt roll, capped 85
  castStability: number;
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

/** One of the six axis directions tracked for build-identity. Mirrors the
 *  server-side AxisDirection in @ashes/core/abilities/axisBonuses. */
export type AxisDirection =
  | 'phys' | 'magical'
  | 'melee' | 'ranged'
  | 'offense' | 'defense';

/** Server-computed snapshot of axis composition. `counts` is per-direction
 *  slotted-node count (sign-only). `tiers` is the ladder tier reached
 *  (1/2/3) or 0 below T1. `active` is per-direction summary text mirroring
 *  what `/stats` prints — used directly in character-sheet tooltips. */
export interface AxisSnapshot {
  counts: Record<AxisDirection, number>;
  tiers:  Record<AxisDirection, number>;
  active: Array<{ direction: AxisDirection; tier: number; summary: string }>;
}

export interface StatusEffect {
  id: string;
  name: string;
  duration: number;            // remaining seconds
  type?: 'buff' | 'debuff';   // display coloring; defaults to 'buff'
  description?: string;        // hover tooltip text
  /** Flat stat additions this effect grants the recipient. Mirrors
   *  ActiveBuff.statMods on the server. Used by the character sheet to
   *  fold buff contributions into the `+nn` column on top of the passive
   *  bonuses (which arrive separately as derivedStatsBonuses). */
  statMods?: Record<string, number>;
}

export interface CharacterState {
  id: string;
  name: string;
  level: number;
  experience: number;
  abilityPoints: number;
  statPoints: number;
  isAlive: boolean;
  position: Vector3;
  heading: number;
  rotation: Vector3;
  currentSpeed?: MovementSpeed;
  health: StatBar;
  stamina: StatBar;
  mana: StatBar;
  coreStats?: CoreStats;
  /** Per-stat passive bonuses applied on top of `coreStats` (the base allocation).
   *  Surfaces "STR 10 (+5)" displays in CharacterSheet — values are deltas, not totals. */
  coreStatsBonuses?: Partial<CoreStats>;
  derivedStats?: DerivedStats;
  /** Per-derived-stat bonuses from passives (and future gear/buff sources).
   *  Same delta convention as coreStatsBonuses. */
  derivedStatsBonuses?: Partial<DerivedStats>;
  /** Build-identity axis snapshot derived from slotted passive composition.
   *  Drives the character-sheet 6-spoke web visualization. Server pushes
   *  on world_entry and on PASSIVE_LOADOUT_CHANGED. */
  axisSnapshot?: AxisSnapshot;
  corruption: CorruptionStatus;
  corruptionBenefits: CorruptionBenefits;
  unlockedFeats: string[];
  unlockedAbilities: { activeNodes: string[]; passiveNodes: string[]; apSpent: number };
  activeLoadout:  (string | null)[];
  passiveLoadout: (string | null)[];
  specialLoadout: string[];
}

export interface ZoneInfo {
  id: string;
  name: string;
  description: string;
  weather: string;
  timeOfDay: string;
  /** Normalised 0–1 time of day (0 = midnight, 0.25 = 6 am, 0.5 = noon). */
  timeOfDayValue?: number;
  lighting: string;
  contentRating: ContentRating;
  /** Current season from climate sim: 'spring' | 'summer' | 'fall' | 'winter' */
  season?: string;
  /** Day of year 1–365 from climate sim */
  dayOfYear?: number;
  /** Real seconds per in-game day. Server-authoritative — client uses this to
   *  interpolate the sun smoothly between 1 Hz updates without hardcoding the rate. */
  secsPerDay?: number;
  /** Temperature normalized to -1.0 (cold) → 1.0 (hot) */
  temperature?: number;
  /** Surface wind. */
  wind?: {
    /** m/s */
    speed: number;
    /** Compass degrees 0–360 */
    direction: number;
  };
  /** Playable-circle radius in metres for overworld zones — drives the
   *  miasma boundary wall + post-process distortion. Null/absent for
   *  vault zones (no overworld boundary applies). */
  zoneRadiusM?: number | null;
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
  /** Dispatch kind for the unified F-key interaction system. Set on
   *  server-side static interactables (vault portals, hireling consoles,
   *  training dummies). When present, the F-key prompt shows
   *  `interactionPrompt`; absent on plain mobs / NPCs / players. */
  interactionKind?: string;
  /** Short label rendered next to the [F] key-cap when this entity is
   *  the nearest in-range interactable. */
  interactionPrompt?: string;
  hostile?: boolean;
  animation?: string;
  /** For characters: the current animation action. For plants: the growth stage name ('sprout', 'mature', 'flowering', etc.). */
  currentAction?: AnimationAction | string;
  fromPosition?: Vector3;
  movementDuration?: number;
  movementSpeed?: number;
  heading?: number;
  /** True while a player or companion is mid-caravan-ride. Server toggles
   *  on ride start / end and includes in every per-tick movement update
   *  so the client can render a cart mesh under the entity for the
   *  ride's duration. */
  caravanActive?: boolean;
  /** GLB asset path for 3D model (e.g. "dungeon/Dungeon_Entrance_01.glb"). */
  modelAsset?: string;
  /** Uniform scale multiplier for the GLB model (default 1). */
  modelScale?: number;
  /** Species or sub-type identifier (e.g. "fox", "oak_tree"). Drives placeholder shape selection. */
  tag?: string;
  /** Visual variant index (0–4). Server-authoritative; drives pre-built geometry selection in ForestRenderer. */
  variant?: number;
  /** Owner relationship for synthetic party-panel rows. Set on companions
   *  (1:1 with player) and hirelings (1-many per player, vault-only). */
  ownerCharacterId?: string;
  /** Companion / hireling archetype string. For hirelings: 'tank' | 'healer'
   *  | 'ranged_magic_dd' | etc. For companions: 'tank' | 'scrappy_fighter'
   *  | 'cautious_healer' | 'opportunist'. Used as a fallback when the
   *  server-computed role tag is missing. */
  archetype?: string;
  /** Single-symbol party-panel role tag — 'T' | 'M' | 'M♦' | 'R' | 'R♦'
   *  | 'C' | 'H' | 'Su' | '?' | '*'. Server-computed on entity broadcast
   *  and on PASSIVE_LOADOUT_CHANGED for players. */
  role?: string;
  /** Mana / stamina pools for non-self entities. Self vitals come from
   *  PlayerState via the state_update.character pipeline; companions and
   *  hirelings carry vitals on their entity broadcast so the party panel
   *  can render MP/Stamina bars without per-pet status events. */
  mana?:    StatBar;
  stamina?: StatBar;
  /** Server-authoritative level (1..50). Used by NameplateManager to
   *  compute the viewer-vs-target con tier (the 7-step ↓↓↓ … ↑↑↑ ladder).
   *  Shipped on mobs and players. Persists through partial updates via
   *  EntityRegistry's shallow-merge. */
  level?: number;
  /** Mob aggro disposition — 'hostile' | 'neutral' | 'friendly'. Drives
   *  nameplate name color (red / yellow / white) and engagement rules
   *  server-side. Set on MobEntity; undefined for non-mobs. */
  disposition?: string;
  /** Notorious Monster flag — when true, the nameplate shows "??" in
   *  place of con arrows (level is unknown to the viewer). */
  notorious?: boolean;
  /** Guild tag (3-5 uppercase chars) for non-party player plates —
   *  rendered as "[TAG] Name". Resolved server-side at zone-in. */
  guildTag?: string;
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
  /** Static ability node definitions — used to render the ability tree. */
  abilityManifest: AbilityNodeSummary[];
  /** True for guest (ephemeral) sessions — shows /register prompt in UI. */
  isGuest?: boolean;
}

// ── Guest Registration ────────────────────────────────────────────────────────

export interface RegisterAccountPayload {
  username: string;
  email: string;
  password: string;
}

export interface RegisterResultPayload {
  success: boolean;
  username?: string;
  error?: string;
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
    isAlive?: boolean;
    // Progression
    experience?: number;
    level?: number;
    abilityPoints?: number;
    statPoints?: number;
    // Stats — base + delta from passives (and future gear/buffs)
    coreStats?:           CoreStats;
    coreStatsBonuses?:    Partial<CoreStats>;
    derivedStats?:        DerivedStats;
    derivedStatsBonuses?: Partial<DerivedStats>;
    // Build-identity axis snapshot — pushed on slot/unslot
    axisSnapshot?:        AxisSnapshot;
    // Status effects
    effects?: StatusEffect[];
  };
  combat?: {
    atb?: StatBar;
    autoAttack?: StatBar;
    inCombat?: boolean;
    /** Explicit null when cleared. Server always emits a value (JSON drops
     *  undefined fields, which would leave the client holding stale ids). */
    autoAttackTarget?: string | null;
    specialCharges?: Record<string, number>;
    enmityList?: EnmityEntry[];
  };
  allies?: PartyAllyState[];
  /** Vitals-only updates for entities the client already knows about
   *  (companions + hirelings). Routed to EntityRegistry.applyVitals which
   *  patches health/mana/stamina without touching position — bypasses the
   *  EntityFactory.setTargetPosition path that would otherwise restart
   *  every pet's interp lerp at this broadcast's cadence. */
  vitals?: Array<{
    id:       string;
    health?:  StatBar;
    mana?:    StatBar;
    stamina?: StatBar;
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
  eventTypeData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Carried in EventPayload.eventTypeData for `caravan_ride_started`. The
 *  client drives caravan motion locally from this single broadcast —
 *  per-tick position updates are suppressed during the ride for both
 *  rider and party (server still simulates server-side for boundary
 *  damage / arrival). Path is in world XZ metres; speed in m/s; hover
 *  is the cart's Y-offset above terrain. */
export interface CaravanRideStartedData {
  riderId:       string;
  startPosition: { x: number; y: number; z: number };
  path:          { x: number; z: number }[];
  speedMPS:      number;
  hoverM:        number;
  partyOffsets:  { entityId: string; offsetX: number; offsetZ: number }[];
  heading:       number;
}

/** Carried in `caravan_ride_ended`. Final authoritative position lets
 *  the client snap if its prediction drifted; reason is informational. */
export interface CaravanRideEndedData {
  riderId:       string;
  reason:        'arrived' | 'dismount' | 'died' | 'left_zone' | string;
  finalPosition: { x: number; y: number; z: number };
}

/** Combat outcome shape carried inside EventPayload.eventTypeData for combat_hit/combat_miss. */
export type CombatOutcome = 'hit' | 'crit' | 'glance' | 'penetrating' | 'deflected' | 'miss';

export interface CombatHitData {
  attackerId: string;
  targetId:   string;
  abilityId:  string;
  amount:     number;
  critical:   boolean;
  outcome:    CombatOutcome;
  /** Server-authoritative remaining cooldown in ms for the ability that just
   *  resolved. Optional — older servers won't send it; clients should fall back
   *  to the manifest's static cooldown. */
  cooldownMs?: number;
  /** True when this CombatHitData was synthesised from a `combat_heal` event
   *  rather than a damage-dealing hit. Lets the UI use a heal-specific flash. */
  isHeal?: boolean;
}

/** Broadcast when a cast-time ability begins. Drives the cast bar HUD on
 *  the casting client + (future) remote nameplate cast bars. */
export interface CastStartPayload {
  entityId:    string;
  abilityId:   string;
  abilityName: string;
  durationMs:  number;
  targetId:    string;
  timestamp:   number;
}

/** Broadcast when a cast resolves successfully (ability fires). */
export interface CastCompletePayload {
  entityId:  string;
  abilityId: string;
  timestamp: number;
}

/** Broadcast when a cast is interrupted before completion. Reasons:
 *  `player_cancel`, `jump`, `dash`, `damage_interrupt`, future `stunned`/
 *  `knocked_back` etc. MP stays gone (committed at cast-start). */
export interface CastBreakPayload {
  entityId:  string;
  abilityId: string;
  reason:    string;
  timestamp: number;
}

/** Broadcast when a channel begins (cast → channel transition). Drives
 *  the cast-bar HUD into drain mode (100% → 0% over durationMs). */
export interface ChannelStartPayload {
  entityId:    string;
  abilityId:   string;
  abilityName: string;
  durationMs:  number;
  targetId:    string;
  timestamp:   number;
}

/** Broadcast on each channel tick. Optional consumer for sound effects
 *  or visual pulse — the cast bar fills locally from start time. */
export interface ChannelTickPayload {
  entityId:  string;
  abilityId: string;
  timestamp: number;
}

/** Broadcast when a channel ends naturally (full duration elapsed). */
export interface ChannelCompletePayload {
  entityId:  string;
  abilityId: string;
  timestamp: number;
}

/** Broadcast when a channel is interrupted before completion. Reasons:
 *  `player_cancel`, `jump`, `dash`, `sprint_input`, `damage_interrupt`,
 *  `caster_died`, `anchor_lost`, `insufficient_mp`. */
export interface ChannelBreakPayload {
  entityId:  string;
  abilityId: string;
  reason:    string;
  timestamp: number;
}

// ── AoE telegraphs (server-authoritative warning windows) ────────────────────

/** AoE footprint — mirrors the server's AoeShape. Cone/line are scaffolded
 *  even though no current ability uses them; the renderer supports all three
 *  so future abilities don't require a wire-format change. */
export type AoeShape =
  | { shape: 'circle'; radius: number }
  | { shape: 'cone';   length: number; angle: number }
  | { shape: 'line';   length: number; width: number };

/** Broadcast when a cast/channel-phase AoE warning ring should appear on
 *  the ground. Either `origin` (static worldspace XZ for snapshot anchors)
 *  or `anchorEntityId` (dynamic — client lerps from its entity store) is
 *  set, never both.
 *
 *  Affinity drives colour: `hostile` = red ring on a damage AoE that the
 *  player should leave; `friendly` = green ring on a beneficial zone they
 *  may want to stand in.
 *
 *  Phase distinguishes the lifecycle: `cast` rings fill 0→1 over the cast
 *  duration as a wind-up ramp; `channel` rings hold steady and pulse on
 *  each channel_tick. */
export interface TelegraphRegisterPayload {
  id:           string;
  casterId:     string;
  abilityId:    string;
  abilityName:  string;
  shape:        AoeShape;
  origin?:      { x: number; z: number };
  anchorEntityId?: string;
  heading?:     number;
  startedAt:    number;
  endsAt:       number;
  affinity:     'hostile' | 'friendly';
  phase:        'cast' | 'channel';
}

/** Broadcast when a telegraph is removed before its natural endsAt — cast/
 *  channel break, caster death, etc. Natural expiry doesn't broadcast: the
 *  renderer disposes from `endsAt` on its own. */
export interface TelegraphCancelPayload {
  id:        string;
  reason:    string;
  timestamp: number;
}

// ── AI debug panel (/aidebug) ────────────────────────────────────────────────

export interface AIDebugSnapshotEntity {
  id:                 string;
  name:               string;
  type:               'player' | 'companion';
  hp:                 number;
  maxHp:              number;
  mp:                 number;
  maxMp:              number;
  stam:               number;
  maxStam:            number;
  pos:                { x: number; z: number };
  isAlive:            boolean;
  inCombat?:          boolean;
  state?:             string;
  archetype?:         string | null;
  engagementMode?:    string;
  preferredRange?:    string | null;
  behaviorState?:     string;
  autoAttackTargetId: string | null;
  /** Server-resolved auto-attack target name (mob/player/companion). null
   *  when no target. Server has the EntityStore so it can resolve mobs. */
  targetName:         string | null;
  /** 2D distance (m) to autoAttackTarget. null when no target. */
  targetDistance:     number | null;
}

export interface AIDebugConsideredAbility {
  abilityId:  string;
  category:   'damage' | 'cc' | 'heal' | 'buff' | 'debuff';
  baseWeight: number;
  weight:     number;
  jitter:     number;
  score:      number;
  skipReason: string | null;
}

export interface AIDebugDecision {
  tickAt:          number;
  selfId:          string;
  selfPos:         { x: number; z: number };
  selfHp:          number;
  selfMaxHp:       number;
  selfMana:        number;
  selfStamina:     number;
  state:           'idle' | 'engaging';
  movementMode:    'chase' | 'stationary' | 'kite';
  preferredRange:  'close' | 'mid' | 'long';
  rangeBand:       { min: number; ideal: number; max: number };
  target: {
    id:        string;
    /** Server-resolved entity name (mob/player/companion). Optional —
     *  may be missing if the entity left the zone between tick + emit. */
    name?:     string;
    hp:        number;
    maxHp:     number;
    distance:  number;
  } | null;
  movement:        { heading: number; speed: number } | null;
  considered:      AIDebugConsideredAbility[];
  emergencyHeal:   boolean;
  chosen:          { abilityId: string; targetId: string; targetName?: string } | null;
  reason:          string;
  engagementMode?: string;
}

export interface AIDebugAATransition {
  at:       number;
  entityId: string;
  prev:     string | null;
  next:     string | null;
  reason:   string;
}

/** Broadcast each zone tick to subscribers of /aidebug. Carries a snapshot
 *  of the subscriber's player + their companions, plus per-tick BT decisions
 *  and autoAttackTarget transitions. */
export interface AIDebugTickPayload {
  zoneId:        string;
  tickAt:        number;
  ownPlayerId:   string;
  player:        AIDebugSnapshotEntity;
  companions:    AIDebugSnapshotEntity[];
  decisions:     AIDebugDecision[];
  aaTransitions: AIDebugAATransition[];
}

/** Sent only to the caster when a cast is rejected (OOM, range, on-CD, silenced, etc.). */
export interface CombatErrorPayload {
  code:    string;
  message: string;
  /** Server-authoritative remaining time in milliseconds for time-based rejections
   *  (`on_cooldown`, `on_gcd`). Optional — older servers won't send it; clients
   *  should fall back to a guess from the manifest. */
  remainingMs?: number;
}

// ── Companion Creation ────────────────────────────────────────────────────────

export interface CompanionCreateData {
  name: string;
  personalityType?: string;
  archetype?: string;
  traits?: string[];
  goals?: string[];
  description?: string;
  systemPrompt?: string;
}

// ── Companion Config ─────────────────────────────────────────────────────────

export type CompanionArchetype = 'scrappy_fighter' | 'cautious_healer' | 'opportunist' | 'tank';
export type PreferredRange     = 'close' | 'mid' | 'long';
export type TargetPriority     = 'weakest' | 'nearest' | 'threatening_player';
export type CombatStance       = 'aggressive' | 'cautious' | 'support';
export type EngagementMode     = 'aggressive' | 'defensive' | 'passive';
export type HealPriorityMode   = 'lowest_hp' | 'most_damage_taken' | 'tank_first';

export interface CompanionCombatSettings {
  preferredRange:   PreferredRange;
  priority:         TargetPriority;
  stance:           CombatStance;
  abilityWeights:   Record<string, number>;
  retreatThreshold: number;
  engagementMode:   EngagementMode;

  // Healing rules
  healAllyThreshold:      number;
  minHealTarget:          number;
  healPriorityMode:       HealPriorityMode;

  // Buff / cooldown rules
  saveCooldownsForElites: boolean;
  minEnemyHpForBuffs:     number;

  // Resource management
  resourceReservePercent: number;

  // Recovery
  defensiveThreshold:     number;

  // Engagement overrides
  ignoreFamily:           string[];
  alwaysEngageFamily:     string[];
  ignoreSpecies:          string[];
  alwaysEngageSpecies:    string[];
}

export interface CompanionAbilityInfo {
  id:          string;
  name:        string;
  description: string;
  enabled:     boolean;
  tags?:       string[];
}

export interface CompanionCoreStats {
  strength: number; vitality: number; dexterity: number;
  agility: number; intelligence: number; wisdom: number;
}

export interface CompanionDerivedStats {
  attackRating:      number;
  defenseRating:     number;
  magicAttack:       number;
  magicDefense:      number;
  criticalHitChance: number;
  evasion:           number;
  movementSpeed:     number;
  healPotencyMult:   number;
  threatMultiplier:  number;
}

export interface CompanionConfigPayload {
  companionId:       string;
  name:              string;
  level:             number;
  currentHealth:     number;
  maxHealth:         number;
  currentMana?:      number;
  maxMana?:          number;
  currentStamina?:   number;
  maxStamina?:       number;
  isAlive:           boolean;
  archetype:         CompanionArchetype;
  behaviorState:     string;
  taskDescription:   string | null;
  combatSettings:    CompanionCombatSettings;
  abilities:         CompanionAbilityInfo[];
  harvestsCompleted: number;
  itemsGathered:     number;
  lastAbility?:      { abilityId: string; abilityName: string; timestamp: number } | null;
  coreStats?:        CompanionCoreStats;
  derivedStats?:     CompanionDerivedStats;
  personalityType?:  string | null;
  traits?:           string[];
  description?:      string | null;
}

/** Lightweight status update for the CompanionHUD, sent ~1/s during combat. */
export interface CompanionStatusPayload {
  companionId:    string;
  currentHealth:  number;
  maxHealth:      number;
  currentMana:    number;
  maxMana:        number;
  currentStamina: number;
  maxStamina:     number;
  isAlive:        boolean;
  behaviorState:  string;
  engagementMode: EngagementMode;
  llmPending:     boolean;
  lastAbility:    { abilityId: string; abilityName: string; timestamp: number } | null;
}

// ── Companion Loadout ─────────────────────────────────────────────────────────

export interface CompanionLoadoutSlot {
  slot:   number;
  nodeId: string | null;
  name:   string;
}

export interface CompanionAvailableAbility {
  nodeId: string;
  name:   string;
  tier:   number;
  sector: string;
}

export interface CompanionLoadoutPayload {
  companionId: string;
  web:         'active' | 'passive';
  slots:       CompanionLoadoutSlot[];
  available:   CompanionAvailableAbility[];
}

// ── Communication ─────────────────────────────────────────────────────────────

export interface CommunicationPayload {
  channel: CommunicationChannel;
  senderId: string;
  senderName: string;
  senderType?: 'player' | 'npc' | 'companion';
  content: string;
  distance?: number;
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

// ── Inventory ─────────────────────────────────────────────────────────────────

export type EquipSlot =
  | 'head' | 'body' | 'hands' | 'legs' | 'feet'
  | 'necklace' | 'bracelet' | 'ring1' | 'ring2'
  | 'mainhand' | 'offhand'
  | 'mainhand2' | 'offhand2';

export const EQUIP_SLOTS: EquipSlot[] = [
  'head', 'body', 'hands', 'legs', 'feet',
  'necklace', 'bracelet', 'ring1', 'ring2',
  'mainhand', 'offhand', 'mainhand2', 'offhand2',
];

export const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head', body: 'Body', hands: 'Hands', legs: 'Legs', feet: 'Feet',
  necklace: 'Necklace', bracelet: 'Bracelet', ring1: 'Ring', ring2: 'Ring',
  mainhand: 'Main Hand', offhand: 'Off Hand',
  mainhand2: 'Main Hand', offhand2: 'Off Hand',
};

export interface ItemInfo {
  id:           string;
  templateId:   string;
  name:         string;
  description:  string;
  itemType:     string;
  quantity:     number;
  durability?:  number;
  properties?:  Record<string, unknown>;
  iconUrl?:     string;
  equipped:     boolean;
  equipSlot?:   EquipSlot;
}

export interface InventoryUpdatePayload {
  items:           ItemInfo[];
  equipment:       Partial<Record<EquipSlot, ItemInfo>>;
  activeWeaponSet: 1 | 2;
  timestamp:       number;
}

// ── Ability Tree ──────────────────────────────────────────────────────────────

/** Static metadata for one ability-tree node, sent once inside world_entry. */
export interface AbilityNodeSummary {
  id:               string;
  web:              'active' | 'passive';
  sector:           string;
  tier:             number;       // 1–4
  name:             string;
  description:      string;
  cost:             number;       // AP cost
  adjacentTo:       string[];     // neighbour node IDs
  // Active effect (active-web nodes)
  effectDescription?: string;
  staminaCost?:       number;
  manaCost?:          number;
  cooldown?:          number;
  castTime?:          number;
  targetType?:        string;
  range?:             number;
  // Passive stat bonuses
  statBonuses?: Record<string, number>;
  questGate?:   string;
}

/** Emitted by the server after every unlock / slot operation. */
export interface AbilityUpdatePayload {
  unlockedActiveNodes:  string[];
  unlockedPassiveNodes: string[];
  activeLoadout:        (string | null)[];
  passiveLoadout:       (string | null)[];
  abilityPoints:        number;
  success:              boolean;
  message:              string;
}

// ── Party ────────────────────────────────────────────────────────────────────

export interface PartyMemberInfo {
  id:   string;
  name: string;
}

export interface PartyAllyState {
  entityId:    string;
  /** 0-100. Used by the HUD when the ally is in a different zone (no local entity to read). */
  hpPct?:      number;
  staminaPct?: number;
  manaPct?:    number;
  /** False when the ally is a corpse — HUD greys the row. */
  isAlive?:    boolean;
  atb?:        StatBar;
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

// ── Harvest ──────────────────────────────────────────────────────────────────

export interface HarvestResultPayload {
  plantName: string;
  items:     { name: string; quantity: number }[];
}

// ── Market data (structured command_response.data payloads) ──────────────────

export interface MarketSearchResult {
  orderId:      string;
  itemName:     string;
  quantity:     number;
  pricePerUnit: number;
  scope:        'REGIONAL' | 'WORLD';
  regionName:   string;
}

export interface MarketOrderInfo {
  orderId:        string;
  itemName:       string;
  quantity:       number;
  filledQuantity: number;
  pricePerUnit:   number;
  scope:          'REGIONAL' | 'WORLD';
  status:         string;
}

export interface MarketStallInfo {
  name:         string;
  owner:        string;
  region:       string;
  stallType:    string;
  activeOrders: number;
}

export type MarketDataPayload =
  | { type: 'market_search';  results: MarketSearchResult[] }
  | { type: 'market_orders';  orders: MarketOrderInfo[] }
  | { type: 'market_wallet';  balance: number }
  | { type: 'market_stall';   stall: MarketStallInfo }
  | { type: 'market_list';    success: boolean }
  | { type: 'market_buy';     success: boolean }
  | { type: 'market_cancel';  success: boolean };

// ── Examine / Peek ───────────────────────────────────────────────────────────

export interface ExaminePeekPayload {
  id:          string;
  name:        string;
  entityType:  'player' | 'npc' | 'companion' | 'mob' | 'wildlife' | 'structure' | 'plant';
  isAlive:     boolean;
  inCombat:    boolean;
  range:       number;
  description: string | null;
  level?:      number;
  healthPct?:  number;
  // Mob / wildlife
  faction?:    string;
  notorious?:  boolean;
  tag?:        string;
  // Plant
  growthStage?: string;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export interface ErrorPayload {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
}

// ── Stat Allocation / Respec Results ─────────────────────────────────

export interface StatAllocateResultPayload {
  success: boolean;
  stat?:   string;
  newValue?: number;
  error?:  string;
}

export interface RespecResultPayload {
  success: boolean;
  type?:   'stats' | 'abilities';
  message?: string;
  error?:  string;
}

// ── Experience ────────────────────────────────────────────────────────────────

export interface ExperienceGainedPayload {
  entityType:  'player' | 'companion';
  entityId:    string;
  gainedXp:    number;
  experience:  number;
  level:       number;
  leveledUp:   boolean;
  gainedAp?:   number;     // player only — AP banked (level-up + post-cap XP→AP)
  lostAp?:     number;     // player only — AP would-have-been but bank was full
  gainedSp?:   number;     // player only
  mobName:     string;
  breakdown: {
    mobLevel:       number;
    recipientLevel: number;
    partySize:      number;
    baseXp:         number;
    conMult:        number;
    partyMult:      number;
  };
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

// ── Loot ──────────────────────────────────────────────────────────────────────

export interface LootSessionItem {
  id:          string;
  templateId:  string;
  name:        string;
  itemType:    string;
  description: string;
  iconUrl?:    string;
  quantity:    number;
}

export interface LootSessionStartPayload {
  sessionId:     string;
  mobName:       string;
  mode:          'solo' | 'party';
  items:         LootSessionItem[];
  gold:          number;
  goldPerMember: number;
  expiresAt:     number;
}

export interface LootItemResultPayload {
  sessionId:  string;
  itemId:     string;
  itemName:   string;
  winnerId:   string | null;
  winnerName: string | null;
  winRoll:    'need' | 'want' | null;
  rollValue:  number;
}

export interface LootSessionEndPayload {
  sessionId: string;
}

// ── Enmity ───────────────────────────────────────────────────────────────────

export type EnmityLevel = 'red' | 'yellow' | 'blue';

export interface EnmityEntry {
  entityId: string;
  name:     string;
  level:    EnmityLevel;
}

// ── Village / Plot System ────────────────────────────────────────────────────

export interface ZoneTransferPayload {
  zoneId: string;
}

export interface VillagePlacementModePayload {
  catalogId:    string;
  structureName: string;
  displayName:  string;
  sizeX:        number;
  sizeZ:        number;
  modelAsset:   string;
  gridSize:     number;
  goldCost:     number;
}

export interface VillageStructureInfo {
  id:        string;
  catalogId: string;
  name:      string;
  position:  Vector3;
  rotation:  number;
  sizeX:     number;
  sizeZ:     number;
}

export interface VillageStatePayload {
  villageName:     string;
  ownerCharacterId: string;
  ownerName:       string;
  templateName:    string;
  structures:      VillageStructureInfo[];
  maxStructures:   number;
  gridSize:        number;
  isOwner:         boolean;
}

export interface VillageCatalogEntry {
  name:           string;
  displayName:    string;
  description:    string;
  category:       string;
  sizeX:          number;
  sizeZ:          number;
  goldCost:       number;
  maxPerVillage:  number;
}

export interface VillageCatalogPayload {
  structures: VillageCatalogEntry[];
}

// ── Guild ────────────────────────────────────────────────────────────────────

export interface GuildUpdatePayload {
  guildId?:       string;
  name?:          string;
  tag?:           string;
  description?:   string;
  motto?:         string;
  memberCount?:   number;
  maxBeacons?:    number;
  litBeaconCount?: number;
  isGuildmaster?:  boolean;
  bonuses?: {
    corruptionResistPercent: number;
    xpBonusPercent: number;
  };
  /** Set when the player is removed from a guild (kicked/disbanded). */
  removed?: boolean;
  reason?:  'kicked' | 'disbanded';
}

export interface GuildMemberInfo {
  characterId:   string;
  characterName: string;
  isGuildmaster: boolean;
  isOnline:      boolean;
  joinedAt:      number;
}

export interface GuildMemberListPayload {
  guildId:  string;
  guildTag: string;
  members:  GuildMemberInfo[];
}

export interface GuildInvitePayload {
  guildId:     string;
  guildName:   string;
  guildTag:    string;
  inviterName: string;
}

export interface GuildChatPayload {
  senderId:   string;
  senderName: string;
  message:    string;
  timestamp:  number;
}

export interface GuildFoundingNarrativePayload {
  step:       number;
  totalSteps: number;
  narrative:  string;
}

// ── Script Editor ────────────────────────────────────────────────────────────

/** Server → Client: open (or revert/undo) the script editor modal. */
export interface EditorOpenPayload {
  editorId:   string;
  objectId:   string;
  objectName: string;
  verb:       string;
  source:     string;
  language:   'lua';
  readOnly:   boolean;
  version:    number;
  origin:     'edit' | 'ai' | 'template' | 'undo';
}

/** Server → Client: result of a save or compile operation. */
export interface EditorResultPayload {
  editorId: string;
  success:  boolean;
  version?: number;
  errors:   Array<{ line?: number; col?: number; message: string }>;
  warnings: Array<{ line?: number; message: string }>;
}

// ── System Toasts ─────────────────────────────────────────────────────────────

/** Server → Client: floating system notification (zone build progress, etc.) */
export interface SystemToastPayload {
  message:   string;
  type:      'info' | 'success' | 'warning';
  duration?: number;
}

/** Server → Client: a deferred zone build has finished. Carries enough
 *  context for the client to re-issue a travel_request via a confirm modal
 *  ("X is ready, travel now?"). */
export interface ZoneBuildCompletePayload {
  zoneId:           string;
  destinationName:  string;
  routeRef:         string;
}

/** Server → Client: filtered slash-command reference for the requesting
 *  player. Server filters by role so admin entries don't leak to players. */
export interface CommandHelpEntry {
  name:        string;
  aliases:     string[];
  category:    'general' | 'movement' | 'combat' | 'party' | 'companion' | 'social' | 'travel' | 'admin' | 'debug';
  role:        'player' | 'admin';
  clientSide:  boolean;
  syntax:      string;
  description: string;
}
export interface CommandHelpListPayload {
  viewerRole: 'player' | 'admin';
  commands:   CommandHelpEntry[];
}

// ── Beacon & Library Alerts ───────────────────────────────────────────────────

/** Server → Client: guild beacon fuel / state alert. */
export interface BeaconAlertPayload {
  alertType: 'LOW_FUEL' | 'CRITICAL_FUEL' | 'EXTINGUISHED' | 'RELIT';
  beaconId:  string;
  hoursRemaining?: number;
  message:   string;
  timestamp: number;
}

/** Server → Client: library assault start / resolved. */
export interface LibraryAssaultPayload {
  phase:        'started' | 'resolved';
  libraryId:    string;
  libraryName:  string;
  assaultType:  string;
  wasDefended?: boolean;
  offlineHours?: number;
  message:      string;
  timestamp:    number;
}

// ── Vault events ────────────────────────────────────────────────────────────

/** Server → Client: a vault gate has been opened. */
export interface VaultGateOpenedPayload {
  instanceId:    string;
  corridorIndex: number;
  gateIndex:     number;
  position:      { x: number; z: number };
  orientation:   'horizontal' | 'vertical';
  tiles:         Array<{ row: number; col: number }>;
  message:       string;
}

/** Server → Client: entered a new vault room. */
export interface VaultRoomEnterPayload {
  instanceId: string;
  roomIndex:  number;
  roomName:   string;
  isBossRoom: boolean;
  mobCount:   number;
  message:    string;
}

/** Server → Client: a vault mob was killed. */
export interface VaultMobKilledPayload {
  instanceId:    string;
  roomIndex:     number;
  remainingMobs: number;
}

/** Server → Client: a vault room was cleared. */
export interface VaultRoomClearedPayload {
  instanceId: string;
  roomIndex:  number;
  roomName:   string;
  message:    string;
}

/** Server → Client: vault completed successfully. */
export interface VaultCompletePayload {
  instanceId:  string;
  goldAwarded: number;
  message?:    string;
  summary?:    unknown;
  /** Exit portal spawn — client synthesizes this entity locally. Optional
   *  in case the vault has no tile grid (legacy, hand-authored rooms). */
  exitPortal?: {
    id:       string;
    name:     string;
    position: { x: number; y: number; z: number };
  };
}

/** Server → Client: vault failed (party wipe). */
export interface VaultFailedPayload {
  instanceId: string;
  message:    string;
}

/** Server → Client: vault staging zone is active. Sent at vault join while
 *  the squad is still assembling — `/hire` and `/dismiss` are valid until
 *  the first player drifts outside `stagingPoint.radius` from the entrance. */
export interface VaultStagingActivePayload {
  instanceId:   string;
  stagingPoint: { x: number; z: number; radius: number };
}

/** Server → Client: vault staging is broken — squad locked, mobs spawning.
 *  Triggered by the first player to leave the staging circle. Scaling tier
 *  is now frozen against the combat-effective party size. */
export interface VaultStagingBrokenPayload {
  instanceId:         string;
  triggerCharacterId: string;
  combatPartySize:    number;
  scalingTier:        'solo' | 'small' | 'party';
  message?:           string;
}
