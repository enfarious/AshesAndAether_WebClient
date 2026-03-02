import * as THREE from 'three';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import type { HeightmapService } from '@/world/HeightmapService';
import { PlayerEntity } from './PlayerEntity';
import { RemoteEntity } from './RemoteEntity';
import type { EntityObject } from './EntityObject';
import type { Entity } from '@/network/Protocol';

/**
 * EntityFactory — bridges EntityRegistry events to Three.js scene objects.
 *
 * Listens to the registry and creates/updates/destroys EntityObject instances.
 * Maintains the id → EntityObject map that the rest of the scene uses.
 *
 * Also manages the target-highlight ring: a flat torus that tracks the
 * currently selected target each frame, spinning and pulsing opacity.
 */
export class EntityFactory {
  private objects = new Map<string, EntityObject>();
  private player:  PlayerEntity | null = null;

  // ── Heightmap (for fixing entities with missing Y) ───────────────────────
  private heightmap: HeightmapService | null = null;

  // ── Target highlight ring ─────────────────────────────────────────────────
  private highlightRing: THREE.Mesh | null = null;
  private highlightMat:  THREE.MeshBasicMaterial | null = null;
  private highlightAge   = 0;
  private unsubTarget:   (() => void) | null = null;

  constructor(
    private readonly scene:       THREE.Scene,
    private readonly registry:    EntityRegistry,
    private readonly playerState: PlayerState,
  ) {
    registry.onAdd(   entity => this._onCreate(entity));
    registry.onUpdate(entity => this._onUpdate(entity));
    registry.onRemove(id     => this._onRemove(id));

    this._buildHighlight();
    this.unsubTarget = playerState.onChange(() => this._syncHighlight());
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

  /**
   * Provide the heightmap so entities with missing Y (e.g. plants at Y=0)
   * can be placed at the correct terrain elevation.
   * Also retroactively fixes any existing entities that were created before
   * the heightmap was available.
   */
  setHeightmap(hm: HeightmapService | null): void {
    this.heightmap = hm;
    if (!hm) return;

    // Fix any entities already in the scene with Y ≈ 0
    for (const [id, obj] of this.objects) {
      const regEntity = this.registry.get(id);
      if (!regEntity || !regEntity.position) continue;
      if (Math.abs(regEntity.position.y) > 1) continue; // already has a real Y

      const elev = hm.getElevation(regEntity.position.x, regEntity.position.z);
      if (elev !== null) {
        obj.object3d.position.y = elev;
      }
    }
  }

  /** Called every frame — ticks all entity interpolators and the highlight ring. */
  update(dt: number): void {
    // Feed client-side prediction into PlayerEntity BEFORE the entity tick so
    // that update() consumes the predicted position on this same frame.
    const localPos = this.playerState.localPosition;
    if (this.player && localPos) {
      this.player.setPredictedPosition(
        new THREE.Vector3(localPos.x, localPos.y, localPos.z),
      );
    }

    for (const obj of this.objects.values()) {
      obj.update(dt);
    }
    this._updateHighlight(dt);
  }

  dispose(): void {
    for (const obj of this.objects.values()) {
      obj.dispose();
    }
    this.objects.clear();
    this.player = null;

    if (this.unsubTarget) { this.unsubTarget(); this.unsubTarget = null; }
    if (this.highlightRing) {
      this.scene.remove(this.highlightRing);
      this.highlightRing.geometry.dispose();
      this.highlightMat?.dispose();
      this.highlightRing = null;
      this.highlightMat  = null;
    }
  }

  // ── Registry event handlers ───────────────────────────────────────────────

  private _onCreate(entity: Entity): void {
    const isPlayer = entity.id === this.registry.playerId;

    // Fix entities with missing Y (server sends Y=0 for plants) by looking up
    // the terrain elevation from the heightmap.
    if (!isPlayer && entity.position && Math.abs(entity.position.y) <= 1 && this.heightmap) {
      const elev = this.heightmap.getElevation(entity.position.x, entity.position.z);
      if (elev !== null) {
        entity = { ...entity, position: { ...entity.position, y: elev } };
      }
    }

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

    // Allow entity objects to react to non-position attribute changes
    // (e.g. plants update their scale/colour when growth stage changes).
    obj.applyUpdate(entity);
  }

  private _onRemove(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.dispose();
    this.objects.delete(id);
    if (obj === this.player) this.player = null;
  }

  // ── Target highlight ring ─────────────────────────────────────────────────

  /**
   * Build the torus mesh once at startup. It stays hidden until a target is
   * selected, then tracks that target's rendered position each frame.
   *
   * TorusGeometry lies in the XY plane by default; rotating X by 90° flattens
   * it onto the XZ ground plane so it rings the entity's feet.
   */
  private _buildHighlight(): void {
    const geo = new THREE.TorusGeometry(0.68, 0.038, 8, 40);
    this.highlightMat = new THREE.MeshBasicMaterial({
      color:       0xddaa22,   // amber/gold — visible on all terrain types
      transparent: true,
      opacity:     0,
      depthWrite:  false,
    });
    this.highlightRing = new THREE.Mesh(geo, this.highlightMat);
    this.highlightRing.rotation.x = Math.PI / 2; // lay flat on XZ plane
    this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);
  }

  /** Called when playerState changes — show/hide ring based on target presence. */
  private _syncHighlight(): void {
    if (!this.highlightRing) return;
    const hasTarget = !!this.playerState.targetId;
    this.highlightRing.visible = hasTarget;
    if (!hasTarget) this.highlightAge = 0;
  }

  /**
   * Each frame: snap ring to target's rendered position, spin slowly,
   * and pulse opacity between 0.45 and 0.85 for a "selected" feel.
   */
  private _updateHighlight(dt: number): void {
    if (!this.highlightRing || !this.highlightMat) return;

    const targetId = this.playerState.targetId;
    if (!targetId) {
      this.highlightRing.visible = false;
      return;
    }

    const obj = this.objects.get(targetId);
    if (!obj) {
      this.highlightRing.visible = false;
      return;
    }

    // Track the entity's interpolated (rendered) position, not server position.
    // Lift slightly so the ring sits just above the ground plane.
    const p = obj.object3d.position;
    this.highlightRing.position.set(p.x, p.y + 0.05, p.z);
    this.highlightRing.visible = true;

    // Slow spin around Y axis
    this.highlightRing.rotation.y -= dt * 0.9;

    // Soft opacity pulse: 0.45 ↔ 0.85
    this.highlightAge += dt;
    this.highlightMat.opacity = 0.65 + 0.20 * Math.sin(this.highlightAge * 3.5);
  }
}
