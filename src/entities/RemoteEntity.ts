import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EntityObject } from './EntityObject';
import { HeadingIndicator, type HeadingIndicatorProminence } from './HeadingIndicator';
import { ClientConfig } from '@/config/ClientConfig';
import type { Entity } from '@/network/Protocol';
import type { HeightmapService } from '@/world/HeightmapService';

/**
 * MovementInterpolator — handles smooth server-authoritative movement.
 *
 * When a position update arrives:
 *   - If the delta is within snap threshold, lerp to target
 *   - If the delta exceeds snap threshold (large correction), snap immediately
 */
class MovementInterpolator {
  private from     = new THREE.Vector3();
  private target   = new THREE.Vector3();
  /** Reusable scratch vector — avoids allocating a new Vector3 every tick. */
  private _scratch = new THREE.Vector3();
  private elapsed  = 0;
  private duration = 0;
  private active   = false;

  get isActive(): boolean { return this.active; }
  get targetPosition(): THREE.Vector3 { return this.target.clone(); }

  setTarget(
    current:    THREE.Vector3,
    target:     THREE.Vector3,
    durationMs: number,
    from?:      THREE.Vector3,
  ): boolean {
    // Use server's previous position to check if this is a genuine large teleport,
    // not the visual position (which may lag behind). The lerp itself always starts
    // from the current visual position so there's no backwards snap.
    const snapFrom = from ?? current;
    const dist = snapFrom.distanceTo(target);

    if (dist > ClientConfig.movementSnapThreshold) {
      this.active = false;
      return false;
    }

    this.from.copy(current);
    this.target.copy(target);
    this.elapsed  = 0;
    this.duration = durationMs / 1000;
    this.active   = true;
    return true;
  }

  tick(dt: number): THREE.Vector3 | null {
    if (!this.active) return null;
    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.duration, 1);
    this._scratch.copy(this.from).lerp(this.target, easeOut(t));
    if (t >= 1) this.active = false;
    return this._scratch;
  }
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

/** Tags whose mesh is a static structure — no heading, no indicator. */
const _NO_HEADING_TAGS = new Set([
  'vault_portal',
  'vault_exit_portal',
  'hireling_console',
  'caravan_terminal',
]);

/** Returns null when the entity should not display a heading arrow at all
 *  (plants, structures). Otherwise picks colour + prominence per the
 *  playtest readability spec:
 *    - Party (companion, hireling), other players, and hostile-of-any-type
 *      get the prominent arrow.
 *    - NPCs, non-hostile mobs, and wildlife get the subtle arrow so the
 *      world isn't a sea of bright indicators when you're not in combat. */
function _decideHeadingIndicator(entity: Entity): { color: number; prominence: HeadingIndicatorProminence } | null {
  const type = entity.type?.toLowerCase() ?? '';
  if (type === 'plant') return null;
  if (entity.tag && _NO_HEADING_TAGS.has(entity.tag)) return null;
  // Trees in case a tree slips through here without being intercepted by
  // ForestRenderer's species path. Belt and suspenders.
  if (type === 'plant' || EntityObject.TREE_TAGS.has(entity.tag ?? '')) return null;

  // Hostiles of any type read as the same threat colour — players need to
  // ID "things that will hit me" at a glance, regardless of mob species.
  if (entity.hostile) return { color: 0xff3333, prominence: 'prominent' };

  switch (type) {
    case 'companion': return { color: 0x44ddee, prominence: 'prominent' };
    case 'hireling':  return { color: 0xffaa44, prominence: 'prominent' };
    case 'player':    return { color: 0xffdd44, prominence: 'prominent' };
    case 'npc':       return { color: 0x44ddee, prominence: 'subtle' };
    case 'mob':       return { color: 0xffa500, prominence: 'subtle' };
    case 'wildlife':  return { color: 0xc8a870, prominence: 'subtle' };
    default:          return null;
  }
}

/**
 * RemoteEntity — a non-player entity (NPC, mob, other player, companion, wildlife, plant) in the scene.
 *
 * Shape / colour legend:
 *   player    — blue capsule
 *   companion — green capsule
 *   npc       — green sphere
 *   mob       — yellow sphere (non-hostile) / red sphere (hostile)
 *   wildlife  — tan cone    (non-hostile) / red cone  (hostile)
 *   plant     — green tapered cylinder; scale + colour vary by growth stage
 */
export class RemoteEntity extends EntityObject {
  private interp        = new MovementInterpolator();
  private _entityType:  string;
  private _plantMeshRef: THREE.Mesh | null = null;
  private _plantStage:  string = '';

  /** Smooth heading interpolation — prevents jarring rotation snaps. */
  private _targetHeading: number | null = null;
  private static readonly HEADING_LERP_SPEED = 10; // radians per second (fast but smooth)

  /** Heading chevron — top-level scene mesh (NOT parented to entity root).
   *  Its tangent-plane fit is driven each frame in update() from this
   *  entity's world XZ + rotation.y. _headingMode caches the prominence +
   *  colour signature so applyUpdate can rebuild on a hostility flip
   *  (non-hostile mob aggros etc) without spurious re-creation. */
  private _heading:        HeadingIndicator     | null = null;
  private _headingMode:    string                      = '';   // cached "prom|color" key
  private _headingHm:      HeightmapService     | null = null;
  private _headingScene:   THREE.Scene          | null = null;

  /** Dead-reckoning velocity (m/s in world space). Set from heading + speed
   *  on each authoritative position update. Cleared when speed=0. update()
   *  walks the entity forward by this each frame so a sustained-direction
   *  mover keeps moving smoothly between server broadcasts (which may be
   *  ~1s apart for steady movement after server-side suppression). */
  private _velX = 0;
  private _velZ = 0;
  /** performance.now() of the last server position update — caps how long
   *  extrapolation is allowed to run unattended. */
  private _lastServerUpdateMs = 0;
  /** Hard cap on extrapolation duration. Past this we freeze rather than
   *  walk an entity off into the void if the connection stalls. Comfortably
   *  longer than the server's MOVE_HEARTBEAT_MS so a healthy heartbeat
   *  always lands inside the window. */
  private static readonly EXTRAPOLATION_CAP_MS = 2500;

  /** Jump arc — added to the rendered Y on top of the interp/extrapolation
   *  result. Triggered by `player_jump` events from the server. The local
   *  player handles its own arc on a body sub-mesh (camera follows root),
   *  but RemoteEntity has no camera attachment so we bounce the root
   *  itself. */
  private _jumpArcEndsAt   = 0;
  private _jumpArcStartedAt = 0;
  /** Matches PlayerEntity defaults so local + remote arcs read the same. */
  private static readonly JUMP_DURATION_MS = 800;
  private static readonly JUMP_APEX_M      = 1.2;

  // ── Static GLB model cache ────────────────────────────────────────────────
  // Shared across all RemoteEntity instances so the same model isn't fetched
  // twice. Keyed by modelAsset path (e.g. "dungeon/Dungeon_Entrance_01.glb").
  private static _glbCache  = new Map<string, THREE.Group>();
  private static _glbLoader = new GLTFLoader();

  /** Clone a cached model or return null if not yet cached. */
  private static _cloneCachedModel(assetPath: string): THREE.Group | null {
    const cached = RemoteEntity._glbCache.get(assetPath);
    if (!cached) return null;
    const clone = cached.clone(true);
    // Deep-clone materials so per-instance changes don't bleed.
    clone.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.material = (child.material as THREE.Material).clone();
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }

  constructor(entity: Entity, scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name  = `entity_${entity.id}`;

    const type = entity.type?.toLowerCase() ?? '';
    let mesh: THREE.Mesh;
    let placeholderForModel: THREE.Mesh | null = null;

    if (entity.modelAsset) {
      // GLB model — start with a small placeholder marker, swap when loaded
      mesh = EntityObject._sphereMesh(0xff8800, 0.25); // bright orange marker
      placeholderForModel = mesh;
    } else if (entity.tag === 'vault_portal' || entity.tag === 'vault_exit_portal') {
      // Custom: emissive ring + light column on the ground. Geometry lives
      // directly in `root` so multiple meshes form the portal. Same visual
      // for entry and exit; the action UI distinguishes them.
      EntityObject._addVaultPortalToGroup(root);
      mesh = null as unknown as THREE.Mesh;
    } else if (entity.tag === 'hireling_console') {
      // Vault-entry obelisk — the thing players F to open the hireling panel.
      EntityObject._addHirelingConsoleToGroup(root);
      mesh = null as unknown as THREE.Mesh;
    } else if (entity.tag === 'caravan_terminal') {
      // Boarding kiosk at each civic / guild beacon — F opens the
      // destination panel for in-zone fast travel.
      EntityObject._addCaravanTerminalToGroup(root);
      mesh = null as unknown as THREE.Mesh;
    } else if (type === 'player' || type === 'companion' || type === 'hireling') {
      mesh = EntityObject._capsuleMesh(EntityObject._entityColor(entity));
    } else if (type === 'wildlife') {
      mesh = EntityObject._animalMesh(entity.tag ?? '');
    } else if (type === 'plant' && EntityObject.TREE_TAGS.has(entity.tag ?? '')) {
      EntityObject._addTreeToGroup(root, entity.tag ?? '');
      mesh = null as unknown as THREE.Mesh; // tree geometry goes directly into root
    } else if (type === 'plant') {
      const stage = (entity.currentAction as string | undefined) ?? 'mature';
      mesh = EntityObject._plantMesh(stage);
    } else {
      // npc, mob, and any unknown type → sphere
      if (!type || (type !== 'npc' && type !== 'mob')) {
        // eslint-disable-next-line no-console
        console.warn('[RemoteEntity] Magenta-fallback for entity:', JSON.stringify(entity));
      }
      mesh = EntityObject._sphereMesh(EntityObject._entityColor(entity));
    }

    if (mesh) root.add(mesh);

    // Apply modelScale to the render root for placeholder meshes (boss
    // arena bosses scale 3× this way without a custom GLB). The GLB
    // load path applies scale to the loaded model directly, so skip
    // here when modelAsset is set to avoid double-scaling.
    if (!entity.modelAsset && entity.modelScale && entity.modelScale !== 1) {
      root.scale.setScalar(entity.modelScale);
    }

    if (entity.position) {
      root.position.set(entity.position.x, entity.position.y, entity.position.z);
    }
    if (entity.heading !== undefined) {
      // See PlayerEntity.setHeading note on convention — server's heading H
      // (degrees, 0 = +Z, atan2(dx, dz)) maps to rotation.y = H_rad. The
      // legacy `-H` was masked by symmetric capsule meshes.
      root.rotation.y = THREE.MathUtils.degToRad(entity.heading);
    }

    scene.add(root);
    super(entity.id, root);

    // Store for later updates
    this._entityType   = type;
    this._headingScene = scene;

    // Heading indicator — skipped for structures (portals, consoles, kiosks)
    // and plants. Everything that can face a direction gets a chevron.
    this._ensureHeadingIndicator(entity);
    if (!placeholderForModel && type === 'plant' && mesh && !EntityObject.TREE_TAGS.has(entity.tag ?? '')) {
      this._plantMeshRef = mesh;
      this._plantStage   = (entity.currentAction as string | undefined) ?? 'mature';
    }

    // Kick off async model load after super() has been called
    if (placeholderForModel && entity.modelAsset) {
      this._loadModel(entity.modelAsset, root, placeholderForModel, entity.modelScale);
    }
  }

  // ── GLB loading ─────────────────────────────────────────────────────────

  /**
   * Load a GLB model from the server asset directory, replace the placeholder
   * mesh, and cache the prototype for future clones.
   */
  private _loadModel(assetPath: string, root: THREE.Group, placeholder: THREE.Mesh, scale?: number): void {
    const s = scale ?? 1;

    // Fast path: already cached → swap immediately
    const cached = RemoteEntity._cloneCachedModel(assetPath);
    if (cached) {
      root.remove(placeholder);
      placeholder.geometry?.dispose();
      (placeholder.material as THREE.Material)?.dispose();
      if (s !== 1) cached.scale.setScalar(s);
      root.add(cached);
      return;
    }

    // Async load
    const url = `${ClientConfig.serverUrl}/world/assets/${assetPath}`;
    RemoteEntity._glbLoader.load(
      url,
      (gltf) => {
        // Store prototype in cache (unscaled)
        RemoteEntity._glbCache.set(assetPath, gltf.scene.clone(true));

        // Prepare the loaded scene
        gltf.scene.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        // Apply scale
        if (s !== 1) gltf.scene.scale.setScalar(s);

        // Swap placeholder → model
        root.remove(placeholder);
        placeholder.geometry?.dispose();
        (placeholder.material as THREE.Material)?.dispose();
        root.add(gltf.scene);
      },
      undefined, // onProgress — not needed
      (err) => {
        console.warn(`[RemoteEntity] Failed to load model '${assetPath}':`, err);
        // Keep the placeholder visible as fallback
      },
    );
  }

  /** Feed the heightmap to this entity's heading chevron so its
   *  tangent-plane fit samples real terrain. Called by EntityFactory.setHeightmap
   *  on zone change. Safe with null (vault). */
  setHeightmap(hm: HeightmapService | null): void {
    this._headingHm = hm;
    this._heading?.setHeightmap(hm);
  }

  /** Decide whether this entity should display a heading chevron and, if
   *  so, what colour + prominence. Re-buildable so applyUpdate can flip
   *  prominence when a non-hostile mob aggros. */
  private _ensureHeadingIndicator(entity: Entity): void {
    const decision = _decideHeadingIndicator(entity);
    if (!decision) {
      this._teardownHeadingIndicator();
      return;
    }
    const modeKey = `${decision.prominence}|${decision.color.toString(16)}`;
    if (modeKey === this._headingMode && this._heading) return;     // unchanged
    this._teardownHeadingIndicator();
    if (!this._headingScene) return;
    this._heading = new HeadingIndicator(
      this._headingScene,
      new THREE.Color(decision.color),
      decision.prominence,
    );
    if (this._headingHm) this._heading.setHeightmap(this._headingHm);
    this._headingMode = modeKey;
  }

  private _teardownHeadingIndicator(): void {
    if (this._heading) {
      this._heading.dispose();
      this._heading = null;
    }
    this._headingMode = '';
  }

  override update(dt: number): void {
    // Caravan ride: CaravanRide manager drives this entity's position +
    // rotation locally each frame. Yield to it — any interp / extrap
    // writes here would race the manager's authoritative path tick.
    if (this._caravanRiding) return;

    // Two motion sources compete each frame:
    //   - interp (smooth-correction lerp toward latest authoritative position)
    //   - extrapolation (dead-reckon along last-known velocity)
    // They take turns, not compose: interp's tick() rewrites position from
    // `from→target` each frame and would wipe extrapolation deltas from the
    // prior frame. While interp is active, it owns position; once it
    // finishes (t >= 1), extrapolation owns position until the next
    // setTarget call resets the lerp.
    if (this.interp.isActive) {
      const pos = this.interp.tick(dt);
      if (pos) this.object3d.position.copy(pos);
    } else if (this._velX !== 0 || this._velZ !== 0) {
      const sinceLastMs = performance.now() - this._lastServerUpdateMs;
      if (sinceLastMs <= RemoteEntity.EXTRAPOLATION_CAP_MS) {
        this.object3d.position.x += this._velX * dt;
        this.object3d.position.z += this._velZ * dt;
      }
    }

    // 2b. Jump arc — additive Y bounce on top of whatever the position
    //     systems set this frame. Synced visually with the server-side
    //     jump duration so the bounce ends as motion stops being driven
    //     by jumpSpeed on the server.
    if (this._jumpArcEndsAt > 0) {
      const now = performance.now();
      if (now >= this._jumpArcEndsAt) {
        this._jumpArcEndsAt = 0;
      } else {
        const t = (now - this._jumpArcStartedAt) / RemoteEntity.JUMP_DURATION_MS;
        this.object3d.position.y += Math.sin(t * Math.PI) * RemoteEntity.JUMP_APEX_M;
      }
    }

    // 3. Smooth heading interpolation (shortest-arc)
    if (this._targetHeading !== null) {
      const current = this.object3d.rotation.y;
      let delta = this._targetHeading - current;
      // Shortest arc
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) < 0.01) {
        this.object3d.rotation.y = this._targetHeading;
        this._targetHeading = null;
      } else {
        this.object3d.rotation.y += delta * Math.min(1, RemoteEntity.HEADING_LERP_SPEED * dt);
      }
    }

    // Drive the heading chevron from this entity's current world transform.
    // The chevron is a top-level scene mesh, NOT a child of root — needs
    // an explicit per-frame fit to the local terrain tangent plane.
    if (this._heading) {
      const p = this.object3d.position;
      this._heading.update(p.x, p.y, p.z, this.object3d.rotation.y);
    }
  }

  /** Override base dispose so the heading chevron (top-level scene mesh,
   *  NOT in this.object3d's hierarchy) gets cleaned up alongside the body. */
  override dispose(): void {
    this._teardownHeadingIndicator();
    super.dispose();
  }

  /** Sync chevron visibility with the body's distance-culled state. */
  override setSceneOwnedVisible(visible: boolean): void {
    this._heading?.setVisible(visible);
  }

  override setTargetPosition(
    position:        THREE.Vector3,
    heading?:        number,
    durationMs?:     number,
    from?:           THREE.Vector3,
    movementSpeed?: number,
  ): void {
    // Snapshot-interp duration. Players use a short lerp (100ms) and
    // extrapolate past it for steady WASD where the server suppresses
    // redundant ticks. AI entities (companions, hirelings, mobs, wildlife)
    // lerp over ~1.5 server ticks AND skip extrapolation entirely — server
    // is the only source of truth for them, and predicting forward past
    // the last snapshot just produces visible snap-back when the BT
    // changes the entity's heading or stops it. 150ms is close to the
    // local player's RENDER_DELAY_MS=130 so the party stays in sync
    // during caravan rides instead of drifting relative to the rider.
    const isAi = this._entityType !== 'player';
    const interpMs = durationMs ?? (isAi ? 150 : 100);

    const snapped = !this.interp.setTarget(this.object3d.position, position, interpMs, from);
    if (snapped) {
      this.object3d.position.copy(position);
    }
    if (heading !== undefined) {
      const targetRad = THREE.MathUtils.degToRad(heading);
      if (this._targetHeading === null) {
        // First update — snap to avoid spinning from 0
        this.object3d.rotation.y = targetRad;
      }
      this._targetHeading = targetRad;
    }

    this._lastServerUpdateMs = performance.now();
    if (isAi) {
      // No extrapolation for AI — let the lerp do all the smoothing. The
      // server broadcasts every move with a non-zero speed, so a stationary
      // entity just sees no update and holds. Predicting past the snapshot
      // is what produces the jerks user reported.
      this._velX = 0;
      this._velZ = 0;
    } else if (movementSpeed !== undefined && movementSpeed > 0 && heading !== undefined) {
      // Remote players: keep dead-reckoning for the server's WASD-suppression
      // window. Server convention: heading 0° = +Z (south), increases
      // clockwise. World direction is (sin H, cos H).
      const headingRad = THREE.MathUtils.degToRad(heading);
      this._velX = Math.sin(headingRad) * movementSpeed;
      this._velZ = Math.cos(headingRad) * movementSpeed;
    } else {
      this._velX = 0;
      this._velZ = 0;
    }
  }

  /** Trigger the Y-arc visual on this remote entity. Called from the
   *  app-level `player_jump` event handler for non-self entities. */
  playJump(): void {
    this._jumpArcStartedAt = performance.now();
    this._jumpArcEndsAt    = this._jumpArcStartedAt + RemoteEntity.JUMP_DURATION_MS;
  }

  /**
   * React to entity attribute changes beyond position/heading.
   * Plants update their scale and colour when the growth stage changes;
   * players + companions toggle a placeholder cart mesh when riding a
   * caravan; a non-hostile mob that aggros has its heading indicator
   * rebuilt with the threat colour + prominence.
   */
  override applyUpdate(partial: Partial<Entity>): void {
    // Caravan cart toggle — applies to player + companion entities.
    if (partial.caravanActive !== undefined) {
      this._caravanRiding = partial.caravanActive === true;
      this._setCaravanCartVisible(this._caravanRiding);
    }

    // Hostility flip — rebuild the heading arrow into the threat colour.
    // EntityFactory passes the full entity object here in practice; we
    // synthesize the minimal shape _decideHeadingIndicator needs.
    if (partial.hostile !== undefined) {
      this._ensureHeadingIndicator({
        type:    this._entityType,
        tag:     partial.tag,
        hostile: partial.hostile,
      } as unknown as Entity);
    }

    if (this._entityType !== 'plant') return;
    if (!partial.currentAction) return;

    const newStage = partial.currentAction as string;
    if (newStage === this._plantStage) return; // no change

    this._plantStage = newStage;

    if (this._plantMeshRef) {
      // Swap material colour
      const mat = this._plantMeshRef.material as THREE.MeshStandardMaterial;
      mat.color.setHex(EntityObject._plantStageColor(newStage));

      // Adjust scale and re-centre on ground
      const s = EntityObject._plantStageScale(newStage);
      this._plantMeshRef.scale.setScalar(s);
      this._plantMeshRef.position.y = (0.70 * s) / 2;
    }
  }

  /** Lazily attach a placeholder cart mesh beneath this entity and
   *  toggle its visibility. Only player entities render a cart — when
   *  the lead rider has companions/hirelings as passengers, the server
   *  flags ALL of them with caravanActive (so the Y-snap skip works for
   *  the party), but we restrict cart rendering to type === 'player' so
   *  we don't stack a cart per passenger. */
  private _setCaravanCartVisible(visible: boolean): void {
    if (this._entityType !== 'player') return;
    if (!this._caravanCart) {
      if (!visible) return; // never showed → nothing to hide
      this._caravanCart = EntityObject._buildCaravanCart();
      this.object3d.add(this._caravanCart);
    }
    this._caravanCart.visible = visible;
  }

  private _caravanCart: THREE.Group | null = null;
  /** True while this entity is locked to a caravan ride. update() yields
   *  position writes; CaravanRide drives them directly. */
  private _caravanRiding = false;
}
