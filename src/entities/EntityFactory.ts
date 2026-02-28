import * as THREE from 'three';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import { PlayerEntity } from './PlayerEntity';
import { RemoteEntity } from './RemoteEntity';
import type { EntityObject } from './EntityObject';
import type { Entity } from '@/network/Protocol';

/**
 * EntityFactory — bridges EntityRegistry events to Three.js scene objects.
 *
 * Listens to the registry and creates/updates/destroys EntityObject instances.
 * Maintains the id → EntityObject map that the rest of the scene uses.
 */
export class EntityFactory {
  private objects = new Map<string, EntityObject>();
  private player:  PlayerEntity | null = null;

  constructor(
    private readonly scene:    THREE.Scene,
    private readonly registry: EntityRegistry,
    private readonly playerState: PlayerState,
  ) {
    registry.onAdd(    entity => this._onCreate(entity));
    registry.onUpdate( entity => this._onUpdate(entity));
    registry.onRemove( id     => this._onRemove(id));
  }

  getPlayerEntity(): PlayerEntity | null {
    return this.player;
  }

  getObject(id: string): EntityObject | undefined {
    return this.objects.get(id);
  }

  getAllObjects(): EntityObject[] {
    return Array.from(this.objects.values());
  }

  /** Called every frame — ticks all entity interpolators. */
  update(dt: number): void {
    for (const obj of this.objects.values()) {
      obj.update(dt);
    }
  }

  dispose(): void {
    for (const obj of this.objects.values()) {
      obj.dispose();
    }
    this.objects.clear();
    this.player = null;
  }

  // ── Registry event handlers ───────────────────────────────────────────────

  private _onCreate(entity: Entity): void {
    const isPlayer = entity.id === this.registry.playerId;

    let obj: EntityObject;
    if (isPlayer) {
      // Reconstruct CharacterState-shaped object from what we have
      const cs = {
        ...entity,
        position: entity.position ?? { x: 0, y: 0, z: 0 },
        heading:  entity.heading  ?? 0,
        rotation: { x: 0, y: 0, z: 0 },
        health:   entity.health   ?? { current: 0, max: 0 },
        stamina:  { current: 0, max: 0 },
        mana:     { current: 0, max: 0 },
        isAlive:  entity.isAlive  ?? true,
      } as Parameters<typeof PlayerEntity>[0];

      const pe = new PlayerEntity(cs, this.scene);
      this.player = pe;
      obj = pe;
    } else {
      obj = new RemoteEntity(entity, this.scene);
    }

    this.objects.set(entity.id, obj);
  }

  private _onUpdate(entity: Entity): void {
    const obj = this.objects.get(entity.id);
    if (!obj) {
      this._onCreate(entity);
      return;
    }

    if (entity.position) {
      const pos = new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z);
      obj.setTargetPosition(pos, entity.heading, entity.movementDuration);
    }
  }

  private _onRemove(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.dispose();
    this.objects.delete(id);
    if (obj === this.player) this.player = null;
  }
}
