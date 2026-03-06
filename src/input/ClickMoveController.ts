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
    const entityObjects = this.factory.getAllObjects()
      .map(obj => obj.object3d)
      .filter(o => o.userData['entityId'] !== this.registry.playerId);

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

    if (this.heightmap) {
      const hit = this.heightmap.raycast(this.raycaster.ray);
      if (!hit) return;
      this.socket.sendMovePosition({ x: hit.x, y: hit.y, z: hit.z });
      // Predict at the same speed the server will use: base × jog multiplier
      // (sendMovePosition defaults to 'jog').
      const speed = this.player.baseMovementSpeed * SPEED_MULTIPLIERS['jog'] || 5.0;
      this._playerEntity?.startClickMove(new THREE.Vector3(hit.x, hit.y, hit.z), speed);
      return;
    }

    // Fallback for flat terrain (e.g. village zones): intersect y=0 ground plane
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(groundPlane, hit)) {
      this.socket.sendMovePosition({ x: hit.x, y: 0, z: hit.z });
      const speed = this.player.baseMovementSpeed * SPEED_MULTIPLIERS['jog'] || 5.0;
      this._playerEntity?.startClickMove(new THREE.Vector3(hit.x, 0, hit.z), speed);
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
