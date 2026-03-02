import type {
  CharacterState,
  StatBar,
  Vector3,
  MovementSpeed,
  CorruptionUpdatePayload,
  ItemInfo,
  EquipSlot,
  InventoryUpdatePayload,
  AbilityNodeSummary,
  AbilityUpdatePayload,
} from '@/network/Protocol';

type Listener = () => void;

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
  private _heading:  number  = 0;
  private _speed:    MovementSpeed = 'stop';

  private _position: Vector3 = { x: 0, y: 0, z: 0 };

  private _health:  StatBar = { current: 0, max: 0 };
  private _stamina: StatBar = { current: 0, max: 0 };
  private _mana:    StatBar = { current: 0, max: 0 };

  private _corruption: number = 0;

  private _combat: CombatGauges = {
    atb:              null,
    autoAttack:       null,
    inCombat:         false,
    autoAttackTarget: null,
    specialCharges:   {},
  };

  private _targetId:   string | null = null;
  private _targetName: string | null = null;

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

  /**
   * Client-predicted position — set every frame by WASDController while
   * movement keys are held.  EntityFactory reads this and forwards it to
   * PlayerEntity so the player capsule moves smoothly without waiting for
   * server round-trips.  null when the player is stationary.
   */
  private _localPos: Vector3 | null = null;

  private listeners = new Set<Listener>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get id():            string  { return this._id; }
  get name():          string  { return this._name; }
  get level():         number  { return this._level; }
  get experience():    number  { return this._experience; }
  get abilityPoints(): number  { return this._abilityPoints; }
  get statPoints():    number  { return this._statPoints; }
  get isAlive():       boolean { return this._isAlive; }
  get position(): Vector3 { return this._position; }
  get heading():  number  { return this._heading; }
  get speed():    MovementSpeed { return this._speed; }
  get health():   StatBar { return this._health; }
  get stamina():  StatBar { return this._stamina; }
  get mana():     StatBar { return this._mana; }
  get corruption(): number { return this._corruption; }
  get combat():   CombatGauges { return this._combat; }
  get targetId(): string | null { return this._targetId; }
  get targetName(): string | null { return this._targetName; }
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

  /** Client-predicted position; null while stationary. */
  get localPosition(): Vector3 | null { return this._localPos; }

  /** Called by WASDController every frame movement keys are held. */
  setLocalPosition(pos: Vector3): void { this._localPos = { ...pos }; }

  /** Called by WASDController when movement keys are released. */
  clearLocalPosition(): void { this._localPos = null; }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyWorldEntry(character: CharacterState, abilityManifest?: AbilityNodeSummary[]): void {
    this._id            = character.id;
    this._name          = character.name;
    this._level         = character.level;
    this._experience    = character.experience   ?? 0;
    this._abilityPoints = character.abilityPoints ?? 0;
    this._statPoints    = character.statPoints    ?? 0;
    this._isAlive       = character.isAlive;
    this._position = { ...character.position };
    this._heading  = character.heading;
    this._speed    = character.currentSpeed ?? 'stop';
    this._health   = character.health  ? { ...character.health }  : { current: 0, max: 0 };
    this._stamina  = character.stamina ? { ...character.stamina } : { current: 0, max: 0 };
    this._mana     = character.mana    ? { ...character.mana }    : { current: 0, max: 0 };
    this._corruption = character.corruption?.current ?? 0;
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
    this._notify();
  }

  applyCombatUpdate(combat: {
    atb?:              StatBar;
    autoAttack?:       StatBar;
    inCombat?:         boolean;
    autoAttackTarget?: string;
    specialCharges?:   Record<string, number>;
  }): void {
    if (combat.atb        !== undefined) this._combat.atb              = combat.atb;
    if (combat.autoAttack !== undefined) this._combat.autoAttack       = combat.autoAttack;
    if (combat.inCombat   !== undefined) {
      this._combat.inCombat = combat.inCombat;
      if (!combat.inCombat) {
        this._combat.atb        = null;
        this._combat.autoAttack = null;
        this._combat.autoAttackTarget = null;
      }
    }
    if (combat.autoAttackTarget !== undefined) this._combat.autoAttackTarget = combat.autoAttackTarget;
    if (combat.specialCharges)  this._combat.specialCharges = { ...combat.specialCharges };
    this._notify();
  }

  applyServerPosition(position: Vector3, heading?: number, speed?: MovementSpeed): void {
    this._position = { ...position };
    if (heading !== undefined) this._heading = heading;
    if (speed   !== undefined) this._speed   = speed;
    this._notify();
  }

  applyCorruptionUpdate(payload: CorruptionUpdatePayload): void {
    this._corruption = payload.corruption;
    this._notify();
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

  setTarget(id: string | null, name: string | null): void {
    this._targetId   = id;
    this._targetName = name;
    this._notify();
  }

  clearTarget(): void {
    this._targetId   = null;
    this._targetName = null;
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
