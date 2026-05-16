import * as THREE from 'three';
import type { PlayerState }      from '@/state/PlayerState';
import type { EntityRegistry }   from '@/state/EntityRegistry';
import type { EntityFactory }    from './EntityFactory';
import type { AbilityArming }    from '@/input/AbilityArming';

/**
 * SubTargetIndicator — a translucent, glowy downward-pointing cone hovering
 * above the head of the player's current sub-target during AbilityArming's
 * enemy/ally picker.
 *
 * Visible only while `abilityArming.isPicking` is true. Follows the rendered
 * (interpolated) position of `player.targetId` via EntityFactory.
 *
 * Colour:
 *   • Blue  — ally picker (heals / buffs).
 *   • Red   — enemy picker, target is currently engaged with the viewer or an
 *             ally (mob.combatTargetId is in the viewer's allied-id set).
 *   • Yellow — enemy picker, target is hostile but uncommitted (proximity-
 *              passive: no AA target, or AA target outside the party).
 *
 * Same pattern as AutoAttackRing: scene-owned mesh, hidden by default,
 * positioned + recoloured each frame in update(dt).
 */

const CONE_HEIGHT     = 0.85;
const CONE_RADIUS     = 0.32;
const CONE_SEGMENTS   = 24;
/** Distance above the entity's reported Y at which the cone's BASE sits.
 *  Apex hangs below by CONE_HEIGHT, so visual "tip" is at +Y_OFFSET above
 *  the entity. Tuned for ~1.8m tall character — the cone hovers ~0.7m above
 *  the head when Y_OFFSET=2.5. */
const Y_OFFSET_BASE   = 3.2;
/** Amplitude of the vertical bob (m). Slow oscillation makes the indicator
 *  feel alive without distracting from the picker UX. */
const BOB_AMPLITUDE_M = 0.12;
/** Rate of the bob/pulse cycle in Hz. */
const PULSE_HZ        = 1.4;
/** Opacity range of the additive-glow pulse. */
const OPACITY_MIN     = 0.55;
const OPACITY_MAX     = 0.95;

const COLOR_ALLY      = new THREE.Color(0x5a9cff);  // friendly blue
const COLOR_HOSTILE_IDLE = new THREE.Color(0xffd040);  // uncommitted yellow
const COLOR_HOSTILE_AGGRO = new THREE.Color(0xff4848);  // aggroed red

export class SubTargetIndicator {
  private mesh:     THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  private _elapsed = 0;

  constructor(
    private readonly scene:         THREE.Scene,
    private readonly entityFactory: EntityFactory,
    private readonly entityRegistry: EntityRegistry,
    private readonly playerState:   PlayerState,
    /** Getter rather than direct ref because AbilityArming is built lazily
     *  on world entry — the indicator lives across the app and would otherwise
     *  capture a null. Getter returns null while the player is pre-session. */
    private readonly getArming:     () => AbilityArming | null,
  ) {
    // ConeGeometry has apex at +Y, base centered at -height/2 → +height/2 of
    // half-height. We want the apex pointing DOWN at the entity, so rotate
    // 180° around X. After rotation, apex sits at -Y in local space.
    const geo = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, CONE_SEGMENTS, 1, true);
    geo.rotateX(Math.PI);

    this.material = new THREE.MeshBasicMaterial({
      color:       COLOR_HOSTILE_IDLE,
      transparent: true,
      opacity:     OPACITY_MAX,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      depthTest:   false,                  // overlay-style: always visible
      side:        THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 998;           // just below AutoAttackRing
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  /** Call every frame from App._loop. Hides the mesh when no picker is
   *  active or no target is rendered. */
  update(dt: number): void {
    this._elapsed += dt;

    const arming = this.getArming();
    const kind = arming?.pickKind ?? null;
    if (!kind) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }

    const targetId = this.playerState.targetId;
    if (!targetId) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }

    const targetObj = this.entityFactory.getObject(targetId);
    if (!targetObj) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }

    // Colour: ally picker always blue; enemy picker splits on aggro state.
    let color: THREE.Color;
    if (kind === 'ally') {
      color = COLOR_ALLY;
    } else {
      color = this._isTargetAggroOnParty(targetId)
        ? COLOR_HOSTILE_AGGRO
        : COLOR_HOSTILE_IDLE;
    }
    if (!this.material.color.equals(color)) this.material.color.copy(color);

    // Slow pulse — opacity + Y bob driven by a shared sine. The two phase-
    // synced cues read as a single "breathing" motion.
    const phase = Math.sin(this._elapsed * PULSE_HZ * Math.PI * 2);     // -1..+1
    const halfRange = (OPACITY_MAX - OPACITY_MIN) * 0.5;
    const midOpacity = (OPACITY_MAX + OPACITY_MIN) * 0.5;
    this.material.opacity = midOpacity + phase * halfRange;
    const bob = phase * BOB_AMPLITUDE_M;

    // Position above the target's rendered (interpolated) position. The
    // entity's reported Y is the foot — add Y_OFFSET_BASE for head clearance.
    const p = targetObj.object3d.position;
    this.mesh.position.set(p.x, p.y + Y_OFFSET_BASE + bob, p.z);
    this.mesh.visible = true;
  }

  /** Returns true iff the target mob's broadcast `combatTargetId` is an id
   *  the viewer considers allied (self / party / companion). Defensive on
   *  the typing — only mob entities carry the field, and it may be
   *  undefined for non-mobs or before the first AA-transition broadcast. */
  private _isTargetAggroOnParty(targetId: string): boolean {
    const ent = this.entityRegistry.get(targetId);
    if (!ent) return false;
    const tgt = ent.combatTargetId;
    if (!tgt) return false;
    return this._alliedIds().has(tgt);
  }

  private _alliedIds(): Set<string> {
    const ids = new Set<string>();
    if (this.playerState.id) ids.add(this.playerState.id);
    for (const m of this.playerState.partyMembers) {
      if (m.id) ids.add(m.id);
    }
    const companionId = this.playerState.companion?.companionId;
    if (companionId) ids.add(companionId);
    return ids;
  }
}
