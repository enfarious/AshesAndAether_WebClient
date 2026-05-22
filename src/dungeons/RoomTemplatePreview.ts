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

interface CollisionRect {
  minX: number; minZ: number; maxX: number; maxZ: number;
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
   *  before the server-side resolveMovement snaps them back. */
  private collisionRects: CollisionRect[] = [];

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
        roomGroup.position.set(placement.origin.x, placement.origin.y, placement.origin.z);
        this.group.add(roomGroup);
        // Compute world-space, halo-inflated collision rects for this room.
        for (const rect of this._computeWallRects(placement.template, placement.origin)) {
          this.collisionRects.push(rect);
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
      // Register each room sub-group as a camera-collision target so the
      // spring-arm doesn't clip through walls/ceilings. Position is final
      // because we set it above + scene.add before adding the target.
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

  clear(): void {
    this.collisionRects = [];
    // Gate slabs live under this.group — the traverse-dispose below frees
    // their geometry/material; just drop the tracking maps here.
    this.gateMeshes.clear();
    this.gateCollisionRects.clear();
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
