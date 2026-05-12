import * as THREE from 'three';
import { SocketClient }       from '@/network/SocketClient';
import { MessageRouter }      from '@/network/MessageRouter';
import { ClientConfig }       from '@/config/ClientConfig';
import { SessionState }       from '@/state/SessionState';
import { PlayerState }        from '@/state/PlayerState';
import { EntityRegistry }     from '@/state/EntityRegistry';
import { WorldState }         from '@/state/WorldState';
import { SceneManager }       from '@/world/SceneManager';
import { WeatherEffects }     from '@/world/WeatherEffects';
import { CloudLayer }         from '@/world/CloudLayer';
import { AssetLoader }        from '@/world/AssetLoader';
import { EntityFactory }      from '@/entities/EntityFactory';
import { RemoteEntity }       from '@/entities/RemoteEntity';
import { AutoAttackRing }     from '@/entities/AutoAttackRing';
import { TelegraphRenderer } from '@/entities/TelegraphRenderer';
import { NameplateManager } from '@/entities/NameplateManager';
import { VaultStagingMarker } from '@/vault/VaultStagingMarker';
import { OrbitCamera }        from '@/camera/OrbitCamera';
import { CameraInput }        from '@/camera/CameraInput';
import { ClickMoveController } from '@/input/ClickMoveController';
import { WASDController }      from '@/input/WASDController';
import { GamepadController }   from '@/input/GamepadController';
import { TabTargetService }    from '@/input/TabTargetService';
import { HUD, type PerfSnapshot } from '@/ui/HUD';
import { ChatPanel }          from '@/ui/ChatPanel';
import { TargetWindow }       from '@/ui/TargetWindow';
import { InventoryWindow }    from '@/ui/InventoryWindow';
import { LootWindow }         from '@/ui/LootWindow';
import { ExamineWindow }      from '@/ui/ExamineWindow';
import { HarvestToast }       from '@/ui/HarvestToast';
import { BeaconToast }        from '@/ui/BeaconToast';
import { AbilityWindow }      from '@/ui/AbilityWindow';
import { CharacterSheet }    from '@/ui/CharacterSheet';
import { ScriptEditor }      from '@/ui/ScriptEditor';
import { PartyWindow }       from '@/ui/PartyWindow';
import { ActionBar }          from '@/ui/ActionBar';
import { Minimap }            from '@/ui/Minimap';
import { VaultMinimap }       from '@/ui/VaultMinimap';
import { LoginScreen }        from '@/ui/LoginScreen';
import { CharacterSelect }    from '@/ui/CharacterSelect';
import { SettingsWindow }     from '@/ui/SettingsWindow';
import { VillagePanel }       from '@/ui/VillagePanel';
import { MarketPanel }        from '@/ui/MarketPanel';
import { WorldMapPanel }      from '@/ui/WorldMapPanel';
import { GuildPanel }         from '@/ui/GuildPanel';
import { CompanionPanel }     from '@/ui/CompanionPanel';
import { CompanionHUD }       from '@/ui/CompanionHUD';
import { SystemMenu }         from '@/ui/SystemMenu';
import { LayoutEditor }       from '@/ui/LayoutEditor';
import { EnmityPanel }        from '@/ui/EnmityPanel';
import { AIDebugWindow }      from '@/ui/AIDebugWindow';
import { BuildPanel }         from '@/ui/BuildPanel';
import { RegistrationModal }  from '@/ui/RegistrationModal';
import { HirelingPanel }      from '@/ui/HirelingPanel';
import { DummyPanel }         from '@/ui/DummyPanel';
import { TravelPanel }        from '@/ui/TravelPanel';
import { CommandHelpPanel }   from '@/ui/CommandHelpPanel';
import { SystemToast }        from '@/ui/SystemToast';
import { LevelUpToast }       from '@/ui/LevelUpToast';
import { VaultCompleteToast } from '@/ui/VaultCompleteToast';
import { SkyHint }            from '@/ui/SkyHint';
import { CorpseSystem }       from '@/entities/CorpseSystem';
import { CorruptionMiasma }  from '@/entities/CorruptionMiasma';
import { MiasmaGroundFog }   from '@/world/MiasmaGroundFog';
import { MiasmaBoundaryWall } from '@/world/MiasmaBoundaryWall';
import { WardBeaconManager } from '@/entities/WardBeacon';
import { GuildBeaconManager, type GuildBeaconData } from '@/entities/GuildBeacon';
import { DisposableBeaconManager, type DisposableBeaconData } from '@/entities/DisposableBeacon';
import { CorpseRenderer, type CorpseData } from '@/entities/Corpse';
import { HarvestNodeManager, type HarvestNodeData } from '@/entities/HarvestNode';
import { RockRenderer, type RockData } from '@/world/RockRenderer';
import { WaterRenderer }      from '@/world/WaterRenderer';
import { yieldToBrowser }     from '@/world/yieldUtil';
import { ForestDebugRenderer } from '@/world/ForestDebugRenderer';
import { ForestRenderer }      from '@/world/ForestRenderer';
import { VaultRenderer }      from '@/world/VaultRenderer';
import type { VaultTileData } from '@/world/VaultRenderer';
import { PlacementMode }      from '@/village/PlacementMode';
import { ChatLogger }         from '@/companion/ChatLogger';
import { CompanionLLMService, type CompanionCombatTriggerPayload, type CompanionSocialTriggerPayload } from '@/companion/CompanionLLMService';
import { CompanionMemoryStore } from '@/companion/CompanionMemoryStore';
import { loadSettings }       from '@/companion/CompanionSettings';

/**
 * App — top-level bootstrap. Creates all modules, wires them together,
 * and runs the game loop.
 *
 * Modules do not know about each other directly.
 * App owns the wiring.
 */
/** Range at which the F-key triggers /harvest + the HUD prompt shows.
 *  Matches the server's HARVEST_RANGE_M so the prompt is honest. */
const HARVEST_KEY_RANGE_M = 10;

/** F-key range for looting an own-corpse. Matches the server-side 3 m gate
 *  in `_onLootCommand` so the prompt is honest. */
const LOOT_KEY_RANGE_M = 3;

export class App {
  // ── Network ───────────────────────────────────────────────────────────────
  private socket:  SocketClient;
  private router:  MessageRouter;

  // ── State ─────────────────────────────────────────────────────────────────
  private session:  SessionState;
  private player:   PlayerState;
  private entities: EntityRegistry;
  private world:    WorldState;

  // ── Rendering ─────────────────────────────────────────────────────────────
  private scene:   SceneManager;
  private camera:  OrbitCamera;
  private camInput: CameraInput;
  private assets:  AssetLoader;
  private factory: EntityFactory;
  private autoAttackRing: AutoAttackRing;
  private telegraphs:    TelegraphRenderer;
  private nameplates:    NameplateManager;
  private stagingMarker: VaultStagingMarker;
  private corpses: CorpseSystem;
  private weather: WeatherEffects;
  private clouds:  CloudLayer;
  private worldRoot:  THREE.Group | null = null;
  private _heightmap: import('@/world/HeightmapService').HeightmapService | null = null;
  private miasma:     CorruptionMiasma | null = null;
  private miasmaFog:  MiasmaGroundFog | null = null;
  private miasmaWall: MiasmaBoundaryWall | null = null;
  private beacons:    WardBeaconManager | null = null;
  private guildBeacons: GuildBeaconManager | null = null;
  private disposableBeacons: DisposableBeaconManager | null = null;
  private playerCorpses: CorpseRenderer | null = null;
  /** Cached "is a harvest glint within range?" — refreshed every frame so
   *  the F-key probe and HUD prompt agree without each doing their own scan. */
  private _harvestableInRange = false;
  /** Cached "is a lootable own-corpse within 3m?" — refreshed every frame
   *  so the F-key probe and HUD prompt agree without each doing their own
   *  scan. Filtered to corpses owned by the local character. */
  private _lootableCorpseInRange = false;
  private harvestNodes: HarvestNodeManager | null = null;
  private rockRenderer: RockRenderer | null = null;
  private water:      WaterRenderer | null = null;
  private _forestDebug:    ForestDebugRenderer | null = null;
  private _forestRenderer: ForestRenderer      | null = null;
  private _vaultRenderer:  VaultRenderer       | null = null;

  // ── Input ─────────────────────────────────────────────────────────────────
  private clickMove: ClickMoveController;
  private wasd:      WASDController;
  private gamepad:   GamepadController;
  private tabTarget: TabTargetService | null = null;

  // ── UI ────────────────────────────────────────────────────────────────────
  private loginScreen:     LoginScreen     | null = null;
  private characterSelect: CharacterSelect | null = null;
  private hud:             HUD             | null = null;
  private chatPanel:       ChatPanel       | null = null;
  private targetWindow:    TargetWindow    | null = null;
  private inventoryWindow: InventoryWindow | null = null;
  private lootWindow:      LootWindow      | null = null;
  private examineWindow:   ExamineWindow   | null = null;
  private scriptEditor:    ScriptEditor    | null = null;
  private harvestToast:    HarvestToast    | null = null;
  private beaconToast:     BeaconToast     | null = null;
  private systemToast:     SystemToast     | null = null;
  private levelUpToast:    LevelUpToast    | null = null;
  private vaultCompleteToast: VaultCompleteToast | null = null;
  private skyHint:         SkyHint         | null = null;
  private abilityWindow:   AbilityWindow   | null = null;
  private characterSheet:  CharacterSheet  | null = null;
  private partyWindow:     PartyWindow     | null = null;
  private actionBar:       ActionBar       | null = null;
  private minimap:         Minimap         | null = null;
  private vaultMinimap:    VaultMinimap    | null = null;
  private settingsWindow:  SettingsWindow  | null = null;
  private villagePanel:      VillagePanel      | null = null;
  private marketPanel:       MarketPanel       | null = null;
  private registrationModal: RegistrationModal  | null = null;
  private hirelingPanel:     HirelingPanel      | null = null;
  private dummyPanel:        DummyPanel         | null = null;
  private worldMapPanel:     WorldMapPanel      | null = null;
  private travelPanel:       TravelPanel        | null = null;
  private commandHelpPanel:  CommandHelpPanel   | null = null;
  private guildPanel:        GuildPanel         | null = null;
  private companionPanel:    CompanionPanel     | null = null;
  private companionHUD:      CompanionHUD       | null = null;
  private systemMenu:        SystemMenu         | null = null;
  private layoutEditor:      LayoutEditor       | null = null;
  private enmityPanel:       EnmityPanel        | null = null;
  private aiDebugWindow:     AIDebugWindow      | null = null;
  private buildPanel:        BuildPanel         | null = null;
  private placementMode:     PlacementMode      | null = null;

  // ── BYOLLM ──────────────────────────────────────────────────────────────
  private chatLogger:    ChatLogger           | null = null;
  private memoryStore:   CompanionMemoryStore | null = null;
  private companionLLM:  CompanionLLMService  | null = null;

  // ── Environment tracking ─────────────────────────────────────────────────
  private _lastWeather  = '';
  private _lastLighting = '';
  private _hasEnteredZone = false;

  /** Reference tracking for PlayerEntity wiring. We hold the *reference* we
   *  last applied for each dep — pe itself, heightmap, worldRoot, forest. On
   *  every tick we compare current vs last-wired and re-apply on diff.
   *  Booleans couldn't catch the case where the PlayerEntity reference was
   *  swapped out under us (zone transfer + applyWorldEntry creates a fresh
   *  PE) — the flag still said "wired" so wasd kept talking to the dead PE,
   *  which is what caused WASD hitching after travel. */
  private _wiredPe:              import('@/entities/PlayerEntity').PlayerEntity | null = null;
  private _wiredHeightmap:       import('@/world/HeightmapService').HeightmapService | null = null;
  private _wiredWorldRoot:       import('three').Group | null = null;
  private _wiredForestRenderer:  ForestRenderer | null = null;

  /** Fallback timer that hides the loading screen if `world_ready` never
   *  arrives. Armed when phase enters `loading_world`, cleared on
   *  `world_ready` or when phase leaves the entry sequence. */
  private _worldReadyFallback: ReturnType<typeof setTimeout> | null = null;

  /** ZoneId we're either currently loading or just finished loading.
   *  Used to short-circuit re-entrant `_loadWorldAssets` calls — duplicate
   *  `world_entry` from the server (or any other double-fire) used to
   *  cascade into a full second asset bake (the visible "hangs at World
   *  Assets Ready a second time" symptom). Cleared when phase leaves
   *  in_world so a true zone change still re-runs the load. */
  private _loadedZoneId: string | null = null;

  /** Loading-screen gate state.  We hide the screen only when BOTH the
   *  server has confirmed world_ready AND the client has finished its
   *  post-asset-load chain (water, beacons, forest plant, etc). Either
   *  alone would drop the curtain too early — server-fast cases would
   *  expose a half-built world; client-fast cases would let movement
   *  input race ahead of the zone server. Reset to false on every
   *  loading_world transition so each zone entry re-arms the gate. */
  private _worldReadyReceived = false;
  private _assetsLoaded       = false;

  // ── FPS limiter ──────────────────────────────────────────────────────────
  private _fpsLimit = 0;
  private _frameInterval = 0;
  private _lastRender = 0;

  // ── Perf overlay (F9) ────────────────────────────────────────────────────
  /** EMA of render-call ms — smooths the per-frame jitter on the F9 line. */
  private _perfFrameMs = 0;
  /** Last cached snapshot — refreshed at most every 500ms while F9 is on. */
  private _perfSnapshot: PerfSnapshot | null = null;
  private _perfLastGather = 0;

  // ── Loop ──────────────────────────────────────────────────────────────────
  private rafId: number = 0;
  private lastTime = 0;

  constructor(
    private readonly canvas:  HTMLCanvasElement,
    private readonly uiRoot:  HTMLElement,
    private readonly loading: LoadingScreen,
  ) {
    // State
    this.session  = new SessionState();
    this.player   = new PlayerState();
    this.entities = new EntityRegistry();
    this.world    = new WorldState();

    // Settings window — replaces FpsWidget + UIScaleWidget.
    // Created early so saved FPS limit & UI scale restore before first frame.
    this.settingsWindow = new SettingsWindow(this.uiRoot, {
      onFpsLimitChange:     this.setFpsLimit,
      onUiScaleChange:      (scale) => { (this.uiRoot.style as any).zoom = String(scale); },
      onDrawDistanceChange: () => { /* ClientConfig already mutated by SettingsWindow */ },
      onBeaconDetailChange: () => { this.guildBeacons?.rebuildAuras(); },
      onMiasmaQualityChange: () => { this._rebuildMiasmaFog(); },
      onMiasmaRangeChange:   () => { this._rebuildMiasmaFog(); },
    });

    // Network
    this.socket = new SocketClient();
    this.router = new MessageRouter(
      this.socket, this.session, this.player, this.entities, this.world,
    );
    this.router.mount();

    // Rendering
    this.scene   = new SceneManager(canvas);
    this.camera  = new OrbitCamera();
    this.camInput = new CameraInput(this.camera, canvas);
    this.assets  = new AssetLoader();
    this.factory = new EntityFactory(this.scene.scene, this.entities, this.player);
    this.autoAttackRing = new AutoAttackRing(this.scene.scene, this.factory, this.player);
    this.telegraphs     = new TelegraphRenderer(this.scene.scene, this.router, this.factory, this.entities, this.player);
    this.nameplates     = new NameplateManager(
      this.entities,
      this.player,
      (id) => this.factory.getObject(id),
      this.uiRoot,
    );
    this.stagingMarker  = new VaultStagingMarker(this.scene.scene, this.router);
    this._forestRenderer = new ForestRenderer(this.scene.scene, this.entities);
    this.corpses = new CorpseSystem(this.scene.scene, this.entities);
    this.weather = new WeatherEffects(this.scene.scene);
    this.clouds  = new CloudLayer(this.scene.scene);

    // Input
    this.clickMove = new ClickMoveController(
      canvas, this.camera, this.socket, this.player, this.entities, this.factory,
    );
    this.wasd = new WASDController(this.camera, this.socket, this.player, this.entities);
    this.gamepad = new GamepadController(this.camera, this.socket, this.player);

    // Asset loader status → loading screen
    this.assets.onStatus(msg  => loading.setStatus(msg));
    this.assets.onProgress(p  => loading.setProgress(p));

    // Phase transitions → screen management
    this.session.on('phase', () => this._onPhaseChange());

    // World entry → load assets
    this.session.on('phase', () => {
      if (this.session.phase === 'loading_world') {
        // Will transition to in_world when world_entry fires
      }
    });

    // Zone server confirms the player is registered + entity roster has been
    // synced — safe to drop the loading curtain. This decouples the loading
    // screen from `world_entry` (which fires before the zone server has
    // processed PLAYER_JOIN_ZONE, so early movement would silently drop).
    this.router.onWorldReady(() => this._onWorldReady());

    this.world.onZoneChange(() => {
      if (!this.world.zone) return;
      const wx  = this.world.zone.weather  ?? 'clear';
      const lit = this.world.zone.lighting ?? 'normal';

      const isFirstEntry      = !this._hasEnteredZone;
      const envChanged        = wx !== this._lastWeather || lit !== this._lastLighting;
      const transitionStarted = isFirstEntry || envChanged;

      if (isFirstEntry) {
        // First zone entry — short fade from default scene to current TOD preset.
        this.scene.transitionZone(this.world.zone, 2);
        this._hasEnteredZone = true;
      } else if (envChanged) {
        // Weather or lighting changed — smooth crossfade.
        this.scene.transitionZone(this.world.zone, 20);
      }
      // TOD-only updates need no transition — tick() drives lighting continuously.

      // Recapture fog baseline ONLY when the scene preset actually shifts
      // (zone transition). The previous unconditional recapture ran on every
      // applyZonePartial notify (weather/TOD ticks fire many times a minute),
      // and each pass captured the already-corruption-modulated fog as the
      // new "baseline" — so each frame's modulation drifted further toward
      // FOG_TINT and density compounded. Hours of AFK = world fades to black.
      if (this.miasma && transitionStarted) {
        setTimeout(() => this.miasma?.recaptureFogBaseline(), 100);
      }

      this._lastWeather  = wx;
      this._lastLighting = lit;

      // Update precipitation visuals to match new weather/season
      this.weather.setState(wx, this.world.season ?? 'summer');
    });

    // ── XP gain / level-up notifications ──────────────────────────────────
    this.world.onEvent(payload => {
      if (payload.eventType === 'xp_gain' || payload.eventType === 'level_up' || payload.eventType === 'companion_level_up') {
        const msg = payload['message'] as string | undefined;
        if (msg) this.world.pushMessage('system', msg);
      }
    });

    // ── Live guild-beacon placement (admin /beacon-grant) ──────────────────
    // Server broadcasts the new beacon's anchor data so existing players in
    // zone see the visual appear without re-zoning. addBeacon is idempotent
    // on id, so a fetch-then-event race is safe.
    this.world.onEvent(payload => {
      if (payload.eventType !== 'guild_beacon_placed') return;
      const data = payload.eventTypeData as GuildBeaconData | undefined;
      if (!data) return;
      this.guildBeacons?.addBeacon(data);
      this.guildBeacons?.repositionOnTerrain();
    });

    // ── Harvest node glints (server-authoritative NodePool) ────────────────
    this.world.onEvent(payload => {
      if (payload.eventType === 'harvest_node_added') {
        const data = payload.eventTypeData as HarvestNodeData | undefined;
        if (data) this.harvestNodes?.addNode(data);
        return;
      }
      if (payload.eventType === 'harvest_node_batch_added') {
        const data = payload.eventTypeData as { nodes?: HarvestNodeData[] } | undefined;
        if (data?.nodes) this.harvestNodes?.addNodes(data.nodes);
        return;
      }
      if (payload.eventType === 'harvest_node_removed') {
        const data = payload.eventTypeData as { id?: string } | undefined;
        if (data?.id) this.harvestNodes?.removeNode(data.id);
        return;
      }
    });

    // ── Rock outcrops (static scatter, server RockRegistry) ───────────────
    this.world.onEvent(payload => {
      if (payload.eventType !== 'rocks_initial') return;
      const data = payload.eventTypeData as { rocks?: RockData[] } | undefined;
      if (data?.rocks) this.rockRenderer?.addRocks(data.rocks);
    });

    // ── Disposable beacons (placed via /placebeacon, lifecycle via tick) ──
    this.world.onEvent(payload => {
      if (payload.eventType === 'disposable_beacon_placed') {
        const data = payload.eventTypeData as DisposableBeaconData | undefined;
        if (data) {
          this.disposableBeacons?.addBeacon(data);
          this.disposableBeacons?.repositionOnTerrain();
        }
        return;
      }
      if (payload.eventType === 'disposable_beacons_initial') {
        const data = payload.eventTypeData as { beacons?: DisposableBeaconData[] } | undefined;
        if (data?.beacons) {
          this.disposableBeacons?.addBeacons(data.beacons);
          this.disposableBeacons?.repositionOnTerrain();
        }
        return;
      }
      if (payload.eventType === 'disposable_beacon_emergency') {
        const data = payload.eventTypeData as { id?: string } | undefined;
        if (data?.id) this.disposableBeacons?.setEmergency(data.id);
        return;
      }
      if (payload.eventType === 'disposable_beacon_relit') {
        const data = payload.eventTypeData as { id?: string } | undefined;
        if (data?.id) this.disposableBeacons?.setLit(data.id);
        return;
      }
      if (payload.eventType === 'disposable_beacon_expired') {
        const data = payload.eventTypeData as { id?: string } | undefined;
        if (data?.id) this.disposableBeacons?.removeBeacon(data.id);
        return;
      }
    });

    // ── Aether Density (1Hz server push of player's local DangerMap value) ─
    this.world.onEvent(payload => {
      if (payload.eventType !== 'aether_density') return;
      const data = payload.eventTypeData as { value?: number } | undefined;
      if (data && typeof data.value === 'number') {
        // Centralize on WorldState so post-process / future consumers
        // can read every frame without resubscribing. HUD also reads
        // the latest value here for its tier bar.
        this.world.setAetherDensity(data.value);
        this.hud?.setAetherDensity(data.value);
      }
    });

    // ── Corpses (overworld death drops, /loot recovery) ───────────────────
    this.world.onEvent(payload => {
      if (payload.eventType === 'corpse_added') {
        const data = payload.eventTypeData as CorpseData | undefined;
        if (data) {
          this.playerCorpses?.addCorpse(data);
          this.playerCorpses?.repositionOnTerrain();
        }
        return;
      }
      if (payload.eventType === 'corpses_initial') {
        const data = payload.eventTypeData as { corpses?: CorpseData[] } | undefined;
        if (data?.corpses) {
          this.playerCorpses?.addCorpses(data.corpses);
          this.playerCorpses?.repositionOnTerrain();
        }
        return;
      }
      if (payload.eventType === 'corpse_removed') {
        const data = payload.eventTypeData as { id?: string } | undefined;
        if (data?.id) this.playerCorpses?.removeCorpse(data.id);
        return;
      }
    });

    // ── Eldritch death events ──────────────────────────────────────────────
    this.world.onEvent(payload => {
      if (payload.eventType !== 'entity_death') return;

      const entityId              = payload['entityId'] as string | undefined;
      const dissolveDurationSecs  = (payload['dissolveDurationSeconds'] as number | undefined) ?? 4;
      if (!entityId) return;

      // Resolve spawn position: use registry lookup (entity still in scene at this point)
      // falling back to the coordinates embedded in the event payload.
      const regEntity = this.entities.get(entityId);
      const pos = regEntity?.position
        ? new THREE.Vector3(regEntity.position.x, regEntity.position.y, regEntity.position.z)
        : new THREE.Vector3(
            (payload['x'] as number | undefined) ?? 0,
            (payload['y'] as number | undefined) ?? 0,
            (payload['z'] as number | undefined) ?? 0,
          );

      this.corpses.spawnEffect(entityId, pos, dissolveDurationSecs);

      // If this death is the local player, record the dissolve deadline in PlayerState
      // so the HUD can show a countdown and the WASDController can listen.
      if (entityId === this.player.id) {
        this.player.setCorpseDissolvesAt(Date.now() + dissolveDurationSecs * 1000);
      }
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.loading.show();
    this.loading.setStatus('Connecting to server…');
    this.loading.setProgress(0);

    // Show login once connected (handshake_ack triggers phase → 'login')
    // If the server is unreachable, surface that on the loading screen
    // rather than hanging silently. After exhausting retries on the current
    // host, try fallback servers (e.g. fusoya.servegame.com) before giving up.
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    let triedFallback = false;

    const tryConnect = (): void => {
      this.socket.connect();
    };

    // ── Loading-screen server picker ─────────────────────────────────────
    // Always-on server input + Reconnect button so a wrong/unreachable URL
    // can be corrected without ever reaching the login screen.
    const serverInput = document.getElementById('loading-server-input') as HTMLInputElement | null;
    const serverBtn   = document.getElementById('loading-server-btn')   as HTMLButtonElement | null;
    if (serverInput) {
      serverInput.value = ClientConfig.serverUrl.replace(/^https?:\/\//, '');
    }
    const reconnectWithNewUrl = (): void => {
      if (!serverInput) return;
      const raw = serverInput.value.trim();
      if (!raw) return;
      ClientConfig.setServerUrl(raw);
      retryCount    = 0;
      triedFallback = false;
      this.loading.setStatus(`Connecting to ${raw}…`);
      this.socket.disconnect();
      setTimeout(tryConnect, 200);
    };
    if (serverBtn) {
      serverBtn.addEventListener('click', reconnectWithNewUrl);
    }
    if (serverInput) {
      serverInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') reconnectWithNewUrl();
      });
    }

    const tryFallbackHost = (): boolean => {
      if (triedFallback) return false;
      const fallback = ClientConfig.getNextFallback();
      if (!fallback) return false;
      triedFallback = true;
      retryCount = 0;
      const display = fallback.replace(/^https?:\/\//, '');
      console.log(`[App] Primary server failed — trying fallback: ${display}`);
      this.loading.setStatus(`Trying ${display}…`);
      ClientConfig.setServerUrl(fallback);
      this.socket.disconnect();
      setTimeout(tryConnect, 500);
      return true;
    };

    this.session.on('connectionStatus', () => {
      const status = this.session.connectionStatus;
      if (status === 'error') {
        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          this.loading.setStatus(
            `Server unreachable — retrying (${retryCount}/${MAX_RETRIES})…`
          );
          setTimeout(tryConnect, RETRY_DELAY_MS);
        } else if (!tryFallbackHost()) {
          this.loading.setStatus(
            'Could not reach any server. Check the server address on the login screen.'
          );
          // Show login screen so the user can manually enter a server URL
          this._showLogin();
        }
      } else if (status === 'handshaking') {
        this.loading.setStatus('Handshaking…');
        retryCount = 0;
      } else if (status === 'connected') {
        // Phase change to 'login' will hide the loading screen.
        // Sync the login screen server field to whichever host actually connected.
        this._syncLoginServerField();
        retryCount = 0;
        triedFallback = false;
      } else if (status === 'disconnected' && this.session.phase === 'in_world') {
        this.loading.show();
        this.loading.setStatus('Disconnected. Reconnecting…');
        retryCount = 0;
        triedFallback = false;
        setTimeout(tryConnect, RETRY_DELAY_MS);
      }
    });

    tryConnect();
    this.rafId = requestAnimationFrame(this._loop);

    // F8 — toggle OSM forest polygon debug overlay (includes ground ring at zone radius)
    // F9 — toggle GPU perf overlay (draw calls, tris, shadow lights, frame ms)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'F8') this._forestDebug?.toggle();
      else if (e.code === 'F9') {
        const on = this.hud?.togglePerfMode() ?? false;
        if (!on) this._perfSnapshot = null;
      }
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.clickMove.dispose();
    this.wasd.dispose();
    this.gamepad.dispose();
    this.camInput.dispose();
    this.camera.dispose();
    this.miasma?.dispose();
    this.miasmaFog?.dispose();
    this.miasmaWall?.dispose();
    this.beacons?.dispose();
    this.guildBeacons?.dispose();
    this.disposableBeacons?.dispose();
    this.playerCorpses?.dispose();
    this.harvestNodes?.dispose();
    this.rockRenderer?.dispose();
    this.water?.dispose();
    this._forestDebug?.dispose();
    this.corpses.dispose();
    this._forestRenderer?.dispose();
    this.factory.dispose();
    this.scene.dispose();
    this.socket.disconnect();
    this.loginScreen?.dispose();
    this.characterSelect?.dispose();
    this.hud?.dispose();
    this.chatPanel?.dispose();
    this.targetWindow?.dispose();
    this.inventoryWindow?.dispose();
    this.lootWindow?.dispose();
    this.examineWindow?.dispose();
    this.scriptEditor?.dispose();
    this.harvestToast?.dispose();
    this.abilityWindow?.dispose();
    this.characterSheet?.dispose();
    this.partyWindow?.dispose();
    this.actionBar?.dispose();
    this.minimap?.dispose();
    this.villagePanel?.dispose();
    this.marketPanel?.dispose();
    this.worldMapPanel?.dispose();
    this.travelPanel?.dispose();
    this.guildPanel?.dispose();
    this.companionPanel?.dispose();
    this.enmityPanel?.dispose();
    this.aiDebugWindow?.dispose();
    this.buildPanel?.dispose();
    this.systemMenu?.dispose();
    this.layoutEditor?.dispose();
    this.registrationModal?.dispose();
    this.placementMode?.dispose();
    this.settingsWindow?.dispose();
    this.autoAttackRing.dispose();
    this.telegraphs.dispose();
    this.stagingMarker.dispose();
  }

  // ── Chat command handlers ────────────────────────────────────────────────

  /** /quit — graceful logout, clear auth, reconnect to show login screen. */
  private _handleQuit(): void {
    this.socket.sendLogout();
    // Set phase away from in_world BEFORE disconnect so auto-reconnect doesn't fire.
    this.session.setPhase('disconnected');
    setTimeout(() => {
      this.socket.disconnect();
      this.session.clearAuth();
      this.entities.clear();
      // Dispose old character select so it's rebuilt fresh for the next account.
      this.characterSelect?.dispose();
      this.characterSelect = null;
      // Reconnect fresh — handshake_ack will set phase → 'login'.
      this.socket.connect();
    }, 500);
  }

  /** Show a small confirm modal when a deferred zone build completes,
   *  asking whether the player wants to travel to the new zone now or
   *  later (via the travel panel on demand). Re-uses travel_request without
   *  deferBuild so the regular transfer path runs. */
  private _showTravelReadyModal(destinationName: string, zoneId: string, routeRef: string): void {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(8,6,4,0.78);
      display: flex; align-items: center; justify-content: center;
      z-index: 800; pointer-events: auto;
    `;
    modal.innerHTML = `
      <div style="
        background: rgba(20,15,10,0.98);
        border: 1px solid rgba(200,98,42,0.45);
        padding: 1.6rem 1.6rem 1.2rem; width: min(380px, 92vw);
        display: flex; flex-direction: column; gap: 0.9rem;
      ">
        <div style="font-family: var(--font-display, serif); letter-spacing: 0.18em;
                    color: rgba(200,145,60,0.95); font-size: 1rem; text-transform: uppercase;">
          ${this._escHtml(destinationName)} is Ready
        </div>
        <div style="font-size: 0.88rem; color: rgba(200,180,150,0.85); line-height: 1.5;">
          The zone has finished building. Travel there now?
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="cs-btn" id="trm-now"   style="flex:1;">Travel Now</button>
          <button class="cs-btn" id="trm-later" style="flex:1;
                  background: transparent; color: rgba(150,120,80,0.7);
                  border-color: rgba(120,90,50,0.30);">Later</button>
        </div>
      </div>
    `;
    modal.querySelector('#trm-now')?.addEventListener('click', () => {
      this.socket.sendTravelRequest({
        destinationName,
        destinationZoneId: zoneId,
        routeRef,
        distanceMiles:     0,
        hasToll:           false,
        deferBuild:        false,
      });
      modal.remove();
    });
    modal.querySelector('#trm-later')?.addEventListener('click', () => {
      modal.remove();
    });
    this.uiRoot.appendChild(modal);
  }

  private _escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** /shutdown — graceful logout, then close the client window. */
  private _handleShutdown(): void {
    this.socket.sendLogout();
    setTimeout(() => {
      this.socket.disconnect();
      // Tauri WebView2: window.close() closes the native window.
      // Browser: closes the tab (may be blocked by browser if not user-initiated).
      window.close();
    }, 500);
  }

  // ── Game loop ─────────────────────────────────────────────────────────────

  private _loop = (now: number): void => {
    this.rafId = requestAnimationFrame(this._loop);

    // FPS limiter — skip frame if too soon
    if (this._fpsLimit > 0 && (now - this._lastRender) < this._frameInterval) return;
    this._lastRender = now;

    // FPS counter + entity count + position debug
    const _debugPe = this.factory?.getPlayerEntity();
    this.hud?.updateFps(
      now,
      this.factory?.getAllObjects().length ?? 0,
      _debugPe?.object3d.position,
      this._perfSnapshot ?? undefined,
    );

    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    // Tick entities
    this.factory.update(dt);
    if (this._forestRenderer) {
      const fp = this.factory.getPlayerEntity()?.object3d.position;
      if (fp) this._forestRenderer.update(fp.x, fp.z);
    }

    // Wire PlayerEntity + physics deps via reference tracking. We compare
    // each current dep against the last-wired reference and re-apply on diff.
    // When PE itself swaps (zone transfer recreates the entity), all dep
    // tracking is invalidated since the new PE has none of our state.
    const pe = this.factory.getPlayerEntity();
    if (pe !== this._wiredPe) {
      this.wasd.setPlayerEntity(pe);
      this.gamepad.setPlayerEntity(pe);
      this.clickMove.setPlayerEntity(pe);
      this._wiredPe = pe;
      // PE swap → new PE has no deps applied. Invalidate dep tracking so the
      // checks below re-apply each one to the new PE.
      this._wiredHeightmap      = null;
      this._wiredWorldRoot      = null;
      this._wiredForestRenderer = null;
    }
    if (pe && this._heightmap !== this._wiredHeightmap) {
      pe.setHeightmap(this._heightmap);
      this._wiredHeightmap = this._heightmap;
    }
    if (pe && this.worldRoot !== this._wiredWorldRoot) {
      pe.setWorldRoot(this.worldRoot);
      this.camera.setWorldRoot(this.worldRoot);
      this._wiredWorldRoot = this.worldRoot;
    }
    if (pe && this._forestRenderer !== this._wiredForestRenderer) {
      if (this._forestRenderer) {
        const fr = this._forestRenderer;
        pe.setTreeQuery((x, z, rSq) => fr.queryNearby(x, z, rSq));
      }
      this._wiredForestRenderer = this._forestRenderer;
    }

    // Tick tendril / corpse effects
    this.corpses.update(dt);

    // WASD movement + Q/E camera rotation
    this.wasd.tick(dt);
    this.gamepad.tick(dt);

    // Follow player with camera
    const playerEntity = this.factory.getPlayerEntity();
    if (playerEntity) {
      this.camera.follow(playerEntity.cameraTarget, dt);
      // Ceiling clip hole: intersect the camera→player ray with the
      // ceiling plane so the hole tracks the camera's line of sight.
      const camPos = this.camera.camera.position;
      const target = playerEntity.cameraTarget;
      this._vaultRenderer?.setClipCenter(
        camPos.x, camPos.y, camPos.z,
        target.x, target.z,
      );
      // Promote shadow casting to the nearest room lights only — keeps the
      // ominous corner feel without paying for 36 cubemap passes/frame.
      this._vaultRenderer?.updateShadowFollow(target.x, target.y, target.z);
    }

    // Sky-look hint visibility (driven by camera engagement state).
    this.skyHint?.update(
      this.camera.getSkyEngagement(),
      this.camera.isSkyTargetActive(),
      this.camera.isSkyLatched(),
    );

    // Advance day/night / weather crossfade + sun orbit
    this.scene.tick(
      dt,
      this.world.getTimeOfDayNormalized(),
      playerEntity?.cameraTarget,
    );

    // Precipitation, lightning, snow — follows the player
    if (playerEntity) {
      this.weather.tick(dt, playerEntity.cameraTarget);

      // Cloud layer — coverage derived from current weather, since the
      // climate sim's cloud_cover float isn't currently surfaced.
      const wx = this.world.zone?.weather ?? 'clear';
      const cover =
        wx === 'storm'  ? 1.00 :
        wx === 'rain'   ? 0.85 :
        wx === 'fog'    ? 0.85 :
        wx === 'cloudy' ? 0.70 :
        wx === 'mist'   ? 0.30 :
                          0.05;
      const wind = this.world.wind;
      this.clouds.tick(
        dt,
        playerEntity.cameraTarget,
        cover,
        wind?.speed     ?? 1.5,
        wind?.direction ?? 0,
        this.scene.getSunDirection(),
        wx,
      );
    }

    // Tick action bar cooldowns
    this.actionBar?.tick(dt);

    // Tick auto-attack ring (lerp + reposition)
    this.autoAttackRing.update(dt);

    // Tick AoE telegraphs (reposition follow-anchors, advance cast fill,
    // decay tick pulses, dispose naturally-expired entries)
    this.telegraphs.update(dt);

    // Spin the vault staging banner around Y while the marker is up.
    this.stagingMarker.update(dt);

    // Tick corruption miasma (particles + fog based on distance from anchors)
    if (this.miasma && playerEntity) {
      this.miasma.update(dt, playerEntity.cameraTarget);
    }

    // Tick ward beacon animations (ring spin + pulse)
    this.beacons?.update(dt);
    this.guildBeacons?.update(dt);
    this.disposableBeacons?.update(dt);
    this.playerCorpses?.update(dt);
    this.harvestNodes?.update(dt);
    this.rockRenderer?.update(dt);
    if (this.miasmaFog) {
      // Cheap to push every frame — anchor lists are 6 + ≤32 entries.
      // Auto-reactive: a /beacon-grant placement shows up in fog next tick.
      const civic = this.beacons?.anchorList() ?? [];
      const guild = this.guildBeacons?.beaconList() ?? [];
      this.miasmaFog.setCivicAnchors(civic);
      this.miasmaFog.setGuildBeacons(guild);
      this.miasmaFog.update(dt, this.player.position.x, this.player.position.z);
    }
    this.miasmaWall?.update(dt);

    // Harvest proximity check — drives the F-key probe AND the HUD prompt
    // off a single per-frame scan against the live node set. Cheap (XZ
    // scan over ~1800 entries worst case).
    this._harvestableInRange = this.harvestNodes?.hasNodeWithin(
      this.player.position.x, this.player.position.z, HARVEST_KEY_RANGE_M,
    ) ?? false;

    // Same pattern for own-corpses. Server-side /loot honours a 3m gate,
    // mirrored here.
    this._lootableCorpseInRange = this.playerCorpses?.hasLootableCorpseWithin(
      this.player.position.x, this.player.position.z, LOOT_KEY_RANGE_M,
    ) ?? false;

    // F-key prompt priority: interactable entity (has interactionKind)
    // > lootable corpse > harvest glint. Mobs without a kind don't trip
    // the prompt — they're click-target, not F-interact.
    const nearestInteractable = this.wasd?.findNearestInteractable() ?? null;
    if (nearestInteractable?.interactionPrompt) {
      this.hud?.setInteractPrompt(nearestInteractable.interactionPrompt);
    } else if (this._lootableCorpseInRange) {
      this.hud?.setInteractPrompt('Loot');
    } else if (this._harvestableInRange) {
      this.hud?.setHarvestPromptVisible(true);
    } else {
      this.hud?.setInteractPrompt(null);
    }

    // Tick water shader animation (wave displacement + fog sync)
    this.water?.update(dt, this.scene.getSunDirection());

    // Nameplate per-frame: range fade + max-count cap. Must run after
    // entity ticks (factory.update) so plate distances reflect this
    // frame's positions. CSS2DRenderer.render() projects each plate's
    // CSS2DObject to screen space via the same camera as the WebGL
    // render below, so they line up exactly with their entity.
    const _cam = this.camera.getCamera();
    this.nameplates.update(_cam);

    // Update post-process uniforms (time + player position + zone radius)
    // before rendering. Trigger is position-based — distance from origin
    // past zoneRadiusM. Cheap when inside the ring (passthrough branch).
    this.scene.tickPostProcess(
      dt,
      this.player.position.x,
      this.player.position.z,
      this.world.zone?.zoneRadiusM ?? null,
    );

    // Time the render call. renderer.info auto-resets each frame, so the
    // counts below reflect just this render (including shadow passes).
    const _t0 = performance.now();
    this.scene.render(_cam);
    this.nameplates.css2d.render(this.scene.scene, _cam);
    const _frameMs = performance.now() - _t0;

    // Smooth the per-frame jitter with a light EMA (~0.1 weight).
    this._perfFrameMs = this._perfFrameMs === 0
      ? _frameMs
      : this._perfFrameMs * 0.9 + _frameMs * 0.1;

    // Refresh the perf snapshot at most 2×/sec to match the FPS line cadence.
    // Skipped entirely when the F9 overlay is off.
    if (this.hud?.perfMode) {
      if (now - this._perfLastGather >= 500) {
        this._perfLastGather = now;
        const info = this.scene.renderer.info;
        let shadowLights = 0;
        let totalLights  = 0;
        this.scene.scene.traverse(obj => {
          const l = obj as THREE.Light;
          if ((l as THREE.Light).isLight) {
            totalLights++;
            if ((l as THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight).castShadow) {
              shadowLights++;
            }
          }
        });
        this._perfSnapshot = {
          frameMs:      this._perfFrameMs,
          drawCalls:    info.render.calls,
          triangles:    info.render.triangles,
          programs:     info.programs?.length ?? 0,
          geometries:   info.memory.geometries,
          textures:     info.memory.textures,
          shadowLights,
          totalLights,
          indoor:       this.scene.isIndoor,
        };
      }
    }
  };

  /**
   * Set an FPS cap. 0 = unlimited.
   */
  setFpsLimit = (limit: number): void => {
    this._fpsLimit = limit;
    this._frameInterval = limit > 0 ? 1000 / limit : 0;
  };

  // ── Phase management ──────────────────────────────────────────────────────

  private _onPhaseChange(): void {
    const phase = this.session.phase;

    // Loading screen is managed per-case below — it must persist across the
    // loading_world → in_world transition and only drop on world_ready (or
    // the fallback timer) so the player isn't unblocked before the zone
    // server has registered them and synced the entity roster.
    if (phase !== 'loading_world' && phase !== 'in_world') {
      this.loading.hide();
    }
    // Server-picker form is a startup-failure escape hatch — only relevant
    // before we've authenticated. Hide once the loading screen is being
    // used for gameplay transitions (travel, zone hop).
    const serverPicker = document.getElementById('loading-server');
    if (serverPicker) {
      serverPicker.style.display = (phase === 'disconnected' || phase === 'login') ? 'flex' : 'none';
    }
    this.loginScreen?.hide();
    this.characterSelect?.hide();
    this.hud?.hide();
    this.chatPanel?.hide();
    this.targetWindow?.hide();
    this.inventoryWindow?.hide();
    this.characterSheet?.hide();
    this.partyWindow?.hide();
    this.actionBar?.hide();
    this.minimap?.hide();
    this.villagePanel?.hide();
    this.guildPanel?.hide();
    this.companionPanel?.hide();
    this.enmityPanel?.hide();
    this.buildPanel?.hide();
    this.systemMenu?.hide();
    this.placementMode?.exit();

    switch (phase) {
      case 'login':
        this._showLogin();
        break;

      case 'character_select':
        this._showCharacterSelect();
        break;

      case 'loading_world':
        this.loading.show();
        this.loading.setStatus('Entering world…');
        this.loading.setProgress(0);
        this._hasEnteredZone = false;
        // New zone is incoming — release the in_world load guard so the
        // next setPhase('in_world') actually runs _loadWorldAssets.
        this._loadedZoneId = null;
        // Re-arm the loading-screen gate. Both signals must fire again
        // before the curtain drops on the new zone.
        this._worldReadyReceived = false;
        this._assetsLoaded       = false;
        // Halt input during the transition so any stray WASD presses on the
        // loading screen don't send move messages tied to the about-to-be-
        // -discarded PlayerEntity. The reference-tracking wiring above will
        // re-attach controllers automatically once the new PE arrives (via
        // applyWorldEntry) — no need to reset tracking fields here.
        this._heightmap = null;
        this.wasd.setPlayerEntity(null);
        this.gamepad.setPlayerEntity(null);
        this.clickMove.setPlayerEntity(null);
        // Defensive fallback — if world_ready never arrives, we'd otherwise
        // strand the player on a black screen. 10 s is well past the worst
        // observed addPlayer + entity-sync latency; if we hit this, log it.
        this._armWorldReadyFallback();
        break;

      case 'in_world':
        // Loading screen stays visible until world_ready (or fallback) — the
        // zone server may not have registered this player yet, so showing
        // the game world here would let movement input race ahead of the
        // server's addPlayer and snap-back.
        this._showGameUI();
        // Create corruption miasma on first world entry
        if (!this.miasma) {
          this.miasma = new CorruptionMiasma(this.scene.scene);
        }
        // Ground-hugging fog plane — renders the danger field per-pixel.
        // Sibling to CorruptionMiasma (which handles particles + scene fog
        // tint); this gives the heavy "you're walking through it" feel.
        // Skipped entirely when miasmaQuality === 'off'.
        if (!this.miasmaFog && ClientConfig.miasmaSubdivisions() > 0) {
          this.miasmaFog = new MiasmaGroundFog(
            this.scene.scene,
            ClientConfig.miasmaSubdivisions(),
            ClientConfig.miasmaPlaneSize(),
          );
          this.miasmaFog.setVisible(false); // wait for heightmap + anchors
        }
        // The boundary wall is per-zone (radius differs) so it's built
        // inside _loadWorldAssets after the heightmap arrives, not here.
        // Create ward beacons above civic anchors
        if (!this.beacons) {
          this.beacons = new WardBeaconManager(this.scene.scene);
        }
        // Create harvest-node glints manager. Server pushes initial snapshot
        // on join; live add/remove arrives via the world.onEvent handlers
        // wired in the constructor. No per-zone fetch needed.
        // Camera ref: glints push laterally toward the camera each frame so
        // they're never hidden inside trunks. Heightmap ref: glint Y locks
        // to the same source ForestRenderer uses for tree visuals, so they
        // sit at the visible trunk base regardless of server/client DEM
        // sampling differences.
        if (!this.harvestNodes) {
          this.harvestNodes = new HarvestNodeManager(
            this.scene.scene,
            () => this.camera.camera.position,
            () => this._heightmap,
          );
        }
        // Rock outcrops — static scatter, populated from rocks_initial event.
        // Camera ref lets the per-frame cull collapse far rocks to scale=0.
        if (!this.rockRenderer) {
          this.rockRenderer = new RockRenderer(
            this.scene.scene,
            () => this._heightmap,
            () => this.camera.camera.position,
          );
        }
        // Disposable beacons — placed via /placebeacon, lifecycle via server.
        // Slim warm-fire visual, distinct from guild beacons' purple permanence.
        if (!this.disposableBeacons) {
          this.disposableBeacons = new DisposableBeaconManager(
            this.scene.scene, () => this.worldRoot,
          );
        }
        // Corpses — overworld death drops. Owned-corpse glow uses the local
        // character id to highlight the player's own bundles.
        if (!this.playerCorpses) {
          this.playerCorpses = new CorpseRenderer(
            this.scene.scene,
            () => this.entities.playerId,
            () => this.worldRoot,
          );
        }
        // Create guild-beacon manager (renders purple variants in deep miasma)
        if (!this.guildBeacons) {
          // Pass a terrain-root resolver so the aura raycasts hit only
          // terrain — without this, tree canopies (opaque, 8-22m tall)
          // intercept the disc's ground lookup and the disc drapes over
          // the forest instead of the ground.
          this.guildBeacons = new GuildBeaconManager(this.scene.scene, () => this.worldRoot);
        }
        // Vault zones are flat at Y=0. The previous overworld heightmap would
        // otherwise still be in effect when the camera snaps and entities
        // render — putting them hundreds of metres above the vault floor.
        // Null the heightmap synchronously here, before any further setup.
        if (this.world.zone?.id.startsWith('vault:')) {
          this._heightmap = null;
          this.clickMove.setHeightmap(null);
          this.factory.setHeightmap(null);
          this.autoAttackRing.setHeightmap(null);
    this.telegraphs.setHeightmap(null);
          const pe = this.factory.getPlayerEntity();
          if (pe) pe.setHeightmap(null);
        }
        // Snap camera to player position on world entry
        this.camera.snapToTarget(
          new THREE.Vector3(this.player.position.x, this.player.position.y, this.player.position.z)
        );
        // Load world geometry — zone is guaranteed set before setPhase('in_world')
        if (this.world.zone) {
          this._loadWorldAssets(this.world.zone.id);
        } else {
          console.error('[App] in_world phase but world.zone is null!');
        }
        break;

      case 'disconnected':
        // Only show login on disconnect if we were previously authenticated.
        // On initial startup 'disconnected' is the default phase — the loading
        // screen handles that state instead.
        if (this.session.accountId) {
          this._showLogin();
        }
        break;
    }
  }

  private _onWorldReady(): void {
    if (this._worldReadyFallback !== null) {
      clearTimeout(this._worldReadyFallback);
      this._worldReadyFallback = null;
    }
    this._worldReadyReceived = true;
    this._maybeFinishLoading();
  }

  private _armWorldReadyFallback(): void {
    if (this._worldReadyFallback !== null) clearTimeout(this._worldReadyFallback);
    this._worldReadyFallback = setTimeout(() => {
      console.warn('[App] world_ready fallback fired — server never confirmed readiness within 10s');
      this._worldReadyFallback = null;
      // Treat as if world_ready arrived — the gate still respects the
      // assets-loaded flag, so we won't expose a half-built world; we
      // just stop waiting on the server.
      this._worldReadyReceived = true;
      this._maybeFinishLoading();
    }, 10_000);
  }

  /** Hide the loading screen iff both the server's world_ready signal
   *  has fired AND the client's asset-load chain has finished. Called
   *  from both completion paths; the second one wins. */
  private _maybeFinishLoading(): void {
    if (!this._worldReadyReceived || !this._assetsLoaded) return;
    this.loading.complete();
    this.loading.hide();
  }

  /**
   * Force every shader currently in the scene to compile BEFORE we hide
   * the loading screen. Without this, custom ShaderMaterials (water,
   * miasma fog, telegraph rings, beacons, etc.) compile lazily on first
   * draw — and on driver/GPU configurations without
   * `KHR_parallel_shader_compile` the compile is synchronous, blocking
   * the first gameplay frame for 100ms–several seconds. Surfaced as the
   * "tab unresponsive" zone-load hang.
   *
   * On Chrome/Edge with the parallel-compile extension this is fully
   * async — the await resolves only once GPU-side compile completes,
   * which is exactly the window where the loading screen is up. On
   * browsers without the extension, the compile still blocks but it
   * blocks during loading rather than gameplay. Either way, the visible
   * stall moves into the loading curtain.
   *
   * Idempotent — already-compiled materials are skipped at zero cost
   * thanks to Three.js's WebGLProgramCache.
   */
  private async _warmShaderCache(): Promise<void> {
    if (!this.scene?.renderer || !this.scene?.scene) return;
    const camera = this.camera?.getCamera();
    if (!camera) return;
    const t0 = performance.now();
    try {
      await this.scene.renderer.compileAsync(this.scene.scene, camera);
      console.log(`[App] shader warm-cache: ${(performance.now() - t0).toFixed(0)}ms`);
    } catch (err) {
      console.warn('[App] shader warm-cache failed:', err);
    }
  }

  /** Dispose any existing miasma fog plane and (if quality !== 'off')
   *  build a fresh one at the new subdivision count. Called when the
   *  user changes the Miasma Fog setting. Safe to call any time — also
   *  re-applies heightmap/anchors so the new fog is immediately
   *  conformed and reactive. */
  private _rebuildMiasmaFog(): void {
    this.miasmaFog?.dispose();
    this.miasmaFog = null;
    const subdiv = ClientConfig.miasmaSubdivisions();
    if (subdiv <= 0) return; // user picked Off
    this.miasmaFog = new MiasmaGroundFog(
      this.scene.scene,
      subdiv,
      ClientConfig.miasmaPlaneSize(),
    );
    if (this._heightmap) this.miasmaFog.setHeightmap(this._heightmap);
    this.miasmaFog.setVisible(this.session.phase === 'in_world');
  }

  private _showLogin(): void {
    if (!this.loginScreen) {
      this.loginScreen = new LoginScreen(this.uiRoot, this.socket, this.session);
    }
    this.loginScreen.show();
  }

  /** Update the login screen server field to match the active ClientConfig URL. */
  private _syncLoginServerField(): void {
    this.loginScreen?.syncServerField();
  }

  private _showCharacterSelect(): void {
    this.loginScreen?.hide();
    if (!this.characterSelect) {
      this.characterSelect = new CharacterSelect(this.uiRoot, this.socket, this.session);
    }
    this.characterSelect.show();
  }

  private _showGameUI(): void {
    if (!this.hud) {
      this.hud = new HUD(this.uiRoot, this.player, this.socket, this.world);
    }
    if (!this.chatPanel) {
      this.chatPanel = new ChatPanel(this.uiRoot, this.world, this.socket, this.player);
      this.chatPanel.setQuitCallback(() => this._handleQuit());
      this.chatPanel.setShutdownCallback(() => this._handleShutdown());
      this.chatPanel.setTelegraphToggleCallback((on) => this.telegraphs.setVisible(on));

      // Wire /cc to client-side BYOLLM
      this.chatPanel.setCompanionChatCallback((message: string) => {
        const comp = this.player.companion;
        if (!comp) {
          this.world.pushMessage('system', 'You don\'t have a companion summoned.');
          return;
        }
        if (!this.companionLLM) {
          this.world.pushMessage('system', 'Companion chat system not initialized.');
          return;
        }
        const companionName = comp.name;
        // Show thinking indicator
        this.world.pushMessage('companion', '\u2026', companionName);
        // Async LLM call — no cooldown for player-initiated chat
        void this.companionLLM.handleChat(this.player.name, message).then((reply) => {
          if (reply) {
            this.world.pushMessage('companion', reply, companionName);
          } else {
            this.world.pushMessage('companion',
              `*${companionName} looks at you but doesn't seem to know what to say.*`,
              companionName);
          }
        });
      });
    }
    if (!this.targetWindow) {
      this.targetWindow = new TargetWindow(this.uiRoot, this.player, this.entities, this.socket);
    }
    if (!this.inventoryWindow) {
      this.inventoryWindow = new InventoryWindow(this.uiRoot, this.player, this.socket);
      // Wire 'I' key to inventory toggle via WASDController callback
      this.wasd.setInventoryToggle(() => this.inventoryWindow!.toggle());
    }
    if (!this.lootWindow) {
      this.lootWindow = new LootWindow(this.uiRoot, this.socket, this.router);
    }
    if (!this.examineWindow) {
      this.examineWindow = new ExamineWindow(this.uiRoot);
      this.router.onExamine(p => this.examineWindow!.show(p));
    }
    if (!this.scriptEditor) {
      this.scriptEditor = new ScriptEditor(this.uiRoot, this.socket);
      this.router.onEditorOpen(p => this.scriptEditor!.open(p));
      this.router.onEditorResult(p => this.scriptEditor!.handleResult(p));
    }
    if (!this.harvestToast) {
      this.harvestToast = new HarvestToast(this.uiRoot);
      this.router.onHarvest(p => this.harvestToast!.show(p));
    }
    if (!this.skyHint) {
      this.skyHint = new SkyHint(this.uiRoot);
    }
    if (!this.systemToast) {
      this.systemToast = new SystemToast(this.uiRoot);
      this.router.onSystemToast(p => this.systemToast!.show(p));

      // Deferred-build complete — prompt the player whether to travel now.
      // Re-uses the existing travel_request channel; the new request omits
      // deferBuild so it transfers normally now that the zone is built.
      this.router.onZoneBuildComplete(p => {
        this._showTravelReadyModal(p.destinationName, p.zoneId, p.routeRef);
      });

      // /help → server filters by role, sends back command list, this panel
      // renders it. Lazy-instantiate on first response.
      this.router.onCommandHelpList(p => {
        if (!this.commandHelpPanel) {
          this.commandHelpPanel = new CommandHelpPanel(this.uiRoot);
        }
        this.commandHelpPanel.show(p);
      });

      // Vault completion celebration banner.
      if (!this.vaultCompleteToast) this.vaultCompleteToast = new VaultCompleteToast(this.uiRoot);
      this.router.onVaultComplete(p => {
        this.vaultCompleteToast!.show({
          goldAwarded: p.goldAwarded,
          hasPortal:   !!p.exitPortal,
        });
      });

      // Level-up celebration toast (player only — companion shows in chat already).
      if (!this.levelUpToast) this.levelUpToast = new LevelUpToast(this.uiRoot);
      this.router.onExperienceGained(p => {
        if (p.entityType !== 'player' || !p.leveledUp) return;
        this.levelUpToast!.show({
          level:    p.level,
          gainedAp: p.gainedAp ?? 0,
          gainedSp: p.gainedSp ?? 0,
        });
      });

      // Show a "forest generating" notice if no plants arrive within 3 s of
      // world_entry. On cache-hit runs the first plant batch lands in < 1 s
      // and the timer is cancelled before it fires — nothing shown.
      //
      // Skip the timer entirely for vault zones: the server doesn't stream
      // plants there (no flora in a sealed dungeon), so the toast would
      // appear and never dismiss.
      let forestTimer: ReturnType<typeof setTimeout> | null = null;
      let dismissForest: (() => void) | null = null;
      this.router.onWorldEntry(() => {
        if (forestTimer) { clearTimeout(forestTimer); forestTimer = null; }
        if (dismissForest) { dismissForest(); dismissForest = null; }
        if (this.world.zone?.id.startsWith('vault:')) return;
        forestTimer = setTimeout(() => {
          forestTimer = null;
          dismissForest = this.systemToast!.showPersistent(
            'Growing the forest for the first time — trees will appear shortly.',
            'info',
          );
        }, 3_000);
      });
      this.router.onFirstPlant(() => {
        if (forestTimer) { clearTimeout(forestTimer); forestTimer = null; }
        if (dismissForest) { dismissForest(); dismissForest = null; }
      });
    }
    if (!this.beaconToast) {
      this.beaconToast = new BeaconToast(this.uiRoot);
      this.router.onBeaconAlert(p => this.beaconToast!.show(p));
      this.router.onLibraryAssault(p => this.beaconToast!.showLibraryAssault(p));
    }
    if (!this.registrationModal) {
      this.registrationModal = new RegistrationModal(this.uiRoot, this.player, this.socket, this.router);
      // Wire /register in chat to open this modal
      this.chatPanel!.setRegisterCallback(() => this.registrationModal!.show());
    }
    if (!this.hirelingPanel) {
      // Modal that listens for `open_hireling_panel` server pushes (sent
      // when the player F-keys the entry-room obelisk, and on hire/dismiss
      // success). No host-side wiring beyond construction.
      this.hirelingPanel = new HirelingPanel(this.uiRoot, this.socket);
    }
    if (!this.dummyPanel) {
      // Empirical-readout modal for F-keyed training dummies. Subscribes
      // to combat outcomes (filtered to the inspected dummy) and renders
      // rolling 30s DPS + hit/miss/crit/glance/pen/deflect counters.
      this.dummyPanel = new DummyPanel(this.uiRoot, this.socket, this.router);
    }
    if (!this.abilityWindow) {
      this.abilityWindow = new AbilityWindow(this.uiRoot, this.player, this.socket, this.router);
      this.abilityWindow.setBeaconRangeCheck(() =>
        this.beacons?.isPositionInRange(this.player.position.x, this.player.position.z) ?? false,
      );
      // Wire 'K' key to ability tree toggle via WASDController callback
      this.wasd.setAbilityToggle(() => this.abilityWindow!.toggle());
    }
    if (!this.characterSheet) {
      this.characterSheet = new CharacterSheet(this.uiRoot, this.player, this.socket);
      this.characterSheet.setBeaconRangeCheck(() =>
        this.beacons?.isPositionInRange(this.player.position.x, this.player.position.z) ?? false,
      );
      this.wasd.setCharacterSheetToggle(() => this.characterSheet!.toggle());
    }
    // Wire the F-key harvest probe to the same cached value the HUD prompt
    // reads — both reflect "is there a glint within range right now?".
    this.wasd.setHarvestableProbe(() => this._harvestableInRange);
    this.wasd.setLootableCorpseProbe(() => this._lootableCorpseInRange);
    if (!this.actionBar) {
      this.actionBar = new ActionBar(this.uiRoot, this.player, this.socket, this.entities);
      this.actionBar.onValidationError = (msg) => this.world.pushMessage('system', msg);
      this.wasd.setAbilitySlotCallback((idx) => this.actionBar!.activateSlot(idx));
      this.router.onCombatOutcome((data) => this.actionBar!.flashOutcome(data));
      this.router.onCombatError((err)    => this.actionBar!.flashError(err));
    }
    if (!this.partyWindow) {
      this.partyWindow = new PartyWindow(this.uiRoot, this.player, this.entities, this.socket);
      this.wasd.setPartyToggle(() => this.partyWindow!.toggle());
    }
    if (!this.minimap) {
      this.minimap = new Minimap(this.uiRoot, this.player, this.entities, this.world);
    }
    if (!this.marketPanel) {
      this.marketPanel = new MarketPanel(this.uiRoot, this.player, this.socket, this.router);
      this.wasd.setMarketToggle(() => this.marketPanel!.toggle());
      this.targetWindow!.setMarketToggle(() => this.marketPanel!.show());
    }
    if (!this.worldMapPanel) {
      this.worldMapPanel = new WorldMapPanel(this.uiRoot, this.player, this.entities, this.world, this.socket);
      this.wasd.setWorldMapToggle(() => this.worldMapPanel!.toggle());
    }
    if (!this.travelPanel) {
      this.travelPanel = new TravelPanel(this.uiRoot, this.world, this.socket, this.session);
      this.wasd.setTravelToggle(() => this.travelPanel!.toggle());
    }
    if (!this.guildPanel) {
      this.guildPanel = new GuildPanel(this.uiRoot, this.player, this.socket, this.router);
      this.wasd.setGuildToggle(() => this.guildPanel!.toggle());
    }
    if (!this.companionPanel) {
      this.companionPanel = new CompanionPanel(this.uiRoot, this.player, this.socket, this.router);
      this.wasd.setCompanionToggle(() => this.companionPanel!.toggle());
    }
    if (!this.companionHUD) {
      this.companionHUD = new CompanionHUD(this.uiRoot, this.player);
    }

    // ── BYOLLM system ─────────────────────────────────────────────────────
    if (!this.chatLogger) {
      const settings = loadSettings();
      this.chatLogger = new ChatLogger(settings.chatHistory.enabledChannels);
      void this.chatLogger.init();

      // Hook chat messages into the logger after rendering
      this.world.onChat((entry) => {
        this.chatLogger!.write(entry.channel, entry.sender, entry.content);
      });
    }
    if (!this.memoryStore) {
      this.memoryStore = new CompanionMemoryStore();
      void this.memoryStore.init();
    }
    if (!this.companionLLM) {
      this.companionLLM = new CompanionLLMService(this.socket, this.chatLogger!, this.memoryStore);

      // Wire trigger handlers
      this.router.onCompanionCombatTrigger((p) => {
        void this.companionLLM!.handleCombatTrigger(p as CompanionCombatTriggerPayload);
      });
      this.router.onCompanionSocialTrigger((p) => {
        void this.companionLLM!.handleSocialTrigger(p as CompanionSocialTriggerPayload);
      });

      // Wire LLM test callback into settings window
      this.settingsWindow?.setTestLLMCallback((config) => this.companionLLM!.testConnection(config));

      // Feed companion config to LLM service (personality data for /cc prompts)
      this.router.onCompanionConfig((payload) => {
        this.companionLLM!.setCompanionConfig(payload);
      });
    }
    if (!this.enmityPanel) {
      this.enmityPanel = new EnmityPanel(this.uiRoot, this.player);
      this.enmityPanel.setTargetCallback((entityId) => {
        const entity = this.entities.get(entityId);
        this.player.setTarget(entityId, entity?.name ?? null);
      });
    }
    if (!this.aiDebugWindow) {
      // Subscribed via /aidebug on (admin-only). Panel auto-shows on first
      // tick from server; no other client-side gate needed.
      this.aiDebugWindow = new AIDebugWindow(this.uiRoot, this.router, this.socket);
    }
    if (!this.buildPanel) {
      this.buildPanel = new BuildPanel(this.uiRoot, this.socket, this.router);
      // B key — only toggle if in own village
      this.wasd.setBuildToggle(() => {
        if (this.world.isVillage && this.world.villageOwnerId === this.player.id) {
          this.buildPanel!.toggle();
        }
      });
    }
    if (!this.systemMenu) {
      this.systemMenu = new SystemMenu(this.uiRoot);
      this.systemMenu.setCallbacks({
        character:  () => this.characterSheet?.toggle(),
        inventory:  () => this.inventoryWindow?.toggle(),
        abilities:  () => this.abilityWindow?.toggle(),
        companion:  () => this.companionPanel?.toggle(),
        guild:      () => this.guildPanel?.toggle(),
        party:      () => this.partyWindow?.toggle(),
        map:        () => this.worldMapPanel?.toggle(),
        travel:     () => this.travelPanel?.toggle(),
        market:     () => this.marketPanel?.toggle(),
        layout:     () => this.layoutEditor?.toggle(),
        settings:   () => this.settingsWindow?.toggle(),
      });
    }
    // Layout editor — drag-to-reposition HUD widgets
    if (!this.layoutEditor) {
      this.layoutEditor = new LayoutEditor(this.uiRoot);
      this.wasd.setLayoutEditToggle(() => this.layoutEditor?.toggle());
      this.wasd.setLayoutEditActive(() => this.layoutEditor?.isActive ?? false);
    }
    // Settings window — O key toggle
    this.wasd.setSettingsToggle(() => this.settingsWindow?.toggle());
    // Tab targeting
    if (!this.tabTarget) {
      this.tabTarget = new TabTargetService(
        this.entities, this.player,
        () => {
          const pe = this.factory.getPlayerEntity();
          if (pe) {
            const p = pe.object3d.position;
            return { x: p.x, y: p.y, z: p.z };
          }
          return this.player.position;
        },
      );
      this.wasd.setTabTargetNext(() => this.tabTarget!.cycleTarget(1));
      this.wasd.setTabTargetPrev(() => this.tabTarget!.cycleTarget(-1));
      this.wasd.setPartyTargetSlotCallback(slot => this.tabTarget!.targetPartySlot(slot));
      this.wasd.setPartyTargetNext(() => this.tabTarget!.cyclePartyTarget(1));
      this.wasd.setPartyTargetPrev(() => this.tabTarget!.cyclePartyTarget(-1));

      // Ctrl+Tab + F1-F8 walk the panel's row order so muscle memory
      // matches what's on screen — including hirelings and companions.
      if (this.partyWindow) {
        this.tabTarget.setOrderedAllyIdsProvider(() => this.partyWindow!.getOrderedAllyIds());
      }

      // Ctrl+F — toggle focus on the current main target. Skips self and any
      // hostile/dead/non-existent entity; ally casts will fall back to the
      // standard chain when no focus is set.
      this.wasd.setToggleFocusOnTarget(() => {
        const tid = this.player.targetId;
        if (!tid || tid === this.player.id) return;
        if (this.player.focusTargetId === tid) {
          this.player.clearFocusTarget();
          return;
        }
        const ent = this.entities.get(tid);
        if (!ent || ent.isAlive === false) return;
        if (ent.hostile) return;
        this.player.setFocusTarget(tid, ent.name ?? tid);
      });

      // Gamepad — same targeting callbacks + layout/menu awareness
      this.gamepad.setTabTargetNext(() => this.tabTarget!.cycleTarget(1));
      this.gamepad.setTabTargetPrev(() => this.tabTarget!.cycleTarget(-1));
      this.gamepad.setPartyTargetNext(() => this.tabTarget!.cyclePartyTarget(1));
      this.gamepad.setPartyTargetPrev(() => this.tabTarget!.cyclePartyTarget(-1));
      this.gamepad.setLayoutEditActive(() => this.layoutEditor?.isActive ?? false);
      this.gamepad.setIsMenuOpen(() =>
        (this.inventoryWindow?.isVisible ?? false) ||
        (this.characterSheet?.isVisible  ?? false) ||
        (this.abilityWindow?.isVisible   ?? false) ||
        (this.marketPanel?.isVisible     ?? false) ||
        (this.worldMapPanel?.isVisible   ?? false) ||
        (this.travelPanel?.isVisible     ?? false) ||
        (this.guildPanel?.isVisible      ?? false) ||
        (this.companionPanel?.isVisible  ?? false) ||
        (this.partyWindow?.isVisible     ?? false) ||
        (this.buildPanel?.isVisible      ?? false) ||
        (this.scriptEditor?.isVisible    ?? false)
      );
    }
    if (!this.villagePanel) {
      this.villagePanel = new VillagePanel(this.uiRoot, this.world, this.player, this.socket);
      this.villagePanel.setPlaceCallback(() => this.buildPanel?.show());
    }
    if (!this.placementMode) {
      this.placementMode = new PlacementMode(
        this.scene.scene, this.camera.getCamera(), this.canvas, this.socket, this.uiRoot,
      );
      this.router.onVillagePlacementMode(p => this.placementMode!.enter(p));
    }

    // Wire vault gate opened → update VaultRenderer tiles + collision +
    // refresh client-side collision candidate caches (PlayerEntity and
    // OrbitCamera both cache bounding spheres that are stale after the
    // wall geometry changes).
    this.router.onVaultGateOpened(p => {
      this._vaultRenderer?.openGate(p.tiles);
      if (this.worldRoot) {
        const pe = this.factory.getPlayerEntity();
        pe?.setWorldRoot(this.worldRoot);
        this.camera.setWorldRoot(this.worldRoot);
      }
    });

    // Player jump event — play the Y-arc visual on the matching entity.
    // Skip self: WASDController's spacebar handler already kicked off the
    // jump locally with captured velocity. Replaying it from this server
    // round-trip would reset _jumpVelX/_jumpVelZ to zero (defaults), killing
    // horizontal motion mid-arc — exactly the "straight up, then horizontal
    // kicks in" hitch. Remote players will need their own RemoteEntity arc
    // when we test multiplayer.
    this.router.onPlayerJump((entityId) => {
      if (entityId === this.player.id) return;
      const obj = this.factory.getObject(entityId);
      // playJump is RemoteEntity-only; instanceof keeps the call type-safe
      // when the entity exists but is some other subclass (shouldn't happen
      // for a player_jump event, but be defensive against malformed events).
      if (obj instanceof RemoteEntity) obj.playJump();
    });

    // Player dash event — server-authoritative teleport. The state_update
    // that follows would otherwise lerp the 5m gap over ~100ms (= ~50 m/s
    // slide), which reads as the entity sliding "off the rails". Snapping
    // here ahead of the lerp keeps the dash feeling instant.
    this.router.onPlayerDash((entityId, x, z) => {
      if (entityId === this.player.id) {
        this.factory.getPlayerEntity()?.snapTo(x, z);
        this.wasd?.clearPrediction();
      }
      // (Remote-dash visual: snap remote entity too — handled by their own
      // setTargetPosition flow, just need a tighter teleport threshold there
      // if it ever feels like a slide.)
    });

    // Cast lifecycle — open / close the HUD cast bar for self only.
    // Remote cast bars (above nameplates) are deferred until nameplates exist.
    this.router.onCastStart((p) => {
      if (p.entityId === this.player.id) {
        this.hud?.showCast(p.abilityName, p.durationMs);
      }
    });
    this.router.onCastComplete((p) => {
      if (p.entityId === this.player.id) this.hud?.completeCast();
    });
    this.router.onCastBreak((p) => {
      if (p.entityId === this.player.id) this.hud?.breakCast();
    });

    // Channel lifecycle — same HUD widget but drain mode (1 → 0). Server's
    // channel_start arrives right after cast_complete for channeled
    // abilities, so the bar transitions cleanly cast → channel.
    this.router.onChannelStart((p) => {
      if (p.entityId === this.player.id) {
        this.hud?.showChannel(p.abilityName, p.durationMs);
      }
    });
    this.router.onChannelComplete((p) => {
      if (p.entityId === this.player.id) this.hud?.completeCast();
    });
    this.router.onChannelBreak((p) => {
      if (p.entityId === this.player.id) this.hud?.breakCast();
    });

    this.hud.show();
    this.actionBar.show();
    this.minimap.show();
    this.chatPanel.show();
    this.targetWindow.show();
    this.systemMenu!.show();
    this.enmityPanel.show();
    // Show village panel if we're in a village zone
    if (this.world.isVillage) {
      this.villagePanel.show();
    }
    // inventoryWindow and lootWindow start hidden (loot panels auto-appear on drops)

    // Apply saved layout positions now that all widgets exist in the DOM
    this.layoutEditor?.applyAll();
  }

  // ── Asset loading ─────────────────────────────────────────────────────────

  private async _loadWorldAssets(zoneId: string): Promise<void> {
    // Re-entry guard — fires when a duplicate world_entry (or any other
    // path that double-triggers in_world) calls us a second time for the
    // same zone before phase changes again. Without this, we'd re-run the
    // entire asset bake — chunked but still 2× wall-clock and visibly
    // hanging during the second pass.
    if (this._loadedZoneId === zoneId) {
      console.warn(`[App] _loadWorldAssets(${zoneId}) suppressed — already loaded for this phase`);
      return;
    }
    this._loadedZoneId = zoneId;

    // Reset persistent per-zone renderers BEFORE any await — the
    // server's join-time event blasts (rocks_initial, harvest_node_batch_added,
    // disposable_beacons_initial, corpses_initial) fire fast and arrive
    // during any subsequent yield in this function.  If we cleared late,
    // those events would land first and then get wiped by our clear().
    // Doing it synchronously here means events always land into a fresh,
    // ready renderer.
    this.water?.clear();
    this._forestDebug?.clear();
    this._forestRenderer?.clear();
    this._vaultRenderer = null;
    this.harvestNodes?.clear();
    this.rockRenderer?.clear();
    this.disposableBeacons?.clear();

    // Tear down the vault minimap whenever we change zones — if the new zone
    // is also a vault, the post-fetch path below builds a fresh one against
    // the new renderer + tile grid.
    if (!zoneId.startsWith('vault:')) {
      this.vaultMinimap?.dispose();
      this.vaultMinimap = null;
      this.minimap?.show();
    }

    if (this.worldRoot) {
      this.scene.scene.remove(this.worldRoot);
      this.worldRoot = null;
      this.clickMove.clearWorldRoot();
      this.camera.setWorldRoot(null);
    }

    // Village zones use procedural terrain instead of server-hosted GLBs
    if (zoneId.startsWith('village:')) {
      this._buildVillageTerrain();
      // Re-show overworld effects hidden by vault zones
      this.beacons?.setVisible(true);
      this.guildBeacons?.setVisible(true);
      this.disposableBeacons?.setVisible(true);
      this.playerCorpses?.setVisible(true);
      this.harvestNodes?.setVisible(true);
      this.rockRenderer?.setVisible(true);
      this.miasmaFog?.setVisible(false); // village = inside walls, no miasma
      this.clouds.setVisible(true);
      this.scene.setIndoorMode(false, this.camera.getCamera());
      this._assetsLoaded = true;
      this._maybeFinishLoading();
      return;
    }

    // Vault zones use tile-based terrain fetched from the server
    if (zoneId.startsWith('vault:')) {
      // Hide overworld effects that don't belong inside vaults
      this.beacons?.setVisible(false);
      this.guildBeacons?.setVisible(false);
      this.disposableBeacons?.setVisible(false);
      this.playerCorpses?.setVisible(false);
      this.harvestNodes?.setVisible(false);
      this.rockRenderer?.setVisible(false);
      this.miasmaFog?.setVisible(false);
      this.clouds.setVisible(false);
      // Hide the overworld compass immediately — the vault minimap takes the
      // same UI slot once the tile fetch completes. Avoids a flicker where
      // the wrong widget is up during the (~few hundred ms) fetch window.
      this.minimap?.hide();
      // Tighten camera frustum + fog so the GPU isn't rasterising 2 km of
      // off-screen vault hall behind walls. No occlusion culling in Three.js.
      this.scene.setIndoorMode(true, this.camera.getCamera());
      await this._buildVaultTerrain(zoneId);
      this._assetsLoaded = true;
      this._maybeFinishLoading();
      return;
    }

    // Open-world zones — restore outdoor camera/fog if we were in a vault.
    this.clouds.setVisible(true);
    this.scene.setIndoorMode(false, this.camera.getCamera());

    try {
      const { worldRoot: root, heightmap, origin } = await this.assets.loadZone(zoneId);
      this.worldRoot = root;
      this._heightmap = heightmap;
      this.scene.scene.add(root);
      this.clickMove.setHeightmap(heightmap);
      this.clickMove.setWorldRoot(root);  // no-op but kept for future mesh targets
      this.factory.setHeightmap(heightmap);
      this.autoAttackRing.setHeightmap(heightmap);
      this.telegraphs.setHeightmap(heightmap);
      this._forestRenderer?.setHeightmap(heightmap);
      this.camera.setWorldRoot(root);
        const pe = this.factory.getPlayerEntity();
      if (pe) {
        pe.setHeightmap(heightmap);
        pe.setWorldRoot(root);
      }

      // Compute world bounding box, log diagnostics, fit camera.
      const box = new THREE.Box3().setFromObject(root);
      const boxCenter = new THREE.Vector3();
      const boxSize   = new THREE.Vector3();
      box.getCenter(boxCenter);
      box.getSize(boxSize);

      const pp = this.player.position;
      console.log(`[App] WorldRoot bounding box:`);
      console.log(`  min: (${box.min.x.toFixed(1)}, ${box.min.y.toFixed(1)}, ${box.min.z.toFixed(1)})`);
      console.log(`  max: (${box.max.x.toFixed(1)}, ${box.max.y.toFixed(1)}, ${box.max.z.toFixed(1)})`);
      console.log(`  size: ${boxSize.x.toFixed(0)}m x ${boxSize.y.toFixed(0)}m x ${boxSize.z.toFixed(0)}m`);
      console.log(`  center: (${boxCenter.x.toFixed(1)}, ${boxCenter.y.toFixed(1)}, ${boxCenter.z.toFixed(1)})`);
      console.log(`[App] Player position: (${pp.x.toFixed(1)}, ${pp.y.toFixed(1)}, ${pp.z.toFixed(1)})`);
      console.log(`[App] Player inside world box X: ${box.min.x <= pp.x && pp.x <= box.max.x}`);
      console.log(`[App] Player inside world box Y: ${box.min.y <= pp.y && pp.y <= box.max.y}`);
      console.log(`[App] Player inside world box Z: ${box.min.z <= pp.z && pp.z <= box.max.z}`);

      if (!box.isEmpty()) {
        // Rather than deriving distance from zone size (which is huge at 6km),
        // use a fixed street-level distance that works well for town-scale content.
        // The player's camera tracks their position; this just sets the zoom level.
        const targetDist = 50;  // 50m: enough to see a building + road ahead clearly
        this.camera.setDistance(targetDist);
        console.log(`[App] Camera distance set to ${targetDist}m`);
      }

      this.systemToast?.show({
        type: 'success',
        message: `${this.world.zone?.name ?? zoneId} — zone loaded.`,
      });

      // Each phase below was previously fire-and-yield-nothing — surfacing
      // a status string + a yieldToBrowser between them gives the user
      // visible progress AND lets the browser paint, which kept the page
      // ticking past its unresponsive watchdog. Phases ordered so the
      // visible-from-spawn ones (terrain done, water, beacons) come first.

      this.loading.setStatus('Loading corruption…');
      await yieldToBrowser();
      this.miasma?.loadForZone(zoneId);
      this.miasmaFog?.setHeightmap(heightmap);
      this.miasmaFog?.setVisible(true);
      // Boundary wall — radius is per-zone, so rebuild when zone changes.
      // Dispose any old wall (different zone or radius); skip rebuild for
      // vault zones where the server sends a null radius.
      this.miasmaWall?.dispose();
      this.miasmaWall = null;
      const wallRadius = this.world.zone?.zoneRadiusM ?? null;
      if (wallRadius && wallRadius > 0) {
        this.miasmaWall = new MiasmaBoundaryWall(this.scene.scene, wallRadius);
        this.miasmaWall.setHeightmap(heightmap);
      }

      this.loading.setStatus('Placing civic beacons…');
      await yieldToBrowser();
      this.beacons?.loadForZone(zoneId);
      this.beacons?.setVisible(true);
      this.beacons?.repositionOnTerrain();

      this.loading.setStatus('Placing guild beacons…');
      await yieldToBrowser();
      this.guildBeacons?.loadForZone(zoneId);
      this.guildBeacons?.setVisible(true);
      this.guildBeacons?.repositionOnTerrain();

      // Renderers cleared at the top of this function (before any yields)
      // so server-pushed events on join land in a fresh state. Here we
      // just turn them visible + reposition any entities that arrived
      // before the heightmap was set.
      this.harvestNodes?.setVisible(true);
      this.harvestNodes?.repositionOnTerrain();
      this.rockRenderer?.setVisible(true);
      this.disposableBeacons?.setVisible(true);
      this.disposableBeacons?.repositionOnTerrain();

      // Water rendering — animated shader surfaces from OSM polygon data.
      // Built sync (~100 ms for ~20 features); not per-feature chunked
      // because rAF yields between features triggered repeated render
      // passes that visibly hung on the water shader's first compile.
      this.loading.setStatus('Building water…');
      await yieldToBrowser();
      if (!this.water) this.water = new WaterRenderer(this.scene.scene, heightmap);
      else this.water.setHeightmap(heightmap);
      if (origin) {
        await this.water.loadForZone(zoneId, origin.lat, origin.lon);
      }

      // Debug overlay — OSM forest polygons rendered as semi-transparent green shading.
      // Toggle with F8. Polygons that appear far from the zone centre = coordinate mismatch.
      if (!this._forestDebug) this._forestDebug = new ForestDebugRenderer(this.scene.scene, heightmap);
      else this._forestDebug.setHeightmap(heightmap);
      this._forestDebug.loadForZone(zoneId);

      this.loading.setStatus('Fetching forest…');
      await yieldToBrowser();
      console.time('[load] forest fetch');

      // Static landscape — trees fetched once over HTTP (with browser cache)
      // instead of streamed over the realtime WebSocket. Re-visits hit 304
      // and load instantly. Failure is non-fatal: an empty manifest just
      // means no trees this load (live plant_spawn deltas can still fill in).
      try {
        const resp = await fetch(`${ClientConfig.serverUrl}/world/landscape/${encodeURIComponent(zoneId)}/trees`);
        console.timeEnd('[load] forest fetch');
        if (resp.ok) {
          this.loading.setStatus('Parsing forest data…');
          await yieldToBrowser();
          console.time('[load] forest parse');
          const manifest = await resp.json() as {
            version: number;
            trees: Array<{ id: string; species: string; x: number; y: number; z: number; variant?: number }>;
          };
          console.timeEnd('[load] forest parse');
          console.log('[load] forest tree count:', manifest.trees?.length ?? 0);
          if (manifest.trees && this._forestRenderer) {
            console.time('[load] forest plant');
            await this._forestRenderer.bulkAddFromManifest(
              manifest.trees,
              (done, total) => {
                this.loading.setStatus(`Planting forest (${done}/${total})…`);
              },
            );
            console.timeEnd('[load] forest plant');
          }
        } else {
          console.warn('[App] Tree manifest fetch returned', resp.status);
        }
      } catch (err) {
        console.warn('[App] Tree manifest fetch failed:', err);
      }
    } catch (err) {
      console.error('[App] Zone asset load failed:', err);
    }

    // Force shaders to compile BEFORE we drop the loading curtain. The
    // overworld load chain assembles water, miasma fog, beacons, forest,
    // and rock InstancedMeshes — each is a ShaderMaterial that compiles
    // lazily on first draw. On drivers without KHR_parallel_shader_compile
    // the compile is sync and blocks the first frame; precompiling here
    // moves that stall onto the loading screen instead of gameplay.
    await this._warmShaderCache();

    // Asset chain done — release the loading screen iff world_ready also
    // arrived. If world_ready won the race, this is the call that hides
    // the curtain; otherwise _onWorldReady will close it once the server
    // signal lands.
    this._assetsLoaded = true;
    this._maybeFinishLoading();
  }

  /**
   * Build vault terrain from tile data fetched from the server.
   * Falls back to a flat grey plane if the fetch fails.
   */
  private async _buildVaultTerrain(zoneId: string): Promise<void> {
    // ── Clear overworld heightmap IMMEDIATELY ────────────────────────────────
    // Vault zones are flat (Y=0). The heightmap must be nulled BEFORE the
    // async tile fetch so that entities created during the fetch don't get
    // snapped to overworld terrain elevations (the old heightmap persists
    // until this point, which would put Y=0 vault entities hundreds of
    // metres in the air).
    this._heightmap = null;
    this.clickMove.setHeightmap(null);
    this.factory.setHeightmap(null);
    this.autoAttackRing.setHeightmap(null);
    this.telegraphs.setHeightmap(null);
    const peEarly = this.factory.getPlayerEntity();
    if (peEarly) peEarly.setHeightmap(null);

    // Extract instanceId from 'vault:<instanceId>'
    const instanceId = zoneId.slice('vault:'.length);
    const url = `${ClientConfig.serverUrl}/world/vault-tiles/${instanceId}`;

    let tileData: VaultTileData | null = null;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        tileData = await resp.json() as VaultTileData;
      } else {
        console.warn(`[App] Vault tiles fetch returned ${resp.status}`);
      }
    } catch (err) {
      console.error('[App] Failed to fetch vault tiles:', err);
    }

    const root = new THREE.Group();
    root.name = 'WorldRoot';

    if (tileData) {
      const renderer = new VaultRenderer();
      renderer.build(tileData);
      root.add(renderer.group);
      this._vaultRenderer = renderer;
      console.log(`[App] Vault terrain built: ${tileData.width}×${tileData.height} tiles`);

      // Swap the corner widget to the vault minimap. Overworld compass would
      // be misleading underground (no entities, no cardinal context), and the
      // vault map shows real layout instead.
      this.minimap?.hide();
      this.vaultMinimap?.dispose();
      this.vaultMinimap = new VaultMinimap(
        this.uiRoot,
        this.player,
        renderer,
        this.router,
        this.world.zone?.name ?? 'Vault',
      );
    } else {
      // Fallback: simple grey plane (sized for multi-room vaults)
      const geo = new THREE.PlaneGeometry(200, 100);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9 });
      const plane = new THREE.Mesh(geo, mat);
      plane.receiveShadow = true;
      root.add(plane);
      console.warn('[App] Vault tile fetch failed — using fallback plane');
    }

    // Add a dim ambient light for the cave interior
    const ambientExtra = new THREE.AmbientLight(0x606080, 0.3);
    root.add(ambientExtra);

    this.worldRoot = root;
    this.scene.scene.add(root);
    this.clickMove.setWorldRoot(root);
    this.camera.setWorldRoot(root);
    // PlayerEntity may have been created during the async fetch — catch it now
    // and wire worldRoot (heightmap already nulled at method start).
    const pe = this.factory.getPlayerEntity();
    if (pe) {
      pe.setHeightmap(null);
      pe.setWorldRoot(root);
    }
    this.camera.setDistance(20);
  }

  /**
   * Build a simple procedural village terrain: grass ground plane + subtle grid lines.
   */
  private _buildVillageTerrain(): void {
    const root = new THREE.Group();
    root.name = 'WorldRoot';

    const size = 64; // metres — covers hilltop_medium; meadow/riverside fit too

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(size, size);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x5a8a3a,
      roughness: 0.95,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    ground.name = 'village-ground';
    root.add(ground);

    // Grid overlay (subtle lines at 2m intervals)
    const gridSize = 2;
    const halfSize = size / 2;
    const gridGeo = new THREE.BufferGeometry();
    const verts: number[] = [];
    for (let i = -halfSize; i <= halfSize; i += gridSize) {
      verts.push(i, 0.01, -halfSize, i, 0.01, halfSize);   // Z lines
      verts.push(-halfSize, 0.01, i, halfSize, 0.01, i);    // X lines
    }
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const gridMat = new THREE.LineBasicMaterial({ color: 0x4a7a30, transparent: true, opacity: 0.25 });
    const grid = new THREE.LineSegments(gridGeo, gridMat);
    grid.name = 'village-grid';
    root.add(grid);

    // Boundary fence (wireframe box outline)
    const boundaryGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 1, size));
    const boundaryMat = new THREE.LineBasicMaterial({ color: 0x8b6914, transparent: true, opacity: 0.4 });
    const boundary = new THREE.LineSegments(boundaryGeo, boundaryMat);
    boundary.position.y = 0.5;
    boundary.name = 'village-boundary';
    root.add(boundary);

    this.worldRoot = root;
    this._heightmap = null;
    this.scene.scene.add(root);
    this.clickMove.setHeightmap(null);
    this.clickMove.setWorldRoot(root);
    this.factory.setHeightmap(null);
    this.autoAttackRing.setHeightmap(null);
    this.telegraphs.setHeightmap(null);
    this.camera.setWorldRoot(root);
    // Wire physics to player entity — village has no heightmap, but worldRoot
    // provides collision with placed structures.
    const pe = this.factory.getPlayerEntity();
    if (pe) {
      pe.setHeightmap(null);
      pe.setWorldRoot(root);
    }
    this.camera.setDistance(30);
    console.log('[App] Village procedural terrain built');
  }
}

// ── Loading screen helper ─────────────────────────────────────────────────────

export class LoadingScreen {
  private el:   HTMLElement;
  private fill: HTMLElement;
  private status: HTMLElement;
  private hideTimer: number | null = null;

  constructor() {
    this.el     = document.getElementById('loading-screen')!;
    this.fill   = document.getElementById('loading-bar-fill')!;
    this.status = document.getElementById('loading-status')!;
  }

  show(): void {
    // Cancel any pending hide so an immediate hide()→show() in the same tick
    // (e.g. _onPhaseChange clearing all panels then re-showing this one)
    // doesn't leave us with a queued display:none firing 650 ms later.
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.el.classList.remove('fade-out');
    this.el.style.display  = '';
    this.el.style.opacity  = '1';
    this.el.style.pointerEvents = 'auto';
  }

  hide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.el.classList.add('fade-out');
    this.hideTimer = window.setTimeout(() => {
      this.el.style.display = 'none';
      this.el.classList.remove('fade-out');
      this.hideTimer = null;
    }, 650);
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
  }

  /** Asset-loader progress. Capped at 95% so the bar can't claim "done"
   *  while we're still waiting on the server's world_ready handshake —
   *  a full bar that doesn't dismiss feels broken. complete() releases
   *  the cap and snaps to 100%. */
  setProgress(pct: number): void {
    const capped = Math.min(pct, 0.95);
    this.fill.style.width = `${Math.round(capped * 100)}%`;
  }

  /** Snap to 100%. Call once world_ready arrives, just before hide(). */
  complete(): void {
    this.fill.style.width = '100%';
  }
}
