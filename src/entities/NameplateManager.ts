import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { PlayerState } from '@/state/PlayerState';
import type { Entity } from '@/network/Protocol';
import type { EntityObject } from './EntityObject';
import { ClientConfig } from '@/config/ClientConfig';
import { computeConTier, NOTORIOUS_READOUT, aggroNameColor, type ConReadout } from './ConTier';
import { isPvpHostileToSelf } from './pvpHostility';

/**
 * NameplateManager — owns the CSS2DRenderer, builds and updates one DOM
 * plate per visible entity, ranges plates to fade + cull beyond camera
 * limits.
 *
 * Plate variants (decided each refresh):
 *   self      — local player. Verbosity from `nameplateSelfMode` setting.
 *   party     — verbose: role tag + HP bar + name.
 *   player    — non-party players: name (+ optional guild tag).
 *   mob       — name (aggro-colored) + con arrows. Notorious shows "??".
 *   target    — overrides the base variant: adds HP bar (settings toggle).
 *   wildlife  — only renders when targeted (otherwise no plate at all).
 *   npc       — name only.
 *
 * The plate is parented to each entity's Object3D via a CSS2DObject child,
 * so it follows the entity automatically — no per-frame projection math
 * needed in this class. We only own: refresh-on-update, target/party
 * reactivity, range fade, and the max-plate cap.
 */
export class NameplateManager {
  readonly css2d: CSS2DRenderer;

  /** Dedicated scene subtree holding only the currently-visible plates.
   *  CSS2DRenderer.render() walks whatever Object3D it's given recursively
   *  looking for CSS2DObject children. Passing the full scene means it
   *  walks 4000+ scene children every frame just to find the ≤30 plates
   *  that actually need projection. We instead reparent each visible plate
   *  to this container and pass *it* to css2d.render(), turning the walk
   *  from O(scene) into O(visible plates). app.ts adds the container to
   *  the scene root so Three.js's main renderer updates its matrixWorld
   *  each frame — the WebGL renderer skips it cheaply since it has no
   *  Mesh children. */
  readonly plateContainer: THREE.Group;

  private plates  = new Map<string, Nameplate>();
  private unsubs: Array<() => void>   = [];

  /** Reused per-frame to avoid GC churn on `_updateRanges`. */
  private _scratch    = new THREE.Vector3();
  private _originPos  = new THREE.Vector3();
  private _sorted: { id: string; distSq: number }[] = [];

  /** Last scale we wrote to the layer's CSS variable — skip the DOM
   *  write when unchanged so we're not thrashing styles every frame. */
  private _lastScale = -1;

  constructor(
    private readonly registry:    EntityRegistry,
    private readonly playerState: PlayerState,
    private readonly getObject:   (id: string) => EntityObject | undefined,
    parentEl: HTMLElement,
  ) {
    this.css2d = new CSS2DRenderer();
    this.css2d.setSize(window.innerWidth, window.innerHeight);
    const dom = this.css2d.domElement;
    dom.id = 'nameplate-layer';
    dom.style.position      = 'absolute';
    dom.style.top           = '0';
    dom.style.left          = '0';
    dom.style.pointerEvents = 'none';
    // Low z-index — plates sit above the canvas but below any HUD widget
    // (action bar, chat, target frame, etc) so the HUD never gets occluded
    // by a plate hovering near screen edge.
    dom.style.zIndex        = '1';
    parentEl.appendChild(dom);

    this.plateContainer = new THREE.Group();
    this.plateContainer.name = 'nameplate-container';

    this._injectStyles();

    this.unsubs.push(registry.onAdd(    (e)  => this._onAdd(e)));
    this.unsubs.push(registry.onUpdate( (e)  => this._refresh(e.id)));
    this.unsubs.push(registry.onVitalsUpdate((e) => this._refresh(e.id)));
    this.unsubs.push(registry.onRemove( (id) => this._onRemove(id)));
    this.unsubs.push(playerState.onChange(() => this._refreshAll()));

    window.addEventListener('resize', this._onResize);
  }

  /** Build plates for any entities already in the registry — fires when
   *  the manager is constructed after world entry. */
  bootstrapExisting(): void {
    for (const e of this.registry.getAll()) this._onAdd(e);
  }

  /** Per-frame: walk all plates, set opacity by distance, hide beyond
   *  max range or past the max-count tail. Distance is measured from
   *  the local player's pawn — not the camera — so rotating the camera
   *  doesn't make nearby plates fade weirdly. Call after entity ticks
   *  but before css2d.render(). */
  update(_camera: THREE.Camera): void {
    // Sync the scale CSS var only when settings changed.
    const scale = ClientConfig.nameplateScale;
    if (scale !== this._lastScale) {
      this.css2d.domElement.style.setProperty('--aa-plate-scale', String(scale));
      this._lastScale = scale;
    }

    this._originPos.set(
      this.playerState.position.x,
      this.playerState.position.y,
      this.playerState.position.z,
    );
    const maxRange  = ClientConfig.nameplateMaxRange;
    const fadeStart = Math.min(ClientConfig.nameplateFadeStart, maxRange);
    const maxRangeSq = maxRange * maxRange;
    const maxCount  = ClientConfig.nameplateMaxCount;

    this._sorted.length = 0;
    for (const [id, plate] of this.plates) {
      const obj = this.getObject(id);
      if (!obj) {
        // Object3D vanished (entity removed mid-frame). Detach plate from
        // wherever it was so the next CSS2DRenderer walk doesn't trip on
        // an orphan parent reference.
        plate.css2d.parent?.remove(plate.css2d);
        plate.setVisible(false);
        continue;
      }
      this._scratch.copy(obj.object3d.position);
      const dx = this._scratch.x - this._originPos.x;
      const dy = this._scratch.y - this._originPos.y;
      const dz = this._scratch.z - this._originPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      this._sorted.push({ id, distSq });
    }
    // Closest first; sort is short (<= maxCount candidates typically).
    this._sorted.sort((a, b) => a.distSq - b.distSq);

    // Walk all plates, attach those that should render this frame, detach
    // the rest. CSS2DRenderer.render() walks the entire scene graph each
    // frame looking for CSS2DObjects — keeping out-of-range plates outside
    // the graph turns that walk from O(plate-eligible entities) into
    // O(maxCount). On a Stephentown zone with ~500 plate-bearing entities
    // this is the difference between ~17 ms and ~0.5 ms per frame.
    for (let i = 0; i < this._sorted.length; i++) {
      const entry = this._sorted[i]!;
      const plate = this.plates.get(entry.id)!;
      const shouldShow = i < maxCount && entry.distSq <= maxRangeSq;

      if (!shouldShow) {
        // Detach if currently attached; setVisible(false) keeps the DOM
        // node in `display: none` state so any in-flight cast bar tween
        // is preserved cheaply.
        if (plate.css2d.parent) plate.css2d.parent.remove(plate.css2d);
        plate.setVisible(false);
        continue;
      }

      // Attach to the plate container if not already attached. parent ===
      // plateContainer is the steady-state hot path; actual add() only
      // fires on band crossings. World position is copied from the entity
      // each frame — plates aren't parented to the entity so they don't
      // bloat the CSS2DRenderer scan, but they still track the entity's
      // motion exactly.
      const obj = this.getObject(entry.id)!;
      if (plate.css2d.parent !== this.plateContainer) {
        this.plateContainer.add(plate.css2d);
      }
      const ep = obj.object3d.position;
      plate.css2d.position.set(ep.x, ep.y + Nameplate.OVERHEAD_OFFSET_Y, ep.z);

      const dist = Math.sqrt(entry.distSq);
      let alpha = 1;
      if (dist > fadeStart && maxRange > fadeStart) {
        alpha = 1 - (dist - fadeStart) / (maxRange - fadeStart);
        if (alpha < 0) alpha = 0;
      }
      plate.setVisible(true);
      plate.setOpacity(alpha);
    }

    // Advance any active cast bars. Cheap walk — most ticks no plate has
    // an active cast. Tied into the same per-frame update so we don't add
    // a second loop or RAF.
    const castNow = performance.now();
    for (const plate of this.plates.values()) plate.tickCast(castNow);
  }

  // ── Cast bar plumbing ─────────────────────────────────────────────────────
  //
  // Server pushes cast_start / cast_complete / cast_break (and channel
  // variants) for ANY entity, but app.ts only routes self to the HUD. We
  // expose entityId-keyed entry points here so app.ts can also forward
  // non-self events into the right plate's overhead cast bar.
  //
  // No-op when the entity has no plate (out of range, wildlife untargeted,
  // settings disabled the type). Cast bars don't render on the self plate
  // either — the HUD's bottom-centre bar already covers it.

  showCast(entityId: string, abilityName: string, durationMs: number): void {
    if (entityId === this.registry.playerId) return;
    const plate = this.plates.get(entityId);
    if (!plate) return;
    plate.showCast(abilityName, durationMs, /*drain*/ false);
  }

  showChannel(entityId: string, abilityName: string, durationMs: number): void {
    if (entityId === this.registry.playerId) return;
    const plate = this.plates.get(entityId);
    if (!plate) return;
    plate.showCast(abilityName, durationMs, /*drain*/ true);
  }

  endCast(entityId: string): void {
    const plate = this.plates.get(entityId);
    if (!plate) return;
    plate.endCast();
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const plate of this.plates.values()) plate.dispose();
    this.plates.clear();
    window.removeEventListener('resize', this._onResize);
    this.css2d.domElement.remove();
  }

  // ── Registry handlers ───────────────────────────────────────────────────

  private _onAdd(entity: Entity): void {
    if (this.plates.has(entity.id)) {
      this._refresh(entity.id);
      return;
    }
    if (!this._shouldHavePlate(entity, /*isTarget*/ false)) return;
    const obj = this.getObject(entity.id);
    if (!obj) return; // Object not yet built — will catch on next update event.

    // CSS2DObject is NOT attached to the entity's object3d here. Attachment
    // happens per-frame in update() based on the range + maxCount decision —
    // keeps the scene-walk that CSS2DRenderer.render does each frame bounded
    // to ~maxCount plates instead of the full plate-eligible entity set.
    // With ~500 mob/npc/player entities holding plates, the prior model was
    // ~17 ms of pure scene traversal in CSS2DRenderer.render even though only
    // 30 plates ever showed.
    const plate = new Nameplate();
    this.plates.set(entity.id, plate);
    this._refresh(entity.id);
  }

  private _onRemove(id: string): void {
    const plate = this.plates.get(id);
    if (!plate) return;
    plate.dispose();
    this.plates.delete(id);
  }

  /** Re-evaluate variant + content for an entity. Cheaper than a remove +
   *  add: keeps the DOM node and css2d object alive. */
  private _refresh(id: string): void {
    const entity = this.registry.get(id);
    if (!entity) return;

    const isTarget = this.playerState.targetId === id;
    const wantsPlate = this._shouldHavePlate(entity, isTarget);

    const existing = this.plates.get(id);
    if (!wantsPlate) {
      if (existing) { existing.dispose(); this.plates.delete(id); }
      return;
    }
    if (!existing) { this._onAdd(entity); return; }

    const viewerLevel    = this.playerState.level;
    const isSelf         = entity.id === this.registry.playerId;
    const isParty        = this.playerState.partyMembers.some(m => m.id === entity.id);
    const viewerPvpArmed = this.playerState.pvpArmed;
    const viewerGuildId  = this.playerState.guildId;
    existing.render(entity, { isSelf, isParty, isTarget, viewerLevel, viewerPvpArmed, viewerGuildId });
  }

  private _refreshAll(): void {
    for (const id of this.plates.keys()) this._refresh(id);
    // Also pick up entities that should NOW have plates because the
    // target changed (wildlife only gets a plate when targeted).
    for (const e of this.registry.getAll()) {
      const isTarget = this.playerState.targetId === e.id;
      if (isTarget && !this.plates.has(e.id)) this._onAdd(e);
    }
  }

  // ── Variant gating ──────────────────────────────────────────────────────

  /** True if `entity` should have a plate given current settings + state.
   *  Combines per-type toggles and "wildlife only when targeted" rule. */
  private _shouldHavePlate(entity: Entity, isTarget: boolean): boolean {
    const type    = (entity.type ?? '').toLowerCase();
    const isSelf  = entity.id === this.registry.playerId;
    if (isSelf) return ClientConfig.nameplateSelfMode !== 'off';
    switch (type) {
      case 'player':    return ClientConfig.nameplateShowPlayers;
      case 'companion':
      case 'hireling':  return ClientConfig.nameplateShowPlayers;
      case 'npc':       return ClientConfig.nameplateShowNpcs;
      case 'mob':       return ClientConfig.nameplateShowMobs;
      case 'wildlife':  return isTarget;
      default:          return false; // structures, plants, vault portals, etc.
    }
  }

  // ── Style injection (once per page load) ────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('nameplate-styles')) return;
    const style = document.createElement('style');
    style.id = 'nameplate-styles';
    style.textContent = NAMEPLATE_CSS;
    document.head.appendChild(style);
  }

  private _onResize = (): void => {
    this.css2d.setSize(window.innerWidth, window.innerHeight);
  };
}

// ── Nameplate (single plate) ──────────────────────────────────────────────

interface RenderContext {
  isSelf:         boolean;
  isParty:        boolean;
  isTarget:       boolean;
  viewerLevel:    number | undefined;
  /** Viewer's own armed flag — required for the open-PvP hostility
   *  classifier (both sides armed + non-guild = hostile). */
  viewerPvpArmed: boolean;
  viewerGuildId:  string | null;
}

class Nameplate {
  readonly css2d: CSS2DObject;
  private readonly root:     HTMLDivElement;
  private readonly nameEl:   HTMLSpanElement;
  private readonly tagEl:    HTMLSpanElement;
  private readonly conEl:    HTMLSpanElement;
  private readonly hpWrap:   HTMLDivElement;
  private readonly hpFill:   HTMLDivElement;
  private readonly castWrap: HTMLDivElement;
  private readonly castLabel: HTMLSpanElement;
  private readonly castFill: HTMLDivElement;
  private _opacity = 1;

  // Active cast state. Local timer is the source of truth — server sends
  // start/end, we fill or drain locally so we don't pay tick-rate on the
  // wire. Mirrors HUD cast bar pattern.
  private _castActive    = false;
  private _castStartedAt = 0;
  private _castDurationMs = 0;
  /** Drain mode = channel (1 → 0). false = cast (0 → 1). */
  private _castDrain     = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'aa-plate';

    // Row 1: [TAG] role-tag name con-arrows
    const row1 = document.createElement('div');
    row1.className = 'aa-plate-row';
    this.tagEl  = document.createElement('span'); this.tagEl.className  = 'aa-plate-tag';
    this.nameEl = document.createElement('span'); this.nameEl.className = 'aa-plate-name';
    this.conEl  = document.createElement('span'); this.conEl.className  = 'aa-plate-con';
    row1.appendChild(this.tagEl);
    row1.appendChild(this.nameEl);
    row1.appendChild(this.conEl);
    this.root.appendChild(row1);

    // Row 2: HP bar (target/party/self+hp variants only)
    this.hpWrap = document.createElement('div');
    this.hpWrap.className = 'aa-plate-hpwrap';
    this.hpFill = document.createElement('div');
    this.hpFill.className = 'aa-plate-hpfill';
    this.hpWrap.appendChild(this.hpFill);
    this.root.appendChild(this.hpWrap);

    // Row 3: cast bar (hidden until a cast/channel begins). Sits below the
    // HP bar so the eye reads "what they are" → "how alive" → "what they're
    // about to do." Hidden by default.
    this.castWrap = document.createElement('div');
    this.castWrap.className = 'aa-plate-castwrap';
    this.castWrap.style.display = 'none';
    this.castLabel = document.createElement('span');
    this.castLabel.className = 'aa-plate-castlabel';
    this.castFill  = document.createElement('div');
    this.castFill.className = 'aa-plate-castfill';
    this.castWrap.appendChild(this.castFill);
    this.castWrap.appendChild(this.castLabel);
    this.root.appendChild(this.castWrap);

    this.css2d = new CSS2DObject(this.root);
    // NameplateManager writes the plate's world position each frame using
    // OVERHEAD_OFFSET_Y above the entity. We initialise to (0, offset, 0)
    // so the first frame the plate flashes in renders at a sane location.
    this.css2d.position.set(0, Nameplate.OVERHEAD_OFFSET_Y, 0);
  }

  /** Metres above the entity's reported origin where the plate sits.
   *  Clears most humanoid silhouettes; for larger mobs the plate floats a
   *  bit, which reads correctly. */
  static readonly OVERHEAD_OFFSET_Y = 2.2;

  showCast(name: string, durationMs: number, drain: boolean): void {
    this._castActive     = true;
    this._castStartedAt  = performance.now();
    this._castDurationMs = Math.max(1, durationMs);
    this._castDrain      = drain;
    this.castLabel.textContent = name;
    this.castWrap.classList.toggle('drain', drain);
    this.castWrap.style.display = 'block';
    // Seed initial fill width so the bar doesn't pop from a stale value.
    this.castFill.style.width = drain ? '100%' : '0%';
  }

  /** Hide the cast bar. Called on cast_complete / cast_break / entity death.
   *  No-op when no cast is active. */
  endCast(): void {
    if (!this._castActive) return;
    this._castActive = false;
    this.castWrap.style.display = 'none';
  }

  /** Per-frame: advance the cast bar fill. Auto-hides on natural expiry —
   *  server complete/break events still call endCast, this just handles the
   *  late-message case (cast hits 100% before complete event arrives). */
  tickCast(now: number): void {
    if (!this._castActive) return;
    const elapsed = now - this._castStartedAt;
    const t       = Math.max(0, Math.min(1, elapsed / this._castDurationMs));
    const pct     = this._castDrain ? (1 - t) : t;
    this.castFill.style.width = `${(pct * 100).toFixed(1)}%`;
    if (elapsed >= this._castDurationMs) {
      // Hold visible at terminal value for a frame so the bar lands fully
      // filled/drained before disappearing — looks intentional vs blinking
      // off prematurely. endCast handles the actual hide on server signal.
    }
  }

  render(entity: Entity, ctx: RenderContext): void {
    // ── Aggro / friendly classification ────────────────────────────────
    const type        = (entity.type ?? '').toLowerCase();
    // Open-PvP: armed non-guildmate peers flip from friendly to hostile.
    // Takes precedence over the "all players are friendly" default.
    const pvpHostile  = isPvpHostileToSelf(entity, ctx.viewerPvpArmed, ctx.viewerGuildId);
    const isFriendly  = !pvpHostile && (
                          ctx.isSelf
                          || ctx.isParty
                          || type === 'player'
                          || type === 'companion'
                          || type === 'hireling'
                          || type === 'npc'
                          || entity.disposition === 'friendly'
                        );

    // ── Name (with guild tag for non-party players) ────────────────────
    let displayName = entity.name ?? '';
    if (type === 'player' && !ctx.isSelf && !ctx.isParty
        && ClientConfig.nameplateShowGuildTag
        && entity.guildTag) {
      displayName = `[${entity.guildTag}] ${displayName}`;
    }
    this.nameEl.textContent = displayName;
    this.nameEl.style.color = aggroNameColor(entity.disposition, isFriendly);

    // ── Role tag (party + companions/hirelings get the panel letter) ────
    if (ctx.isParty || type === 'companion' || type === 'hireling') {
      this.tagEl.textContent = entity.role ?? '';
      this.tagEl.style.display = entity.role ? 'inline' : 'none';
    } else {
      this.tagEl.textContent = '';
      this.tagEl.style.display = 'none';
    }

    // ── Con arrows (mobs + wildlife, when level known) ──────────────────
    let con: ConReadout | undefined;
    const showCon = (type === 'mob' || type === 'wildlife') && !isFriendly;
    if (showCon) {
      con = entity.notorious
        ? NOTORIOUS_READOUT
        : computeConTier(ctx.viewerLevel, entity.level);
    }
    if (con) {
      this.conEl.textContent = con.arrows;
      this.conEl.style.color = con.color;
      this.conEl.style.display = 'inline';
    } else {
      this.conEl.textContent = '';
      this.conEl.style.display = 'none';
    }

    // ── HP bar (target with toggle / party / self+hp) ───────────────────
    const showHp = (ctx.isTarget && ClientConfig.nameplateTargetShowHp)
                   || ctx.isParty
                   || (ctx.isSelf && (ClientConfig.nameplateSelfMode === 'name_hp'
                                       || ClientConfig.nameplateSelfMode === 'full'));
    if (showHp && entity.health && entity.health.max > 0) {
      const pct = Math.max(0, Math.min(1, entity.health.current / entity.health.max));
      this.hpFill.style.width = `${(pct * 100).toFixed(1)}%`;
      // HP color: green high, yellow mid, red low.
      let hpColor = '#7cd47c';
      if (pct < 0.66) hpColor = '#f0c878';
      if (pct < 0.33) hpColor = '#e85040';
      this.hpFill.style.background = hpColor;
      this.hpWrap.style.display = 'block';
    } else {
      this.hpWrap.style.display = 'none';
    }

    // ── Target highlight (subtle ring/glow on the plate) ────────────────
    this.root.classList.toggle('targeted', ctx.isTarget);
    this.root.classList.toggle('friendly', isFriendly);
  }

  setVisible(v: boolean): void {
    // CSS2DRenderer.render() syncs `element.style.display` from `.visible`
    // each frame, so we only need to toggle the Object3D flag here. The
    // visibility inherits from the parent entity Object3D too — if the
    // factory culls the entity by draw distance, the plate disappears
    // automatically (three.js inherits .visible).
    this.css2d.visible = v;
  }

  setOpacity(a: number): void {
    if (a === this._opacity) return;
    this._opacity = a;
    this.root.style.opacity = String(a);
  }

  dispose(): void {
    this.css2d.parent?.remove(this.css2d);
    this.root.remove();
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────

const NAMEPLATE_CSS = `
#nameplate-layer { --aa-plate-scale: 1; }
.aa-plate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(2px * var(--aa-plate-scale));
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif;
  font-size: calc(12px * var(--aa-plate-scale));
  font-weight: 600;
  line-height: 1.0;
  text-shadow: 0 1px 2px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,1);
  user-select: none;
  pointer-events: none;
  transform: translate(-50%, -100%);
  white-space: nowrap;
  text-align: center;
  transition: opacity 120ms linear;
}
.aa-plate-row {
  display: inline-flex;
  align-items: baseline;
  gap: calc(5px * var(--aa-plate-scale));
}
.aa-plate-tag {
  font-size: calc(10px * var(--aa-plate-scale));
  font-weight: 700;
  color: #cfa969;
  padding: calc(1px * var(--aa-plate-scale)) calc(4px * var(--aa-plate-scale));
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(207,169,105,0.55);
  border-radius: 2px;
  line-height: 1;
}
.aa-plate-name { color: #fff; }
.aa-plate-con {
  /* Pizzaz: bigger, bolder, with an emissive glow drawn from the
     inline color the renderer sets. Outer halo (currentColor) sells
     the "lit-up" look; inner dark stroke keeps it readable on bright
     backgrounds. */
  font-size: calc(16px * var(--aa-plate-scale));
  font-weight: 900;
  letter-spacing: calc(1.5px * var(--aa-plate-scale));
  text-shadow:
    0 0 calc(8px * var(--aa-plate-scale)) currentColor,
    0 0 calc(3px * var(--aa-plate-scale)) currentColor,
    0 1px 2px rgba(0,0,0,0.95),
    0 -1px 2px rgba(0,0,0,0.95);
}
.aa-plate-hpwrap {
  width: calc(56px * var(--aa-plate-scale));
  height: calc(4px * var(--aa-plate-scale));
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(0,0,0,0.9);
  border-radius: 2px;
  overflow: hidden;
}
.aa-plate-hpfill {
  height: 100%;
  width: 100%;
  background: #7cd47c;
  transition: width 140ms linear, background 140ms linear;
}
.aa-plate.targeted .aa-plate-name {
  text-shadow: 0 0 4px #ffd86b, 0 1px 2px rgba(0,0,0,0.85);
}
.aa-plate.targeted .aa-plate-hpwrap {
  border-color: rgba(255,216,107,0.8);
  box-shadow: 0 0 4px rgba(255,216,107,0.55);
}
/* Cast bar — sits below the HP bar. Fill colour signals cast vs channel:
   amber/orange for casts (winding up), blue for channels (already firing). */
.aa-plate-castwrap {
  position: relative;
  width:  calc(120px * var(--aa-plate-scale));
  height: calc(15px * var(--aa-plate-scale));
  background: rgba(0,0,0,0.7);
  border: 1px solid rgba(0,0,0,0.9);
  border-radius: 2px;
  overflow: hidden;
  margin-top: calc(2px * var(--aa-plate-scale));
}
.aa-plate-castfill {
  position: absolute;
  inset: 0;
  width: 0%;
  background: linear-gradient(180deg, #f6c060 0%, #c87820 100%);
  transition: width 80ms linear;
}
.aa-plate-castwrap.drain .aa-plate-castfill {
  background: linear-gradient(180deg, #6cb8f0 0%, #2870c0 100%);
}
.aa-plate-castlabel {
  position: relative;
  display: block;
  font-size: calc(11px * var(--aa-plate-scale));
  font-weight: 700;
  color: #fff;
  line-height: calc(15px * var(--aa-plate-scale));
  text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,1);
  letter-spacing: 0.5px;
}
`;
