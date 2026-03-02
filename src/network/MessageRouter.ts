import type { SocketClient } from './SocketClient';
import type { SessionState } from '@/state/SessionState';
import type { PlayerState } from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { WorldState } from '@/state/WorldState';
import type {
  HandshakeAckPayload,
  AuthSuccessPayload,
  AuthErrorPayload,
  AuthConfirmNamePayload,
  CharacterListPayload,
  CharacterConfirmNamePayload,
  CharacterErrorPayload,
  WorldEntryPayload,
  StateUpdatePayload,
  EventPayload,
  CommunicationPayload,
  ProximityRosterPayload,
  ProximityRosterDeltaPayload,
  CorruptionUpdatePayload,
  InventoryUpdatePayload,
  ErrorPayload,
  CommandResponsePayload,
  LootSessionStartPayload,
  LootItemResultPayload,
  LootSessionEndPayload,
  AbilityUpdatePayload,
  PartyMemberInfo,
  PartyAllyState,
  ZoneTransferPayload,
  VillagePlacementModePayload,
  VillageStatePayload,
  RegisterResultPayload,
} from './Protocol';

/**
 * MessageRouter — subscribes to raw SocketClient events and dispatches
 * typed updates to the appropriate state stores.
 *
 * This is the only place that knows both the network shape and the state shape.
 * Nothing else should read from the socket directly.
 */
export class MessageRouter {
  private lootStartListeners    = new Set<(p: LootSessionStartPayload) => void>();
  private lootResultListeners   = new Set<(p: LootItemResultPayload) => void>();
  private lootEndListeners      = new Set<(p: LootSessionEndPayload) => void>();
  private abilityUpdateListeners = new Set<(p: AbilityUpdatePayload) => void>();
  private registerResultListeners = new Set<(p: RegisterResultPayload) => void>();
  private villagePlacementListeners = new Set<(p: VillagePlacementModePayload) => void>();
  private villageStateListeners    = new Set<(p: VillageStatePayload) => void>();

  constructor(
    private readonly socket:   SocketClient,
    private readonly session:  SessionState,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly world:    WorldState,
  ) {}

  onLootSessionStart(fn: (p: LootSessionStartPayload) => void): () => void {
    this.lootStartListeners.add(fn);
    return () => this.lootStartListeners.delete(fn);
  }

  onLootItemResult(fn: (p: LootItemResultPayload) => void): () => void {
    this.lootResultListeners.add(fn);
    return () => this.lootResultListeners.delete(fn);
  }

  onLootSessionEnd(fn: (p: LootSessionEndPayload) => void): () => void {
    this.lootEndListeners.add(fn);
    return () => this.lootEndListeners.delete(fn);
  }

  /** Subscribe to ability_update events (unlock result or slot change). */
  onAbilityUpdate(fn: (p: AbilityUpdatePayload) => void): () => void {
    this.abilityUpdateListeners.add(fn);
    return () => this.abilityUpdateListeners.delete(fn);
  }

  onRegisterResult(fn: (p: RegisterResultPayload) => void): () => void {
    this.registerResultListeners.add(fn);
    return () => this.registerResultListeners.delete(fn);
  }

  onVillagePlacementMode(fn: (p: VillagePlacementModePayload) => void): () => void {
    this.villagePlacementListeners.add(fn);
    return () => this.villagePlacementListeners.delete(fn);
  }

  onVillageState(fn: (p: VillageStatePayload) => void): () => void {
    this.villageStateListeners.add(fn);
    return () => this.villageStateListeners.delete(fn);
  }

  mount(): void {
    const s = this.socket;

    s.on('handshake_ack', (p) => {
      const payload = p as HandshakeAckPayload;
      if (!payload.compatible) {
        console.error('[MessageRouter] Incompatible protocol version');
        this.session.setConnectionStatus('error', 'Incompatible protocol version');
        return;
      }
      this.socket.onHandshakeAck();
      this.session.setConnectionStatus('connected');
    });

    s.on('auth_success', (p) => {
      const payload = p as AuthSuccessPayload;
      this.session.onAuthSuccess(payload);
    });

    s.on('auth_error', (p) => {
      const payload = p as AuthErrorPayload;
      this.session.onAuthError(payload);
    });

    s.on('auth_confirm_name', (p) => {
      const payload = p as AuthConfirmNamePayload;
      this.session.onAuthConfirmName(payload);
    });

    s.on('character_list', (p) => {
      const payload = p as CharacterListPayload;
      this.session.onCharacterList(payload);
    });

    s.on('character_confirm_name', (p) => {
      const payload = p as CharacterConfirmNamePayload;
      this.session.onCharacterConfirmName(payload);
    });

    s.on('character_error', (p) => {
      const payload = p as CharacterErrorPayload;
      this.session.onCharacterError(payload);
    });

    s.on('world_entry', (p) => {
      const payload = p as WorldEntryPayload;
      this.world.applyZone(payload.zone);
      this.player.applyWorldEntry(payload.character, payload.abilityManifest, payload.isGuest);
      this.entities.applyWorldEntry(payload.entities, payload.character.id);
      // setPhase last — listeners will find world.zone and player.position ready
      this.session.setPhase('in_world');
    });

    s.on('state_update', (p) => {
      const payload = p as StateUpdatePayload;

      if (payload.character) {
        this.player.applyStateUpdate(payload.character);
        if (payload.character.effects) {
          this.player.applyEffects(payload.character.effects);
        }
      }

      if (payload.combat) {
        this.player.applyCombatUpdate(payload.combat);
      }

      if (payload.zone) {
        this.world.applyZonePartial(payload.zone);
      }

      if (payload.entities) {
        if (payload.entities.added) {
          for (const e of payload.entities.added) {
            this.entities.add(e);
          }
        }
        if (payload.entities.updated) {
          for (const e of payload.entities.updated) {
            if (e.id) {
              this.entities.update(e.id, e);
              // Keep player state in sync from entity updates
              if (e.id === this.player.id) {
                if (e.position) {
                  this.player.applyServerPosition(e.position, e.heading, undefined, e.movementSpeed);
                }
                if (e.isAlive !== undefined) {
                  this.player.applyStateUpdate({ isAlive: e.isAlive });
                }
              }
            }
          }
        }
        if (payload.entities.removed) {
          for (const id of payload.entities.removed) {
            this.entities.remove(id);
          }
        }
      }

      if (payload.allies) {
        this.player.applyPartyAllies(payload.allies as PartyAllyState[]);
      }
    });

    s.on('event', (p) => {
      const payload = p as EventPayload;
      this.world.onGameEvent(payload);

      // ── Party events ────────────────────────────────────────────────────
      if (payload.eventType?.startsWith('party_')) {
        console.log(`[MessageRouter] party event: ${payload.eventType}`, payload);
      }
      if (payload.eventType === 'party_roster') {
        this.player.applyPartyRoster(
          payload['partyId'] as string,
          payload['leaderId'] as string,
          payload['members'] as PartyMemberInfo[],
        );
      }
      if (payload.eventType === 'party_joined') {
        this.player.applyPartyMemberJoined(
          payload['memberId'] as string,
          payload['memberName'] as string,
        );
        this.world.pushMessage('system', `${payload['memberName']} joined the party.`);
      }
      if (payload.eventType === 'party_left' || payload.eventType === 'party_kicked') {
        const memberId = payload['memberId'] as string;
        if (memberId === this.player.id) {
          this.player.clearParty();
        } else {
          this.player.applyPartyMemberLeft(memberId);
        }
        const verb = payload.eventType === 'party_left' ? 'left' : 'was kicked from';
        this.world.pushMessage('system', `${payload['memberName']} ${verb} the party.`);
      }
      if (payload.eventType === 'party_invite') {
        this.player.applyPartyInvite(
          payload['fromName'] as string,
          payload['expiresAt'] as number,
        );
        this.world.pushMessage('system',
          `${payload['fromName']} invites you to a party. /party accept or /party decline`);
      }
    });

    s.on('communication', (p) => {
      const payload = p as CommunicationPayload;
      console.log('[MessageRouter] communication →', payload.channel, payload.senderName, payload.content);
      this.world.onCommunication(payload);
    });

    // Server sends ALL chat (say/shout/emote/whisper/party) as 'chat' events with
    // { channel, sender, senderId, message, timestamp }.  Map to CommunicationPayload.
    s.on('chat', (p) => {
      const raw = p as { channel: string; sender: string; senderId: string; message: string; timestamp: number; distance?: number };
      console.log(`[MessageRouter] chat → channel="${raw.channel}" sender="${raw.sender}" message="${raw.message}"`);
      const mapped: CommunicationPayload = {
        channel:    raw.channel as CommunicationPayload['channel'],
        senderId:   raw.senderId,
        senderName: raw.sender,
        content:    raw.message,
        timestamp:  raw.timestamp,
        ...(raw.distance !== undefined ? { distance: raw.distance } : {}),
      };
      this.world.onCommunication(mapped);
    });

    s.on('proximity_roster', (p) => {
      const payload = p as ProximityRosterPayload;
      this.world.applyProximityRoster(payload);
    });

    s.on('proximity_roster_delta', (p) => {
      const payload = p as ProximityRosterDeltaPayload;
      this.world.applyProximityDelta(payload);
    });

    s.on('corruption_update', (p) => {
      const payload = p as CorruptionUpdatePayload;
      this.player.applyCorruptionUpdate(payload);
      // Notify chat on state transitions
      if (payload.previousState && payload.previousState !== payload.state) {
        const label = payload.state.charAt(0) + payload.state.slice(1).toLowerCase();
        this.world.pushMessage('system', `Your corruption has shifted to ${label}.`);
      }
    });

    s.on('inventory_update', (p) => {
      const payload = p as InventoryUpdatePayload;
      this.player.applyInventoryUpdate(payload);
    });

    s.on('command_response', (p) => {
      const payload = p as CommandResponsePayload;
      // Show the human-readable result (success message or error string) in chat.
      const text = payload.success ? payload.message : payload.error;
      if (text) this.world.pushMessage('system', text);
    });

    s.on('error', (p) => {
      const payload = p as ErrorPayload;
      console.error(`[Server] ${payload.severity}: ${payload.code} — ${payload.message}`);
      if (payload.severity === 'fatal') {
        this.session.setConnectionStatus('error', payload.message);
      } else {
        // Surface non-fatal server errors in the chat log so the player sees them.
        this.world.pushMessage('system', payload.message);
      }
    });

    s.on('loot_session_start', (p) => {
      this.lootStartListeners.forEach(fn => fn(p as LootSessionStartPayload));
    });

    s.on('loot_item_result', (p) => {
      this.lootResultListeners.forEach(fn => fn(p as LootItemResultPayload));
    });

    s.on('loot_session_end', (p) => {
      this.lootEndListeners.forEach(fn => fn(p as LootSessionEndPayload));
    });

    s.on('ability_update', (p) => {
      const payload = p as AbilityUpdatePayload;
      // Sync state first, then notify UI listeners
      this.player.applyAbilityUpdate(payload);
      // Surface success/error message in chat (same pattern as command_response)
      if (payload.message) this.world.pushMessage('system', payload.message);
      this.abilityUpdateListeners.forEach(fn => fn(payload));
    });

    s.on('register_result', (p) => {
      const payload = p as RegisterResultPayload;
      if (payload.success && payload.username) {
        this.player.setRegistered(payload.username);
        this.world.pushMessage('system', `Account registered! Welcome, ${payload.username}. Your character is now permanent.`);
      }
      this.registerResultListeners.forEach(fn => fn(payload));
    });

    // ── Zone transfer (village system) ────────────────────────────────────
    s.on('zone_transfer', (p) => {
      const payload = p as ZoneTransferPayload;
      console.log('[MessageRouter] zone_transfer →', payload.zoneId);
      // Clear all entities and set phase to loading_world (shows loading screen)
      this.entities.clear();
      this.session.setPhase('loading_world');
      // Acknowledge so the gateway triggers enterWorld for the new zone
      this.socket.sendZoneTransferReady();
    });

    s.on('village_state', (p) => {
      this.villageStateListeners.forEach(fn => fn(p as VillageStatePayload));
    });

    s.on('village_placement_mode', (p) => {
      this.villagePlacementListeners.forEach(fn => fn(p as VillagePlacementModePayload));
    });

    s.on('_connected', () => {
      this.session.setConnectionStatus('handshaking');
    });

    s.on('_disconnected', () => {
      this.session.setConnectionStatus('disconnected');
      this.session.setPhase('disconnected');
    });

    s.on('_connect_error', (p) => {
      this.session.setConnectionStatus('error', String(p));
    });
  }
}
