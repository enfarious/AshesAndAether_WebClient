/**
 * Protocol types — mirrors the server's src/network/protocol/types.ts.
 * Keep in sync. The server is the source of truth.
 */

export type ClientType = 'text' | '2d' | '3d' | 'vr';
export type AuthMethod  = 'guest' | 'credentials' | 'token' | 'airlock';
export type MoveMethod  = 'heading' | 'position' | 'compass';
export type MovementSpeed     = 'walk' | 'jog' | 'run' | 'stop';

/** Mirrors server SPEED_MULTIPLIERS — applied to base movement speed. */
export const SPEED_MULTIPLIERS: Record<MovementSpeed, number> = {
  walk: 1.0,
  jog:  2.0,
  run:  3.5,
  stop: 0.0,
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

export interface StatusEffect {
  id: string;
  name: string;
  duration: number;            // remaining seconds
  type?: 'buff' | 'debuff';   // display coloring; defaults to 'buff'
  description?: string;        // hover tooltip text
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
  derivedStats?: DerivedStats;
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
  /** For characters: the current animation action. For plants: the growth stage name ('sprout', 'mature', 'flowering', etc.). */
  currentAction?: AnimationAction | string;
  movementDuration?: number;
  movementSpeed?: number;
  heading?: number;
  /** GLB asset path for 3D model (e.g. "dungeon/Dungeon_Entrance_01.glb"). */
  modelAsset?: string;
  /** Uniform scale multiplier for the GLB model (default 1). */
  modelScale?: number;
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
    // Status effects
    effects?: StatusEffect[];
  };
  combat?: {
    atb?: StatBar;
    autoAttack?: StatBar;
    inCombat?: boolean;
    autoAttackTarget?: string;
    specialCharges?: Record<string, number>;
    enmityList?: EnmityEntry[];
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
  staminaPct?: number;
  manaPct?:    number;
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
}

/** Server → Client: vault failed (party wipe). */
export interface VaultFailedPayload {
  instanceId: string;
  message:    string;
}
