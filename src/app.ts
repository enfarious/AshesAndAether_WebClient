import * as THREE from 'three';
import { SocketClient }       from '@/network/SocketClient';
import { MessageRouter }      from '@/network/MessageRouter';
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
import { HUD }                from '@/ui/HUD';
import { ChatPanel }          from '@/ui/ChatPanel';
import { TargetWindow }       from '@/ui/TargetWindow';
import { LoginScreen }        from '@/ui/LoginScreen';
import { CharacterSelect }    from '@/ui/CharacterSelect';

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
  private worldRoot: THREE.Group | null = null;

  // ── Input ─────────────────────────────────────────────────────────────────
  private clickMove: ClickMoveController;
  private wasd:      WASDController;

  // ── UI ────────────────────────────────────────────────────────────────────
  private loginScreen:     LoginScreen     | null = null;
  private characterSelect: CharacterSelect | null = null;
  private hud:             HUD             | null = null;
  private chatPanel:       ChatPanel       | null = null;
  private targetWindow:    TargetWindow    | null = null;

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

    // Input
    this.clickMove = new ClickMoveController(
      canvas, this.camera, this.socket, this.player, this.entities, this.factory,
    );
    this.wasd = new WASDController(this.camera, this.socket, this.player);

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
      if (this.world.zone) {
        this.scene.applyZone(this.world.zone);
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
    // rather than hanging silently.
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3000;

    const tryConnect = (): void => {
      this.socket.connect();
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
        } else {
          this.loading.setStatus(
            'Could not reach the server. Is it running on localhost:3100?'
          );
        }
      } else if (status === 'handshaking') {
        this.loading.setStatus('Handshaking…');
        retryCount = 0;
      } else if (status === 'connected') {
        // Phase change to 'login' will hide the loading screen
        retryCount = 0;
      } else if (status === 'disconnected' && this.session.phase === 'in_world') {
        this.loading.show();
        this.loading.setStatus('Disconnected. Reconnecting…');
        retryCount = 0;
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
    this.camInput.dispose();
    this.camera.dispose();
    this.factory.dispose();
    this.scene.dispose();
    this.socket.disconnect();
    this.loginScreen?.dispose();
    this.characterSelect?.dispose();
    this.hud?.dispose();
    this.chatPanel?.dispose();
    this.targetWindow?.dispose();
  }

  // ── Game loop ─────────────────────────────────────────────────────────────

  private _loop = (now: number): void => {
    this.rafId = requestAnimationFrame(this._loop);

    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    // Tick entities
    this.factory.update(dt);

    // WASD movement + Q/E camera rotation
    this.wasd.tick(dt);

    // Follow player with camera
    const playerEntity = this.factory.getPlayerEntity();
    if (playerEntity) {
      this.camera.follow(playerEntity.cameraTarget, dt);
    }

    this.scene.render(this.camera.getCamera());
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
        break;

      case 'in_world':
        this.loading.hide();
        this._showGameUI();
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

  private _showCharacterSelect(): void {
    this.loginScreen?.hide();
    if (!this.characterSelect) {
      this.characterSelect = new CharacterSelect(this.uiRoot, this.socket, this.session);
    }
    this.characterSelect.show();
  }

  private _showGameUI(): void {
    if (!this.hud) {
      this.hud = new HUD(this.uiRoot, this.player);
    }
    if (!this.chatPanel) {
      this.chatPanel = new ChatPanel(this.uiRoot, this.world, this.socket);
    }
    if (!this.targetWindow) {
      this.targetWindow = new TargetWindow(this.uiRoot, this.player, this.entities, this.socket);
    }
    this.hud.show();
    this.chatPanel.show();
    this.targetWindow.show();
  }

  // ── Asset loading ─────────────────────────────────────────────────────────

  private async _loadWorldAssets(zoneId: string): Promise<void> {
    // Remove previous world geometry
    if (this.worldRoot) {
      this.scene.scene.remove(this.worldRoot);
      this.worldRoot = null;
      this.clickMove.clearWorldRoot();
    }

    try {
      const { worldRoot: root, heightmap } = await this.assets.loadZone(zoneId);
      this.worldRoot = root;
      this.scene.scene.add(root);
      this.clickMove.setHeightmap(heightmap);
      this.clickMove.setWorldRoot(root);  // no-op but kept for future mesh targets

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
    } catch (err) {
      console.error('[App] Zone asset load failed:', err);
    }
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
