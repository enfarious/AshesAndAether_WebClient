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
/** Connector wall + ceiling height. Must be at least DOORWAY_HEIGHT: the
 *  room cuts its doorway opening that tall, so a shorter connector leaves an
 *  open slot above the connector roof that peers into the void. The room's
 *  own lintel seals everything above DOORWAY_HEIGHT. */
const CONNECTOR_WALL_HEIGHT = DOORWAY_HEIGHT;
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
        const roomGroup = this._buildRoom(placement.template);
        // RoomPlacement.origin.y is now a real, varying value (terraced
        // dungeons) — the sub-group is positioned at the full origin so
        // the room sits at its placement elevation.
        roomGroup.position.set(placement.origin.x, placement.origin.y, placement.origin.z);
        this.group.add(roomGroup);
        // Compute world-space, halo-inflated collision rects for this room.
        for (const rect of this._computeWallRects(placement.template, placement.origin)) {
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
        const slab = this._buildGateSlab(gate.rect);
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
   * is the raw (un-haloed) server doorway rect — WALL_THICK deep, up to
   * DOORWAY_WIDTH wide. Sits in the doorway band (floor → DOORWAY_HEIGHT).
   */
  private _buildGateSlab(rect: WireRect): THREE.Mesh {
    const sizeX = Math.max(0.01, rect.maxX - rect.minX);
    const sizeZ = Math.max(0.01, rect.maxZ - rect.minZ);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x140f0c, roughness: 0.95, metalness: 0.05,
      emissive: 0x2a0d0d, emissiveIntensity: 0.35,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sizeX, DOORWAY_HEIGHT, sizeZ),
      mat,
    );
    mesh.position.set(
      (rect.minX + rect.maxX) / 2,
      DOORWAY_HEIGHT / 2,
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
   */
  private _computeWallRects(
    tmpl:   WireTemplate,
    origin: { x: number; y: number; z: number },
  ): CollisionRect[] {
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

      const doorPositions = wallExits
        .map((e) => (axis === 'x' ? e.position.x : e.position.z))
        .sort((a, b) => a - b);

      const minA = -(wallAxisSize / 2 + WALL_THICK);
      const maxA =   wallAxisSize / 2 + WALL_THICK;

      let segStart = minA;
      const segments: Array<[number, number]> = [];
      for (const dp of doorPositions) {
        const segEnd = dp - DOORWAY_WIDTH / 2;
        if (segEnd > segStart) segments.push([segStart, segEnd]);
        segStart = dp + DOORWAY_WIDTH / 2;
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

      // ── Floor ──────────────────────────────────────────────────────────
      if (connector.style === 'stair' && Math.abs(dy) > AXIS_EPSILON) {
        // Stepped boxes climbing the Y delta. Step count from the run
        // length so steps stay a sane depth; each step is a flat box.
        const stepCount = Math.max(1, Math.round(runLen / STAIR_STEP_RUN));
        const stepRun   = runLen / stepCount;
        for (let s = 0; s < stepCount; s++) {
          // Step centre at fractional position (s+0.5)/stepCount along run.
          const t  = (s + 0.5) / stepCount;
          const cx = a.x + dx * t;
          const cz = a.z + dz * t;
          // Top of the step = lerped floor Y at the step's far edge, so
          // the player stands at the matching sampleFloorY height.
          const stepTopY = a.y + dy * ((s + 1) / stepCount);
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
      } else {
        // corridor (flat), ramp (tilted), elevator (flat platform). A thin
        // box so the floor reads with thickness; tilted for a Y delta.
        const floorThick = 0.12;
        // Slope length — the hypotenuse including the Y rise, so a tilted
        // floor still spans corner-to-corner without a gap.
        const slopeLen = Math.hypot(runLen, dy);
        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(connector.width, floorThick, slopeLen),
          floorMat,
        );
        floor.position.set(midX, (a.y + b.y) / 2 + 0.02, midZ);
        // rotation.order MUST be 'YXZ'. Three.js's default 'XYZ' applies the
        // X (pitch) about the world axis BEFORE the yaw, shearing the ramp
        // into a parallelogram. 'YXZ' yaws first, so the pitch lands on the
        // run-local X axis.
        floor.rotation.order = 'YXZ';
        floor.rotation.y = yaw;
        // Pitch about the (now run-local) X axis so the slope matches dy/runLen.
        if (Math.abs(dy) > AXIS_EPSILON) {
          floor.rotation.x = -Math.atan2(dy, runLen);
        }
        floor.receiveShadow = true;
        floor.castShadow    = true;
        root.add(floor);
      }

      // ── Side walls ─────────────────────────────────────────────────────
      // Two boxes offset ±width/2 perpendicular to the run, full height,
      // each spanning the (sloped) segment length. Walls follow the Y
      // slope so they sit flush with floor + ceiling.
      const wallH    = CONNECTOR_WALL_HEIGHT;
      const wallLen  = Math.hypot(runLen, dy);
      const wallPitch = Math.abs(dy) > AXIS_EPSILON ? -Math.atan2(dy, runLen) : 0;
      for (const side of [+1, -1] as const) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICK, wallH, wallLen),
          wallMat,
        );
        wall.position.set(
          midX + nx * half * side,
          (a.y + b.y) / 2 + wallH / 2,
          midZ + nz * half * side,
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
      // capping the connector at wall height, following the Y slope.
      const ceilThick = 0.1;
      const ceiling = new THREE.Mesh(
        new THREE.BoxGeometry(connector.width, ceilThick, wallLen),
        ceilMat,
      );
      ceiling.position.set(midX, (a.y + b.y) / 2 + wallH, midZ);
      ceiling.rotation.order = 'YXZ'; // yaw-then-pitch in the run-local frame
      ceiling.rotation.y = yaw;
      ceiling.rotation.x = wallPitch;
      ceiling.receiveShadow = true;
      root.add(ceiling);

      // Interior light per segment so the connector isn't pitch black.
      const light = new THREE.PointLight(0xffd0a0, 1.0, runLen * 1.6 + 6, 1.4);
      light.position.set(midX, (a.y + b.y) / 2 + wallH * 0.8, midZ);
      root.add(light);
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

      // Inset the wall ends that meet a room. The WALL_THICK/2 + PLAYER_RADIUS
      // halo below extends the rect past the segment endpoint; without the
      // inset that haloed rect pokes past the room wall plane into the
      // doorway, leaving an L-corner NPCs snag on. Only the polyline's two
      // room-meeting ends inset; interior bend joints keep full length.
      // MUST match server Stitcher.computeConnectorWallSegments exactly.
      const inset = Math.min(WALL_THICK / 2 + PLAYER_RADIUS, len * 0.4);
      const ux = dx / len, uz = dz / len;
      const aInset = (i === 0)               ? inset : 0;
      const bInset = (i === poly.length - 2) ? inset : 0;
      const iax = a.x + ux * aInset, iaz = a.z + uz * aInset;
      const ibx = b.x - ux * bInset, ibz = b.z - uz * bInset;

      // Each wall is a thick line segment; its AABB (the server's
      // orientedSegmentToRect) is the collision rect. Halo-inflated by
      // PLAYER_RADIUS to match the server's wall-slide grid expansion.
      for (const side of [+1, -1] as const) {
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

      if (alongX) {
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const yAtMinX = a.x <= b.x ? a.y : b.y;
        const yAtMaxX = a.x <= b.x ? b.y : a.y;
        regions.push({
          minX, maxX,
          minZ: a.z - half, maxZ: a.z + half,
          y0: yAtMinX, y1: yAtMaxX,
          axis: yAtMinX === yAtMaxX ? 'flat' : 'x',
          ceilingY: Math.min(yAtMinX, yAtMaxX) + CONNECTOR_WALL_HEIGHT,
        });
      } else {
        const minZ = Math.min(a.z, b.z);
        const maxZ = Math.max(a.z, b.z);
        const yAtMinZ = a.z <= b.z ? a.y : b.y;
        const yAtMaxZ = a.z <= b.z ? b.y : a.y;
        regions.push({
          minX: a.x - half, maxX: a.x + half,
          minZ, maxZ,
          y0: yAtMinZ, y1: yAtMaxZ,
          axis: yAtMinZ === yAtMaxZ ? 'flat' : 'z',
          ceilingY: Math.min(yAtMinZ, yAtMaxZ) + CONNECTOR_WALL_HEIGHT,
        });
      }
    }
    return regions;
  }

  private _buildRoom(tmpl: WireTemplate): THREE.Group {
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
      for (const mesh of this._buildWallSegments(dir, tmpl.exits, sizeX, sizeZ, wallH, wallMat)) {
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

    // Interior point light — without it the enclosed box is pitch black.
    const light = new THREE.PointLight(0xffd0a0, 1.6, Math.max(sizeX, sizeZ) * 1.4, 1.4);
    light.position.set(0, wallH * 0.8, 0);
    root.add(light);

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
   * Build one wall as up to N+2 box segments — N+1 around N doorway
   * cutouts in the lower band (0 → DOORWAY_HEIGHT), plus one full-width
   * lintel spanning DOORWAY_HEIGHT → wallH. Walls with no doorways are
   * a single full-height box.
   *
   * For N/S walls the wall runs along X; the cross-axis position is on Z.
   * For E/W walls it's the other way around.
   */
  private _buildWallSegments(
    direction: 'N' | 'S' | 'E' | 'W',
    allExits:  WireExit[],
    sizeX:     number,
    sizeZ:     number,
    wallH:     number,
    material:  THREE.Material,
  ): THREE.Mesh[] {
    const wallExits = allExits.filter((e) => e.direction === direction);

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

    // Doorway band — segments around each cutout. Height clamps to wallH
    // for walls shorter than the default doorway (no headroom).
    const doorPositions = wallExits
      .map((e) => axis === 'x' ? e.position.x : e.position.z)
      .sort((a, b) => a - b);

    const lowerH = Math.min(DOORWAY_HEIGHT, wallH);
    const meshes: THREE.Mesh[] = [];
    let segStart = minA;
    for (const dp of doorPositions) {
      const segEnd = dp - DOORWAY_WIDTH / 2;
      if (segEnd > segStart) {
        meshes.push(this._buildWallBox(axis, crossPos, segStart, segEnd, 0, lowerH, material));
      }
      segStart = dp + DOORWAY_WIDTH / 2;
    }
    if (maxA > segStart) {
      meshes.push(this._buildWallBox(axis, crossPos, segStart, maxA, 0, lowerH, material));
    }

    // Lintel — full-width band above the doorway. Skipped when the wall
    // is at or below DOORWAY_HEIGHT (no headroom for a lintel).
    if (wallH > DOORWAY_HEIGHT) {
      meshes.push(this._buildWallBox(axis, crossPos, minA, maxA, DOORWAY_HEIGHT, wallH, material));
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
