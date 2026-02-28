import type {
  CharacterState,
  StatBar,
  Vector3,
  MovementSpeed,
  CorruptionUpdatePayload,
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
  private _id:       string  = '';
  private _name:     string  = '';
  private _level:    number  = 1;
  private _isAlive:  boolean = true;
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

  private listeners = new Set<Listener>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get id():       string  { return this._id; }
  get name():     string  { return this._name; }
  get level():    number  { return this._level; }
  get isAlive():  boolean { return this._isAlive; }
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

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyWorldEntry(character: CharacterState): void {
    this._id       = character.id;
    this._name     = character.name;
    this._level    = character.level;
    this._isAlive  = character.isAlive;
    this._position = { ...character.position };
    this._heading  = character.heading;
    this._speed    = character.currentSpeed ?? 'stop';
    this._health   = character.health  ? { ...character.health }  : { current: 0, max: 0 };
    this._stamina  = character.stamina ? { ...character.stamina } : { current: 0, max: 0 };
    this._mana     = character.mana    ? { ...character.mana }    : { current: 0, max: 0 };
    this._corruption = character.corruption?.current ?? 0;
    this._notify();
  }

  applyStateUpdate(update: {
    health?:  StatBar;
    stamina?: StatBar;
    mana?:    StatBar;
  }): void {
    if (update.health)  this._health  = { ...update.health };
    if (update.stamina) this._stamina = { ...update.stamina };
    if (update.mana)    this._mana    = { ...update.mana };
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
