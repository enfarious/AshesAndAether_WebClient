import * as THREE from 'three';
import type { HeightmapService } from '@/world/HeightmapService';
import type { SocketClient }     from '@/network/SocketClient';
import type { PlayerState }      from '@/state/PlayerState';
import type { EntityRegistry }   from '@/state/EntityRegistry';
import type { OrbitCamera }      from '@/camera/OrbitCamera';
import type { EntityFactory }    from '@/entities/EntityFactory';

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

    this.player.clearTarget();

    // ── 2. Heightmap hit? ────────────────────────────────────────────────────
    if (!this.heightmap) {
      console.warn('[ClickMove] No heightmap loaded — cannot click-to-move');
      return;
    }

    const hit = this.heightmap.raycast(this.raycaster.ray);
    if (!hit) return;

    console.log(`[ClickMove] Heightmap hit (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}, ${hit.z.toFixed(1)})`);
    this.socket.sendMovePosition({ x: hit.x, y: hit.y, z: hit.z });
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
