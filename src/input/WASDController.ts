import type { OrbitCamera }    from '@/camera/OrbitCamera';
import type { SocketClient }   from '@/network/SocketClient';
import type { PlayerState }    from '@/state/PlayerState';
import type { PlayerEntity }   from '@/entities/PlayerEntity';

/**
 * WASDController — keyboard movement + camera rotation.
 *
 * W / S   — move forward / backward (relative to camera heading)
 * A / D   — strafe left / right     (relative to camera heading)
 * Q / E   — rotate camera left / right
 *
 * Movement uses **continuous** server commands: the first press sends a
 * heading + speed to start the server moving; subsequent updates at ~10 Hz
 * act as heading changes + heartbeats.  The server keeps walking until it
 * receives an explicit stop or the heartbeat times out (~300 ms).
 *
 * The client runs parallel prediction by calling PlayerEntity.drivePosition()
 * directly each frame.  When keys are released, stopWASD() is called and the
 * entity smoothly reconciles to the server position.
 *
 * Camera rotation runs every frame (dt-scaled) for fluid response.
 */

const QE_SPEED         = 1.8;   // camera yaw speed, radians / second
const PITCH_SPEED      = 50;    // camera pitch speed, degrees / second
const ZOOM_SPEED       = 30;    // camera zoom speed, units / second
const FALLBACK_SPEED_MPS = 17.5; // conservative default: 5 m/s base x 3.5 run multiplier
const HEADING_RESEND   = 3;     // degrees — resend heading if direction changed more than this
const SEND_INTERVAL_MS = 100;   // min gap between heading sends (10 Hz)

export class WASDController {
  private held              = new Set<string>();
  private lastSendAt        = 0;
  private lastSentHeading   = -999; // impossible heading -> forces first send
  private isMoving          = false;

  /** Client-predicted local position while movement keys are held. */
  private _localX: number | null = null;
  private _localY: number | null = null;
  private _localZ: number | null = null;

  /** Direct reference to the player entity for driving position. */
  private _playerEntity: PlayerEntity | null = null;

  private inventoryToggle:      (() => void) | null = null;
  private abilityToggle:        (() => void) | null = null;
  private characterSheetToggle: (() => void) | null = null;
  private partyToggle:          (() => void) | null = null;
  private abilitySlotCallback:  ((slotIndex: number) => void) | null = null;
  private marketToggle:         (() => void) | null = null;
  private worldMapToggle:       (() => void) | null = null;
  private guildToggle:          (() => void) | null = null;
  private companionToggle:      (() => void) | null = null;
  private buildToggle:              (() => void) | null = null;
  private settingsToggle:           (() => void) | null = null;
  private tabTargetNext:            (() => void) | null = null;
  private tabTargetPrev:            (() => void) | null = null;
  private partyTargetSlotCallback:  ((slot: number) => void) | null = null;
  private partyTargetNext:          (() => void) | null = null;
  private partyTargetPrev:          (() => void) | null = null;
  private layoutEditToggle:         (() => void) | null = null;
  private layoutEditActive:         (() => boolean) | null = null;

  setInventoryToggle(fn: () => void):      void { this.inventoryToggle      = fn; }
  setAbilityToggle(fn: () => void):        void { this.abilityToggle        = fn; }
  setCharacterSheetToggle(fn: () => void): void { this.characterSheetToggle = fn; }
  setPartyToggle(fn: () => void):          void { this.partyToggle          = fn; }
  setAbilitySlotCallback(fn: (slotIndex: number) => void): void { this.abilitySlotCallback = fn; }
  setMarketToggle(fn: () => void):         void { this.marketToggle         = fn; }
  setWorldMapToggle(fn: () => void):       void { this.worldMapToggle       = fn; }
  setGuildToggle(fn: () => void):          void { this.guildToggle          = fn; }
  setCompanionToggle(fn: () => void):    void { this.companionToggle      = fn; }
  setBuildToggle(fn: () => void):       void { this.buildToggle          = fn; }
  setSettingsToggle(fn: () => void):   void { this.settingsToggle       = fn; }
  setTabTargetNext(fn: () => void):        void { this.tabTargetNext        = fn; }
  setTabTargetPrev(fn: () => void):        void { this.tabTargetPrev        = fn; }
  setPartyTargetSlotCallback(fn: (slot: number) => void): void { this.partyTargetSlotCallback = fn; }
  setPartyTargetNext(fn: () => void):      void { this.partyTargetNext      = fn; }
  setPartyTargetPrev(fn: () => void):      void { this.partyTargetPrev      = fn; }
  setLayoutEditToggle(fn: () => void):     void { this.layoutEditToggle     = fn; }
  setLayoutEditActive(fn: () => boolean):  void { this.layoutEditActive     = fn; }

  /** Wire the player entity after EntityFactory creates it. */
  setPlayerEntity(pe: PlayerEntity | null): void { this._playerEntity = pe; }

  constructor(
    private readonly camera: OrbitCamera,
    private readonly socket: SocketClient,
    private readonly player: PlayerState,
  ) {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  // ── Called once per frame from App._loop ───────────────────────────────────

  tick(dt: number): void {
    // Suppress all movement / camera input while layout edit mode is active.
    if (this.layoutEditActive?.()) return;

    // Q / E — smooth camera yaw (every frame, dt-scaled)
    if (this.held.has('q')) this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('e')) this.camera.addYaw(-QE_SPEED * dt);

    // Arrow keys — camera yaw + pitch
    if (this.held.has('arrowleft'))  this.camera.addYaw(+QE_SPEED * dt);
    if (this.held.has('arrowright')) this.camera.addYaw(-QE_SPEED * dt);
    if (this.held.has('arrowup'))   this.camera.addPitch(+PITCH_SPEED * dt);
    if (this.held.has('arrowdown')) this.camera.addPitch(-PITCH_SPEED * dt);

    // +/- — keyboard zoom
    if (this.held.has('=') || this.held.has('+')) this.camera.addZoom(+ZOOM_SPEED * dt);
    if (this.held.has('-'))                       this.camera.addZoom(-ZOOM_SPEED * dt);

    // Gate on isAlive / isRooted — stop movement if dead or movement-impaired
    if (!this.player.isAlive || this.player.isRooted) {
      if (this.isMoving) {
        this.socket.sendMoveStop();
        this.isMoving = false;
        this.lastSentHeading = -999;
      }
      if (this._localX !== null) {
        this._localX = this._localY = this._localZ = null;
        this._playerEntity?.stopWASD();
      }
      return;
    }

    // Build a [-1..1] input vector from held keys
    const inputX = (this.held.has('d') ? 1 : 0) - (this.held.has('a') ? 1 : 0);
    const inputZ = (this.held.has('w') ? 1 : 0) - (this.held.has('s') ? 1 : 0);

    if (inputX === 0 && inputZ === 0) {
      // No movement keys — stop server movement and clear prediction
      if (this.isMoving) {
        this.socket.sendMoveStop();
        this.isMoving = false;
        this.lastSentHeading = -999;
      }
      if (this._localX !== null) {
        this._localX = this._localY = this._localZ = null;
        this._playerEntity?.stopWASD();
      }
      return;
    }

    // Cancel any active click-move when WASD starts
    this._playerEntity?.stopClickMove();

    // Rotate input by camera yaw -> world-space XZ direction.
    const yaw    = this.camera.getYaw();
    const worldX =  inputX * Math.cos(yaw) - inputZ * Math.sin(yaw);
    const worldZ = -inputX * Math.sin(yaw) - inputZ * Math.cos(yaw);

    const len = Math.hypot(worldX, worldZ);
    if (len === 0) return;

    const normX = worldX / len;
    const normZ = worldZ / len;

    // ── Client-side prediction ───────────────────────────────────────────────
    // Seed from entity position on the first frame of each movement burst.
    if (this._localX === null && this._playerEntity) {
      const p = this._playerEntity.object3d.position;
      this._localX = p.x;
      this._localY = p.y;
      this._localZ = p.z;
    }

    if (this._localX !== null && this._localY !== null && this._localZ !== null) {
      // Advance local position at the server's actual speed this frame.
      const speedMPS = this.player.movementSpeedMPS || FALLBACK_SPEED_MPS;
      this._localX += normX * speedMPS * dt;
      this._localZ += normZ * speedMPS * dt;
      // Y tracks server for terrain height
      this._localY = this.player.position.y;

      // Drive the entity directly — no intermediary
      this._playerEntity?.drivePosition(this._localX, this._localY, this._localZ);
    }

    // ── Continuous server send ──────────────────────────────────────────────────
    // Convert world direction to heading (degrees).  Server convention:
    //   heading 0 = +Z (south), increases clockwise -> atan2(X, Z).
    let headingDeg = Math.atan2(normX, normZ) * (180 / Math.PI);
    if (headingDeg < 0) headingDeg += 360;

    const now = Date.now();
    const headingDelta = Math.abs(headingDeg - this.lastSentHeading);
    // Wrap-around-safe delta (e.g. 359 -> 1 = 2, not 358)
    const wrappedDelta = Math.min(headingDelta, 360 - headingDelta);

    // Send immediately on start, on heading change, or every 100 ms as heartbeat
    const shouldSend = !this.isMoving
      || wrappedDelta > HEADING_RESEND
      || now - this.lastSendAt >= SEND_INTERVAL_MS;

    if (shouldSend) {
      this.socket.sendMoveContinuous(headingDeg, 'run');
      this.lastSentHeading = headingDeg;
      this.lastSendAt = now;
      this.isMoving = true;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this.held.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent): void => {
    // Don't steal keys from text inputs / chat
    if (this._isTyping(e.target)) return;

    // Prevent browser scrolling for arrow keys and +/-
    const key = e.key.toLowerCase();
    if (key.startsWith('arrow') || key === '=' || key === '+' || key === '-') {
      e.preventDefault();
    }

    // F10 — toggle layout editor
    if (key === 'f10') {
      e.preventDefault();
      this.layoutEditToggle?.();
      return;
    }

    // While layout edit is active, swallow all other game keys
    if (this.layoutEditActive?.()) return;

    // Tab / Shift+Tab — cycle targets
    if (key === 'tab') {
      e.preventDefault();
      if (e.shiftKey) this.tabTargetPrev?.();
      else            this.tabTargetNext?.();
      return;
    }

    // F1-F8 — target party member by slot
    if (key.startsWith('f') && key.length <= 2) {
      const fNum = parseInt(key.slice(1), 10);
      if (fNum >= 1 && fNum <= 8) {
        e.preventDefault();
        this.partyTargetSlotCallback?.(fNum - 1);
        return;
      }
    }

    // Ctrl+ArrowUp / Ctrl+ArrowDown — cycle party targets
    if (e.ctrlKey && (key === 'arrowup' || key === 'arrowdown')) {
      e.preventDefault();
      if (key === 'arrowup') this.partyTargetPrev?.();
      else                   this.partyTargetNext?.();
      return;
    }

    // H — respawn when dead
    if (e.key.toLowerCase() === 'h' && !this.player.isAlive) {
      this.socket.sendRespawn();
      return;
    }

    // I — toggle inventory
    if (e.key.toLowerCase() === 'i') {
      this.inventoryToggle?.();
      return;
    }

    // K — toggle ability tree
    if (e.key.toLowerCase() === 'k') {
      this.abilityToggle?.();
      return;
    }

    // C — toggle character sheet
    if (e.key.toLowerCase() === 'c') {
      this.characterSheetToggle?.();
      return;
    }

    // P — toggle party window
    if (e.key.toLowerCase() === 'p') {
      this.partyToggle?.();
      return;
    }

    // L — toggle target lock-on
    if (e.key.toLowerCase() === 'l') {
      this.player.toggleTargetLock();
      return;
    }

    // F — set focus target (current target → focus)
    if (e.key.toLowerCase() === 'f') {
      this.player.focusCurrentTarget();
      return;
    }

    // G — toggle guild panel
    if (e.key.toLowerCase() === 'g') {
      this.guildToggle?.();
      return;
    }

    // N — toggle companion panel
    if (e.key.toLowerCase() === 'n') {
      this.companionToggle?.();
      return;
    }

    // B — toggle build panel (village owner only — checked in app.ts callback)
    if (e.key.toLowerCase() === 'b') {
      this.buildToggle?.();
      return;
    }

    // Ctrl+M — toggle market panel
    if (e.ctrlKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      this.marketToggle?.();
      return;
    }

    // M — toggle world map (plain M without Ctrl)
    if (e.key.toLowerCase() === 'm' && !e.ctrlKey) {
      this.worldMapToggle?.();
      return;
    }

    // O — toggle settings window
    if (e.key.toLowerCase() === 'o') {
      this.settingsToggle?.();
      return;
    }

    // 1-8 — action bar ability slots
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 8) {
      this.abilitySlotCallback?.(num - 1);
      return;
    }

    this.held.add(e.key.toLowerCase());
  };

  private _onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.key.toLowerCase());
  };

  private _isTyping(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return (
      el instanceof HTMLInputElement    ||
      el instanceof HTMLTextAreaElement ||
      el.isContentEditable
    );
  }
}
