import {
  SPEED_MULTIPLIERS,
  type CharacterState,
  type StatBar,
  type Vector3,
  type MovementSpeed,
  type CoreStats,
  type DerivedStats,
  type CorruptionState,
  type CorruptionUpdatePayload,
  type StatusEffect,
  type ItemInfo,
  type EquipSlot,
  type InventoryUpdatePayload,
  type AbilityNodeSummary,
  type AbilityUpdatePayload,
  type PartyMemberInfo,
  type PartyAllyState,
  type GuildUpdatePayload,
  type GuildMemberInfo,
  type GuildMemberListPayload,
  type CompanionConfigPayload,
  type CompanionStatusPayload,
  type EnmityEntry,
} from '@/network/Protocol';

type Listener = () => void;

export interface XpBreakdownInfo {
  mobName:        string;
  mobLevel:       number;
  recipientLevel: number;
  partySize:      number;
  baseXp:         number;
  conMult:        number;
  partyMult:      number;
  awardedXp:      number;
}

interface CombatGauges {
  atb:            StatBar | null;
  autoAttack:     StatBar | null;
  inCombat:       boolean;
  autoAttackTarget: string | null;
  specialCharges: Record<string, number>;
}

/**
 * PlayerState — the local player's authoritative state as reported by the server.
 *
 * Position here is the SERVER-AUTHORITATIVE position.
 * The rendered position (with interpolation) lives in PlayerEntity.
 */
export class PlayerState {
  private _id:            string  = '';
  private _name:          string  = '';
  private _level:         number  = 1;
  private _experience:    number  = 0;
  private _abilityPoints: number  = 0;
  private _statPoints:    number  = 0;
  private _isAlive:       boolean = true;
  private _isGuest:       boolean = false;
  private _heading:  number  = 0;
  private _speed:    MovementSpeed = 'stop';
  /** Base movement speed in m/s (from derivedStats.movementSpeed). Apply SPEED_MULTIPLIERS for actual. */
  private _baseMovementSpeed: number = 0;
  /** Actual server movement speed in metres/second (from entity updates). */
  private _movementSpeedMPS: number = 0; // 0 = unknown; WASDController uses a conservative fallback
  /** High-res timestamp of the last applyServerPosition call (ms, from performance.now()). */
  private _lastServerPosTime: number = 0;

  private _position: Vector3 = { x: 0, y: 0, z: 0 };

  private _health:  StatBar = { current: 0, max: 0 };
  private _stamina: StatBar = { current: 0, max: 0 };
  private _mana:    StatBar = { current: 0, max: 0 };

  private _coreStats:    CoreStats | null    = null;
  private _derivedStats: DerivedStats | null = null;
  /** Per-stat passive bonuses on top of `_coreStats`. Drives the "(+N)"
   *  column in CharacterSheet. Empty / null when no passives are unlocked. */
  private _coreStatsBonuses:    Partial<CoreStats>    | null = null;
  private _derivedStatsBonuses: Partial<DerivedStats> | null = null;
  /** Server-pushed axis snapshot driving the character-sheet 6-spoke web
   *  visualization. Updated on world_entry and on PASSIVE_LOADOUT_CHANGED. */
  private _axisSnapshot: import('@/network/Protocol').AxisSnapshot | null = null;

  /** Last kill XP breakdown — surfaced by /xpinfo for live tuning. */
  private _lastXpBreakdown: XpBreakdownInfo | null = null;

  private _corruption: number = 0;
  private _corruptionState: CorruptionState = 'CLEAN';
  private _effects: StatusEffect[] = [];

  private _combat: CombatGauges = {
    atb:              null,
    autoAttack:       null,
    inCombat:         false,
    autoAttackTarget: null,
    specialCharges:   {},
  };

  /** Incremented on each applyCombatUpdate — see combatVersion getter. */
  private _combatVersion = 0;

  private _targetId:     string | null = null;
  private _targetName:   string | null = null;

  /**
   * Locked main target. Distinct from `_targetId`: the player's current
   * displayed main target can drift (Tab cycle, ally-targeted heal click)
   * but the lock survives so post-cast snap-back returns here. When equal
   * to `_targetId` the lock icon shows on the displayed target (closed).
   */
  private _lockedTargetId:   string | null = null;
  private _lockedTargetName: string | null = null;

  private _focusTargetId:   string | null = null;
  private _focusTargetName: string | null = null;

  /**
   * Unix-ms timestamp at which the player's corpse will fully dissolve and
   * auto-release to homepoint.  null when the player is alive.
   * Set by App when an `entity_death` event arrives for this player.
   */
  private _corpseDissolvesAt: number | null = null;

  // ── Inventory ───────────────────────────────────────────────────────────
  private _inventory:      ItemInfo[]                           = [];
  private _equipment:      Partial<Record<EquipSlot, ItemInfo>> = {};
  private _activeWeaponSet: 1 | 2                               = 1;

  // ── Ability tree ─────────────────────────────────────────────────────────
  private _unlockedActiveNodes:  string[]            = [];
  private _unlockedPassiveNodes: string[]            = [];
  private _activeLoadout:        (string | null)[]   = Array(8).fill(null);
  private _passiveLoadout:       (string | null)[]   = Array(8).fill(null);
  private _specialLoadout:       string[]            = [];
  /** Full node manifest sent once on world_entry. */
  private _abilityManifest:      AbilityNodeSummary[] = [];

  // ── Guild ───────────────────────────────────────────────────────────────────
  private _guildId:            string | null = null;
  private _guildName:          string | null = null;
  private _guildTag:           string | null = null;
  private _guildDescription:   string | null = null;
  private _guildMotto:         string | null = null;
  private _guildMemberCount:   number  = 0;
  private _guildMaxBeacons:    number  = 0;
  private _guildLitBeacons:    number  = 0;
  private _isGuildmaster:      boolean = false;
  private _guildBonuses: { corruptionResistPercent: number; xpBonusPercent: number } | null = null;
  private _guildMembers:       GuildMemberInfo[] = [];

  // ── Open-PvP ────────────────────────────────────────────────────────────────
  /** True while the server has us in the `armed` state (mirrored from
   *  pvp_state pushes). Combined with `guildId` + each peer's `pvpArmed`
   *  to compute client-side hostility — drives nameplate color, target
   *  Attack button, tab-target cycling. */
  private _pvpArmed: boolean = false;

  // ── Enmity ──────────────────────────────────────────────────────────────────
  private _enmityList: EnmityEntry[] = [];

  // ── Companion ─────────────────────────────────────────────────────────────
  private _companion: CompanionConfigPayload | null = null;

  // ── Party ──────────────────────────────────────────────────────────────────
  private _partyId:       string | null = null;
  private _partyLeaderId: string | null = null;
  private _partyMembers:  PartyMemberInfo[] = [];
  private _partyAllies:   PartyAllyState[] = [];
  private _pendingInvite: { fromName: string; expiresAt: number } | null = null;

  private listeners = new Set<Listener>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get id():            string  { return this._id; }
  get name():          string  { return this._name; }
  get level():         number  { return this._level; }
  get experience():    number  { return this._experience; }
  get abilityPoints(): number  { return this._abilityPoints; }
  get statPoints():    number  { return this._statPoints; }
  get lastXpBreakdown(): XpBreakdownInfo | null { return this._lastXpBreakdown; }

  setLastXpBreakdown(info: XpBreakdownInfo): void {
    this._lastXpBreakdown = info;
  }
  get isAlive():       boolean { return this._isAlive; }
  /** True when any active effect prevents movement (root, stun, casting, etc.).
   *  Casting is mirrored as a synthetic 'casting' buff by the server (see
   *  CombatStateStore.setCasting) so the existing client-side movement gate
   *  in WASDController + ClickMoveController treats cast-time as immobile
   *  the same way it treats root/stun. */
  get isRooted():      boolean { return this._effects.some(e => e.id === 'rooted' || e.id === 'stunned' || e.id === 'casting'); }

  /** True while a hard-CC stun is active. Stun blocks both rotation and
   *  movement. Distinct from `isRooted` (which is a broader catch-all). */
  get isStunned(): boolean { return this._effects.some(e => e.id === 'stunned'); }

  /** True when the player can't even rotate — stunned or mid-cast. WASD/
   *  click/gamepad input handlers bail entirely on this. Channeling is NOT
   *  here; channeling allows rotation (movement is speed-clamped server-side). */
  get isRotationLocked(): boolean { return this._effects.some(e => e.id === 'stunned' || e.id === 'casting'); }

  /** True when XZ movement is blocked. Includes rooted, stunned, casting.
   *  Rooted-only allows rotation: input controllers should accept heading
   *  changes but skip local position prediction. */
  get isMovementLocked(): boolean { return this._effects.some(e => e.id === 'rooted' || e.id === 'stunned' || e.id === 'casting'); }
  /** True when channeling. Movement is allowed BUT clamped server-side to
   *  channel tier (~1.225 m/s). Sprint input breaks the channel. The HUD
   *  uses this flag to render the cast bar in drain mode. */
  get isChanneling():  boolean { return this._effects.some(e => e.id === 'channeling'); }
  get isGuest():       boolean { return this._isGuest; }
  get position(): Vector3 { return this._position; }
  get heading():  number  { return this._heading; }
  get speed():    MovementSpeed { return this._speed; }
  /** Base movement speed in m/s (before walk/jog/run multiplier). */
  get baseMovementSpeed(): number { return this._baseMovementSpeed; }
  /** Actual movement speed in m/s as reported by the server. */
  get movementSpeedMPS(): number { return this._movementSpeedMPS; }
  /** When the server position was last updated (performance.now() ms). */
  get lastServerPosTime(): number { return this._lastServerPosTime; }
  get health():   StatBar { return this._health; }
  get stamina():  StatBar { return this._stamina; }
  get mana():     StatBar { return this._mana; }
  get coreStats():    CoreStats | null    { return this._coreStats; }
  get derivedStats(): DerivedStats | null { return this._derivedStats; }
  get coreStatsBonuses():    Partial<CoreStats>    | null { return this._coreStatsBonuses; }
  get derivedStatsBonuses(): Partial<DerivedStats> | null { return this._derivedStatsBonuses; }
  get axisSnapshot(): import('@/network/Protocol').AxisSnapshot | null { return this._axisSnapshot; }
  get corruption(): number { return this._corruption; }
  get corruptionState(): CorruptionState { return this._corruptionState; }
  get effects(): StatusEffect[] { return this._effects; }
  get combat():   CombatGauges { return this._combat; }
  /** Bumps on every applyCombatUpdate. Lets consumers detect a fresh server
   *  push even when the field values haven't changed (e.g. autoAttack timer
   *  reset to 0 again after another swing fire). */
  get combatVersion(): number { return this._combatVersion; }
  get targetId(): string | null { return this._targetId; }
  get targetName(): string | null { return this._targetName; }
  /** True only when the *displayed* main target IS the locked one. Tabbing
   *  away leaves the lock intact but flips this false (open lock icon).
   *  Use `lockedTargetId` to read the lock independently of what's displayed. */
  get targetLocked(): boolean {
    return this._lockedTargetId !== null && this._lockedTargetId === this._targetId;
  }
  /** The remembered locked main target, regardless of what's currently displayed.
   *  Drives post-cast snap-back. */
  get lockedTargetId():   string | null { return this._lockedTargetId; }
  get lockedTargetName(): string | null { return this._lockedTargetName; }
  get focusTargetId(): string | null { return this._focusTargetId; }
  get focusTargetName(): string | null { return this._focusTargetName; }
  /** Unix-ms at which corpse auto-dissolves. null if alive. */
  get corpseDissolvesAt(): number | null { return this._corpseDissolvesAt; }

  get inventory():       ItemInfo[]                            { return this._inventory; }
  get equipment():       Partial<Record<EquipSlot, ItemInfo>>  { return this._equipment; }
  get activeWeaponSet(): 1 | 2                                 { return this._activeWeaponSet; }

  get unlockedActiveNodes():  string[]             { return this._unlockedActiveNodes; }
  get unlockedPassiveNodes(): string[]             { return this._unlockedPassiveNodes; }
  get activeLoadout():        (string | null)[]    { return this._activeLoadout; }
  get passiveLoadout():       (string | null)[]    { return this._passiveLoadout; }
  get specialLoadout():       string[]             { return this._specialLoadout; }
  get abilityManifest():      AbilityNodeSummary[] { return this._abilityManifest; }

  get guildId():          string | null          { return this._guildId; }
  get guildName():        string | null          { return this._guildName; }
  get guildTag():         string | null          { return this._guildTag; }
  /** Open-PvP armed state. Set via `setPvpArmed` from the pvp_state event
   *  handler in app.ts. Idle/arming/disarming all read false; only
   *  `state === 'armed'` flips this true. */
  get pvpArmed():         boolean                { return this._pvpArmed; }

  setPvpArmed(armed: boolean): void {
    if (this._pvpArmed === armed) return;
    this._pvpArmed = armed;
    this._notify();
  }
  get guildDescription(): string | null          { return this._guildDescription; }
  get guildMotto():       string | null          { return this._guildMotto; }
  get guildMemberCount(): number                 { return this._guildMemberCount; }
  get guildMaxBeacons():  number                 { return this._guildMaxBeacons; }
  get guildLitBeacons():  number                 { return this._guildLitBeacons; }
  get isGuildmaster():    boolean                { return this._isGuildmaster; }
  get guildBonuses(): { corruptionResistPercent: number; xpBonusPercent: number } | null { return this._guildBonuses; }
  get guildMembers():     GuildMemberInfo[]      { return this._guildMembers; }

  get partyId():       string | null          { return this._partyId; }
  get partyLeaderId(): string | null          { return this._partyLeaderId; }
  get partyMembers():  PartyMemberInfo[]      { return this._partyMembers; }
  get partyAllies():   PartyAllyState[]       { return this._partyAllies; }
  get pendingInvite(): { fromName: string; expiresAt: number } | null { return this._pendingInvite; }

  get enmityList(): EnmityEntry[] { return this._enmityList; }

  get companion(): CompanionConfigPayload | null { return this._companion; }

  /** Called after successful guest registration to clear ephemeral status. */
  setRegistered(username: string): void {
    this._isGuest = false;
    this._name    = username;
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyWorldEntry(character: CharacterState, abilityManifest?: AbilityNodeSummary[], isGuest?: boolean): void {
    this._id            = character.id;
    this._name          = character.name;
    this._level         = character.level;
    this._experience    = character.experience   ?? 0;
    this._abilityPoints = character.abilityPoints ?? 0;
    this._statPoints    = character.statPoints    ?? 0;
    this._isAlive       = character.isAlive;
    this._isGuest       = isGuest ?? false;
    this._position = { ...character.position };
    this._heading  = character.heading;
    this._speed    = character.currentSpeed ?? 'stop';
    this._health   = character.health  ? { ...character.health }  : { current: 0, max: 0 };
    this._stamina  = character.stamina ? { ...character.stamina } : { current: 0, max: 0 };
    this._mana     = character.mana    ? { ...character.mana }    : { current: 0, max: 0 };
    this._corruption      = character.corruption?.current ?? 0;
    this._corruptionState = character.corruption?.state   ?? 'CLEAN';
    this._effects         = [];
    this._partyId         = null;
    this._partyLeaderId   = null;
    this._partyMembers    = [];
    this._partyAllies     = [];
    this._pendingInvite   = null;
    this._coreStats    = character.coreStats    ?? null;
    this._derivedStats = character.derivedStats ?? null;
    this._coreStatsBonuses    = character.coreStatsBonuses    ?? null;
    this._derivedStatsBonuses = character.derivedStatsBonuses ?? null;
    this._axisSnapshot        = character.axisSnapshot         ?? null;
    // Seed prediction speeds from derived stats so WASD & click-to-move
    // prediction is accurate from the first frame.
    if (this._derivedStats?.movementSpeed) {
      this._baseMovementSpeed = this._derivedStats.movementSpeed;
      // Pre-compute jog speed for WASDController's initial frames
      // (overwritten by the first server state_update once movement starts).
      this._movementSpeedMPS = this._baseMovementSpeed * SPEED_MULTIPLIERS['jog'];
    }
    // Ability tree
    this._unlockedActiveNodes  = character.unlockedAbilities?.activeNodes  ?? [];
    this._unlockedPassiveNodes = character.unlockedAbilities?.passiveNodes ?? [];
    this._activeLoadout        = character.activeLoadout  ?? Array(8).fill(null);
    this._passiveLoadout       = character.passiveLoadout ?? Array(8).fill(null);
    this._specialLoadout       = character.specialLoadout ?? [];
    if (abilityManifest) this._abilityManifest = abilityManifest;
    this._notify();
  }

  applyAbilityUpdate(payload: AbilityUpdatePayload): void {
    this._unlockedActiveNodes  = payload.unlockedActiveNodes;
    this._unlockedPassiveNodes = payload.unlockedPassiveNodes;
    this._activeLoadout        = payload.activeLoadout;
    this._passiveLoadout       = payload.passiveLoadout;
    this._abilityPoints        = payload.abilityPoints;
    this._notify();
  }

  applyStateUpdate(update: {
    health?:        StatBar;
    stamina?:       StatBar;
    mana?:          StatBar;
    isAlive?:       boolean;
    experience?:    number;
    level?:         number;
    abilityPoints?: number;
    statPoints?:    number;
    coreStats?:     CoreStats;
    coreStatsBonuses?:    Partial<CoreStats>;
    derivedStats?:  DerivedStats;
    derivedStatsBonuses?: Partial<DerivedStats>;
    axisSnapshot?: import('@/network/Protocol').AxisSnapshot;
  }): void {
    if (update.health)               this._health   = { ...update.health };
    if (update.stamina)              this._stamina  = { ...update.stamina };
    if (update.mana)                 this._mana     = { ...update.mana };
    if (update.isAlive !== undefined) {
      this._isAlive = update.isAlive;
      // Clear the corpse timer when the player comes back to life
      if (update.isAlive) this._corpseDissolvesAt = null;
    }
    if (update.experience    !== undefined) this._experience    = update.experience;
    if (update.level         !== undefined) this._level         = update.level;
    if (update.abilityPoints !== undefined) this._abilityPoints = update.abilityPoints;
    if (update.statPoints    !== undefined) this._statPoints    = update.statPoints;
    if (update.coreStats)    this._coreStats    = { ...update.coreStats };
    if (update.coreStatsBonuses !== undefined) {
      this._coreStatsBonuses = { ...update.coreStatsBonuses };
    }
    if (update.derivedStats) {
      this._derivedStats = { ...update.derivedStats };
      if (update.derivedStats.movementSpeed) {
        this._baseMovementSpeed = update.derivedStats.movementSpeed;
      }
    }
    if (update.derivedStatsBonuses !== undefined) {
      this._derivedStatsBonuses = { ...update.derivedStatsBonuses };
    }
    if (update.axisSnapshot !== undefined) {
      this._axisSnapshot = update.axisSnapshot;
    }
    this._notify();
  }

  applyCombatUpdate(combat: {
    atb?:              StatBar;
    autoAttack?:       StatBar;
    inCombat?:         boolean;
    /** Explicit null = cleared; undefined = unchanged. Server now always
     *  emits null on clear (JSON drops undefined keys). */
    autoAttackTarget?: string | null;
    specialCharges?:   Record<string, number>;
    enmityList?:       EnmityEntry[];
  }): void {
    if (combat.atb        !== undefined) this._combat.atb              = combat.atb;
    if (combat.autoAttack !== undefined) this._combat.autoAttack       = combat.autoAttack;
    if (combat.inCombat   !== undefined) {
      this._combat.inCombat = combat.inCombat;
      if (!combat.inCombat) {
        this._combat.atb        = null;
        this._combat.autoAttack = null;
        this._combat.autoAttackTarget = null;
        this._enmityList = [];
      }
    }
    if (combat.autoAttackTarget !== undefined) this._combat.autoAttackTarget = combat.autoAttackTarget;
    if (combat.specialCharges)  this._combat.specialCharges = { ...combat.specialCharges };
    if (combat.enmityList)      this._enmityList = combat.enmityList;
    this._combatVersion++;
    this._notify();
  }

  applyServerPosition(position: Vector3, heading?: number, speed?: MovementSpeed, movementSpeedMPS?: number): void {
    this._position = { ...position };
    this._lastServerPosTime = performance.now();
    if (heading          !== undefined) this._heading          = heading;
    if (speed            !== undefined) this._speed            = speed;
    if (movementSpeedMPS !== undefined) this._movementSpeedMPS = movementSpeedMPS;
    this._notify();
  }

  applyCorruptionUpdate(payload: CorruptionUpdatePayload): void {
    this._corruption      = payload.corruption;
    this._corruptionState = payload.state;
    this._notify();
  }

  applyEffects(effects: StatusEffect[]): void {
    this._effects = effects;
    this._notify();
  }

  /** Tick effect durations locally for smooth timer display. */
  tickEffects(dt: number): void {
    if (this._effects.length === 0) return;
    let removed = false;
    this._effects = this._effects.filter(e => {
      e.duration -= dt;
      if (e.duration <= 0) { removed = true; return false; }
      return true;
    });
    if (removed) this._notify();
  }

  /**
   * Called by App when the server sends an `entity_death` event for this player.
   * Records when the corpse will auto-dissolve so the HUD can show a countdown.
   */
  setCorpseDissolvesAt(dissolveAtMs: number): void {
    this._corpseDissolvesAt = dissolveAtMs;
    this._notify();
  }

  applyInventoryUpdate(payload: InventoryUpdatePayload): void {
    this._inventory       = payload.items;
    this._equipment       = { ...payload.equipment };
    this._activeWeaponSet = payload.activeWeaponSet;
    this._notify();
  }

  // ── Guild mutations ────────────────────────────────────────────────────────

  applyGuildUpdate(payload: GuildUpdatePayload): void {
    if (payload.removed) {
      this.clearGuild();
      return;
    }
    if (payload.guildId)        this._guildId          = payload.guildId;
    if (payload.name)           this._guildName        = payload.name;
    if (payload.tag)            this._guildTag         = payload.tag;
    if (payload.description !== undefined) this._guildDescription = payload.description;
    if (payload.motto !== undefined)       this._guildMotto       = payload.motto;
    if (payload.memberCount  !== undefined) this._guildMemberCount = payload.memberCount;
    if (payload.maxBeacons   !== undefined) this._guildMaxBeacons  = payload.maxBeacons;
    if (payload.litBeaconCount !== undefined) this._guildLitBeacons = payload.litBeaconCount;
    if (payload.isGuildmaster !== undefined)  this._isGuildmaster   = payload.isGuildmaster;
    if (payload.bonuses)       this._guildBonuses     = { ...payload.bonuses };
    this._notify();
  }

  applyGuildMemberList(payload: GuildMemberListPayload): void {
    this._guildMembers = payload.members;
    this._notify();
  }

  clearGuild(): void {
    this._guildId          = null;
    this._guildName        = null;
    this._guildTag         = null;
    this._guildDescription = null;
    this._guildMotto       = null;
    this._guildMemberCount = 0;
    this._guildMaxBeacons  = 0;
    this._guildLitBeacons  = 0;
    this._isGuildmaster    = false;
    this._guildBonuses     = null;
    this._guildMembers     = [];
    this._notify();
  }

  // ── Party mutations ────────────────────────────────────────────────────────

  applyPartyRoster(partyId: string, leaderId: string, members: PartyMemberInfo[]): void {
    this._partyId       = partyId;
    this._partyLeaderId = leaderId;
    this._partyMembers  = members;
    this._pendingInvite = null;
    this._notify();
  }

  applyPartyMemberJoined(id: string, name: string): void {
    if (!this._partyMembers.some(m => m.id === id)) {
      this._partyMembers = [...this._partyMembers, { id, name }];
    }
    this._notify();
  }

  applyPartyMemberLeft(id: string): void {
    this._partyMembers = this._partyMembers.filter(m => m.id !== id);
    this._partyAllies  = this._partyAllies.filter(a => a.entityId !== id);
    if (this._partyMembers.length <= 1) {
      this.clearParty();
      return;
    }
    this._notify();
  }

  applyPartyAllies(allies: PartyAllyState[]): void {
    this._partyAllies = allies;
    this._notify();
  }

  applyPartyInvite(fromName: string, expiresAt: number): void {
    this._pendingInvite = { fromName, expiresAt };
    this._notify();
  }

  clearPartyInvite(): void {
    this._pendingInvite = null;
    this._notify();
  }

  clearParty(): void {
    this._partyId       = null;
    this._partyLeaderId = null;
    this._partyMembers  = [];
    this._partyAllies   = [];
    this._pendingInvite = null;
    this._notify();
  }

  // ── Companion mutations ──────────────────────────────────────────────────

  applyCompanionConfig(payload: CompanionConfigPayload): void {
    // Merge — different emitters send different subsets (gateway sends the
    // full DB-backed config including abilities + derivedStats; zone sends
    // partial updates after mutations). Replace would wipe fields the other
    // side owns. New payload fields take precedence.
    this._companion = { ...(this._companion ?? {}), ...payload } as CompanionConfigPayload;
    this._notify();
  }

  /** Lightweight status patch from companion_status events (HP, resources, BT state, LLM pending). */
  applyCompanionStatus(status: CompanionStatusPayload): void {
    if (!this._companion || this._companion.companionId !== status.companionId) return;
    this._companion = {
      ...this._companion,
      currentHealth:  status.currentHealth,
      maxHealth:      status.maxHealth,
      currentMana:    status.currentMana,
      maxMana:        status.maxMana,
      currentStamina: status.currentStamina,
      maxStamina:     status.maxStamina,
      isAlive:        status.isAlive,
      behaviorState:  status.behaviorState,
      lastAbility:    status.lastAbility,
      combatSettings: {
        ...this._companion.combatSettings,
        engagementMode: status.engagementMode,
      },
    };
    // Stash llmPending as an extra property for the HUD
    (this._companion as CompanionConfigPayload & { llmPending?: boolean }).llmPending = status.llmPending;
    this._notify();
  }

  clearCompanion(): void {
    this._companion = null;
    this._notify();
  }

  /**
   * Stamp a transient action on the companion's lastAbility slot — used when a
   * combat_hit / combat_miss event arrives with the companion as attacker, so
   * the CompanionHUD shows it immediately rather than waiting for the ~1Hz status tick.
   */
  recordCompanionAction(abilityName: string, timestamp: number): void {
    if (!this._companion) return;
    this._companion = {
      ...this._companion,
      lastAbility: { abilityId: abilityName, abilityName, timestamp },
    };
    this._notify();
  }

  setTarget(id: string | null, name: string | null): void {
    this._targetId   = id;
    this._targetName = name;
    this._notify();
  }

  clearTarget(): void {
    this._targetId         = null;
    this._targetName       = null;
    this._lockedTargetId   = null;
    this._lockedTargetName = null;
    this._notify();
  }

  /**
   * Toggle lock on the *currently displayed* target.
   *   - If the displayed target IS the locked one → unlock.
   *   - Else → lock the displayed target (overwriting any prior lock).
   *   - If no displayed target → unlock anything that was locked.
   *
   * To unlock without locking something else: tab back to your locked
   * target, then press Y.
   */
  toggleTargetLock(): void {
    if (!this._targetId) {
      if (this._lockedTargetId !== null) {
        this._lockedTargetId   = null;
        this._lockedTargetName = null;
        this._notify();
      }
      return;
    }
    if (this._lockedTargetId === this._targetId) {
      this._lockedTargetId   = null;
      this._lockedTargetName = null;
    } else {
      this._lockedTargetId   = this._targetId;
      this._lockedTargetName = this._targetName;
    }
    this._notify();
  }

  // ── Focus target ─────────────────────────────────────────────────────────

  setFocusTarget(id: string | null, name: string | null): void {
    this._focusTargetId   = id;
    this._focusTargetName = name;
    this._notify();
  }

  clearFocusTarget(): void {
    this._focusTargetId   = null;
    this._focusTargetName = null;
    this._notify();
  }

  /** Promote current target to focus target. */
  focusCurrentTarget(): void {
    this._focusTargetId   = this._targetId;
    this._focusTargetName = this._targetName;
    this._notify();
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private _notify(): void {
    this.listeners.forEach(fn => fn());
  }
}
