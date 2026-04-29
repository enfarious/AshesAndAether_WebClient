import type { SocketClient } from './SocketClient';
import type { SessionState } from '@/state/SessionState';
import type { PlayerState } from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { WorldState } from '@/state/WorldState';
import type { Entity } from './Protocol';
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
  CombatHitData,
  CombatOutcome,
  CombatErrorPayload,
  CastStartPayload,
  CastCompletePayload,
  CastBreakPayload,
  ChannelStartPayload,
  ChannelTickPayload,
  ChannelCompletePayload,
  ChannelBreakPayload,
  AIDebugTickPayload,
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
  StatAllocateResultPayload,
  RespecResultPayload,
  PartyMemberInfo,
  PartyAllyState,
  ZoneTransferPayload,
  VillagePlacementModePayload,
  VillageStatePayload,
  RegisterResultPayload,
  ExaminePeekPayload,
  MarketDataPayload,
  HarvestResultPayload,
  EditorOpenPayload,
  EditorResultPayload,
  GuildUpdatePayload,
  GuildMemberListPayload,
  GuildInvitePayload,
  GuildChatPayload,
  GuildFoundingNarrativePayload,
  SystemToastPayload,
  BeaconAlertPayload,
  LibraryAssaultPayload,
  CompanionConfigPayload,
  CompanionStatusPayload,
  CompanionLoadoutPayload,
  VillageCatalogPayload,
  VaultGateOpenedPayload,
  VaultRoomEnterPayload,
  VaultMobKilledPayload,
  VaultRoomClearedPayload,
  VaultCompletePayload,
  VaultFailedPayload,
  ExperienceGainedPayload,
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
  private examineListeners         = new Set<(p: ExaminePeekPayload) => void>();
  private harvestListeners         = new Set<(p: HarvestResultPayload) => void>();
  private marketListeners          = new Set<(p: MarketDataPayload) => void>();
  private editorOpenListeners      = new Set<(p: EditorOpenPayload) => void>();
  private editorResultListeners    = new Set<(p: EditorResultPayload) => void>();
  private guildNarrativeListeners  = new Set<(p: GuildFoundingNarrativePayload) => void>();
  private systemToastListeners     = new Set<(p: SystemToastPayload) => void>();
  private beaconAlertListeners     = new Set<(p: BeaconAlertPayload) => void>();
  private libraryAssaultListeners  = new Set<(p: LibraryAssaultPayload) => void>();
  private companionConfigListeners  = new Set<(p: CompanionConfigPayload) => void>();
  private companionLoadoutListeners = new Set<(p: CompanionLoadoutPayload) => void>();
  private companionCombatTriggerListeners = new Set<(p: unknown) => void>();
  private companionSocialTriggerListeners = new Set<(p: unknown) => void>();
  private combatOutcomeListeners    = new Set<(p: CombatHitData) => void>();
  private combatErrorListeners      = new Set<(p: CombatErrorPayload) => void>();
  private villageCatalogListeners   = new Set<(p: VillageCatalogPayload) => void>();
  private playerJumpListeners        = new Set<(entityId: string) => void>();
  private playerDashListeners        = new Set<(entityId: string, x: number, z: number) => void>();
  private castStartListeners         = new Set<(p: CastStartPayload) => void>();
  private castCompleteListeners      = new Set<(p: CastCompletePayload) => void>();
  private castBreakListeners         = new Set<(p: CastBreakPayload) => void>();
  private channelStartListeners      = new Set<(p: ChannelStartPayload) => void>();
  private channelTickListeners       = new Set<(p: ChannelTickPayload) => void>();
  private channelCompleteListeners   = new Set<(p: ChannelCompletePayload) => void>();
  private channelBreakListeners      = new Set<(p: ChannelBreakPayload) => void>();
  private aiDebugTickListeners       = new Set<(p: AIDebugTickPayload) => void>();
  private vaultGateOpenedListeners  = new Set<(p: VaultGateOpenedPayload) => void>();
  private vaultCompleteListeners    = new Set<(p: VaultCompletePayload) => void>();
  private vaultRoomEnterListeners   = new Set<(p: VaultRoomEnterPayload) => void>();
  private vaultRoomClearedListeners = new Set<(p: VaultRoomClearedPayload) => void>();
  private experienceGainedListeners = new Set<(p: ExperienceGainedPayload) => void>();
  private worldEntryListeners       = new Set<() => void>();
  private firstPlantListeners       = new Set<() => void>();
  private _firstPlantFired          = false;

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

  /** Subscribe to experience_gained events (player or companion). */
  onExperienceGained(fn: (p: ExperienceGainedPayload) => void): () => void {
    this.experienceGainedListeners.add(fn);
    return () => this.experienceGainedListeners.delete(fn);
  }

  /** Last experience_gained breakdown received for the player — used by /xpinfo. */
  lastPlayerXpBreakdown: ExperienceGainedPayload | null = null;

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

  onExamine(fn: (p: ExaminePeekPayload) => void): () => void {
    this.examineListeners.add(fn);
    return () => this.examineListeners.delete(fn);
  }

  onHarvest(fn: (p: HarvestResultPayload) => void): () => void {
    this.harvestListeners.add(fn);
    return () => this.harvestListeners.delete(fn);
  }

  onMarketData(fn: (p: MarketDataPayload) => void): () => void {
    this.marketListeners.add(fn);
    return () => this.marketListeners.delete(fn);
  }

  onEditorOpen(fn: (p: EditorOpenPayload) => void): () => void {
    this.editorOpenListeners.add(fn);
    return () => this.editorOpenListeners.delete(fn);
  }

  onEditorResult(fn: (p: EditorResultPayload) => void): () => void {
    this.editorResultListeners.add(fn);
    return () => this.editorResultListeners.delete(fn);
  }

  onGuildFoundingNarrative(fn: (p: GuildFoundingNarrativePayload) => void): () => void {
    this.guildNarrativeListeners.add(fn);
    return () => this.guildNarrativeListeners.delete(fn);
  }

  onWorldEntry(fn: () => void): () => void {
    this.worldEntryListeners.add(fn);
    return () => this.worldEntryListeners.delete(fn);
  }

  onFirstPlant(fn: () => void): () => void {
    this.firstPlantListeners.add(fn);
    return () => this.firstPlantListeners.delete(fn);
  }

  onSystemToast(fn: (p: SystemToastPayload) => void): () => void {
    this.systemToastListeners.add(fn);
    return () => this.systemToastListeners.delete(fn);
  }

  onBeaconAlert(fn: (p: BeaconAlertPayload) => void): () => void {
    this.beaconAlertListeners.add(fn);
    return () => this.beaconAlertListeners.delete(fn);
  }

  onLibraryAssault(fn: (p: LibraryAssaultPayload) => void): () => void {
    this.libraryAssaultListeners.add(fn);
    return () => this.libraryAssaultListeners.delete(fn);
  }

  onCompanionConfig(fn: (p: CompanionConfigPayload) => void): () => void {
    this.companionConfigListeners.add(fn);
    return () => this.companionConfigListeners.delete(fn);
  }

  onCompanionLoadout(fn: (p: CompanionLoadoutPayload) => void): () => void {
    this.companionLoadoutListeners.add(fn);
    return () => this.companionLoadoutListeners.delete(fn);
  }

  onCompanionCombatTrigger(fn: (p: unknown) => void): () => void {
    this.companionCombatTriggerListeners.add(fn);
    return () => this.companionCombatTriggerListeners.delete(fn);
  }

  onCompanionSocialTrigger(fn: (p: unknown) => void): () => void {
    this.companionSocialTriggerListeners.add(fn);
    return () => this.companionSocialTriggerListeners.delete(fn);
  }

  /**
   * Fires for every combat_hit / combat_miss event the client receives.
   * Subscribers filter by attackerId (e.g. self for action-bar flash, companion for HUD).
   */
  onCombatOutcome(fn: (p: CombatHitData) => void): () => void {
    this.combatOutcomeListeners.add(fn);
    return () => this.combatOutcomeListeners.delete(fn);
  }

  /** Fires when the server rejects the player's cast (OOM, range, on-CD, silenced, etc.). */
  onCombatError(fn: (p: CombatErrorPayload) => void): () => void {
    this.combatErrorListeners.add(fn);
    return () => this.combatErrorListeners.delete(fn);
  }

  onVillageCatalog(fn: (p: VillageCatalogPayload) => void): () => void {
    this.villageCatalogListeners.add(fn);
    return () => this.villageCatalogListeners.delete(fn);
  }

  /** Fires for any `player_jump` event broadcast by the zone. Receives the
   *  jumping entity's id so consumers can play the visual on the right
   *  PlayerEntity / RemoteEntity. */
  onPlayerJump(fn: (entityId: string) => void): () => void {
    this.playerJumpListeners.add(fn);
    return () => this.playerJumpListeners.delete(fn);
  }

  /** Fires for any `player_dash` event broadcast by the zone. Receives the
   *  dashing entity's id and the dashed-to XZ. Consumers should treat it
   *  as a teleport (snap, don't lerp) — the state_update that follows would
   *  otherwise interpolate the 5m gap over a single tick (~50 m/s slide). */
  onPlayerDash(fn: (entityId: string, x: number, z: number) => void): () => void {
    this.playerDashListeners.add(fn);
    return () => this.playerDashListeners.delete(fn);
  }

  /** Cast lifecycle events. `cast_start` opens the cast bar; `cast_complete`
   *  closes it (success); `cast_break` closes it with a reason (interrupted). */
  onCastStart(fn: (p: CastStartPayload) => void): () => void {
    this.castStartListeners.add(fn);
    return () => this.castStartListeners.delete(fn);
  }
  onCastComplete(fn: (p: CastCompletePayload) => void): () => void {
    this.castCompleteListeners.add(fn);
    return () => this.castCompleteListeners.delete(fn);
  }
  onCastBreak(fn: (p: CastBreakPayload) => void): () => void {
    this.castBreakListeners.add(fn);
    return () => this.castBreakListeners.delete(fn);
  }

  /** Channel lifecycle. `channel_start` opens the cast bar in drain mode;
   *  `channel_tick` is optional polish (sound/pulse); `channel_complete`
   *  closes it on natural duration expiry; `channel_break` closes it with
   *  a reason on interruption. */
  onChannelStart(fn: (p: ChannelStartPayload) => void): () => void {
    this.channelStartListeners.add(fn);
    return () => this.channelStartListeners.delete(fn);
  }
  onChannelTick(fn: (p: ChannelTickPayload) => void): () => void {
    this.channelTickListeners.add(fn);
    return () => this.channelTickListeners.delete(fn);
  }
  onChannelComplete(fn: (p: ChannelCompletePayload) => void): () => void {
    this.channelCompleteListeners.add(fn);
    return () => this.channelCompleteListeners.delete(fn);
  }
  onChannelBreak(fn: (p: ChannelBreakPayload) => void): () => void {
    this.channelBreakListeners.add(fn);
    return () => this.channelBreakListeners.delete(fn);
  }

  /** Subscribe to /aidebug ticks. Server only emits when at least one
   *  admin has the panel toggled on. Returns a teardown closure. */
  onAIDebugTick(fn: (p: AIDebugTickPayload) => void): () => void {
    this.aiDebugTickListeners.add(fn);
    return () => this.aiDebugTickListeners.delete(fn);
  }

  onVaultGateOpened(fn: (p: VaultGateOpenedPayload) => void): () => void {
    this.vaultGateOpenedListeners.add(fn);
    return () => this.vaultGateOpenedListeners.delete(fn);
  }

  onVaultComplete(fn: (p: VaultCompletePayload) => void): () => void {
    this.vaultCompleteListeners.add(fn);
    return () => this.vaultCompleteListeners.delete(fn);
  }

  onVaultRoomEnter(fn: (p: VaultRoomEnterPayload) => void): () => void {
    this.vaultRoomEnterListeners.add(fn);
    return () => this.vaultRoomEnterListeners.delete(fn);
  }

  onVaultRoomCleared(fn: (p: VaultRoomClearedPayload) => void): () => void {
    this.vaultRoomClearedListeners.add(fn);
    return () => this.vaultRoomClearedListeners.delete(fn);
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
      this._firstPlantFired = false;
      this.worldEntryListeners.forEach(fn => fn());
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
          if (!this._firstPlantFired && payload.entities.added.some((e: Entity) => e.type === 'plant')) {
            this._firstPlantFired = true;
            this.firstPlantListeners.forEach(fn => fn());
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

      // ── Combat outcomes (hit/miss/heal with structured eventTypeData) ───
      if (
        payload.eventType === 'combat_hit'
        || payload.eventType === 'combat_miss'
        || payload.eventType === 'combat_heal'
      ) {
        // Server places structured fields under eventTypeData; older builds may flatten.
        // Heals use `healerId` instead of `attackerId` — normalize.
        const data = (payload.eventTypeData ?? payload) as Partial<CombatHitData> & { healerId?: string };
        const actorId = data.attackerId ?? data.healerId;
        if (actorId && data.targetId && data.abilityId) {
          // combat_miss payloads don't carry an outcome field (server quirk).
          // combat_heal always lands. Default outcome from eventType when missing.
          const outcome: CombatOutcome = data.outcome
            ?? (payload.eventType === 'combat_miss' ? 'miss' : 'hit');
          const hit: CombatHitData = {
            attackerId: actorId,
            targetId:   data.targetId,
            abilityId:  data.abilityId,
            amount:     data.amount   ?? 0,
            critical:   data.critical ?? false,
            outcome,
            ...(data.cooldownMs !== undefined ? { cooldownMs: data.cooldownMs } : {}),
            ...(payload.eventType === 'combat_heal' ? { isHeal: true } : {}),
          };
          this.combatOutcomeListeners.forEach(fn => fn(hit));

          // If the player's companion is the actor, surface it on the CompanionHUD.
          const companionId = this.player.companion?.companionId;
          if (companionId && hit.attackerId === companionId) {
            const label = hit.abilityId === 'auto_attack' ? 'Strike' : hit.abilityId;
            this.player.recordCompanionAction(label, payload.timestamp ?? Date.now());
          }
        }
      }

      // ── Movement effects (jump / dash) ───────────────────────────────
      if (payload.eventType === 'player_jump') {
        const entityId = (payload.eventTypeData as { entityId?: string } | undefined)?.entityId;
        if (entityId) this.playerJumpListeners.forEach(fn => fn(entityId));
      }
      if (payload.eventType === 'player_dash') {
        const data = payload.eventTypeData as { entityId?: string; x?: number; z?: number } | undefined;
        if (data?.entityId && typeof data.x === 'number' && typeof data.z === 'number') {
          this.playerDashListeners.forEach(fn => fn(data.entityId!, data.x!, data.z!));
        }
      }

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
      if (payload.eventType === 'party_promoted') {
        const memberId   = payload['memberId']   as string;
        const memberName = payload['memberName'] as string;
        const youAreLeader = memberId === this.player.id;
        this.world.pushMessage('system',
          youAreLeader
            ? `You are now the party leader.`
            : `${memberName} is now the party leader.`);
      }
    });

    // Server-driven target switch (e.g. auto-retarget after current target dies).
    s.on('target_set', (p) => {
      const payload = p as { targetId: string; targetName: string };
      this.player.setTarget(payload.targetId, payload.targetName);
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

      // Dispatch structured examine/look data to the ExamineWindow.
      const cmdData = payload.data as { type?: string; target?: ExaminePeekPayload } | undefined;
      if (payload.success && cmdData?.type === 'look' && cmdData.target) {
        this.examineListeners.forEach(fn => fn(cmdData.target as ExaminePeekPayload));
        return; // rich UI handles it — don't also dump text to chat
      }

      // Dispatch structured harvest data to HarvestToast (still show text in chat too).
      if (payload.success && cmdData?.type === 'harvest') {
        this.harvestListeners.forEach(fn => fn(cmdData as unknown as HarvestResultPayload));
      }

      // Dispatch structured market data to MarketPanel (don't suppress chat — MUD clients still see text).
      if (cmdData?.type?.startsWith('market_')) {
        this.marketListeners.forEach(fn => fn(cmdData as MarketDataPayload));
      }

      // Show the human-readable result (success message or error string) in chat.
      const text = payload.success ? payload.message : payload.error;
      if (text) this.world.pushMessage('system', text);
    });

    s.on('system_toast', (p) => {
      this.systemToastListeners.forEach(fn => fn(p as SystemToastPayload));
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

    s.on('combat_error', (p) => {
      const payload = p as CombatErrorPayload;
      this.world.pushMessage('system', payload.message);
      this.combatErrorListeners.forEach(fn => fn(payload));
    });

    s.on('cast_start', (p) => {
      this.castStartListeners.forEach(fn => fn(p as CastStartPayload));
    });
    s.on('cast_complete', (p) => {
      this.castCompleteListeners.forEach(fn => fn(p as CastCompletePayload));
    });
    s.on('cast_break', (p) => {
      this.castBreakListeners.forEach(fn => fn(p as CastBreakPayload));
    });

    s.on('channel_start', (p) => {
      this.channelStartListeners.forEach(fn => fn(p as ChannelStartPayload));
    });
    s.on('channel_tick', (p) => {
      this.channelTickListeners.forEach(fn => fn(p as ChannelTickPayload));
    });
    s.on('channel_complete', (p) => {
      this.channelCompleteListeners.forEach(fn => fn(p as ChannelCompletePayload));
    });
    s.on('channel_break', (p) => {
      this.channelBreakListeners.forEach(fn => fn(p as ChannelBreakPayload));
    });

    s.on('ai_debug_tick', (p) => {
      this.aiDebugTickListeners.forEach(fn => fn(p as AIDebugTickPayload));
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

    s.on('stat_allocate_result', (p) => {
      const payload = p as StatAllocateResultPayload;
      if (!payload.success && payload.error) {
        this.world.pushMessage('system', payload.error);
      }
    });

    s.on('experience_gained', (p) => {
      const payload = p as ExperienceGainedPayload;

      // Update PlayerState only for player events (companion XP belongs to companion state).
      if (payload.entityType === 'player') {
        this.player.applyStateUpdate({
          experience:    payload.experience,
          level:         payload.level,
          ...(payload.gainedAp !== undefined && payload.gainedAp > 0
            ? { abilityPoints: this.player.abilityPoints + payload.gainedAp }
            : {}),
          ...(payload.gainedSp !== undefined && payload.gainedSp > 0
            ? { statPoints: this.player.statPoints + payload.gainedSp }
            : {}),
        });
        this.player.setLastXpBreakdown({
          mobName:        payload.mobName,
          mobLevel:       payload.breakdown.mobLevel,
          recipientLevel: payload.breakdown.recipientLevel,
          partySize:      payload.breakdown.partySize,
          baseXp:         payload.breakdown.baseXp,
          conMult:        payload.breakdown.conMult,
          partyMult:      payload.breakdown.partyMult,
          awardedXp:      payload.gainedXp,
        });
        this.lastPlayerXpBreakdown = payload;
      }

      this.experienceGainedListeners.forEach(fn => fn(payload));
    });

    s.on('respec_result', (p) => {
      const payload = p as RespecResultPayload;
      if (payload.success && payload.message) {
        this.world.pushMessage('system', payload.message);
      } else if (!payload.success && payload.error) {
        this.world.pushMessage('system', payload.error);
      }
    });

    s.on('register_result', (p) => {
      const payload = p as RegisterResultPayload;
      if (payload.success && payload.username) {
        this.player.setRegistered(payload.username);
        this.world.pushMessage('system', `Account registered! Welcome, ${payload.username}. Your character is now permanent.`);
      }
      this.registerResultListeners.forEach(fn => fn(payload));
    });

    // ── Guild ─────────────────────────────────────────────────────────────
    s.on('guild_update', (p) => {
      const payload = p as GuildUpdatePayload;
      this.player.applyGuildUpdate(payload);
      if (payload.removed) {
        const reason = payload.reason === 'kicked' ? 'You have been kicked from the guild.' : 'The guild has been disbanded.';
        this.world.pushMessage('system', reason);
      }
    });

    s.on('guild_member_list', (p) => {
      this.player.applyGuildMemberList(p as GuildMemberListPayload);
    });

    s.on('guild_invite', (p) => {
      const payload = p as GuildInvitePayload;
      this.world.pushMessage('system',
        `${payload.inviterName} invites you to join <${payload.guildName}> [${payload.guildTag}]. Type /guild accept or /guild decline.`);
    });

    s.on('guild_chat', (p) => {
      const payload = p as GuildChatPayload;
      this.world.onCommunication({
        channel: 'guild',
        senderId:   payload.senderId,
        senderName: payload.senderName,
        content:    payload.message,
        timestamp:  payload.timestamp,
      });
    });

    s.on('guild_founding_narrative', (p) => {
      const payload = p as GuildFoundingNarrativePayload;
      this.world.pushMessage('system', payload.narrative);
      this.guildNarrativeListeners.forEach(fn => fn(payload));
    });

    // ── Companion config ────────────────────────────────────────────────
    s.on('companion_config', (p) => {
      const payload = p as CompanionConfigPayload;
      this.player.applyCompanionConfig(payload);
      this.companionConfigListeners.forEach(fn => fn(payload));
    });

    // ── Companion status (lightweight combat HUD updates ~1/s) ────────
    s.on('companion_status', (p) => {
      this.player.applyCompanionStatus(p as CompanionStatusPayload);
    });

    // ── Companion loadout (active/passive ability slots) ─────────────
    s.on('companion_active_loadout', (p) => {
      this.companionLoadoutListeners.forEach(fn => fn(p as CompanionLoadoutPayload));
    });

    s.on('companion_passive_loadout', (p) => {
      this.companionLoadoutListeners.forEach(fn => fn(p as CompanionLoadoutPayload));
    });

    // ── Companion BYOLLM triggers ─────────────────────────────────────────
    s.on('companion_combat_trigger', (p) => {
      this.companionCombatTriggerListeners.forEach(fn => fn(p));
    });

    s.on('companion_social_trigger', (p) => {
      this.companionSocialTriggerListeners.forEach(fn => fn(p));
    });

    // ── Beacon & Library alerts ──────────────────────────────────────────
    s.on('beacon_alert', (p) => {
      const payload = p as BeaconAlertPayload;
      this.world.pushMessage('event', payload.message);
      this.beaconAlertListeners.forEach(fn => fn(payload));
    });

    s.on('library_assault', (p) => {
      const payload = p as LibraryAssaultPayload;
      this.world.pushMessage('event', payload.message);
      this.libraryAssaultListeners.forEach(fn => fn(payload));
    });

    // ── Script editor ────────────────────────────────────────────────────
    s.on('editor_open', (p) => {
      this.editorOpenListeners.forEach(fn => fn(p as EditorOpenPayload));
    });

    s.on('editor_result', (p) => {
      this.editorResultListeners.forEach(fn => fn(p as EditorResultPayload));
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

    s.on('village_catalog', (p) => {
      this.villageCatalogListeners.forEach(fn => fn(p as VillageCatalogPayload));
    });

    // ── Vault events (vault progression goes to the System tab) ──────────
    s.on('vault_room_enter', (p) => {
      const payload = p as VaultRoomEnterPayload;
      this.world.pushMessage('system', payload.message);
      this.vaultRoomEnterListeners.forEach(fn => fn(payload));
    });

    s.on('vault_mob_killed', (p) => {
      const payload = p as VaultMobKilledPayload;
      if (payload.remainingMobs > 0) {
        this.world.pushMessage('system', `${payload.remainingMobs} enemies remaining.`);
      }
    });

    s.on('vault_room_cleared', (p) => {
      const payload = p as VaultRoomClearedPayload;
      this.world.pushMessage('system', payload.message);
      this.vaultRoomClearedListeners.forEach(fn => fn(payload));
    });

    s.on('vault_gate_opened', (p) => {
      const payload = p as VaultGateOpenedPayload;
      this.world.pushMessage('system', payload.message);
      this.vaultGateOpenedListeners.forEach(fn => fn(payload));
    });

    s.on('vault_complete', (p) => {
      const payload = p as VaultCompletePayload;
      this.world.pushMessage('system', payload.message ?? 'Vault complete!');
      // Exit portal is now spawned server-side as a real Zone entity (see
      // VaultManager.completeVault → Zone.spawnVaultExitPortal). It arrives
      // via state_update.entities.added on the same broadcast cycle, and is
      // included in the Redis snapshot so reconnecting players also see it.
      this.vaultCompleteListeners.forEach(fn => fn(payload));
    });

    s.on('vault_failed', (p) => {
      const payload = p as VaultFailedPayload;
      this.world.pushMessage('system', payload.message);
    });

    // ── Logout (return to character select) ─────────────────────────────────
    s.on('logout_success', () => {
      console.log('[MessageRouter] logout_success — returning to character select');
      this.entities.clear();
      this.session.setPhase('character_select');
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
