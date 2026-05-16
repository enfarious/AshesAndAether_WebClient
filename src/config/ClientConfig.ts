/**
 * Client configuration — edit or override via environment variables.
 * Vite exposes VITE_* env vars as import.meta.env.VITE_*.
 */

const SERVER_STORAGE_KEY = 'aa_server_url';
const DEFAULT_SERVER = 'http://localhost:5000';

/**
 * Fallback servers to try when the primary is unreachable.
 * Tried in order after the primary exhausts its retries.
 *
 * Empty for now — the old `fusoya.servegame.com:3100` entry was stale and
 * caused clients to silently connect to the wrong host when the LAN target
 * was unreachable.  Add real production fallbacks here when they exist.
 */
const FALLBACK_SERVERS: string[] = [];

function _loadServerUrl(): string {
  // 1. localStorage (user chose a server in the login screen)
  const saved = localStorage.getItem(SERVER_STORAGE_KEY);
  if (saved) return saved;
  // 2. VITE_SERVER_URL env var (build-time override)
  const env = (import.meta as unknown as Record<string, Record<string, string>>)
    ['env']?.['VITE_SERVER_URL'];
  if (env) return env;
  // 3. Default
  return DEFAULT_SERVER;
}

/** Mutable server URL — updated via login screen server field. */
let _serverUrl = _loadServerUrl();

/** Mutable settings — adjusted via Settings window, persisted to localStorage. */
let _drawDistance = 200;
let _cameraYawSensitivity = 0.005;
let _cameraPitchSensitivity = 0.15;
let _treeVisibleRange     = 1000;
/** Harvest glints — gameplay markers; sharper/closer than landscape stuff so
 *  they read as "in this area." Tuned smaller than entity draw distance
 *  because glints are visually noisy (additive blend, tier color). */
let _harvestGlintRange    = 150;
/** Rock outcrops — landscape decoration, mid-range. Smaller than trees
 *  because rocks are individual InstancedMesh entries with per-frame matrix
 *  cost when culling is on, while trees pre-bake. */
let _rockVisibleRange     = 500;

export type BeaconDetail = 'low' | 'med' | 'high';
let _beaconDetail: BeaconDetail = 'med';

/** Subdivision counts for beacon aura discs/domes per detail tier.
 *  Higher tiers conform to terrain more tightly at the cost of vertex
 *  count (a single guild bubble at 'high' is ~768 verts; trivial). */
export interface BeaconSubdivisions { radial: number; rings: number }
const BEACON_DETAIL_TABLE: Record<BeaconDetail, BeaconSubdivisions> = {
  low:  { radial: 16, rings: 6  },
  med:  { radial: 32, rings: 12 },
  high: { radial: 48, rings: 16 },
};

export type MiasmaQuality = 'off' | 'low' | 'med' | 'high' | 'ultra';
let _miasmaQuality: MiasmaQuality = 'med';

/** Per-axis subdivision count of the MiasmaGroundFog plane. Total verts
 *  = (n+1)². 'off' disables the plane entirely. Higher tiers conform to
 *  terrain ridges more tightly at distance; 'med' is the visual sweet
 *  spot for typical play. */
const MIASMA_SUBDIV_TABLE: Record<MiasmaQuality, number> = {
  off:   0,
  low:   64,
  med:   128,
  high:  192,
  ultra: 256,
};

export type MiasmaRange = 'short' | 'med' | 'long' | 'far' | 'ultra';
let _miasmaRange: MiasmaRange = 'long';

// ── Nameplates ──────────────────────────────────────────────────────────────

/** Self-plate verbosity. 'off' hides the local player's plate; 'name' shows
 *  just the name; 'name_hp' adds an HP bar; 'full' adds buffs (future). */
export type SelfPlateMode = 'off' | 'name' | 'name_hp' | 'full';
let _nameplateSelfMode:     SelfPlateMode = 'name';
let _nameplateShowMobs:     boolean = true;
let _nameplateShowNpcs:     boolean = true;
let _nameplateShowPlayers:  boolean = true;
let _nameplateShowGuildTag: boolean = true;
let _nameplateTargetShowHp: boolean = true;
let _nameplateTargetShowCast: boolean = false;
let _nameplateMaxRange:     number  = 60;     // metres — beyond, plates hide
let _nameplateFadeStart:    number  = 35;     // metres — opacity drop begins
let _nameplateMaxCount:     number  = 30;     // hard cap on concurrent plates
let _nameplateScale:        number  = 1.0;    // size multiplier for fonts + HP bar

/** When true, picking Attack on a target also locks it (so subsequent
 *  d-pad cycling doesn't accidentally drop the engagement). User-toggleable
 *  in Settings → Controls. */
let _attackAutoLock:        boolean = true;

/** When true, the server rotates the player to face the target on Attack
 *  engage and on each cast start. Off = manual facing only — pulls aggro
 *  cleanly but you have to aim yourself. User-toggleable in Settings → Controls. */
let _autoFaceOnAction:      boolean = true;

/** When true, the gamepad sprint binding latches: press once to start,
 *  again to stop. Auto-clears on movement stop or stamina depletion. Off =
 *  hold-to-sprint (matches the keyboard Shift convention). */
let _sprintToggleMode:      boolean = false;

/** Stick magnitude below which input is treated as "no movement." Different
 *  controllers have different mechanical play after the stick is released
 *  (worn-out Xbox sticks drift more, fresh PS controllers very little).
 *  Tuned per-user via Settings → Gamepad. Range 0.05 (very sensitive) to
 *  0.40 (heavy deadzone for drifting controllers). Default 0.15 matches
 *  the pre-slider hardcoded value. */
let _gamepadDeadzone:       number  = 0.15;

/** Lock-on movement style — when on and the player has a locked target:
 *  W/forward approaches (capped at 1.5m), S/back retreats, A/D strafe
 *  pure left/right perpendicular to target. Body always faces the locked
 *  target. Dash still resolves from the input direction. Off = classic
 *  free-move where heading tracks input. */
let _lockOnMovement:        boolean = false;

/** Lock-on camera — when on (and target locked), the camera smoothly
 *  yaws to keep the locked target ahead. Implies orbit-style A/D feel
 *  because camera-relative input becomes target-relative. */
let _lockOnCamera:          boolean = false;

/** Plane size in metres — controls how far the fog extends around the
 *  player. Combined with subdivisions, determines vertex spacing
 *  (planeSize / subdivisions). 'long' (1000m) is the default. */
const MIASMA_RANGE_TABLE: Record<MiasmaRange, number> = {
  short: 250,
  med:   500,
  long:  1000,
  far:   2000,
  ultra: 4000,
};

export const ClientConfig = {
  get serverUrl(): string { return _serverUrl; },

  setServerUrl(url: string): void {
    // Normalise: add http:// if bare host:port
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    _serverUrl = url;
    localStorage.setItem(SERVER_STORAGE_KEY, url);
  },

  /**
   * Return the next fallback server URL to try, or null if exhausted.
   * Each call advances the internal index so callers cycle through the list.
   */
  getNextFallback(): string | null {
    const current = _serverUrl;
    // Build the full candidate list: default first, then fallbacks
    const all = [DEFAULT_SERVER, ...FALLBACK_SERVERS];
    // Find a candidate we haven't already tried (skip the one we're currently on)
    for (const candidate of all) {
      if (candidate !== current) return candidate;
    }
    return null;
  },

  protocolVersion: '1.0.0',
  clientVersion:   '0.1.0',
  clientType:      '3d' as const,

  /** Target server updates per second. */
  maxUpdateRate: 20,

  /** Camera orbit elevation in degrees (initial). Lower = more 3rd-person
   *  over-shoulder, higher = more top-down. 30° gives a recognizable
   *  3rd-person action-RPG feel without obscuring the world ahead. */
  cameraElevation: 30,

  /** Min/max elevation (pitch) in degrees. */
  // Lower min so the camera can sit nearly on the horizon — lets you look up
  // and see the sky, sun, moon, and storms.
  cameraMinElevation: 3,
  cameraMaxElevation: 85,

  /** Initial camera distance from player. */
  cameraDistance: 14,

  /** Min/max zoom distance. Max capped at 60 so the default range stays
   *  in playable-tactical territory; for screenshots/scenic shots use a
   *  future dedicated photo-mode rather than the live combat camera. */
  cameraMinDistance: 6,
  cameraMaxDistance: 60,

  /** How fast yaw drag rotates (radians per pixel). Adjustable via Settings. */
  get cameraYawSensitivity(): number { return _cameraYawSensitivity; },
  set cameraYawSensitivity(v: number) { _cameraYawSensitivity = v; },

  /** How fast pitch drag rotates (degrees per pixel). Adjustable via Settings. */
  get cameraPitchSensitivity(): number { return _cameraPitchSensitivity; },
  set cameraPitchSensitivity(v: number) { _cameraPitchSensitivity = v; },

  /** Movement interpolation: snap if server/client delta exceeds this (world units).
   *  Must cover the max per-tick displacement of the fastest entity at the slowest
   *  expected tick rate (fleeing deer: 14 m/s × 0.5 s/tick = 7 m). */
  movementSnapThreshold: 15,

  /** How much history to keep in the chat panel. */
  chatMaxLines: 200,

  /** Draw distance for entities (metres). Adjustable via Settings. */
  get drawDistance(): number { return _drawDistance; },
  set drawDistance(v: number) { _drawDistance = v; },

  /** Max distance (metres) at which plant entities (trees, shrubs) are rendered. */
  get treeVisibleRange(): number { return _treeVisibleRange; },
  set treeVisibleRange(v: number) { _treeVisibleRange = v; },

  /** Max distance (metres) at which harvest glints render. Per-category
   *  setting because glints are gameplay markers (closer = sharper signal),
   *  distinct from entity draw distance and landscape ranges. */
  get harvestGlintRange(): number { return _harvestGlintRange; },
  set harvestGlintRange(v: number) { _harvestGlintRange = v; },

  /** Max distance (metres) at which rock outcrops render. Mid-range —
   *  bigger than glints (rocks help orient in landscape) but smaller than
   *  trees (rocks have per-frame matrix update cost when culled). */
  get rockVisibleRange(): number { return _rockVisibleRange; },
  set rockVisibleRange(v: number) { _rockVisibleRange = v; },

  /** Beacon aura mesh quality — controls disc/dome subdivision count. */
  get beaconDetail(): BeaconDetail { return _beaconDetail; },
  set beaconDetail(v: BeaconDetail) { _beaconDetail = v; },

  /** Resolve current detail tier to subdivision counts. Renderers query
   *  this at construction time; existing aura meshes don't auto-rebuild
   *  on setting change — they reflect the value at their creation. */
  beaconSubdivisions(): BeaconSubdivisions { return BEACON_DETAIL_TABLE[_beaconDetail]; },

  /** Miasma ground-fog quality. 'off' = no fog plane. */
  get miasmaQuality(): MiasmaQuality { return _miasmaQuality; },
  set miasmaQuality(v: MiasmaQuality) { _miasmaQuality = v; },

  /** Per-axis subdivisions for the current miasma quality. 0 means the
   *  fog should not be constructed at all. */
  miasmaSubdivisions(): number { return MIASMA_SUBDIV_TABLE[_miasmaQuality]; },

  /** Miasma fog view distance preset. */
  get miasmaRange(): MiasmaRange { return _miasmaRange; },
  set miasmaRange(v: MiasmaRange) { _miasmaRange = v; },

  /** Plane size (metres) for the current view-distance preset. */
  miasmaPlaneSize(): number { return MIASMA_RANGE_TABLE[_miasmaRange]; },

  // ── Nameplates ─────────────────────────────────────────────────────────

  get nameplateSelfMode(): SelfPlateMode { return _nameplateSelfMode; },
  set nameplateSelfMode(v: SelfPlateMode) { _nameplateSelfMode = v; },

  get nameplateShowMobs(): boolean { return _nameplateShowMobs; },
  set nameplateShowMobs(v: boolean) { _nameplateShowMobs = v; },

  get nameplateShowNpcs(): boolean { return _nameplateShowNpcs; },
  set nameplateShowNpcs(v: boolean) { _nameplateShowNpcs = v; },

  get nameplateShowPlayers(): boolean { return _nameplateShowPlayers; },
  set nameplateShowPlayers(v: boolean) { _nameplateShowPlayers = v; },

  get nameplateShowGuildTag(): boolean { return _nameplateShowGuildTag; },
  set nameplateShowGuildTag(v: boolean) { _nameplateShowGuildTag = v; },

  get nameplateTargetShowHp(): boolean { return _nameplateTargetShowHp; },
  set nameplateTargetShowHp(v: boolean) { _nameplateTargetShowHp = v; },

  get attackAutoLock(): boolean { return _attackAutoLock; },
  set attackAutoLock(v: boolean) { _attackAutoLock = v; },

  get autoFaceOnAction(): boolean { return _autoFaceOnAction; },
  set autoFaceOnAction(v: boolean) { _autoFaceOnAction = v; },

  get sprintToggleMode(): boolean { return _sprintToggleMode; },
  set sprintToggleMode(v: boolean) { _sprintToggleMode = v; },

  get gamepadDeadzone(): number { return _gamepadDeadzone; },
  set gamepadDeadzone(v: number) { _gamepadDeadzone = v; },

  get lockOnMovement(): boolean { return _lockOnMovement; },
  set lockOnMovement(v: boolean) { _lockOnMovement = v; },

  get lockOnCamera(): boolean { return _lockOnCamera; },
  set lockOnCamera(v: boolean) { _lockOnCamera = v; },

  get nameplateTargetShowCast(): boolean { return _nameplateTargetShowCast; },
  set nameplateTargetShowCast(v: boolean) { _nameplateTargetShowCast = v; },

  /** Hard cull distance — entities beyond this distance have no plate. */
  get nameplateMaxRange(): number { return _nameplateMaxRange; },
  set nameplateMaxRange(v: number) { _nameplateMaxRange = v; },

  /** Distance at which plate opacity starts dropping toward zero at
   *  `nameplateMaxRange`. Always ≤ nameplateMaxRange. */
  get nameplateFadeStart(): number { return _nameplateFadeStart; },
  set nameplateFadeStart(v: number) { _nameplateFadeStart = v; },

  /** Max concurrent plates rendered (sorted by distance, tail hidden). */
  get nameplateMaxCount(): number { return _nameplateMaxCount; },
  set nameplateMaxCount(v: number) { _nameplateMaxCount = v; },

  /** Plate size multiplier — scales name, tag, con arrows, and HP bar
   *  uniformly via a CSS variable. 1.0 = default; 0.7 = compact;
   *  1.8 = readable from across the room. */
  get nameplateScale(): number { return _nameplateScale; },
  set nameplateScale(v: number) { _nameplateScale = v; },
};
