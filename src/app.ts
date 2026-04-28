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
import { AutoAttackRing }     from '@/entities/AutoAttackRing';
import { OrbitCamera }        from '@/camera/OrbitCamera';
import { CameraInput }        from '@/camera/CameraInput';
import { ClickMoveController } from '@/input/ClickMoveController';
import { WASDController }      from '@/input/WASDController';
import { GamepadController }   from '@/input/GamepadController';
import { TabTargetService }    from '@/input/TabTargetService';
import { HUD }                from '@/ui/HUD';
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
import { BuildPanel }         from '@/ui/BuildPanel';
import { RegistrationModal }  from '@/ui/RegistrationModal';
import { TravelPanel }        from '@/ui/TravelPanel';
import { SystemToast }        from '@/ui/SystemToast';
import { LevelUpToast }       from '@/ui/LevelUpToast';
import { VaultCompleteToast } from '@/ui/VaultCompleteToast';
import { SkyHint }            from '@/ui/SkyHint';
import { CorpseSystem }       from '@/entities/CorpseSystem';
import { CorruptionMiasma }  from '@/entities/CorruptionMiasma';
import { WardBeaconManager } from '@/entities/WardBeacon';
import { WaterRenderer }      from '@/world/WaterRenderer';
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
  private corpses: CorpseSystem;
  private weather: WeatherEffects;
  private clouds:  CloudLayer;
  private worldRoot:  THREE.Group | null = null;
  private _heightmap: import('@/world/HeightmapService').HeightmapService | null = null;
  private miasma:     CorruptionMiasma | null = null;
  private beacons:    WardBeaconManager | null = null;
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
  private worldMapPanel:     WorldMapPanel      | null = null;
  private travelPanel:       TravelPanel        | null = null;
  private guildPanel:        GuildPanel         | null = null;
  private companionPanel:    CompanionPanel     | null = null;
  private companionHUD:      CompanionHUD       | null = null;
  private systemMenu:        SystemMenu         | null = null;
  private layoutEditor:      LayoutEditor       | null = null;
  private enmityPanel:       EnmityPanel        | null = null;
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

  /** True once we've wired the PlayerEntity to WASD + ClickMove controllers. */
  private _playerEntityWired = false;

  // ── FPS limiter ──────────────────────────────────────────────────────────
  private _fpsLimit = 0;
  private _frameInterval = 0;
  private _lastRender = 0;

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

    this.world.onZoneChange(() => {
      if (!this.world.zone) return;
      const wx  = this.world.zone.weather  ?? 'clear';
      const lit = this.world.zone.lighting ?? 'normal';

      if (!this._hasEnteredZone) {
        // First zone entry — short fade from default scene to current TOD preset.
        this.scene.transitionZone(this.world.zone, 2);
        this._hasEnteredZone = true;
      } else if (wx !== this._lastWeather || lit !== this._lastLighting) {
        // Weather or lighting changed — smooth crossfade.
        this.scene.transitionZone(this.world.zone, 20);
      }
      // TOD-only updates need no transition — tick() drives lighting continuously.

      // Let miasma recapture fog baseline after scene transition starts
      if (this.miasma) {
        // Delay recapture so SceneManager applies the new preset first
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

    // F8 — toggle OSM forest polygon debug overlay
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'F8') this._forestDebug?.toggle();
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
    this.beacons?.dispose();
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
    this.buildPanel?.dispose();
    this.systemMenu?.dispose();
    this.layoutEditor?.dispose();
    this.registrationModal?.dispose();
    this.placementMode?.dispose();
    this.settingsWindow?.dispose();
    this.autoAttackRing.dispose();
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
    this.hud?.updateFps(now, this.factory?.getAllObjects().length ?? 0, _debugPe?.object3d.position);

    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    // Tick entities
    this.factory.update(dt);
    if (this._forestRenderer) {
      const fp = this.factory.getPlayerEntity()?.object3d.position;
      if (fp) this._forestRenderer.update(fp.x, fp.z);
    }

    // Wire PlayerEntity to controllers once it exists
    if (!this._playerEntityWired) {
      const pe = this.factory.getPlayerEntity();
      if (pe) {
        this.wasd.setPlayerEntity(pe);
        this.gamepad.setPlayerEntity(pe);
        this.clickMove.setPlayerEntity(pe);
        // Pass physics data so the entity can do terrain following + wall collision.
        if (this._heightmap) pe.setHeightmap(this._heightmap);
        if (this.worldRoot) {
          pe.setWorldRoot(this.worldRoot);
          this.camera.setWorldRoot(this.worldRoot);
        }
        if (this._forestRenderer) {
          const fr = this._forestRenderer;
          pe.setTreeQuery((x, z, rSq) => fr.queryNearby(x, z, rSq));
        }
        this._playerEntityWired = true;
      }
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

    // Tick corruption miasma (particles + fog based on distance from anchors)
    if (this.miasma && playerEntity) {
      this.miasma.update(dt, playerEntity.cameraTarget);
    }

    // Tick ward beacon animations (ring spin + pulse)
    this.beacons?.update(dt);

    // Tick water shader animation (wave displacement + fog sync)
    this.water?.update(dt, this.scene.getSunDirection());

    this.scene.render(this.camera.getCamera());
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

    this.loading.hide();
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
        // Reset entity wiring — new zone will spawn a new PlayerEntity
        this._playerEntityWired = false;
        this._heightmap = null;
        this.wasd.setPlayerEntity(null);
        this.gamepad.setPlayerEntity(null);
        this.clickMove.setPlayerEntity(null);
        break;

      case 'in_world':
        this.loading.hide();
        this._showGameUI();
        // Create corruption miasma on first world entry
        if (!this.miasma) {
          this.miasma = new CorruptionMiasma(this.scene.scene);
        }
        // Create ward beacons above civic anchors
        if (!this.beacons) {
          this.beacons = new WardBeaconManager(this.scene.scene);
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
      this.worldMapPanel = new WorldMapPanel(this.uiRoot);
      this.wasd.setWorldMapToggle(() => this.worldMapPanel!.toggle());
    }
    if (!this.travelPanel) {
      this.travelPanel = new TravelPanel(this.uiRoot, this.world, this.socket);
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
    // Self goes through the local PlayerEntity; remote players will need
    // their own arc on RemoteEntity (deferred until we test multiplayer).
    this.router.onPlayerJump((entityId) => {
      if (entityId === this.player.id) {
        this.factory.getPlayerEntity()?.playJump();
      }
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
    // Remove previous world geometry + water + trees
    this.water?.clear();
    this._forestDebug?.clear();
    this._forestRenderer?.clear();
    this._vaultRenderer = null;

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
      this.scene.setIndoorMode(false, this.camera.getCamera());
      return;
    }

    // Vault zones use tile-based terrain fetched from the server
    if (zoneId.startsWith('vault:')) {
      // Hide overworld effects that don't belong inside vaults
      this.beacons?.setVisible(false);
      // Hide the overworld compass immediately — the vault minimap takes the
      // same UI slot once the tile fetch completes. Avoids a flicker where
      // the wrong widget is up during the (~few hundred ms) fetch window.
      this.minimap?.hide();
      // Tighten camera frustum + fog so the GPU isn't rasterising 2 km of
      // off-screen vault hall behind walls. No occlusion culling in Three.js.
      this.scene.setIndoorMode(true, this.camera.getCamera());
      await this._buildVaultTerrain(zoneId);
      return;
    }

    // Open-world zones — restore outdoor camera/fog if we were in a vault.
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

      // Terrain is now in the scene — load beacons and miasma anchors for
      // this zone, then reposition beacons onto the terrain surface.
      this.miasma?.loadForZone(zoneId);
      this.beacons?.loadForZone(zoneId);
      this.beacons?.setVisible(true);
      this.beacons?.repositionOnTerrain();

      // Water rendering — animated shader surfaces from OSM polygon data
      if (!this.water) this.water = new WaterRenderer(this.scene.scene, heightmap);
      else this.water.setHeightmap(heightmap);
      if (origin) await this.water.loadForZone(zoneId, origin.lat, origin.lon);

      // Debug overlay — OSM forest polygons rendered as semi-transparent green shading.
      // Toggle with F8. Polygons that appear far from the zone centre = coordinate mismatch.
      if (!this._forestDebug) this._forestDebug = new ForestDebugRenderer(this.scene.scene, heightmap);
      else this._forestDebug.setHeightmap(heightmap);
      await this._forestDebug.loadForZone(zoneId);
    } catch (err) {
      console.error('[App] Zone asset load failed:', err);
    }
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

  constructor() {
    this.el     = document.getElementById('loading-screen')!;
    this.fill   = document.getElementById('loading-bar-fill')!;
    this.status = document.getElementById('loading-status')!;
  }

  show(): void {
    this.el.style.display  = '';
    this.el.style.opacity  = '1';
    this.el.style.pointerEvents = 'auto';
  }

  hide(): void {
    this.el.classList.add('fade-out');
    setTimeout(() => {
      this.el.style.display = 'none';
      this.el.classList.remove('fade-out');
    }, 650);
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
  }

  setProgress(pct: number): void {
    this.fill.style.width = `${Math.round(pct * 100)}%`;
  }
}
