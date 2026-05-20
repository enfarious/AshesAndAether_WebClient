import * as THREE from 'three';
import type { PlayerState }    from '@/state/PlayerState';
import type { EntityFactory }  from './EntityFactory';
import type { AbilityArming }  from '@/input/AbilityArming';
import type { TelegraphRenderer } from './TelegraphRenderer';
import type { AoeShape }       from '@/network/Protocol';

/**
 * AoEPreviewIndicator — a ghost outline of an AoE ability's footprint while
 * the player is in gamepad arming. Disappears on confirm (the real telegraph
 * takes over) or cancel.
 *
 * Anchoring matches the server's telegraph anchoring on cast:
 *   • targetType 'ally' / 'enemy' → anchor on the picker's current target,
 *     so cycling through candidates moves the preview live.
 *   • targetType 'self'           → anchor on the player (PBAoE / aura zones).
 *   • Other / no target           → preview hidden.
 *
 * Heading mirrors the player's heading so cone/line shapes orient with the
 * cast direction. Mesh is shared with TelegraphRenderer's shape factory —
 * cones/lines/circles render with the exact same shaders as real telegraphs,
 * just at lower opacity so the preview reads as "this is a hint."
 */

const PREVIEW_OPACITY = 0.55;
// Y lift is baked into the telegraph shaders' uYLift uniform now — the
// preview mesh just needs to sit at the anchor's reported Y, the shader
// handles terrain conform + the small lift above the surface.
const TWO_PI_DEG = 360;

export class AoEPreviewIndicator {
  // Object3D (not Mesh) — radial-cone shapes return a Group of N child
  // meshes from TelegraphRenderer.buildExternalMesh. Visible/position
  // operations work on both; geometry dispose walks children for groups.
  private mesh:     THREE.Object3D | null = null;
  private material: THREE.ShaderMaterial | null = null;
  /** Cached shape signature — when the armed ability changes, we rebuild
   *  the mesh rather than trying to mutate geometry/uniforms in place. */
  private _cachedSig: string | null = null;

  constructor(
    private readonly scene:         THREE.Scene,
    private readonly entityFactory: EntityFactory,
    private readonly playerState:   PlayerState,
    private readonly telegraphs:    TelegraphRenderer,
    /** AbilityArming is built lazily on world entry — getter avoids capturing null. */
    private readonly getArming:     () => AbilityArming | null,
  ) {}

  dispose(): void {
    this._destroyMesh();
  }

  /** Call every frame from App._loop. */
  update(_dt: number): void {
    const arming = this.getArming();
    const armed  = arming?.armedAbility ?? null;
    if (!armed?.aoe) {
      this._hide();
      return;
    }

    const anchor = this._resolveAnchor(armed.targetType);
    if (!anchor) {
      this._hide();
      return;
    }

    const sig = _signatureOf(armed.aoe);
    if (sig !== this._cachedSig) {
      this._buildMesh(armed.aoe);
      this._cachedSig = sig;
    }
    if (!this.mesh) return;

    // Position on anchor, oriented to player heading. Cone/line geometry is
    // forward-along-+Z; heading=0 already points the shape +Z (south, per
    // server convention), so the same rotation that real telegraphs use
    // applies here too.
    this.mesh.position.set(anchor.x, anchor.y, anchor.z);
    this.mesh.rotation.y = (this.playerState.heading % TWO_PI_DEG) * Math.PI / 180;
    this.mesh.visible = true;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _resolveAnchor(targetType: string | undefined): { x: number; y: number; z: number } | null {
    // Self / PBAoE — anchor on the player.
    if (targetType === 'self' || targetType === 'aoe') {
      return this._playerPos();
    }
    // Target-anchored — anchor on the current main target. During the picker
    // this updates as the player cycles candidates, giving live feedback.
    const targetId = this.playerState.targetId;
    if (!targetId) {
      // Untyped / unknown — fall back to player so the preview is still useful.
      return targetType === undefined ? this._playerPos() : null;
    }
    const obj = this.entityFactory.getObject(targetId);
    if (!obj) return null;
    const p = obj.object3d.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  private _playerPos(): { x: number; y: number; z: number } | null {
    const id = this.playerState.id;
    if (!id) return null;
    const obj = this.entityFactory.getObject(id);
    if (obj) {
      const p = obj.object3d.position;
      return { x: p.x, y: p.y, z: p.z };
    }
    // Fallback to PlayerState's snapshot.
    return { ...this.playerState.position };
  }

  private _buildMesh(shape: AoeShape): void {
    this._destroyMesh();
    // Preview always renders as the player's own offence — blue. Even friendly
    // anchors (Meteorite Storm targets an ally but rains damage) use blue
    // for the preview, since the visual answers "where will this hit?".
    const built = this.telegraphs.buildExternalMesh(shape, 'own_offense', undefined);
    if (!built) return;
    built.mesh.renderOrder = 997;       // below real telegraphs (998)
    built.material.uniforms['uOpacity']!.value = PREVIEW_OPACITY;
    this.scene.add(built.mesh);
    this.mesh = built.mesh;
    this.material = built.material;
  }

  private _destroyMesh(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      // Group (radial cone) → walk children; single Mesh → dispose directly.
      if (this.mesh instanceof THREE.Mesh) {
        this.mesh.geometry.dispose();
      } else {
        this.mesh.traverse((obj) => {
          if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
      }
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }

  private _hide(): void {
    if (this.mesh && this.mesh.visible) this.mesh.visible = false;
  }
}

function _signatureOf(shape: AoeShape): string {
  switch (shape.shape) {
    case 'circle': return `c:${shape.radius}`;
    case 'cone':   return `n:${shape.length}:${shape.angle}`;
    case 'line':   return `l:${shape.length}:${shape.width}`;
  }
}
