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
  ErrorPayload,
  CommandResponsePayload,
} from './Protocol';

/**
 * MessageRouter — subscribes to raw SocketClient events and dispatches
 * typed updates to the appropriate state stores.
 *
 * This is the only place that knows both the network shape and the state shape.
 * Nothing else should read from the socket directly.
 */
export class MessageRouter {
  constructor(
    private readonly socket:   SocketClient,
    private readonly session:  SessionState,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly world:    WorldState,
  ) {}

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
      this.player.applyWorldEntry(payload.character);
      this.entities.applyWorldEntry(payload.entities, payload.character.id);
      // setPhase last — listeners will find world.zone and player.position ready
      this.session.setPhase('in_world');
    });

    s.on('state_update', (p) => {
      const payload = p as StateUpdatePayload;

      if (payload.character) {
        this.player.applyStateUpdate(payload.character);
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
            if (e.id) this.entities.update(e.id, e);
          }
        }
        if (payload.entities.removed) {
          for (const id of payload.entities.removed) {
            this.entities.remove(id);
          }
        }
      }
    });

    s.on('event', (p) => {
      const payload = p as EventPayload;
      this.world.onGameEvent(payload);
    });

    s.on('communication', (p) => {
      const payload = p as CommunicationPayload;
      this.world.onCommunication(payload);
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
