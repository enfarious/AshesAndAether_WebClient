/**
 * Client configuration — edit or override via environment variables.
 * Vite exposes VITE_* env vars as import.meta.env.VITE_*.
 */
export const ClientConfig = {
  serverUrl: (import.meta as unknown as Record<string, Record<string, string>>)
    ['env']?.['VITE_SERVER_URL'] ?? 'http://localhost:3100',

  protocolVersion: '1.0.0',
  clientVersion:   '0.1.0',
  clientType:      '3d' as const,

  /** Target server updates per second. */
  maxUpdateRate: 20,

  /** Camera orbit elevation in degrees (fixed). */
  cameraElevation: 58,

  /** Initial camera distance from player. */
  cameraDistance: 22,

  /** Min/max zoom distance. */
  cameraMinDistance: 8,
  cameraMaxDistance: 500,

  /** How fast yaw drag rotates (radians per pixel). */
  cameraYawSensitivity: 0.005,

  /** Movement interpolation: snap if server/client delta exceeds this (world units). */
  movementSnapThreshold: 4,

  /** How much history to keep in the chat panel. */
  chatMaxLines: 200,
} as const;
