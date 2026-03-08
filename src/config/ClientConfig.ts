/**
 * Client configuration — edit or override via environment variables.
 * Vite exposes VITE_* env vars as import.meta.env.VITE_*.
 */

const SERVER_STORAGE_KEY = 'aa_server_url';
const DEFAULT_SERVER = 'http://localhost:3100';

/**
 * Fallback servers to try when the primary is unreachable.
 * Tried in order after the primary exhausts its retries.
 */
const FALLBACK_SERVERS = [
  'http://fusoya.servegame.com:3100',
];

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

  /** Camera orbit elevation in degrees (initial). */
  cameraElevation: 58,

  /** Min/max elevation (pitch) in degrees. */
  cameraMinElevation: 15,
  cameraMaxElevation: 85,

  /** Initial camera distance from player. */
  cameraDistance: 22,

  /** Min/max zoom distance. */
  cameraMinDistance: 8,
  cameraMaxDistance: 500,

  /** How fast yaw drag rotates (radians per pixel). Adjustable via Settings. */
  get cameraYawSensitivity(): number { return _cameraYawSensitivity; },
  set cameraYawSensitivity(v: number) { _cameraYawSensitivity = v; },

  /** How fast pitch drag rotates (degrees per pixel). Adjustable via Settings. */
  get cameraPitchSensitivity(): number { return _cameraPitchSensitivity; },
  set cameraPitchSensitivity(v: number) { _cameraPitchSensitivity = v; },

  /** Movement interpolation: snap if server/client delta exceeds this (world units). */
  movementSnapThreshold: 4,

  /** How much history to keep in the chat panel. */
  chatMaxLines: 200,

  /** Draw distance for entities (metres). Adjustable via Settings. */
  get drawDistance(): number { return _drawDistance; },
  set drawDistance(v: number) { _drawDistance = v; },
};
