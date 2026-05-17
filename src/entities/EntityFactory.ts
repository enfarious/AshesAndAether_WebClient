import * as THREE from 'three';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import type { HeightmapService } from '@/world/HeightmapService';
import { fitToTerrain } from '@/world/TangentPlaneFit';
import { PlayerEntity, PlayerMoveMode } from './PlayerEntity';
import { RemoteEntity } from './RemoteEntity';
import type { EntityObject } from './EntityObject';
import { ClientConfig } from '@/config/ClientConfig';
import type { Entity } from '@/network/Protocol';
import { FOREST_SPECIES } from '@/world/ForestRenderer';

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
  private objects   = new Map<string, EntityObject>();
  private plantIds  = new Set<string>();
  private player:   PlayerEntity | null = null;

  // ── Heightmap (for snapping entities to rendered terrain surface) ─────────
  private heightmap: HeightmapService | null = null;
  /** Small offset so entities sit visibly above the terrain, not inside it. */
  private static readonly GROUND_CLEARANCE = 0.15;

  // ── Target highlight ring ─────────────────────────────────────────────────
  private highlightRing: THREE.Mesh | null = null;
  private highlightMat:  THREE.ShaderMaterial | null = null;
  private highlightAge   = 0;
  private unsubTarget:   (() => void) | null = null;
  private _playerHeadingUnsub: (() => void) | null = null;

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
   * Provide the heightmap so non-player entities can be snapped to the
   * client-side terrain elevation (server heights may differ from the
   * rendered terrain mesh). Also feeds the heightmap into every entity's
   * heading-chevron tangent-plane fit + retro-snaps existing non-player
   * entities.
   */
  setHeightmap(hm: HeightmapService | null): void {
    this.heightmap = hm;

    for (const [id, obj] of this.objects) {
      // Heading-indicator wiring runs for every entity, including the local
      // player — both PlayerEntity and RemoteEntity expose setHeightmap.
      if (obj instanceof RemoteEntity || obj === this.player) {
        (obj as { setHeightmap?: (hm: HeightmapService | null) => void }).setHeightmap?.(hm);
      }
      if (id === this.registry.playerId) continue;
      if (!hm) continue;
      const regEntity = this.registry.get(id);
      if (!regEntity?.position) continue;

      const elev = hm.getElevation(regEntity.position.x, regEntity.position.z);
      if (elev !== null) {
        obj.object3d.position.y = elev + EntityFactory.GROUND_CLEARANCE;
      }
    }
  }

  private static get DRAW_DIST_SQ(): number {
    return ClientConfig.drawDistance * ClientConfig.drawDistance;
  }

  private static get TREE_DIST_SQ(): number {
    return ClientConfig.treeVisibleRange * ClientConfig.treeVisibleRange;
  }

  /** Called every frame — ticks all entity interpolators and the highlight ring. */
  update(dt: number): void {
    // Player position for distance culling
    const px = this.playerState.position.x;
    const pz = this.playerState.position.z;

    const treeLimitSq = EntityFactory.TREE_DIST_SQ;
    const drawLimitSq = EntityFactory.DRAW_DIST_SQ;

    for (const [id, obj] of this.objects) {
      // Always tick the local player — skip distance check
      if (obj === this.player) { obj.update(dt); continue; }

      const ep = obj.object3d.position;
      const dx = ep.x - px;
      const dz = ep.z - pz;
      const distSq = dx * dx + dz * dz;

      // Plants use a tighter, independently configurable visibility range.
      const limitSq = this.plantIds.has(id) ? treeLimitSq : drawLimitSq;

      if (distSq > limitSq) {
        if (obj.object3d.visible) {
          obj.object3d.visible = false;
          obj.setSceneOwnedVisible(false);   // hide chevron + any other detached meshes
        }
        continue;
      }
      if (!obj.object3d.visible) obj.object3d.visible = true;
      obj.update(dt);     // each entity's update() re-shows its detached meshes
    }
    this._updateHighlight(dt);
  }

  dispose(): void {
    for (const obj of this.objects.values()) {
      obj.dispose();
    }
    this.objects.clear();
    this.plantIds.clear();
    this.player = null;
    if (this._playerHeadingUnsub) { this._playerHeadingUnsub(); this._playerHeadingUnsub = null; }

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
    // Tree species (pine, oak, maple) are batched into InstancedMesh by ForestRenderer.
    if (entity.type === 'plant' && FOREST_SPECIES.has(entity.tag ?? '')) return;

    // Guard: if an object already exists for this ID, dispose the orphan first
    // to prevent leaked Three.js objects accumulating in the scene graph.
    const stale = this.objects.get(entity.id);
    if (stale) {
      stale.dispose();
      this.objects.delete(entity.id);
      if (stale === this.player) {
        this.player = null;
        this._playerHeadingUnsub?.();
        this._playerHeadingUnsub = null;
      }
    }

    const isPlayer = entity.id === this.registry.playerId;

    // Snap non-player entities to client-side terrain elevation so they sit
    // on the rendered surface (server heights may differ from the GLB mesh).
    if (!isPlayer && entity.position && this.heightmap) {
      const elev = this.heightmap.getElevation(entity.position.x, entity.position.z);
      if (elev !== null) {
        entity = { ...entity, position: { ...entity.position, y: elev + EntityFactory.GROUND_CLEARANCE } };
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
      } as unknown as ConstructorParameters<typeof PlayerEntity>[0];

      const pe = new PlayerEntity(cs, this.scene);
      this.player = pe;
      obj = pe;
      // Sync model rotation from PlayerState — covers click-to-move, cast
      // auto-face, and any other server-driven heading change. WASD has its
      // own per-frame local prediction in WASDController.setHeading; we
      // skip the sync while WASD is active, otherwise the (lagging) server
      // heading would clobber the (live) camera-relative prediction and
      // freeze the rotation mid-strafe.
      //
      // Lock-on movement override: if the player is locked on with the
      // lock-on toggle, the body must always face the locked target — not
      // the heading the server echoes (which is the last MOVEMENT direction,
      // since the wire uses one heading for both move + face). Otherwise
      // the moment stopWASD() flips out of WASD mode on stick release, the
      // server's stop-ack would snap the body to the strafe direction.
      this._playerHeadingUnsub = this.playerState.onChange(() => {
        if (pe.mode === PlayerMoveMode.WASD) return;

        if (ClientConfig.lockOnMovement && this.playerState.targetLocked) {
          const facing = this._computeLockOnFacingDeg(pe);
          if (facing !== null) {
            pe.setHeading(facing);
            return;
          }
        }
        pe.setHeading(this.playerState.heading);
      });
    } else {
      obj = new RemoteEntity(entity, this.scene);
    }

    if (entity.type === 'plant') this.plantIds.add(entity.id);
    this.objects.set(entity.id, obj);
  }

  private _onUpdate(entity: Entity): void {
    if (entity.type === 'plant' && FOREST_SPECIES.has(entity.tag ?? '')) return;
    const obj = this.objects.get(entity.id);
    if (!obj) {
      this._onCreate(entity);
      return;
    }

    if (entity.position) {
      const isLocalPlayer = entity.id === this.registry.playerId;
      let y = entity.position.y;
      // Snap non-player entities to client terrain elevation — UNLESS the
      // server flags the entity as mid-caravan-ride, in which case the
      // server-sent Y already includes the cart's hover offset and we
      // shouldn't clobber it with terrain.
      const caravanRiding = entity.caravanActive === true;
      if (!isLocalPlayer && !caravanRiding && this.heightmap) {
        const elev = this.heightmap.getElevation(entity.position.x, entity.position.z);
        if (elev !== null) y = elev + EntityFactory.GROUND_CLEARANCE;
      }
      // PlayerEntity.setTargetPosition() buffers internally via its mode
      // check — safe to call during WASD or IDLE.
      const pos  = new THREE.Vector3(entity.position.x, y, entity.position.z);
      const from = entity.fromPosition
        ? new THREE.Vector3(entity.fromPosition.x, y, entity.fromPosition.z)
        : undefined;
      // Caravan-active AI broadcasts every server tick (100ms) at a fast
      // 30 m/s — each broadcast moves the entity ~3m. Match the lerp
      // duration to the broadcast cadence so the lerp finishes exactly
      // as the next snapshot arrives; longer lerps lag visibly when the
      // path turns and the entity hooks toward the new heading.
      const durOverride = entity.movementDuration
        ?? (caravanRiding ? 100 : undefined);
      obj.setTargetPosition(pos, entity.heading, durOverride, from, entity.movementSpeed);
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
    this.plantIds.delete(id);
    if (obj === this.player) this.player = null;
  }

  // ── Target highlight ring ─────────────────────────────────────────────────

  /** Build the highlight ring once at startup. Flat low-poly annulus —
   *  positioned + rotated each frame onto the local terrain tangent plane
   *  via DEM sampling (no per-vertex shader conform, no jitter). Stays
   *  hidden until a target is selected. */
  private _buildHighlight(): void {
    const innerR = 0.62;
    const outerR = 0.74;
    const radial = 40;
    // 4 segments → 5 rings: inner-edge (bevel 0), inner-flat (1), middle (1),
    // outer-flat (1), outer-edge (bevel 0). One ring-segment slope on each rim.
    const rings  = 4;
    const vertCount = (rings + 1) * radial;
    const positions = new Float32Array(vertCount * 3);
    const bevelMask = new Float32Array(vertCount);
    for (let r = 0; r <= rings; r++) {
      const radius = innerR + (outerR - innerR) * (r / rings);
      const mask   = (r === 0 || r === rings) ? 0 : 1;
      for (let s = 0; s < radial; s++) {
        const a = (s / radial) * Math.PI * 2;
        const idx = r * radial + s;
        positions[idx * 3]     = Math.cos(a) * radius;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = Math.sin(a) * radius;
        bevelMask[idx]         = mask;
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rings; r++) {
      const baseInner = r * radial;
      const baseOuter = (r + 1) * radial;
      for (let s = 0; s < radial; s++) {
        const sNext = (s + 1) % radial;
        indices.push(
          baseInner + s, baseOuter + s, baseInner + sNext,
          baseInner + sNext, baseOuter + s, baseOuter + sNext,
        );
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aBevelMask', new THREE.BufferAttribute(bevelMask, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    this.highlightMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:       { value: new THREE.Color(0xddaa22) },
        uOpacity:     { value: 0.0 },
        // Thin ring — bevel height 0.04 sits low so it doesn't compete
        // with the prominent entity heading chevron at the same target.
        uBevelHeight: { value: 0.04 },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aBevelMask;
        uniform float uBevelHeight;
        void main() {
          vec3 pos = position;
          pos.y += aBevelMask * uBevelHeight;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3  uColor;
        uniform float uOpacity;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(uColor, uOpacity);
        }
      `,
      transparent:         true,
      depthWrite:          false,
      depthTest:           true,
      polygonOffset:       true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side:                THREE.DoubleSide,
    });

    this.highlightRing = new THREE.Mesh(geo, this.highlightMat);
    this.highlightRing.renderOrder   = 996;
    this.highlightRing.frustumCulled = false;   // tangent-plane fit moves the mesh
    this.highlightRing.visible       = false;
    this.scene.add(this.highlightRing);
  }

  /** Heading (server convention, degrees, 0=+Z CW) that points the player
   *  at their currently-locked target. Returns null when no locked target is
   *  rendered or the player is on top of it. Used by the playerState
   *  subscription to override server-echoed heading during lock-on. */
  private _computeLockOnFacingDeg(pe: PlayerEntity): number | null {
    const targetId = this.playerState.lockedTargetId;
    if (!targetId) return null;
    const targetObj = this.getObject(targetId);
    if (!targetObj) return null;
    const tp = targetObj.object3d.position;
    const pp = pe.object3d.position;
    const dx = tp.x - pp.x;
    const dz = tp.z - pp.z;
    if (dx === 0 && dz === 0) return null;
    const facingRad = Math.atan2(dx, dz);
    let deg = (facingRad * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  /** Called when playerState changes — show/hide ring based on target presence. */
  private _syncHighlight(): void {
    if (!this.highlightRing) return;
    const hasTarget = !!this.playerState.targetId;
    this.highlightRing.visible = hasTarget;
    if (!hasTarget) this.highlightAge = 0;
  }

  /** Pick a target-highlight ring colour from the registry entry. Visually
   *  separates the ring from the always-orange AA ring AND tells the player
   *  what kind of thing they have selected without reading nameplates. */
  private _targetHighlightColorHex(entityId: string): number {
    const e = this.registry.get(entityId);
    if (!e) return 0xddaa22;          // amber fallback (entity not yet known)
    if (e.hostile) return 0xff4040;   // red — anything I'd attack
    const type = e.type?.toLowerCase();
    switch (type) {
      case 'companion':
      case 'hireling':
      case 'npc':       return 0x4dee88;   // friendly green
      case 'player':    return 0x6699ff;   // blue — other players
      case 'mob':       return 0xddcc66;   // yellow — neutral mob
      case 'wildlife':  return 0xc8a870;   // tan — ambient wildlife
      default:          return 0xddaa22;   // amber fallback
    }
  }

  /**
   * Each frame: snap ring to target's rendered position, refresh its colour
   * (so hostility flips re-tint live), and pulse opacity for a "selected" feel.
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

    // Tangent-plane fit so the ring sits flat on the local terrain slope
    // under the target. Symmetric ring → no yaw, only tilt.
    const p = obj.object3d.position;
    fitToTerrain(this.highlightRing, this.heightmap, p.x, p.z, null, 0.7, 0.02, p.y);
    this.highlightRing.visible = true;

    // Refresh colour per-frame so an enrage / hostility-flip re-tints the
    // ring without needing a special event hook. setHex mutates in place,
    // no per-frame allocation.
    const colorHex = this._targetHighlightColorHex(targetId);
    (this.highlightMat.uniforms['uColor']!.value as THREE.Color).setHex(colorHex);

    // Soft opacity pulse — drove a brass-feel "selected" beat. Spin was
    // a no-op on the previous symmetric torus; not restoring it.
    this.highlightAge += dt;
    this.highlightMat.uniforms['uOpacity']!.value = 0.65 + 0.20 * Math.sin(this.highlightAge * 3.5);
  }
}
