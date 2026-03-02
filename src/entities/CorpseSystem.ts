import * as THREE from 'three';
import type { EntityRegistry } from '@/state/EntityRegistry';
import { TendrilEffect } from './TendrilEffect';

/**
 * CorpseSystem — manages all active TendrilEffect instances.
 *
 * Spawns a tendril effect when `spawnEffect()` is called (from App on
 * receiving an `entity_death` event), and automatically begins fading it when:
 *
 *   • The entity is removed from the registry (mob/wildlife despawn).
 *   • The entity's `isAlive` flag flips back to true (player raised/respawned).
 *
 * The game loop calls `update(dt)` every frame to tick active effects.
 */
export class CorpseSystem {
  private effects: Map<string, TendrilEffect> = new Map();
  private unsubs:  Array<() => void>          = [];

  constructor(
    private readonly scene:    THREE.Scene,
    private readonly entities: EntityRegistry,
  ) {
    // Mob/wildlife removed → start fading its tendril effect
    this.unsubs.push(
      entities.onRemove(id => {
        this.effects.get(id)?.beginFade();
      }),
    );

    // Entity came back alive (raised / respawned) → fade the tendrils
    this.unsubs.push(
      entities.onUpdate(entity => {
        if (entity.isAlive === true && entity.id) {
          this.effects.get(entity.id)?.beginFade();
        }
      }),
    );
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a tendril effect at `position` for `entityId`.
   * If the entity already has an active effect (e.g. duplicate event), the old
   * one is cleanly disposed before the new one begins.
   *
   * @param entityId               Entity that died.
   * @param position               World-space position of the death.
   * @param dissolveDurationSeconds  How long until corpse fully dissolves
   *                               (≤10 s for mobs, 3600 for players).
   */
  spawnEffect(
    entityId:                string,
    position:                THREE.Vector3,
    dissolveDurationSeconds: number,
  ): void {
    // Clean up any stale effect for this entity
    const existing = this.effects.get(entityId);
    if (existing) {
      existing.dispose();
    }

    const effect = new TendrilEffect(this.scene, position, dissolveDurationSeconds);
    this.effects.set(entityId, effect);
  }

  /**
   * Called every frame from the game loop.
   * Ticks all active effects and removes any that have fully faded.
   */
  update(dt: number): void {
    for (const [id, effect] of this.effects) {
      const done = effect.update(dt);
      if (done) {
        effect.dispose();
        this.effects.delete(id);
      }
    }
  }

  /** Dispose all active effects and unsubscribe from the entity registry. */
  dispose(): void {
    for (const effect of this.effects.values()) {
      effect.dispose();
    }
    this.effects.clear();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }
}
