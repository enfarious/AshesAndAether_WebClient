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
  /** Separate subscription channel for VITALS-ONLY updates (HP / MP /
   *  stamina deltas pushed by the server's 1Hz pet vitals tick). Distinct
   *  from onUpdate so the EntityFactory's position-update path doesn't
   *  fire on every vitals change — that was causing every moving pet to
   *  restart its interp lerp once a second, visible as a 1Hz hitch. */
  private onVitalsListeners = new Set<EntityListener>();

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
    if (this._entities.has(entity.id)) {
      // Entity already tracked — merge as update to avoid duplicate scene objects.
      this.update(entity.id, entity);
      return;
    }
    this._entities.set(entity.id, { ...entity });
    this._notifyAdd(entity);
  }

  update(id: string, partial: Partial<Entity>): void {
    const existing = this._entities.get(id);
    if (!existing) {
      // Update for an unknown entity. Only synthesize if the payload carries
      // enough info to render correctly (specifically `type` — without it the
      // entity falls through to the magenta-alarm placeholder). Otherwise drop
      // the update; the proper `added` payload will follow.
      if (partial.id && partial.position && partial.type) {
        this.add(partial as Entity);
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
    };
    if (heading !== undefined) merged.heading = heading;
    else if (existing.heading !== undefined) merged.heading = existing.heading;
    if (movementDuration !== undefined) merged.movementDuration = movementDuration;
    else if (existing.movementDuration !== undefined) merged.movementDuration = existing.movementDuration;
    this._entities.set(id, merged);
    this._notifyUpdate(merged);
  }

  /** Patch HP/MP/Stamina on an existing entity without touching position
   *  or running the regular onUpdate listeners (which would route through
   *  EntityFactory's position-update path and restart movement interp).
   *  Server uses this for companions + hirelings; players receive vitals
   *  via state_update.character → PlayerState. */
  applyVitals(
    id: string,
    vitals: { health?: Entity['health']; mana?: Entity['mana']; stamina?: Entity['stamina'] },
  ): void {
    const existing = this._entities.get(id);
    if (!existing) return;
    const merged: Entity = { ...existing };
    if (vitals.health)  merged.health  = { ...vitals.health };
    if (vitals.mana)    merged.mana    = { ...vitals.mana };
    if (vitals.stamina) merged.stamina = { ...vitals.stamina };
    this._entities.set(id, merged);
    for (const fn of this.onVitalsListeners) fn(merged);
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

  /** Subscribe to vitals-only patches (state_update.vitals). Fires when a
   *  pet's HP/MP/stamina changes without any position update. */
  onVitalsUpdate(listener: EntityListener): () => void {
    this.onVitalsListeners.add(listener);
    return () => this.onVitalsListeners.delete(listener);
  }

  private _notifyAdd(entity: Entity):   void { this.onAddListeners.forEach(fn => fn(entity)); }
  private _notifyUpdate(entity: Entity): void { this.onUpdateListeners.forEach(fn => fn(entity)); }
  private _notifyRemove(id: string):    void { this.onRemoveListeners.forEach(fn => fn(id)); }
}
