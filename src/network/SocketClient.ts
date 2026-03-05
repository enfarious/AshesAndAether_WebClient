import { io, Socket } from 'socket.io-client';
import { ClientConfig } from '@/config/ClientConfig';
import type {
  HandshakePayload,
  AuthPayload,
  Vector3,
  MovementSpeed,
  CommunicationChannel,
  InteractionAction,
  EquipSlot,
  CompanionCreateData,
} from './Protocol';

type RawListener = (payload: unknown) => void;

/**
 * SocketClient — owns the raw Socket.IO connection.
 *
 * Responsibilities:
 *   - Connect / disconnect lifecycle
 *   - Handshake and queued auth flow
 *   - Typed emit methods for every client → server message
 *   - Raw event subscription (MessageRouter listens here)
 *
 * Does NOT interpret server messages. That is MessageRouter's job.
 */
export class SocketClient {
  private socket: Socket | null = null;
  private handshakeSent   = false;
  private handshakeAcked  = false;
  private pendingAuth: AuthPayload | null = null;
  private listeners = new Map<string, Set<RawListener>>();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connect(): void {
    if (this.socket?.connected) return;

    this.socket = io(ClientConfig.serverUrl, {
      path: '/socket.io/',
      transports: ['websocket'],
      autoConnect: false,
    });

    this.socket.on('connect', () => {
      this.handshakeSent  = false;
      this.handshakeAcked = false;
      this._sendHandshake();
      this._emit('_connected', null);
    });

    this.socket.on('disconnect', (reason) => {
      this.handshakeSent  = false;
      this.handshakeAcked = false;
      this._emit('_disconnected', reason);
    });

    this.socket.on('connect_error', (err) => {
      this._emit('_connect_error', err.message);
    });

    // Forward every server event to our internal bus
    const serverEvents = [
      'handshake_ack',
      'auth_success', 'auth_error', 'auth_confirm_name',
      'character_list', 'character_confirm_name', 'character_roster_delta', 'character_error',
      'world_entry',
      'state_update',
      'event',
      'communication',
      'chat',
      'proximity_roster', 'proximity_roster_delta',
      'corruption_update',
      'inventory_update',
      'loot_session_start', 'loot_item_result', 'loot_session_end',
      'ability_update',
      'stat_allocate_result', 'respec_result',
      'register_result',
      'zone_transfer', 'village_state', 'village_placement_mode', 'village_catalog',
      'editor_open', 'editor_result',
      'guild_update', 'guild_member_list', 'guild_invite', 'guild_chat', 'guild_founding_narrative',
      'companion_config',
      'beacon_alert', 'library_assault',
      'error',
      'pong',
      'command_response',
      'logout_success',
      'dev_ack',
    ] as const;

    for (const name of serverEvents) {
      this.socket.on(name, (payload: unknown) => {
        if (name === 'dev_ack') {
          const p = payload as { event?: string; ok?: boolean; reason?: string };
          console.log(`[Gateway dev_ack] event="${p.event}" ok=${p.ok}${p.reason ? ` reason="${p.reason}"` : ''}`);
        }
        if (name === 'chat' || name === 'communication') {
          console.log(`[SocketClient] ← ${name}`, payload);
        }
        this._emit(name, payload);
      });
    }

    this.socket.connect();
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  get isReady(): boolean {
    return this.isConnected && this.handshakeAcked;
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  /**
   * Queue auth to be sent once the handshake is acknowledged.
   * Safe to call before connecting.
   */
  requestAuth(payload: AuthPayload): void {
    this.pendingAuth = payload;
    this._flushPendingAuth();
  }

  onHandshakeAck(): void {
    this.handshakeAcked = true;
    this._flushPendingAuth();
  }

  // ── Emit methods ──────────────────────────────────────────────────────────

  /** Request graceful logout — return to character select without disconnecting. */
  sendLogout(): void {
    this._send('logout', { timestamp: Date.now() });
  }

  sendCharacterSelect(characterId: string): void {
    this._send('character_select', { characterId });
  }

  sendCharacterCreate(name: string, companion?: CompanionCreateData): void {
    this._send('character_create', {
      name,
      appearance: { description: 'TBD' },
      ...(companion ? { companion } : {}),
    });
  }

  sendCharacterNameConfirmed(name: string, confirmed: boolean): void {
    this._send('character_name_confirmed', { name, confirmed });
  }

  sendAuthNameConfirmed(username: string, password: string, confirmed: boolean): void {
    this._send('auth_name_confirmed', { username, password, confirmed });
  }

  sendMovePosition(position: Vector3, speed?: MovementSpeed): void {
    this._send('move', {
      method: 'position',
      position,
      speed: speed ?? 'jog',
      timestamp: Date.now(),
    });
  }

  sendMoveHeading(heading: number, speed: MovementSpeed): void {
    this._send('move', {
      method: 'heading',
      heading,
      speed,
      timestamp: Date.now(),
    });
  }

  sendMoveContinuous(heading: number, speed: MovementSpeed): void {
    this._send('move', {
      method: 'continuous',
      heading,
      speed,
      timestamp: Date.now(),
    });
  }

  sendMoveStop(): void {
    this._send('move', {
      method: 'heading',
      speed: 'stop',
      timestamp: Date.now(),
    });
  }

  sendChat(channel: CommunicationChannel, message: string, target?: string): void {
    console.log(`[SocketClient] → chat  channel="${channel}" target="${target ?? ''}" message="${message}"`);
    this._send('chat', { channel, message, target, timestamp: Date.now() });
  }

  sendInteract(targetId: string, action: InteractionAction): void {
    this._send('interact', { targetId, action, timestamp: Date.now() });
  }

  sendCombatAction(abilityId: string, targetId: string, position?: Vector3): void {
    console.log(`[SocketClient] sendCombatAction → ability="${abilityId}" target="${targetId}"`, position ?? '');
    this._send('combat_action', { abilityId, targetId, position, timestamp: Date.now() });
  }

  sendCommand(command: string): void {
    console.log(`[SocketClient] → command "${command}"`);
    this._send('command', { command, timestamp: Date.now() });
  }

  sendProximityRefresh(): void {
    this._send('proximity_refresh', { timestamp: Date.now() });
  }

  sendPing(): void {
    this._send('ping', { timestamp: Date.now() });
  }

  sendRespawn(): void {
    this._send('respawn', { timestamp: Date.now() });
  }

  sendEquipItem(itemId: string, slot: EquipSlot): void {
    this._send('equip_item', { itemId, slot, timestamp: Date.now() });
  }

  sendUnequipItem(slot: EquipSlot): void {
    this._send('unequip_item', { slot, timestamp: Date.now() });
  }

  sendWeaponSetSwap(): void {
    this._send('weapon_set_swap', { timestamp: Date.now() });
  }

  sendLootRoll(sessionId: string, itemId: string, roll: 'need' | 'want' | 'pass'): void {
    this._send('loot_roll', { sessionId, itemId, roll });
  }

  sendUnlockAbility(nodeId: string): void {
    this._send('unlock_ability', { nodeId });
  }

  sendSlotActiveAbility(slotNumber: number, nodeId: string): void {
    this._send('slot_active_ability', { slotNumber, nodeId });
  }

  sendSlotPassiveAbility(slotNumber: number, nodeId: string): void {
    this._send('slot_passive_ability', { slotNumber, nodeId });
  }

  sendAllocateStat(stat: string): void {
    this._send('allocate_stat', { stat });
  }

  sendRespecStats(): void {
    this._send('respec_stats', {});
  }

  sendRespecAbilities(): void {
    this._send('respec_abilities', {});
  }

  sendRegisterAccount(username: string, email: string, password: string): void {
    this._send('register_account', { username, email, password });
  }

  sendZoneTransferReady(): void {
    this._send('zone_transfer_ready', {});
  }

  sendVillagePlaceConfirm(catalogId: string, posX: number, posZ: number, rotation: number): void {
    this._send('village_place_confirm', { catalogId, posX, posZ, rotation });
  }

  sendEditorSave(editorId: string, source: string): void {
    this._send('editor_save', { editorId, source });
  }

  sendEditorCompile(editorId: string, source: string): void {
    this._send('editor_compile', { editorId, source });
  }

  sendEditorRevert(editorId: string): void {
    this._send('editor_revert', { editorId });
  }

  sendEditorClose(editorId: string): void {
    this._send('editor_close', { editorId });
  }

  // ── Companion management ─────────────────────────────────────────────────

  sendCompanionRequestConfig(): void {
    this.sendCommand('/companion config');
  }

  sendCompanionSetArchetype(archetype: string): void {
    this.sendCommand(`/companion archetype ${archetype}`);
  }

  sendCompanionConfigure(settings: Record<string, unknown>): void {
    const parts: string[] = [];
    if (settings.stance)          parts.push(`stance=${settings.stance}`);
    if (settings.preferredRange)  parts.push(`range=${settings.preferredRange}`);
    if (settings.priority)        parts.push(`priority=${settings.priority}`);
    if (settings.retreatThreshold !== undefined) parts.push(`retreat=${settings.retreatThreshold}`);
    if (settings.abilityWeights) {
      for (const [k, v] of Object.entries(settings.abilityWeights as Record<string, number>)) {
        parts.push(`${k}=${v}`);
      }
    }
    this.sendCommand(`/companion configure ${parts.join(' ')}`);
  }

  sendCompanionSetAbilities(abilityIds: string[]): void {
    this.sendCommand(`/companion abilities ${abilityIds.join(',')}`);
  }

  sendCompanionFollow(): void { this.sendCommand('/companion follow'); }
  sendCompanionDetach(): void { this.sendCommand('/companion detach'); }
  sendCompanionRecall(): void { this.sendCommand('/companion recall'); }

  // ── Event bus ─────────────────────────────────────────────────────────────

  on(event: string, listener: RawListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: RawListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _send(event: string, payload: unknown): void {
    if (!this.socket?.connected) {
      console.warn(`[SocketClient] Cannot send "${event}": not connected`);
      return;
    }
    this.socket.emit(event, payload);
  }

  private _emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach(fn => fn(payload));
  }

  private _sendHandshake(): void {
    if (this.handshakeSent) return;
    const payload: HandshakePayload = {
      protocolVersion: ClientConfig.protocolVersion,
      clientType:      ClientConfig.clientType,
      clientVersion:   ClientConfig.clientVersion,
      capabilities: {
        graphics:      true,
        audio:         true,
        input:         ['keyboard', 'mouse'],
        maxUpdateRate: ClientConfig.maxUpdateRate,
      },
    };
    this.socket?.emit('handshake', payload);
    this.handshakeSent = true;
  }

  private _flushPendingAuth(): void {
    if (!this.pendingAuth || !this.handshakeAcked) return;
    const auth = this.pendingAuth;
    this.pendingAuth = null;
    this._send('auth', auth);
  }
}
