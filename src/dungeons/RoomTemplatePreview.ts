import * as THREE from 'three';
import type { SocketClient } from '@/network/SocketClient';
import type { OrbitCamera }  from '@/camera/OrbitCamera';

// Loose wire format — mirrors RoomTemplate on the server. Duplicated here
// because the web client lives in a separate repo from @ashes/zone-server.
// If this drifts, the preview just renders weirdly — no runtime contract.
interface WireAnchor {
  position: { x: number; y: number; z: number };
  heading?: number;
}
interface WireExit extends WireAnchor {
  id:        string;
  direction: 'N' | 'S' | 'E' | 'W';
}
interface WireTemplate {
  id:             string;
  footprint:      { sizeX: number; sizeZ: number };
  wallHeight?:    number;
  exits:          WireExit[];
  spawnAnchors:   WireAnchor[];
  hazardAnchors?: WireAnchor[];
  /** Which kind of environmental hazard the anchors represent (Phase 4).
   *  Drives the per-anchor visual switch in _buildRoom. Undefined for
   *  templates with no hazards. The swelling pulse warning for
   *  'pulsing_walls' rides the existing telegraph channel — only the
   *  static emitter glow is drawn here. */
  hazardKind?:    'spore' | 'aether_water' | 'pulsing_walls';
}
interface RoomPlacement {
  template: WireTemplate;
  origin:   { x: number; y: number; z: number };
  /** Per-exit doorway dimensions, keyed by exit id. An exit with an
   *  attached connector carries `{width, height}` (the connector's own
   *  width/height); an exit with no connector is ABSENT from the map
   *  (e.g. the admin single-room `/preview-room` path sends no
   *  connectors). The server already resolved which connector attaches
   *  to which exit — the renderer just consumes this map, falling back
   *  to DOORWAY_WIDTH/DOORWAY_HEIGHT for any absent exit. */
  exitDoorDims?: Record<string, { width: number; height: number }>;
}
/** A single polyline vertex — mirrors the server `Waypoint` type. Each
 *  point carries its own Y so a ramp/stair connector's polyline has
 *  differing Y between endpoints. */
interface WireWaypoint {
  x: number; y: number; z: number;
}
/** A placed connector — parametric polyline geometry bridging two rooms.
 *  Mirrors the server `ConnectorPlacement`. `polyline` is the FULL
 *  world-space path: `[fromExitWorld, ...intermediateWaypoints, toExitWorld]`
 *  and is always ≥2 points. The renderer builds geometry generically from
 *  these points — it does NOT assume axis-aligned segments (only the V0
 *  *server* restricts bends to 90°; see _computeConnectorWallRects). */
interface WireConnector {
  edgeId:   string;
  style:    'corridor' | 'ramp' | 'stair' | 'elevator';
  width:    number;
  /** Per-connector floor-to-ceiling height. Drives the connector tube's
   *  wall + ceiling height (was a fixed module constant). */
  height:   number;
  polyline: WireWaypoint[];
}
/** World-space axis-aligned rect — matches the server WallRect shape. */
interface WireRect {
  minX: number; minZ: number; maxX: number; maxZ: number;
}
/** A still-closed deep-dungeon boss-door gate, as the server sends it in
 *  the `preview_room` payload (Phase 3). */
interface WireGate {
  gateId: string;
  rect:   WireRect;
  /** The gated connector's floor-to-ceiling height — sizes the gate slab
   *  so it fills the actual doorway opening. */
  height: number;
  closed: true;
}
interface PreviewPayload {
  // Single-room form (admin /preview-room <id>)
  template?:   WireTemplate;
  origin?:     { x: number; y: number; z: number };
  // Multi-room form (admin /preview-floor <dungeon> <floor>)
  placements?: RoomPlacement[];
  // First-class connector polylines bridging the rooms. Present on every
  // dungeon/floor render; ABSENT on the single-room admin /preview-room
  // render (no graph edge exists there) — handle undefined/empty.
  connectors?: WireConnector[];
  // Deep-dungeon boss-door gates still closed at render time (Phase 3).
  gates?:      WireGate[];
  // Tear-down
  clear?:      boolean;
}
/** `dungeon_gate` server event — a boss door has opened. */
interface DungeonGatePayload {
  gateId: string;
  state:  'open';
}

const WALL_THICK     = 0.4;
const DOORWAY_WIDTH  = 4.0;
/** Cap doorway cutouts at this height; everything above becomes a solid
 *  lintel. Sized to clear a 3rd-person camera at ~15m distance + default
 *  pitch — at 5m the camera was clipping doorway lintels mid-walk. */
const DOORWAY_HEIGHT = 8.0;
/** Mirrors server CollisionSystem PLAYER_RADIUS — server expands wall
 *  rects by this when populating the wall-slide grid, so the client must
 *  inflate its own collision rects by the same amount or WASD prediction
 *  will leak past where the server blocks (and snap-back when it catches
 *  up). */
const PLAYER_RADIUS  = 0.5;
/** Stair step run-length (metres) — a stepped connector climbs its Y delta
 *  in steps of roughly this depth. Cosmetic only; collision + sampleFloorY
 *  treat a stair like a ramp (linear Y), matching the server. */
const STAIR_STEP_RUN = 0.45;
/** AXIS_EPSILON — a polyline segment counts as axis-aligned when one of
 *  |Δx| / |Δz| is within this of zero. Mirrors server Stitcher.AXIS_EPSILON.
 *  Used ONLY by the collision mirror (_computeConnectorWallRects /
 *  _computeConnectorFloorRegions) — the renderer is axis-agnostic. */
const AXIS_EPSILON   = 1e-3;

interface CollisionRect {
  minX: number; minZ: number; maxX: number; maxZ: number;
}

/**
 * A walkable floor region with a Y range — mirrors the server `FloorRegion`.
 * A flat room region has `y0 === y1` (`axis: 'flat'`); a sloped connector
 * segment carries `y0` at the `axis`-min edge and `y1` at the `axis`-max
 * edge so `sampleFloorY` can lerp Y along the run. Drives WASD-prediction
 * Y so walking a ramp stays smooth instead of stair-stepping on server
 * corrections.
 */
interface FloorRegion {
  minX: number; minZ: number; maxX: number; maxZ: number;
  y0: number; y1: number; axis: 'x' | 'z' | 'flat';
  /** Absolute world ceiling Y over this region — drives the camera's upper
   *  clamp. Flat per region (a sloped connector stores its lowest ceiling). */
  ceilingY: number;
}

/**
 * Renders placeholder visualizations of one or more room templates at
 * world positions. Walls have doorway cutouts at exit positions so you
 * can actually walk through. Floor + ceiling close the box. Spawn
 * anchors render as red spheres, hazards as orange.
 *
 * Driven by the `preview_room` server event — single room (admin
 * /preview-room) or full floor (admin /preview-floor) come through the
 * same channel, distinguished by payload shape.
 */
export class RoomTemplatePreview {
  private group: THREE.Group | null = null;
  /** Halo-inflated wall rects in world space. Used by resolveMovement to
   *  clamp WASD prediction so the player doesn't ghost through walls
   *  before the server-side resolveMovement snaps them back. Both room
   *  walls AND connector side-walls land here. */
  private collisionRects: CollisionRect[] = [];

  /** Walkable floor regions — one flat region per room, one (possibly
   *  sloped) region per connector polyline segment. Consulted by
   *  `sampleFloorY` to keep WASD-predicted Y smooth on ramps/stairs.
   *  Mirrors the server CollisionSystem.floorRegions list. */
  private floorRegions: FloorRegion[] = [];

  /** Boss-door gate slab meshes, keyed by gateId — removed when the
   *  `dungeon_gate` event reports the gate has opened. */
  private readonly gateMeshes = new Map<string, THREE.Mesh>();
  /** Gate collision rects, keyed by gateId — paired 1:1 with gateMeshes.
   *  Spliced out of `collisionRects` when the gate opens so WASD
   *  prediction stops blocking at the (now open) doorway. */
  private readonly gateCollisionRects = new Map<string, CollisionRect>();

  constructor(
    private readonly scene:  THREE.Scene,
    private readonly socket: SocketClient,
    private readonly camera: OrbitCamera,
  ) {
    // A boss door has opened — drop its slab + collision rect.
    this.socket.on('dungeon_gate', (payload: unknown) => {
      const p = payload as DungeonGatePayload;
      if (!p || typeof p.gateId !== 'string' || p.state !== 'open') return;
      this._openGate(p.gateId);
    });

    this.socket.on('preview_room', (payload: unknown) => {
      const p = payload as PreviewPayload;
      if (p.clear) {
        this.clear();
        return;
      }
      const placements: RoomPlacement[] = p.placements
        ?? (p.template && p.origin ? [{ template: p.template, origin: p.origin }] : []);
      if (placements.length === 0) {
        this.clear();
        return;
      }
      this.clear();
      this.group = new THREE.Group();
      this.group.name = 'room_preview';
      for (const placement of placements) {
        const roomGroup = this._buildRoom(placement);
        // RoomPlacement.origin.y is now a real, varying value (terraced
        // dungeons) — the sub-group is positioned at the full origin so
        // the room sits at its placement elevation.
        roomGroup.position.set(placement.origin.x, placement.origin.y, placement.origin.z);
        this.group.add(roomGroup);
        // Compute world-space, halo-inflated collision rects for this room.
        for (const rect of this._computeWallRects(placement)) {
          this.collisionRects.push(rect);
        }
        // Flat walkable floor region for this room (footprint AABB at
        // origin.y) — feeds sampleFloorY for smooth WASD-predicted Y.
        this.floorRegions.push(this._computeRoomFloorRegion(placement));
      }
      // First-class connectors — parametric polyline geometry bridging the
      // rooms. Absent on the single-room admin render; the `?? []` makes
      // that path a no-op.
      for (const connector of p.connectors ?? []) {
        const connGroup = this._buildConnector(connector);
        this.group.add(connGroup);
        // Connector side-wall collision rects (mirrors server geometry).
        for (const rect of this._computeConnectorWallRects(connector)) {
          this.collisionRects.push(rect);
        }
        // Connector floor regions — one (possibly sloped) per polyline
        // segment — so sampleFloorY can lerp Y along a ramp/stair.
        for (const region of this._computeConnectorFloorRegions(connector)) {
          this.floorRegions.push(region);
        }
      }
      // Boss-door gate slabs (Phase 3). Each closed gate gets a dark slab
      // filling its doorway rect, plus a matching collision rect so WASD
      // prediction stops at it (mirrors the server's gate block). Tracked
      // by gateId so the `dungeon_gate` event can drop a single gate.
      for (const gate of p.gates ?? []) {
        const slab = this._buildGateSlab(gate.rect, gate.height);
        this.gateMeshes.set(gate.gateId, slab);
        this.group.add(slab);
        const rect: CollisionRect = {
          minX: gate.rect.minX - PLAYER_RADIUS,
          minZ: gate.rect.minZ - PLAYER_RADIUS,
          maxX: gate.rect.maxX + PLAYER_RADIUS,
          maxZ: gate.rect.maxZ + PLAYER_RADIUS,
        };
        this.gateCollisionRects.set(gate.gateId, rect);
        this.collisionRects.push(rect);
      }

      this.scene.add(this.group);
      // Register every sub-group as a camera-collision target so the
      // spring-arm doesn't clip through walls/ceilings. This covers room
      // sub-groups, connector sub-groups, AND gate slabs — connector
      // groups were added above so they're in `children` here. Each
      // sub-group's world transform is final (positions set + scene.add
      // already done), which addCollisionTarget requires.
      for (const child of this.group.children) {
        this.camera.addCollisionTarget(child);
      }
    });
  }

  /**
   * Open a boss-door gate — drop its slab mesh + collision rect. Called by
   * the `dungeon_gate` socket handler. Idempotent: a no-op for a gateId
   * with no tracked slab (already open / never rendered here).
   */
  private _openGate(gateId: string): void {
    const slab = this.gateMeshes.get(gateId);
    if (slab) {
      slab.geometry?.dispose();
      const mat = slab.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
      slab.removeFromParent();
      this.gateMeshes.delete(gateId);
    }
    const rect = this.gateCollisionRects.get(gateId);
    if (rect) {
      const idx = this.collisionRects.indexOf(rect);
      if (idx !== -1) this.collisionRects.splice(idx, 1);
      this.gateCollisionRects.delete(gateId);
    }
  }

  /**
   * Build a dark slab mesh filling a closed gate's doorway rect. The rect
   * is the raw (un-haloed) server doorway rect — WALL_THICK deep, as wide
   * as the gated connector. `height` is the gated connector's
   * floor-to-ceiling height, so the slab fills the actual opening.
   */
  private _buildGateSlab(rect: WireRect, height: number): THREE.Mesh {
    const sizeX = Math.max(0.01, rect.maxX - rect.minX);
    const sizeZ = Math.max(0.01, rect.maxZ - rect.minZ);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x140f0c, roughness: 0.95, metalness: 0.05,
      emissive: 0x2a0d0d, emissiveIntensity: 0.35,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sizeX, height, sizeZ),
      mat,
    );
    mesh.position.set(
      (rect.minX + rect.maxX) / 2,
      height / 2,
      (rect.minZ + rect.maxZ) / 2,
    );
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.name = 'dungeon_gate_slab';
    return mesh;
  }

  /**
   * Axis-split wall-slide. Mirrors server CollisionSystem.resolveMovement
   * so WASD client prediction matches what the server will accept. Returns
   * the furthest unblocked position from (fromX,fromZ) toward (toX,toZ).
   */
  resolveMovement(fromX: number, fromZ: number, toX: number, toZ: number): { x: number; z: number } {
    if (this.collisionRects.length === 0)  return { x: toX, z: toZ };
    if (!this._isBlocked(toX, toZ))        return { x: toX,   z: toZ   };
    if (!this._isBlocked(toX, fromZ))      return { x: toX,   z: fromZ };
    if (!this._isBlocked(fromX, toZ))      return { x: fromX, z: toZ   };
    return { x: fromX, z: fromZ };
  }

  private _isBlocked(x: number, z: number): boolean {
    for (const r of this.collisionRects) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    }
    return false;
  }

  /**
   * Ground Y at a world (x,z), resolved against the registered floor
   * regions. Returns null when (x,z) is inside no region — the caller
   * keeps its last Y (e.g. mid-doorway between two regions for a frame).
   *
   * For a flat region Y is constant (`y0`). For a sloped region Y is
   * lerped by the fractional position along the run `axis`: 0 at the
   * axis-min edge (`y0`) → 1 at the axis-max edge (`y1`).
   *
   * Mirrors server CollisionSystem.sampleFloorY — WASD prediction calls
   * this so predicted Y stays smooth on ramps/stairs and consistent with
   * the server (which runs the identical lookup). Last-match-wins if
   * regions overlap; terraced rooms never overlap in plan so in practice
   * each (x,z) hits at most one region.
   */
  sampleFloorY(x: number, z: number): number | null {
    if (this.floorRegions.length === 0) return null;
    let result: number | null = null;
    for (const r of this.floorRegions) {
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      if (r.axis === 'flat' || r.y0 === r.y1) {
        result = r.y0;
      } else if (r.axis === 'x') {
        const span = r.maxX - r.minX;
        const t = span > 0 ? (x - r.minX) / span : 0;
        result = r.y0 + (r.y1 - r.y0) * t;
      } else {
        const span = r.maxZ - r.minZ;
        const t = span > 0 ? (z - r.minZ) / span : 0;
        result = r.y0 + (r.y1 - r.y0) * t;
      }
    }
    return result;
  }

  /**
   * Ceiling Y at a world (x,z) — the dungeon analogue of sampleFloorY for
   * the camera's upper clamp. Flat per region (a sloped connector stores its
   * lowest ceiling), so no lerp. Returns null outside every region.
   */
  sampleCeilingY(x: number, z: number): number | null {
    if (this.floorRegions.length === 0) return null;
    let result: number | null = null;
    for (const r of this.floorRegions) {
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      result = r.ceilingY;
    }
    return result;
  }

  clear(): void {
    // Drop ALL dungeon collision state — room walls, connector side-walls,
    // and floor regions. Stale connector collision leaking into the
    // overworld is the exact bug class this project has hit before, so the
    // teardown is deliberately exhaustive here.
    this.collisionRects = [];
    this.floorRegions   = [];
    // Gate slabs live under this.group — the traverse-dispose below frees
    // their geometry/material; just drop the tracking maps here.
    this.gateMeshes.clear();
    this.gateCollisionRects.clear();
    // Drops every transient camera-collision target registered for this
    // dungeon — room sub-groups AND connector sub-groups.
    this.camera.clearTransientCollisionTargets();
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        const mat = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    });
    this.group = null;
  }

  /**
   * World-space wall rects for one placement, halo-inflated by PLAYER_RADIUS
   * to match server's wall-slide grid expansion. Mirrors the segment math
   * in _buildWallSegments — if you change one, change the other.
   *
   * Server collision is 2D, so only the per-exit WIDTH matters here
   * (height is render-only). This and the server's computeRoomWallRects
   * are a true mirror pair: the per-exit width lookup MUST match or WASD
   * prediction diverges from server collision at varied-width doorways.
   */
  private _computeWallRects(placement: RoomPlacement): CollisionRect[] {
    const tmpl   = placement.template;
    const origin = placement.origin;
    const exitDoorDims = placement.exitDoorDims ?? {};
    const { sizeX, sizeZ } = tmpl.footprint;
    const rects: CollisionRect[] = [];

    for (const dir of ['N', 'S', 'E', 'W'] as const) {
      const wallExits    = tmpl.exits.filter((e) => e.direction === dir);
      const axis         = (dir === 'N' || dir === 'S') ? 'x' : 'z';
      const wallAxisSize = axis === 'x' ? sizeX : sizeZ;
      let crossPos: number;
      if      (dir === 'N') crossPos = -sizeZ / 2;
      else if (dir === 'S') crossPos =  sizeZ / 2;
      else if (dir === 'E') crossPos =  sizeX / 2;
      else                  crossPos = -sizeX / 2;

      // Per-exit cutout: axis position + per-exit width (fallback
      // DOORWAY_WIDTH for an exit with no attached connector).
      const cutouts = wallExits
        .map((e) => ({
          pos:   axis === 'x' ? e.position.x : e.position.z,
          width: exitDoorDims[e.id]?.width ?? DOORWAY_WIDTH,
        }))
        .sort((a, b) => a.pos - b.pos);

      const minA = -(wallAxisSize / 2 + WALL_THICK);
      const maxA =   wallAxisSize / 2 + WALL_THICK;

      let segStart = minA;
      const segments: Array<[number, number]> = [];
      for (const c of cutouts) {
        const segEnd = c.pos - c.width / 2;
        if (segEnd > segStart) segments.push([segStart, segEnd]);
        segStart = c.pos + c.width / 2;
      }
      if (maxA > segStart) segments.push([segStart, maxA]);

      for (const [s, e] of segments) {
        if (axis === 'x') {
          rects.push({
            minX: origin.x + s - PLAYER_RADIUS,
            maxX: origin.x + e + PLAYER_RADIUS,
            minZ: origin.z + crossPos - WALL_THICK / 2 - PLAYER_RADIUS,
            maxZ: origin.z + crossPos + WALL_THICK / 2 + PLAYER_RADIUS,
          });
        } else {
          rects.push({
            minX: origin.x + crossPos - WALL_THICK / 2 - PLAYER_RADIUS,
            maxX: origin.x + crossPos + WALL_THICK / 2 + PLAYER_RADIUS,
            minZ: origin.z + s - PLAYER_RADIUS,
            maxZ: origin.z + e + PLAYER_RADIUS,
          });
        }
      }
    }
    return rects;
  }

  /**
   * Flat walkable floor region for a room — its footprint AABB at the
   * room's placement Y. `y0 === y1` / `axis: 'flat'` (a room never slopes).
   * Mirrors server Stitcher.computeRoomFloorRegion.
   */
  private _computeRoomFloorRegion(placement: RoomPlacement): FloorRegion {
    const { sizeX, sizeZ } = placement.template.footprint;
    const { x, y, z } = placement.origin;
    return {
      minX: x - sizeX / 2,
      maxX: x + sizeX / 2,
      minZ: z - sizeZ / 2,
      maxZ: z + sizeZ / 2,
      y0: y,
      y1: y,
      axis: 'flat',
      ceilingY: y + (placement.template.wallHeight ?? 4),
    };
  }

  /**
   * Build the visual geometry for one connector — floor, two side walls,
   * and a ceiling, per polyline segment.
   *
   * The polyline is already FULL world-space, so all geometry is built in
   * world coordinates directly from the points — the returned group sits
   * at the scene origin (position 0,0,0). Geometry is built GENERICALLY
   * from consecutive point pairs: it does NOT special-case N/S/E/W and
   * will correctly draw a diagonal or curved connector if one ever
   * arrives (the V0 90°-bend limit lives only in the server stitcher and
   * in the collision mirror, never here).
   *
   * Per style:
   *   - 'corridor' — flat level floor quad per segment.
   *   - 'ramp'     — floor quad tilted to match the segment's Y slope.
   *   - 'stair'    — a run of stepped boxes climbing the segment Y delta.
   *   - 'elevator' — a flat platform quad at each end Y plus a shaft; the
   *                  walls enclose the shaft. (Treated like a ramp for
   *                  floor-Y purposes — the server lerps Y the same way.)
   */
  private _buildConnector(connector: WireConnector): THREE.Group {
    const root = new THREE.Group();
    root.name = `connector_${connector.edgeId}`;

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x241f18, roughness: 0.92, metalness: 0.0,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x352d24, roughness: 0.78, metalness: 0.05,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x282119, roughness: 0.85, metalness: 0.04,
    });

    const poly = connector.polyline;
    const half = connector.width / 2;

    // True iff poly[k] is an actual 90° bend (axis switches between in and
    // out). Mirrors server Stitcher.computeConnectorFloorRegions and the
    // client `_computeConnectorFloorRegions` collision sibling. Drives the
    // interior-bend floor/ceiling trim below and the bend-block emission.
    const isBendAt = (k: number): boolean => {
      if (k <= 0 || k >= poly.length - 1) return false;
      const prev = poly[k - 1]!, wp = poly[k]!, next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      if (Math.hypot(dInX, dInZ) < AXIS_EPSILON) return false;
      if (Math.hypot(dOutX, dOutZ) < AXIS_EPSILON) return false;
      const inAlongX  = Math.abs(dInZ)  <= AXIS_EPSILON;
      const outAlongX = Math.abs(dOutZ) <= AXIS_EPSILON;
      return inAlongX !== outAlongX;
    };
    // Inside-wall side at the bend at poly[k] — +1 = right turn (inside on
    // +perp); −1 = left turn (inside on −perp). Used by the wall-mesh loop
    // below to trim only the INSIDE wall by `half` at the bend end, so the
    // wall mesh stops exactly at the inside-corner intersection instead of
    // jutting `half` past it into the bend block. Mirrors server logic.
    const bendInsideSide = (k: number): number => {
      const prev = poly[k - 1]!, wp = poly[k]!, next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      return Math.sign(dInX * dOutZ - dInZ * dOutX);
    };

    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const runLen = Math.hypot(dx, dz);
      if (runLen < AXIS_EPSILON) continue; // degenerate — skip

      // Perpendicular unit vector in XZ — offsets the two flanking walls.
      const nx = -dz / runLen;
      const nz =  dx / runLen;
      // Forward unit vector in XZ — used to orient geometry along the run.
      const fx = dx / runLen;
      const fz = dz / runLen;
      // Heading of the run in XZ (rotation about Y). atan2(fx,fz) so the
      // local +Z of a quad/box points down the run.
      const yaw = Math.atan2(fx, fz);
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const dy   = b.y - a.y;

      // ── Interior-bend trim ───────────────────────────────────────────────
      // FLOOR + CEILING meshes retract by `half` at every interior-bend
      // end so the per-bend `width × width` block emitted after this loop
      // is the sole cover for the bend area. WALLS keep full length
      // (their inside-corner overlap is only WALL_THICK² and invisible).
      // Mirrors collision logic in `_computeConnectorFloorRegions` and the
      // server's Stitcher.computeConnectorFloorRegions.
      const aTrim = isBendAt(i)     ? half : 0;
      const bTrim = isBendAt(i + 1) ? half : 0;
      const tRunLen = runLen - aTrim - bTrim;
      // Trimmed endpoints (for floor + ceiling only).
      const aTx = a.x + fx * aTrim, aTz = a.z + fz * aTrim;
      const bTx = b.x - fx * bTrim, bTz = b.z - fz * bTrim;
      const aTy = a.y + dy * (aTrim / runLen);
      const bTy = b.y - dy * (bTrim / runLen);
      const tMidX = (aTx + bTx) / 2;
      const tMidZ = (aTz + bTz) / 2;
      const tMidY = (aTy + bTy) / 2;
      const tDy   = bTy - aTy;
      // Segment shorter than the trim budget → skip floor/ceiling; the
      // adjacent bend blocks butt up to each other and cover the gap.
      const emitFloorCeil = tRunLen > AXIS_EPSILON;

      // ── Floor ──────────────────────────────────────────────────────────
      if (emitFloorCeil && connector.style === 'stair' && Math.abs(tDy) > AXIS_EPSILON) {
        // Stepped boxes climbing the Y delta over the TRIMMED run. Step
        // count from the trimmed run length; first step sits at aTx/aTz/aTy,
        // last step at bTx/bTz/bTy.
        const stepCount = Math.max(1, Math.round(tRunLen / STAIR_STEP_RUN));
        const stepRun   = tRunLen / stepCount;
        for (let s = 0; s < stepCount; s++) {
          // Step centre at fractional position (s+0.5)/stepCount along the
          // trimmed run (aT → bT).
          const t  = (s + 0.5) / stepCount;
          const cx = aTx + (bTx - aTx) * t;
          const cz = aTz + (bTz - aTz) * t;
          // Top of the step = lerped floor Y at the step's far edge, so
          // the player stands at the matching sampleFloorY height.
          const stepTopY = aTy + tDy * ((s + 1) / stepCount);
          const stepH    = 0.25;
          const step = new THREE.Mesh(
            new THREE.BoxGeometry(connector.width, stepH, stepRun),
            floorMat,
          );
          step.position.set(cx, stepTopY - stepH / 2 + 0.02, cz);
          step.rotation.order = 'YXZ';
          step.rotation.y = yaw;
          step.receiveShadow = true;
          step.castShadow    = true;
          root.add(step);
        }
      } else if (emitFloorCeil) {
        // corridor (flat), ramp (tilted), elevator (flat platform). A thin
        // box so the floor reads with thickness; tilted for a Y delta.
        const floorThick = 0.12;
        // Slope length — the hypotenuse including the Y rise, so a tilted
        // floor still spans corner-to-corner without a gap. Uses the
        // TRIMMED run + Y delta.
        const slopeLen = Math.hypot(tRunLen, tDy);
        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(connector.width, floorThick, slopeLen),
          floorMat,
        );
        floor.position.set(tMidX, tMidY + 0.02, tMidZ);
        // rotation.order MUST be 'YXZ'. Three.js's default 'XYZ' applies the
        // X (pitch) about the world axis BEFORE the yaw, shearing the ramp
        // into a parallelogram. 'YXZ' yaws first, so the pitch lands on the
        // run-local X axis.
        floor.rotation.order = 'YXZ';
        floor.rotation.y = yaw;
        // Pitch about the (now run-local) X axis so the slope matches tDy/tRunLen.
        if (Math.abs(tDy) > AXIS_EPSILON) {
          floor.rotation.x = -Math.atan2(tDy, tRunLen);
        }
        floor.receiveShadow = true;
        floor.castShadow    = true;
        root.add(floor);
      }

      // ── Side walls ─────────────────────────────────────────────────────
      // Two boxes offset ±width/2 perpendicular to the run, full height,
      // each spanning the (sloped) segment length. Walls follow the Y
      // slope so they sit flush with floor + ceiling.
      //
      // INSIDE-wall trim — the wall on the inside of any interior bend
      // retracts by `half` at the bend end so it terminates exactly at
      // the inside-corner intersection instead of jutting `half` past it
      // into the bend block. The OUTSIDE wall keeps full length so it
      // meets the outside-corner stub wall cleanly. Mirrors collision in
      // `_computeConnectorWallRects` and the server's
      // Stitcher.computeConnectorWallSegments.
      const wallH = connector.height;
      const aIsBend = isBendAt(i);
      const bIsBend = isBendAt(i + 1);
      const aInsideSide = aIsBend ? bendInsideSide(i) : 0;
      const bInsideSide = bIsBend ? bendInsideSide(i + 1) : 0;
      for (const side of [+1, -1] as const) {
        const aIsInsideHere = aIsBend && aInsideSide === side;
        const bIsInsideHere = bIsBend && bInsideSide === side;
        const wAT = aIsInsideHere ? half : 0;
        const wBT = bIsInsideHere ? half : 0;
        if (wAT + wBT >= runLen - AXIS_EPSILON) continue; // degenerate

        // Trimmed wall endpoints (relative to original a, b).
        const wAx = a.x + fx * wAT, wAz = a.z + fz * wAT;
        const wBx = b.x - fx * wBT, wBz = b.z - fz * wBT;
        const wAy = a.y + dy * (wAT / runLen);
        const wBy = b.y - dy * (wBT / runLen);
        const wRunLen = runLen - wAT - wBT;
        const wDy = wBy - wAy;
        const wMidX = (wAx + wBx) / 2;
        const wMidZ = (wAz + wBz) / 2;
        const wMidY = (wAy + wBy) / 2;
        const wallLen = Math.hypot(wRunLen, wDy);
        const wallPitch = Math.abs(wDy) > AXIS_EPSILON ? -Math.atan2(wDy, wRunLen) : 0;

        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICK, wallH, wallLen),
          wallMat,
        );
        wall.position.set(
          wMidX + nx * half * side,
          wMidY + wallH / 2,
          wMidZ + nz * half * side,
        );
        wall.rotation.order = 'YXZ'; // yaw-then-pitch in the run-local frame
        wall.rotation.y = yaw;
        wall.rotation.x = wallPitch;
        wall.castShadow    = true;
        wall.receiveShadow = true;
        root.add(wall);
      }

      // ── Ceiling ────────────────────────────────────────────────────────
      // Optional but kept for visual consistency with rooms — a thin box
      // capping the connector at wall height, following the Y slope. Uses
      // the TRIMMED run (matches floor).
      if (emitFloorCeil) {
        const ceilThick = 0.1;
        const tSlopeLen = Math.hypot(tRunLen, tDy);
        const ceiling = new THREE.Mesh(
          new THREE.BoxGeometry(connector.width, ceilThick, tSlopeLen),
          ceilMat,
        );
        ceiling.position.set(tMidX, tMidY + wallH, tMidZ);
        ceiling.rotation.order = 'YXZ'; // yaw-then-pitch in the run-local frame
        ceiling.rotation.y = yaw;
        ceiling.rotation.x = Math.abs(tDy) > AXIS_EPSILON ? -Math.atan2(tDy, tRunLen) : 0;
        ceiling.receiveShadow = true;
        root.add(ceiling);
      }

      // Interior lights along the segment — density of one per ~`LIGHT_SPACING`
      // metres of (trimmed) run, minimum one. Previously one per segment
      // regardless of length, which left long corridors dim away from the
      // single midpoint. Distributed evenly along the TRIMMED endpoints so
      // they live inside the segment's actual floor extent (bend blocks get
      // their own light below). Lights at ~80% of wall height.
      if (emitFloorCeil) {
        const LIGHT_SPACING = 10; // metres — tune for ambience vs draw-call cost
        const lightCount = Math.max(1, Math.ceil(tRunLen / LIGHT_SPACING));
        // Per-light range tied to spacing so adjacent lights overlap and the
        // run reads evenly lit. `+ 4` so a short single-light segment still
        // reaches its endpoints.
        const lightRange = LIGHT_SPACING * 1.5 + 4;
        for (let s = 0; s < lightCount; s++) {
          const t = (s + 0.5) / lightCount;
          const lx = aTx + (bTx - aTx) * t;
          const lz = aTz + (bTz - aTz) * t;
          const ly = aTy + (bTy - aTy) * t;
          const light = new THREE.PointLight(0xffd0a0, 1.1, lightRange, 1.4);
          light.position.set(lx, ly + wallH * 0.8, lz);
          root.add(light);
        }
      }
    }

    // ── Per-bend block render geometry ─────────────────────────────────────
    // One `width × width` flat floor + ceiling at every interior bend, plus
    // the two outside-corner stub walls. Matches collision in
    // `_computeConnectorFloorRegions` and `_computeConnectorWallRects`. The
    // bend block covers all four quadrants of the bend area (outside corner
    // + inside corner + the two side quadrants); both adjacent segments
    // retract by `half` at the waypoint so the block is the SOLE floor +
    // ceiling cover for the bend, killing the inside-corner 2 m × 2 m
    // z-fight the player saw before this fix.
    //
    // Stub walls (the L closing the OUTSIDE corner) still need the
    // signX/signZ derivation; the floor + ceiling block does not (it's
    // sign-symmetric, just `width × width` centred at the waypoint).
    const wallH = connector.height;
    const floorThick = 0.12;
    const ceilThick  = 0.1;
    for (let k = 1; k < poly.length - 1; k++) {
      if (!isBendAt(k)) continue;
      const wp   = poly[k]!;
      const prev = poly[k - 1]!;
      const next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;

      // Sign derivation for stub walls — outside-corner direction. See
      // server Stitcher.computeConnectorWallSegments for the derivation
      // table; the spec's formula is wrong for Z-incoming bends, hence
      // the per-axis branching.
      const signX = (Math.abs(dInX) > AXIS_EPSILON)
        ?  Math.sign(dInX)
        : -Math.sign(dOutX);
      const signZ = (Math.abs(dInZ) > AXIS_EPSILON)
        ?  Math.sign(dInZ)
        : -Math.sign(dOutZ);

      // ── Bend block FLOOR — full width × width, centred on waypoint. ──
      {
        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(connector.width, floorThick, connector.width),
          floorMat,
        );
        floor.position.set(wp.x, wp.y + 0.02, wp.z);
        floor.receiveShadow = true;
        floor.castShadow    = true;
        root.add(floor);
      }
      // ── Bend block CEILING — same footprint, at wp.y + wallH. ──
      {
        const ceiling = new THREE.Mesh(
          new THREE.BoxGeometry(connector.width, ceilThick, connector.width),
          ceilMat,
        );
        ceiling.position.set(wp.x, wp.y + wallH, wp.z);
        ceiling.receiveShadow = true;
        root.add(ceiling);
      }

      // ── Outside-corner stub walls — UNCHANGED from previous fix. ──
      // The bend block has no walls of its own; the OUTSIDE corner needs
      // an L to seal it (the inside corner is intentionally open into the
      // adjacent segments). Box length = half + WALL_THICK so the stub
      // ends overlap WALL_THICK/2 with the segment walls, sealing the
      // join with no visible seam.
      const cornerCx = wp.x + signX * half / 2;
      const cornerCz = wp.z + signZ * half / 2;
      // Stub wall 1 — X-aligned at z = wp.z + signZ*half.
      {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(half + WALL_THICK, wallH, WALL_THICK),
          wallMat,
        );
        wall.position.set(cornerCx, wp.y + wallH / 2, wp.z + signZ * half);
        wall.castShadow    = true;
        wall.receiveShadow = true;
        root.add(wall);
      }
      // Stub wall 2 — Z-aligned at x = wp.x + signX*half.
      {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICK, wallH, half + WALL_THICK),
          wallMat,
        );
        wall.position.set(wp.x + signX * half, wp.y + wallH / 2, cornerCz);
        wall.castShadow    = true;
        wall.receiveShadow = true;
        root.add(wall);
      }
      // ── Bend block interior light ─────────────────────────────────────
      // Without this the bend block reads as a dim transition between two
      // lit segments — exactly where a player needs to read the geometry
      // to make the turn. Centre of the block, same height + colour as
      // the segment lights.
      {
        const light = new THREE.PointLight(0xffd0a0, 1.2, connector.width * 2.5 + 4, 1.4);
        light.position.set(wp.x, wp.y + wallH * 0.8, wp.z);
        root.add(light);
      }
    }

    return root;
  }

  /**
   * Connector side-wall collision rects — halo-inflated, world-space.
   *
   * Mirrors the server: two oriented wall segments per polyline segment,
   * offset ±width/2 perpendicular to the run, then each reduced to its
   * AABB (server Stitcher.computeConnectorWallSegments →
   * orientedSegmentToRect). V0 connector segments are axis-aligned, so an
   * axis-aligned wall IS an axis-aligned rect — the AABB is exact.
   *
   * Non-axis-aligned segments are skipped here (the renderer still draws
   * them); that matches the server, whose V0 collision adapter only
   * handles axis-aligned segments. When diagonal connectors land, both
   * sides relax this in lockstep.
   */
  private _computeConnectorWallRects(connector: WireConnector): CollisionRect[] {
    const rects: CollisionRect[] = [];
    const poly = connector.polyline;
    const half = connector.width / 2;

    // Bend predicate + inside-side helper — mirrors server
    // Stitcher.computeConnectorWallSegments.
    const isBendAt = (k: number): boolean => {
      if (k <= 0 || k >= poly.length - 1) return false;
      const prev = poly[k - 1]!, wp = poly[k]!, next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      if (Math.hypot(dInX, dInZ) < AXIS_EPSILON) return false;
      if (Math.hypot(dOutX, dOutZ) < AXIS_EPSILON) return false;
      const inAlongX  = Math.abs(dInZ)  <= AXIS_EPSILON;
      const outAlongX = Math.abs(dOutZ) <= AXIS_EPSILON;
      return inAlongX !== outAlongX;
    };
    const bendInsideSide = (k: number): number => {
      const prev = poly[k - 1]!, wp = poly[k]!, next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      return Math.sign(dInX * dOutZ - dInZ * dOutX);
    };

    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < AXIS_EPSILON) continue;

      // V0 collision mirror — axis-aligned segments only. A diagonal
      // segment is left for the future diagonal branch (the server skips
      // it here too); the renderer above still draws it.
      const alongX = Math.abs(dz) <= AXIS_EPSILON;
      const alongZ = Math.abs(dx) <= AXIS_EPSILON;
      if (!alongX && !alongZ) continue;

      // Perpendicular unit vector — offsets the two flanking walls.
      const nx = -dz / len;
      const nz =  dx / len;

      // Doorway inset (room-boundary end) — mutually exclusive per-end
      // with the interior-bend trim below. MUST match server
      // Stitcher.computeConnectorWallSegments exactly.
      const doorwayInset = Math.min(WALL_THICK / 2 + PLAYER_RADIUS, len * 0.4);
      const ux = dx / len, uz = dz / len;

      // INSIDE-wall bend trim — see server Stitcher for the full comment.
      const aIsBend = isBendAt(i);
      const bIsBend = isBendAt(i + 1);
      const aInsideSide = aIsBend ? bendInsideSide(i) : 0;
      const bInsideSide = bIsBend ? bendInsideSide(i + 1) : 0;

      for (const side of [+1, -1] as const) {
        const aIsInsideHere = aIsBend && aInsideSide === side;
        const bIsInsideHere = bIsBend && bInsideSide === side;

        const aInset = aIsInsideHere ? half : (i === 0               ? doorwayInset : 0);
        const bInset = bIsInsideHere ? half : (i === poly.length - 2 ? doorwayInset : 0);

        if (aInset + bInset >= len - AXIS_EPSILON) continue;

        const iax = a.x + ux * aInset, iaz = a.z + uz * aInset;
        const ibx = b.x - ux * bInset, ibz = b.z - uz * bInset;

        const ax = iax + nx * half * side;
        const az = iaz + nz * half * side;
        const bx = ibx + nx * half * side;
        const bz = ibz + nz * half * side;
        const h  = WALL_THICK / 2;
        rects.push({
          minX: Math.min(ax, bx) - h - PLAYER_RADIUS,
          maxX: Math.max(ax, bx) + h + PLAYER_RADIUS,
          minZ: Math.min(az, bz) - h - PLAYER_RADIUS,
          maxZ: Math.max(az, bz) + h + PLAYER_RADIUS,
        });
      }
    }

    // ── Per-bend outside-corner stub-wall collision rects ──────────────────
    // Mirrors the server's per-interior-waypoint loop in
    // computeConnectorWallSegments. At each 90° bend the two flanking
    // segment walls leave a `half × half` gap on the outside; close it with
    // an L of two stub walls' haloed AABBs. NO inset here (these walls live
    // INSIDE the connector, not at a room boundary).
    //
    // Outside-corner sign — see server Stitcher.computeConnectorWallSegments
    // for the derivation table. The spec's formula is wrong for Z-incoming
    // bends, hence the per-axis branching.
    const h = WALL_THICK / 2;
    for (let k = 1; k < poly.length - 1; k++) {
      const wp   = poly[k]!;
      const prev = poly[k - 1]!;
      const next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      const inLen  = Math.hypot(dInX,  dInZ);
      const outLen = Math.hypot(dOutX, dOutZ);
      if (inLen < AXIS_EPSILON || outLen < AXIS_EPSILON) continue;

      const inAlongX  = Math.abs(dInZ)  <= AXIS_EPSILON;
      const outAlongX = Math.abs(dOutZ) <= AXIS_EPSILON;
      if (inAlongX === outAlongX) continue; // collinear — no bend.

      const signX = (Math.abs(dInX) > AXIS_EPSILON)
        ?  Math.sign(dInX)
        : -Math.sign(dOutX);
      const signZ = (Math.abs(dInZ) > AXIS_EPSILON)
        ?  Math.sign(dInZ)
        : -Math.sign(dOutZ);

      const outsideX = wp.x + signX * half;

      // Stub 1 — X-aligned wall at z = wp.z + signZ*half, spanning
      // x ∈ [wp.x, outsideX] (order-independent: take min/max).
      {
        const sax = wp.x,     saz = wp.z + signZ * half;
        const sbx = outsideX, sbz = wp.z + signZ * half;
        rects.push({
          minX: Math.min(sax, sbx) - h - PLAYER_RADIUS,
          maxX: Math.max(sax, sbx) + h + PLAYER_RADIUS,
          minZ: Math.min(saz, sbz) - h - PLAYER_RADIUS,
          maxZ: Math.max(saz, sbz) + h + PLAYER_RADIUS,
        });
      }
      // Stub 2 — Z-aligned wall at x = outsideX, spanning
      // z ∈ [wp.z, wp.z + signZ*half].
      {
        const sax = outsideX, saz = wp.z + signZ * half;
        const sbx = outsideX, sbz = wp.z;
        rects.push({
          minX: Math.min(sax, sbx) - h - PLAYER_RADIUS,
          maxX: Math.max(sax, sbx) + h + PLAYER_RADIUS,
          minZ: Math.min(saz, sbz) - h - PLAYER_RADIUS,
          maxZ: Math.max(saz, sbz) + h + PLAYER_RADIUS,
        });
      }
    }
    return rects;
  }

  /**
   * Walkable floor regions for a connector — one per polyline segment. A
   * sloped segment (endpoints differ in Y) carries `y0`/`y1` along its run
   * `axis` so `sampleFloorY` can lerp Y; a flat segment has `y0 === y1`,
   * `axis: 'flat'`.
   *
   * Mirrors server Stitcher.computeConnectorFloorRegions — axis-aligned
   * segments only (V0). The endpoint Y is assigned to the axis-min /
   * axis-max edge so a movement query lerps Y correctly regardless of
   * travel direction.
   */
  private _computeConnectorFloorRegions(connector: WireConnector): FloorRegion[] {
    const regions: FloorRegion[] = [];
    const poly = connector.polyline;
    const half = connector.width / 2;

    // True iff poly[k] is an actual 90° bend (axis switches between in and
    // out). Mirrors server Stitcher.computeConnectorFloorRegions.
    const isBendAt = (k: number): boolean => {
      if (k <= 0 || k >= poly.length - 1) return false;
      const prev = poly[k - 1]!, wp = poly[k]!, next = poly[k + 1]!;
      const dInX = wp.x - prev.x, dInZ = wp.z - prev.z;
      const dOutX = next.x - wp.x, dOutZ = next.z - wp.z;
      if (Math.hypot(dInX, dInZ) < AXIS_EPSILON) return false;
      if (Math.hypot(dOutX, dOutZ) < AXIS_EPSILON) return false;
      const inAlongX  = Math.abs(dInZ)  <= AXIS_EPSILON;
      const outAlongX = Math.abs(dOutZ) <= AXIS_EPSILON;
      return inAlongX !== outAlongX;
    };

    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < AXIS_EPSILON) continue;

      const alongX = Math.abs(dz) <= AXIS_EPSILON;
      const alongZ = Math.abs(dx) <= AXIS_EPSILON;
      if (!alongX && !alongZ) continue; // diagonal — future branch

      // Interior-bend trim — mirrors server Stitcher. Each adjacent segment
      // retracts by `half` at every interior-bend end, so the bend block
      // emitted below is the SOLE cover for the bend area (no inside-corner
      // 2 m × 2 m z-fight).
      const aTrim = isBendAt(i)     ? half : 0;
      const bTrim = isBendAt(i + 1) ? half : 0;
      if (aTrim + bTrim >= len - AXIS_EPSILON) continue; // degenerate

      const ux = dx / len, uz = dz / len;
      const aTy = a.y + (b.y - a.y) * (aTrim / len);
      const bTy = b.y - (b.y - a.y) * (bTrim / len);

      if (alongX) {
        const aTx = a.x + ux * aTrim;
        const bTx = b.x - ux * bTrim;
        const minX = Math.min(aTx, bTx);
        const maxX = Math.max(aTx, bTx);
        const yAtMinX = aTx <= bTx ? aTy : bTy;
        const yAtMaxX = aTx <= bTx ? bTy : aTy;
        regions.push({
          minX, maxX,
          minZ: a.z - half, maxZ: a.z + half,
          y0: yAtMinX, y1: yAtMaxX,
          axis: yAtMinX === yAtMaxX ? 'flat' : 'x',
          ceilingY: Math.min(yAtMinX, yAtMaxX) + connector.height,
        });
      } else {
        const aTz = a.z + uz * aTrim;
        const bTz = b.z - uz * bTrim;
        const minZ = Math.min(aTz, bTz);
        const maxZ = Math.max(aTz, bTz);
        const yAtMinZ = aTz <= bTz ? aTy : bTy;
        const yAtMaxZ = aTz <= bTz ? bTy : aTy;
        regions.push({
          minX: a.x - half, maxX: a.x + half,
          minZ, maxZ,
          y0: yAtMinZ, y1: yAtMaxZ,
          axis: yAtMinZ === yAtMaxZ ? 'flat' : 'z',
          ceilingY: Math.min(yAtMinZ, yAtMaxZ) + connector.height,
        });
      }
    }

    // ── Per-bend block floor regions ───────────────────────────────────────
    // One full `width × width` flat block per interior bend waypoint covers
    // all four quadrants of the bend area (outside corner + inside corner +
    // the two "side" quadrants). Replaces the previous half × half outside-
    // corner patch — the bigger footprint is needed because both adjacent
    // segments retract by `half` at the waypoint, so the bend must be sole-
    // covered by this block. Carries the connector's ceilingY field (the
    // client mirror's extra; server FloorRegion has no ceilingY).
    for (let k = 1; k < poly.length - 1; k++) {
      if (!isBendAt(k)) continue;
      const wp = poly[k]!;
      regions.push({
        minX: wp.x - half, maxX: wp.x + half,
        minZ: wp.z - half, maxZ: wp.z + half,
        y0: wp.y, y1: wp.y, axis: 'flat',
        ceilingY: wp.y + connector.height,
      });
    }
    return regions;
  }

  private _buildRoom(placement: RoomPlacement): THREE.Group {
    const tmpl = placement.template;
    // `undefined` is the signal "preview mode, no graph context — cut every
    // exit as a default-width doorway so the previewer sees them". A defined
    // object is the stitched-dungeon path: only exits the stitcher wired a
    // connector to are cut (others stay solid wall). Without that gate, a
    // template reused at a slot that doesn't use all its exits (e.g. b3 the
    // dead-end, or b1's south_entry where the connector lands on west_entry)
    // opens a doorway into the void. Mirrors server
    // Stitcher.computeRoomWallRects exactly.
    const exitDoorDims = placement.exitDoorDims;
    const root = new THREE.Group();
    root.name = `room_${tmpl.id}`;

    const { sizeX, sizeZ } = tmpl.footprint;
    const wallH = tmpl.wallHeight ?? 4;

    // Floor — dark mossy earth.
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a241c, roughness: 0.92, metalness: 0.0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    root.add(floor);

    // Walls — four directions, each split into segments around any exits.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x3a3128, roughness: 0.78, metalness: 0.05,
    });
    for (const dir of ['N', 'S', 'E', 'W'] as const) {
      for (const mesh of this._buildWallSegments(dir, tmpl.exits, exitDoorDims, sizeX, sizeZ, wallH, wallMat)) {
        root.add(mesh);
      }
    }

    // Ceiling — slightly darker than walls. Flipped so its lit face points
    // down into the room (otherwise the interior light reflects off the
    // wrong side and the ceiling looks black).
    const ceilingMat = new THREE.MeshStandardMaterial({
      color: 0x2d251f, roughness: 0.85, metalness: 0.04,
    });
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), ceilingMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = wallH;
    ceiling.receiveShadow = true;
    root.add(ceiling);

    // Exit markers — small green cones, pointed in the exit direction.
    const exitMat = new THREE.MeshStandardMaterial({
      color: 0x103820, emissive: 0x44ee88, emissiveIntensity: 1.2,
      roughness: 0.4, metalness: 0.3,
    });
    for (const ex of tmpl.exits) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 8), exitMat);
      cone.position.set(ex.position.x, ex.position.y + 0.6, ex.position.z);
      const headingDeg = ex.heading ?? 0;
      cone.rotation.x = Math.PI / 2;
      cone.rotation.z = THREE.MathUtils.degToRad(-headingDeg);
      root.add(cone);
    }

    // Spawn anchors — small red spheres at floor level.
    const spawnMat = new THREE.MeshStandardMaterial({
      color: 0x441010, emissive: 0xff3333, emissiveIntensity: 1.4,
      roughness: 0.4, metalness: 0.3,
    });
    for (const sp of tmpl.spawnAnchors) {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), spawnMat);
      sphere.position.set(sp.position.x, sp.position.y + 0.3, sp.position.z);
      root.add(sphere);
    }

    // Hazard anchors — real hazard visuals by kind (Phase 4). The static
    // visuals (spore clouds, aether pools, pulse emitter glows) ride the
    // `preview_room` payload; the swelling pulse warning is a telegraph
    // and needs no geometry here.
    if (tmpl.hazardAnchors && tmpl.hazardAnchors.length > 0) {
      for (const hz of tmpl.hazardAnchors) {
        for (const mesh of this._buildHazardVisual(tmpl.hazardKind, hz)) {
          root.add(mesh);
        }
      }
    }

    // Interior lights — without them the enclosed box is pitch black. A
    // single centre light leaves the corners gloomy in any room ≳ 14 m on
    // either side (intensity falls off as 1/d^1.4); above that threshold
    // use a 2×2 quarter-position grid so the floor reads evenly. Per-light
    // intensity is sized to keep total flux ~comparable to the old single
    // light at small-room sizes and noticeably brighter at large ones.
    const ROOM_GRID_THRESHOLD = 14;
    const lightY = wallH * 0.8;
    const lightRange = Math.max(sizeX, sizeZ) * 0.95 + 4;
    if (sizeX > ROOM_GRID_THRESHOLD || sizeZ > ROOM_GRID_THRESHOLD) {
      // 2×2 quarter-position grid. Lights at (±sizeX/4, _, ±sizeZ/4).
      const qx = sizeX / 4, qz = sizeZ / 4;
      for (const sx of [-1, +1] as const) {
        for (const sz of [-1, +1] as const) {
          const light = new THREE.PointLight(0xffd0a0, 1.3, lightRange, 1.4);
          light.position.set(sx * qx, lightY, sz * qz);
          root.add(light);
        }
      }
    } else {
      const light = new THREE.PointLight(0xffd0a0, 1.6, lightRange, 1.4);
      light.position.set(0, lightY, 0);
      root.add(light);
    }

    return root;
  }

  /**
   * Build the visual(s) for one hazard anchor, switched on the template's
   * `hazardKind` (Phase 4). Radii mirror the server HazardSystem constants
   * so the visual footprint matches where the effect actually fires.
   *
   *   - 'spore'         — a translucent green-glowing cloud sphere.
   *   - 'aether_water'  — a glowing violet disc on the floor.
   *   - 'pulsing_walls' — a small emitter glow orb; the swelling pulse
   *     warning itself is a telegraph (rendered by TelegraphRenderer).
   *
   * Falls back to the legacy orange marker sphere when `hazardKind` is
   * absent (older server, or a hazard kind this client doesn't know).
   */
  private _buildHazardVisual(
    kind: WireTemplate['hazardKind'],
    hz:   WireAnchor,
  ): THREE.Mesh[] {
    const { x, y, z } = hz.position;

    if (kind === 'spore') {
      // Server SPORE_RADIUS_M = 4.0 — translucent green cloud volume.
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1c3a14, emissive: 0x55cc33, emissiveIntensity: 0.9,
        roughness: 0.9, metalness: 0.0,
        transparent: true, opacity: 0.32, depthWrite: false,
      });
      const cloud = new THREE.Mesh(new THREE.SphereGeometry(4.0, 16, 12), mat);
      cloud.position.set(x, y + 2.6, z);
      cloud.name = 'hazard_spore';
      return [cloud];
    }

    if (kind === 'aether_water') {
      // Server AETHER_RADIUS_M = 3.0 — glowing violet pool, a flat disc
      // sitting just above the floor.
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a1444, emissive: 0x8844dd, emissiveIntensity: 1.1,
        roughness: 0.35, metalness: 0.2,
        transparent: true, opacity: 0.6, depthWrite: false,
      });
      const pool = new THREE.Mesh(new THREE.CircleGeometry(3.0, 32), mat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x, y + 0.05, z);
      pool.name = 'hazard_aether_water';
      return [pool];
    }

    if (kind === 'pulsing_walls') {
      // Small emitter glow — the warning itself is a telegraph circle the
      // client already renders via the telegraph_register channel.
      const mat = new THREE.MeshStandardMaterial({
        color: 0x441a0a, emissive: 0xff5522, emissiveIntensity: 1.8,
        roughness: 0.3, metalness: 0.4,
      });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), mat);
      orb.position.set(x, y + 1.0, z);
      orb.name = 'hazard_pulse_emitter';
      return [orb];
    }

    // Fallback — legacy orange marker for an unknown / absent hazard kind.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x442010, emissive: 0xff8844, emissiveIntensity: 1.4,
      roughness: 0.4, metalness: 0.3,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat);
    sphere.position.set(x, y + 0.5, z);
    sphere.name = 'hazard_marker';
    return [sphere];
  }

  /**
   * Build one wall as a run of box segments around its doorway cutouts.
   * Each cutout is sized to ITS exit's connector: width carves the
   * horizontal gap, height sets the open height. Full-height wall
   * segments run between cutouts; each cutout gets its OWN lintel box
   * spanning just its X-range, from its cutout height up to wallH.
   * Walls with no doorways are a single full-height box.
   *
   * Per-exit dims come from `exitDoorDims` (keyed by exit id); an exit
   * absent from the map — no attached connector, e.g. the admin
   * single-room preview — falls back to DOORWAY_WIDTH/DOORWAY_HEIGHT.
   *
   * Per-cutout (rather than one wall-wide) lintels are required now that
   * doorways on the same wall can differ in height. They also make the
   * old CONNECTOR_WALL_HEIGHT === DOORWAY_HEIGHT invariant unnecessary:
   * each cutout is sized to its OWN connector's height, so the cutout
   * roof and the connector tube roof match by construction — no open
   * slot above the connector to seal.
   *
   * For N/S walls the wall runs along X; the cross-axis position is on Z.
   * For E/W walls it's the other way around.
   */
  private _buildWallSegments(
    direction:    'N' | 'S' | 'E' | 'W',
    allExits:     WireExit[],
    exitDoorDims: Record<string, { width: number; height: number }> | undefined,
    sizeX:        number,
    sizeZ:        number,
    wallH:        number,
    material:     THREE.Material,
  ): THREE.Mesh[] {
    // Preview-room mode (no dims map) → cut every exit; stitched mode →
    // cut ONLY exits the stitcher wired a connector to. Mirrors server
    // Stitcher.computeRoomWallRects.
    const wallExits = allExits.filter((e) =>
      e.direction === direction &&
      (exitDoorDims === undefined || e.id in exitDoorDims)
    );

    const axis: 'x' | 'z' = (direction === 'N' || direction === 'S') ? 'x' : 'z';
    const wallAxisSize    = axis === 'x' ? sizeX : sizeZ;
    let crossPos: number;
    if      (direction === 'N') crossPos = -sizeZ / 2;
    else if (direction === 'S') crossPos =  sizeZ / 2;
    else if (direction === 'E') crossPos =  sizeX / 2;
    else                        crossPos = -sizeX / 2;

    const minA = -(wallAxisSize / 2 + WALL_THICK);
    const maxA =   wallAxisSize / 2 + WALL_THICK;

    // No doorways → single full-height box.
    if (wallExits.length === 0) {
      return [this._buildWallBox(axis, crossPos, minA, maxA, 0, wallH, material)];
    }

    // One cutout descriptor per exit on this wall — its axis position
    // plus its per-exit width/height (fallback for an exit with no
    // attached connector). Sorted along the wall axis so the segment
    // walk below proceeds left-to-right.
    const cutouts = wallExits
      .map((e) => {
        // Optional-chain since exitDoorDims is undefined in preview mode.
        // In stitched mode it's defined, but an exit could still be absent
        // here if it's been filtered out above — defensively fall back.
        const dims = exitDoorDims?.[e.id];
        return {
          pos:    axis === 'x' ? e.position.x : e.position.z,
          width:  dims?.width  ?? DOORWAY_WIDTH,
          height: dims?.height ?? DOORWAY_HEIGHT,
        };
      })
      .sort((a, b) => a.pos - b.pos);

    const meshes: THREE.Mesh[] = [];
    let segStart = minA;
    for (const c of cutouts) {
      const cutLow  = c.pos - c.width / 2;
      const cutHigh = c.pos + c.width / 2;
      // Full-height wall segment between the previous cutout and this one.
      if (cutLow > segStart) {
        meshes.push(this._buildWallBox(axis, crossPos, segStart, cutLow, 0, wallH, material));
      }
      // Per-cutout lintel — spans this cutout's X-range, from its open
      // height up to wallH. Clamp to wallH so a cutout taller than the
      // wall just yields no lintel.
      const cutoutH = Math.min(c.height, wallH);
      if (wallH > cutoutH) {
        meshes.push(this._buildWallBox(axis, crossPos, cutLow, cutHigh, cutoutH, wallH, material));
      }
      segStart = cutHigh;
    }
    // Trailing full-height wall segment past the last cutout.
    if (maxA > segStart) {
      meshes.push(this._buildWallBox(axis, crossPos, segStart, maxA, 0, wallH, material));
    }

    return meshes;
  }

  /** Helper — build one wall box at (axisStart→axisEnd, yLow→yHigh) on
   *  the given direction axis. Centralises BoxGeometry creation so the
   *  doorway-band and lintel segments share the same logic. */
  private _buildWallBox(
    axis:      'x' | 'z',
    crossPos:  number,
    axisStart: number,
    axisEnd:   number,
    yLow:      number,
    yHigh:     number,
    material:  THREE.Material,
  ): THREE.Mesh {
    const aLen = axisEnd - axisStart;
    const aMid = (axisStart + axisEnd) / 2;
    const yLen = yHigh - yLow;
    const yMid = (yLow + yHigh) / 2;
    const geo: THREE.BoxGeometry = axis === 'x'
      ? new THREE.BoxGeometry(aLen, yLen, WALL_THICK)
      : new THREE.BoxGeometry(WALL_THICK, yLen, aLen);
    const mesh = new THREE.Mesh(geo, material);
    if (axis === 'x') mesh.position.set(aMid, yMid, crossPos);
    else              mesh.position.set(crossPos, yMid, aMid);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
