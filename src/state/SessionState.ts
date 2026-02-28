import type {
  AuthSuccessPayload,
  AuthErrorPayload,
  AuthConfirmNamePayload,
  CharacterListPayload,
  CharacterConfirmNamePayload,
  CharacterErrorPayload,
  CharacterInfo,
} from '@/network/Protocol';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'error';

export type GamePhase =
  | 'disconnected'
  | 'login'
  | 'character_select'
  | 'loading_world'
  | 'in_world';

type Listener<T> = (value: T) => void;

/**
 * SessionState — auth lifecycle, character selection, and connection phase.
 *
 * This is the first state store populated after a socket connects.
 * The UI reads from it to know what screen to show.
 */
export class SessionState {
  private _connectionStatus: ConnectionStatus = 'idle';
  private _connectionError: string | null = null;
  private _phase: GamePhase = 'disconnected';

  private _accountId:   string | null = null;
  private _authToken:   string | null = null;
  private _isEphemeral: boolean = false;
  private _ephemeralMessage: string | null = null;

  private _characters:          CharacterInfo[] = [];
  private _canCreateCharacter:  boolean = false;
  private _maxCharacters:       number = 0;

  private _selectedCharacterId: string | null = null;

  // Pending confirm-name flows
  private _pendingAuthConfirm:      AuthConfirmNamePayload      | null = null;
  private _pendingCharacterConfirm: CharacterConfirmNamePayload | null = null;
  private _pendingCharacterError:   CharacterErrorPayload       | null = null;

  private listeners = new Map<string, Set<Listener<unknown>>>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get connectionStatus(): ConnectionStatus { return this._connectionStatus; }
  get connectionError():  string | null    { return this._connectionError; }
  get phase():            GamePhase        { return this._phase; }
  get accountId():        string | null    { return this._accountId; }
  get authToken():        string | null    { return this._authToken; }
  get isEphemeral():      boolean          { return this._isEphemeral; }
  get ephemeralMessage(): string | null    { return this._ephemeralMessage; }
  get characters():       CharacterInfo[]  { return this._characters; }
  get canCreateCharacter(): boolean        { return this._canCreateCharacter; }
  get maxCharacters():    number           { return this._maxCharacters; }
  get selectedCharacterId(): string | null { return this._selectedCharacterId; }
  get pendingAuthConfirm():      AuthConfirmNamePayload      | null { return this._pendingAuthConfirm; }
  get pendingCharacterConfirm(): CharacterConfirmNamePayload | null { return this._pendingCharacterConfirm; }
  get pendingCharacterError():   CharacterErrorPayload       | null { return this._pendingCharacterError; }

  // ── Mutations (called by MessageRouter) ───────────────────────────────────

  setConnectionStatus(status: ConnectionStatus, error?: string): void {
    this._connectionStatus = status;
    this._connectionError  = error ?? null;
    if (status === 'connected') this.setPhase('login');
    this._notify('connectionStatus', status);
  }

  setPhase(phase: GamePhase): void {
    this._phase = phase;
    this._notify('phase', phase);
  }

  onAuthSuccess(payload: AuthSuccessPayload): void {
    this._accountId       = payload.accountId;
    this._authToken       = payload.token;
    this._isEphemeral     = payload.isEphemeral ?? false;
    this._ephemeralMessage = payload.ephemeralMessage ?? null;
    this._characters      = payload.characters;
    this._canCreateCharacter = payload.canCreateCharacter;
    this._maxCharacters   = payload.maxCharacters;
    this.setPhase('character_select');
    this._notify('authSuccess', payload);
  }

  onAuthError(payload: AuthErrorPayload): void {
    this._notify('authError', payload);
  }

  onAuthConfirmName(payload: AuthConfirmNamePayload): void {
    this._pendingAuthConfirm = payload;
    this._notify('authConfirmName', payload);
  }

  clearAuthConfirm(): void {
    this._pendingAuthConfirm = null;
  }

  onCharacterList(payload: CharacterListPayload): void {
    this._characters         = payload.characters;
    this._canCreateCharacter = payload.canCreateCharacter;
    this._maxCharacters      = payload.maxCharacters;
    this._notify('characterList', payload);
  }

  onCharacterConfirmName(payload: CharacterConfirmNamePayload): void {
    this._pendingCharacterConfirm = payload;
    this._notify('characterConfirmName', payload);
  }

  clearCharacterConfirm(): void {
    this._pendingCharacterConfirm = null;
  }

  onCharacterError(payload: CharacterErrorPayload): void {
    this._pendingCharacterError = payload;
    this._notify('characterError', payload);
  }

  clearCharacterError(): void {
    this._pendingCharacterError = null;
  }

  selectCharacter(id: string): void {
    this._selectedCharacterId = id;
    this.setPhase('loading_world');
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  on(event: string, listener: Listener<unknown>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<unknown>);
    return () => this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  private _notify(event: string, value: unknown): void {
    this.listeners.get(event)?.forEach(fn => fn(value));
  }
}
