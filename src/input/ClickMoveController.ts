import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';
import type { SocketClient }     from '@/network/SocketClient';
import type { PlayerState }      from '@/state/PlayerState';
import type { EntityRegistry }   from '@/state/EntityRegistry';
import type { OrbitCamera }      from '@/camera/OrbitCamera';
import type { EntityFactory }    from '@/entities/EntityFactory';
import { type PlayerEntity, PlayerMoveMode } from '@/entities/PlayerEntity';
import { SPEED_MULTIPLIERS }     from '@/network/Protocol';

/**
 * ClickMoveController — translates left-click into a move command.
 *
 * Hit-test priority:
 *   1. Entity capsule  → target the entity
 *   2. Heightmap ray   → send move_position to server
 *
 * We use the server's own DEM heightmap for click detection rather than
 * raycasting against the terrain GLB mesh.  The GLB has downward-facing
 * normals (trimesh export artifact) and 265k triangles, both of which make
 * Three.js mesh raycasting unreliable and slow.  The heightmap march is
 * fast (O(distance/10) iterations) and always matches server physics.
 */
export class ClickMoveController {
  private raycaster = new THREE.Raycaster();
  private heightmap: HeightmapService | null = null;
  private _playerEntity: PlayerEntity | null = null;

  /** Wire the player entity after EntityFactory creates it. */
  setPlayerEntity(pe: PlayerEntity | null): void { this._playerEntity = pe; }

  constructor(
    private readonly canvas:   HTMLElement,
    private readonly camera:   OrbitCamera,
    private readonly socket:   SocketClient,
    private readonly player:   PlayerState,
    private readonly registry: EntityRegistry,
    private readonly factory:  EntityFactory,
  ) {
    canvas.addEventListener('click', this._onClick);
  }

  setHeightmap(hm: HeightmapService | null): void {
    this.heightmap = hm;
  }

  // kept for API compatibility — no longer needed for raycasting
  setWorldRoot(_root: THREE.Object3D): void {}
  clearWorldRoot(): void {}

  dispose(): void {
    this.canvas.removeEventListener('click', this._onClick);
  }

  private _onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('#ui-root')) return;

    const ndc = new THREE.Vector2(
      ( e.clientX / window.innerWidth)  * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );

    this.raycaster.setFromCamera(ndc, this.camera.getCamera());

    // ── 1. Entity hit? ───────────────────────────────────────────────────────
    // Plants are excluded for the same reason TabTargetService excludes them
    // (see the note on its candidate switch): harvest is proximity-driven, so
    // a target serves no purpose. Trees and rocks are already unpickable —
    // trees because EntityFactory skips mesh creation for FOREST_SPECIES, rocks
    // because they live in RockRegistry and were never entities. Excluding
    // plants makes all three harvest anchors behave alike: walk up, use the
    // node hint, /harvest. Anything clickable is something you can act on.
    const entityObjects = this.factory.getAllObjects()
      .map(obj => obj.object3d)
      .filter(o => {
        const id = o.userData['entityId'] as string | undefined;
        if (!id || id === this.registry.playerId) return false;
        return this.registry.get(id)?.type !== 'plant';
      });

    const entityHits = this.raycaster.intersectObjects(entityObjects, true);
    if (entityHits.length > 0) {
      const id = this._resolveEntityId(entityHits[0]!.object);
      if (id && id !== this.registry.playerId) {
        this.player.setTarget(id, this.registry.get(id)?.name ?? id);
        return;
      }
    }

    if (!this.player.targetLocked) this.player.clearTarget();

    // ── 2. Terrain hit? ─────────────────────────────────────────────────────
    // WASD has priority over click-to-move
    if (this._playerEntity?.mode === PlayerMoveMode.WASD) return;
    // Bail entirely when stunned or mid-cast (no rotation either).
    if (!this.player.isAlive || this.player.isRotationLocked) return;

    if (this.heightmap) {
      const hit = this.heightmap.raycast(this.raycaster.ray);
      if (!hit) return;
      this.socket.sendMovePosition({ x: hit.x, y: hit.y, z: hit.z });
      // Skip local kick-prediction when rooted — server will rotate the
      // player toward the click without moving them.
      if (!this.player.isMovementLocked) {
        const walkSpeed = this.player.baseMovementSpeed * SPEED_MULTIPLIERS['jog'];
        this._playerEntity?.kickClickPredict(new THREE.Vector3(hit.x, hit.y, hit.z), walkSpeed);
      }
      return;
    }

    // Fallback for flat terrain (e.g. village zones): intersect y=0 ground plane
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(groundPlane, hit)) {
      this.socket.sendMovePosition({ x: hit.x, y: 0, z: hit.z });
      const walkSpeed = this.player.baseMovementSpeed * SPEED_MULTIPLIERS['jog'];
      this._playerEntity?.kickClickPredict(new THREE.Vector3(hit.x, 0, hit.z), walkSpeed);
    }
  };

  private _resolveEntityId(obj: THREE.Object3D): string | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData['entityId']) return cur.userData['entityId'] as string;
      cur = cur.parent;
    }
    return null;
  }
}
