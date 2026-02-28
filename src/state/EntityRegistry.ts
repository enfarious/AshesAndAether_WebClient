import type { Entity, Vector3 } from '@/network/Protocol';

type EntityListener    = (entity: Entity) => void;
type EntityIdListener  = (id: string) => void;

/**
 * EntityRegistry — single source of truth for all entities in the current zone.
 *
 * Owns the canonical map of entityId → Entity data.
 * The Three.js scene objects (EntityObject subclasses) observe this registry.
 *
 * Does NOT hold Three.js objects — that's EntityFactory/scene's job.
 */
export class EntityRegistry {
  private _entities = new Map<string, Entity>();
  private _playerId: string | null = null;

  private onAddListeners    = new Set<EntityListener>();
  private onUpdateListeners = new Set<EntityListener>();
  private onRemoveListeners = new Set<EntityIdListener>();

  // ── Getters ───────────────────────────────────────────────────────────────

  get playerId(): string | null { return this._playerId; }

  getAll(): Entity[] {
    return Array.from(this._entities.values());
  }

  get(id: string): Entity | undefined {
    return this._entities.get(id);
  }

  has(id: string): boolean {
    return this._entities.has(id);
  }

  getNonPlayer(): Entity[] {
    return Array.from(this._entities.values())
      .filter(e => e.id !== this._playerId);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  applyWorldEntry(entities: Entity[], playerId: string): void {
    // Remove old entities
    for (const id of this._entities.keys()) {
      this._notifyRemove(id);
    }
    this._entities.clear();

    this._playerId = playerId;

    for (const entity of entities) {
      this._entities.set(entity.id, entity);
      this._notifyAdd(entity);
    }
  }

  add(entity: Entity): void {
    this._entities.set(entity.id, { ...entity });
    this._notifyAdd(entity);
  }

  update(id: string, partial: Partial<Entity>): void {
    const existing = this._entities.get(id);
    if (!existing) {
      // If we receive an update for an unknown entity, treat it as an add
      if (partial.id && partial.position) {
        const full = partial as Entity;
        this.add(full);
        return;
      }
      return;
    }

    const merged: Entity = {
      ...existing,
      ...partial,
      position: partial.position
        ? { ...partial.position }
        : existing.position,
    };
    this._entities.set(id, merged);
    this._notifyUpdate(merged);
  }

  updatePosition(id: string, position: Vector3, heading?: number, movementDuration?: number): void {
    const existing = this._entities.get(id);
    if (!existing) return;

    const merged: Entity = {
      ...existing,
      position: { ...position },
      heading:  heading ?? existing.heading,
      movementDuration: movementDuration ?? existing.movementDuration,
    };
    this._entities.set(id, merged);
    this._notifyUpdate(merged);
  }

  remove(id: string): void {
    if (!this._entities.has(id)) return;
    this._entities.delete(id);
    this._notifyRemove(id);
  }

  clear(): void {
    for (const id of this._entities.keys()) {
      this._notifyRemove(id);
    }
    this._entities.clear();
    this._playerId = null;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  onAdd(listener: EntityListener):    () => void {
    this.onAddListeners.add(listener);
    return () => this.onAddListeners.delete(listener);
  }

  onUpdate(listener: EntityListener): () => void {
    this.onUpdateListeners.add(listener);
    return () => this.onUpdateListeners.delete(listener);
  }

  onRemove(listener: EntityIdListener): () => void {
    this.onRemoveListeners.add(listener);
    return () => this.onRemoveListeners.delete(listener);
  }

  private _notifyAdd(entity: Entity):   void { this.onAddListeners.forEach(fn => fn(entity)); }
  private _notifyUpdate(entity: Entity): void { this.onUpdateListeners.forEach(fn => fn(entity)); }
  private _notifyRemove(id: string):    void { this.onRemoveListeners.forEach(fn => fn(id)); }
}
