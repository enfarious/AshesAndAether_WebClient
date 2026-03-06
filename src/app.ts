import * as THREE from 'three';
import { SocketClient }       from '@/network/SocketClient';
import { MessageRouter }      from '@/network/MessageRouter';
import { ClientConfig }       from '@/config/ClientConfig';
import { SessionState }       from '@/state/SessionState';
import { PlayerState }        from '@/state/PlayerState';
import { EntityRegistry }     from '@/state/EntityRegistry';
import { WorldState }         from '@/state/WorldState';
import { SceneManager }       from '@/world/SceneManager';
import { AssetLoader }        from '@/world/AssetLoader';
import { EntityFactory }      from '@/entities/EntityFactory';
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
import { LoginScreen }        from '@/ui/LoginScreen';
import { CharacterSelect }    from '@/ui/CharacterSelect';
import { UIScaleWidget }      from '@/ui/UIScaleWidget';
import { FpsWidget }          from '@/ui/FpsWidget';
import { VillagePanel }       from '@/ui/VillagePanel';
import { MarketPanel }        from '@/ui/MarketPanel';
import { WorldMapPanel }      from '@/ui/WorldMapPanel';
import { GuildPanel }         from '@/ui/GuildPanel';
import { CompanionPanel }     from '@/ui/CompanionPanel';
import { SystemMenu }         from '@/ui/SystemMenu';
import { LayoutEditor }       from '@/ui/LayoutEditor';
import { EnmityPanel }        from '@/ui/EnmityPanel';
import { BuildPanel }         from '@/ui/BuildPanel';
import { RegistrationModal }  from '@/ui/RegistrationModal';
import { CorpseSystem }       from '@/entities/CorpseSystem';
import { CorruptionMiasma }  from '@/entities/CorruptionMiasma';
import { WardBeaconManager } from '@/entities/WardBeacon';
import { WaterRenderer }      from '@/world/WaterRenderer';
import { VaultRenderer }      from '@/world/VaultRenderer';
import type { VaultTileData } from '@/world/VaultRenderer';
import { PlacementMode }      from '@/village/PlacementMode';

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
  private corpses: CorpseSystem;
  private worldRoot:  THREE.Group | null = null;
  private _heightmap: import('@/world/HeightmapService').HeightmapService | null = null;
  private miasma:     CorruptionMiasma | null = null;
  private beacons:    WardBeaconManager | null = null;
  private water:      WaterRenderer | null = null;

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
  private abilityWindow:   AbilityWindow   | null = null;
  private characterSheet:  CharacterSheet  | null = null;
  private partyWindow:     PartyWindow     | null = null;
  private actionBar:       ActionBar       | null = null;
  private minimap:         Minimap         | null = null;
  private scaleWidget:     UIScaleWidget   | null = null;
  private fpsWidget:       FpsWidget       | null = null;
  private villagePanel:      VillagePanel      | null = null;
  private marketPanel:       MarketPanel       | null = null;
  private registrationModal: RegistrationModal  | null = null;
  private worldMapPanel:     WorldMapPanel      | null = null;
  private guildPanel:        GuildPanel         | null = null;
  private companionPanel:    CompanionPanel     | null = null;
  private systemMenu:        SystemMenu         | null = null;
  private layoutEditor:      LayoutEditor       | null = null;
  private enmityPanel:       EnmityPanel        | null = null;
  private buildPanel:        BuildPanel         | null = null;
  private placementMode:     PlacementMode      | null = null;

  // ── Environment tracking ─────────────────────────────────────────────────
  private _lastWeather  = '';
  private _lastLighting = '';
  private _hasEnteredZone = false;

  /** True once we've wired the PlayerEntity to WASD + ClickMove controllers. */
  private _playerEntityWired = false;

  // ── FPS limiter ──────────────────────────────────────────────────────────
  private static readonly FPS_STORAGE_KEY = 'aa_fps_limit';
  private static readonly FPS_PRESETS = [30, 60, 120, 144, 0] as const; // 0 = unlimited
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

    // UI scale — mount outside #ui-root so it doesn't zoom itself.
    // Applies saved scale to #ui-root immediately, persists to localStorage.
    this.scaleWidget = new UIScaleWidget(document.body, this.uiRoot);

    // FPS limit widget — mount outside #ui-root alongside scale widget.
    // Fires saved limit on construction, so _fpsLimit is set before first frame.
    this.fpsWidget = new FpsWidget(document.body, this.setFpsLimit);

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
    this.corpses = new CorpseSystem(this.scene.scene, this.entities);

    // Input
    this.clickMove = new ClickMoveController(
      canvas, this.camera, this.socket, this.player, this.entities, this.factory,
    );
    this.wasd = new WASDController(this.camera, this.socket, this.player);
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
    });

    // ── XP gain / level-up notifications ──────────────────────────────────
    this.world.onEvent(payload => {
      if (payload.eventType === 'xp_gain' || payload.eventType === 'level_up') {
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
    this.corpses.dispose();
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
    this.guildPanel?.dispose();
    this.companionPanel?.dispose();
    this.enmityPanel?.dispose();
    this.buildPanel?.dispose();
    this.systemMenu?.dispose();
    this.layoutEditor?.dispose();
    this.registrationModal?.dispose();
    this.placementMode?.dispose();
    this.fpsWidget?.dispose();
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

    // FPS counter + entity count debug
    this.hud?.updateFps(now, this.factory?.getAllObjects().length ?? 0);

    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    // Tick entities
    this.factory.update(dt);

    // Wire PlayerEntity to controllers once it exists
    if (!this._playerEntityWired) {
      const pe = this.factory.getPlayerEntity();
      if (pe) {
        this.wasd.setPlayerEntity(pe);
        this.gamepad.setPlayerEntity(pe);
        this.clickMove.setPlayerEntity(pe);
        // Pass physics data so the entity can do terrain following + wall collision.
        if (this._heightmap) pe.setHeightmap(this._heightmap);
        if (this.worldRoot) pe.setWorldRoot(this.worldRoot);
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
    }

    // Advance day/night / weather crossfade + sun orbit
    this.scene.tick(
      dt,
      this.world.getTimeOfDayNormalized(),
      playerEntity?.cameraTarget,
    );

    // Tick action bar cooldowns
    this.actionBar?.tick(dt);

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
      // Wire 'K' key to ability tree toggle via WASDController callback
      this.wasd.setAbilityToggle(() => this.abilityWindow!.toggle());
    }
    if (!this.characterSheet) {
      this.characterSheet = new CharacterSheet(this.uiRoot, this.player, this.socket);
      this.wasd.setCharacterSheetToggle(() => this.characterSheet!.toggle());
    }
    if (!this.actionBar) {
      this.actionBar = new ActionBar(this.uiRoot, this.player, this.socket);
      this.wasd.setAbilitySlotCallback((idx) => this.actionBar!.activateSlot(idx));
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
    if (!this.guildPanel) {
      this.guildPanel = new GuildPanel(this.uiRoot, this.player, this.socket, this.router);
      this.wasd.setGuildToggle(() => this.guildPanel!.toggle());
    }
    if (!this.companionPanel) {
      this.companionPanel = new CompanionPanel(this.uiRoot, this.player, this.socket, this.router);
      this.wasd.setCompanionToggle(() => this.companionPanel!.toggle());
    }
    if (!this.enmityPanel) {
      this.enmityPanel = new EnmityPanel(this.uiRoot, this.player);
      this.enmityPanel.setTargetCallback((entityId) => {
        const entity = this.entities.get(entityId);
        this.player.setTarget(entityId, entity?.name ?? null);
      });
      this.enmityPanel.show();
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
        market:     () => this.marketPanel?.toggle(),
        layout:     () => this.layoutEditor?.toggle(),
      });
    }
    // Layout editor — drag-to-reposition HUD widgets
    if (!this.layoutEditor) {
      this.layoutEditor = new LayoutEditor(this.uiRoot);
      this.wasd.setLayoutEditToggle(() => this.layoutEditor?.toggle());
      this.wasd.setLayoutEditActive(() => this.layoutEditor?.isActive ?? false);
    }
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
    this.hud.show();
    this.actionBar.show();
    this.minimap.show();
    this.chatPanel.show();
    this.targetWindow.show();
    this.systemMenu!.show();
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
    // Remove previous world geometry + water
    this.water?.clear();
    if (this.worldRoot) {
      this.scene.scene.remove(this.worldRoot);
      this.worldRoot = null;
      this.clickMove.clearWorldRoot();
    }

    // Village zones use procedural terrain instead of server-hosted GLBs
    if (zoneId.startsWith('village:')) {
      this._buildVillageTerrain();
      return;
    }

    // Vault zones use tile-based terrain fetched from the server
    if (zoneId.startsWith('vault:')) {
      await this._buildVaultTerrain(zoneId);
      return;
    }

    try {
      const { worldRoot: root, heightmap, origin } = await this.assets.loadZone(zoneId);
      this.worldRoot = root;
      this._heightmap = heightmap;
      this.scene.scene.add(root);
      this.clickMove.setHeightmap(heightmap);
      this.clickMove.setWorldRoot(root);  // no-op but kept for future mesh targets
      this.factory.setHeightmap(heightmap);
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

      // Terrain is now in the scene — reposition beacons onto it.
      // (Initial beacon raycast fires before GLBs load and misses.)
      this.beacons?.repositionOnTerrain();

      // Water rendering — animated shader surfaces from OSM polygon data
      if (!this.water) this.water = new WaterRenderer(this.scene.scene, heightmap);
      if (origin) await this.water.loadForZone(zoneId, origin.lat, origin.lon);
    } catch (err) {
      console.error('[App] Zone asset load failed:', err);
    }
  }

  /**
   * Build vault terrain from tile data fetched from the server.
   * Falls back to a flat grey plane if the fetch fails.
   */
  private async _buildVaultTerrain(zoneId: string): Promise<void> {
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
      console.log(`[App] Vault terrain built: ${tileData.width}×${tileData.height} tiles`);
    } else {
      // Fallback: simple grey plane
      const geo = new THREE.PlaneGeometry(60, 60);
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
    this._heightmap = null;
    this.scene.scene.add(root);
    this.clickMove.setHeightmap(null);
    this.clickMove.setWorldRoot(root);
    this.factory.setHeightmap(null);
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
