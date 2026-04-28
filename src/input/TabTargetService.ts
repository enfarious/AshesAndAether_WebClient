import type { Entity, Vector3 }  from '@/network/Protocol';
import type { EntityRegistry }   from '@/state/EntityRegistry';
import type { PlayerState }      from '@/state/PlayerState';

/**
 * TabTargetService — FFXI / FFXIV-style keyboard target cycling.
 *
 *  Tab / Shift+Tab        — cycle world targets in a forward cone (FFXIV-ish).
 *  Ctrl+Tab / Ctrl+Shift+Tab — cycle allies (self + party + companion).
 *  F1                     — target self (kept for muscle memory).
 *  F2-F8                  — target party member by slot.
 *
 * Tab list = anything in front of you that isn't an ally, sorted hostile-
 * first then by distance. If the cone is empty (no target in view), Tab is
 * a no-op — rotate the camera/character and try again.
 */
export class TabTargetService {
  /** Cone gate as cos(half-angle). 0.0 = 180° total (full forward hemisphere
   *  anchored at the character, not the camera) — feels right for a 3rd-person
   *  WASD game where the model's facing is the source of truth. Tighten by
   *  raising (0.5 = 120°, 0.707 = 90°). */
  private static readonly TAB_CONE_HALF_COS = 0.0;
  /** Max XZ distance for Tab candidates, in metres. Beyond this, the entity
   *  is invisible enough that auto-targeting it would feel arbitrary. */
  private static readonly TAB_RANGE_M       = 50;
  constructor(
    private readonly entities:          EntityRegistry,
    private readonly player:            PlayerState,
    private readonly getPlayerPosition: () => Vector3,
  ) {}

  /* ── Enemy cycling (Tab / Shift+Tab) ───────────────────────────────────── */

  cycleTarget(direction: 1 | -1): void {
    const candidates = this._buildEnemyCandidates();
    if (candidates.length === 0) return;

    const currentIdx = candidates.findIndex(e => e.id === this.player.targetId);
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : candidates.length - 1;
    } else {
      nextIdx = (currentIdx + direction + candidates.length) % candidates.length;
    }

    const next = candidates[nextIdx]!;
    this.player.setTarget(next.id, next.name);
  }

  /* ── Ally cycling (Ctrl+Tab / Ctrl+Shift+Tab, also Ctrl+Arrow) ──────────── */

  cyclePartyTarget(direction: 1 | -1): void {
    const allies = this._buildAllyCandidates();
    if (allies.length === 0) return;

    const currentIdx = allies.findIndex(a => a.id === this.player.targetId);
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : allies.length - 1;
    } else {
      nextIdx = (currentIdx + direction + allies.length) % allies.length;
    }

    const next = allies[nextIdx]!;
    this.player.setTarget(next.id, next.name);
  }

  /* ── Direct party slot (F1-F8) ─────────────────────────────────────────── */

  targetPartySlot(slot: number): void {
    // F1 (slot 0) = target self
    if (slot === 0) {
      const selfId = this.player.id;
      if (selfId) this.player.setTarget(selfId, this.player.name);
      return;
    }

    // F2-F8 → party members excluding self, preserving roster order
    const others = this.player.partyMembers.filter(m => m.id !== this.player.id);
    const idx = slot - 1;
    if (idx < 0 || idx >= others.length) return;

    const member = others[idx]!;
    this.player.setTarget(member.id, member.name);
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  /** Tab cycles "engagement candidates" — non-ally entities inside a forward
   *  120° cone, within 50m. Hostile-first sort, then distance. If the cone
   *  is empty, the cycle is empty and Tab is a no-op. Tweakable via the
   *  `TAB_CONE_HALF_COS` / `TAB_RANGE_M` class constants. */
  private _buildEnemyCandidates(): Entity[] {
    const playerPos = this.getPlayerPosition();
    const playerId  = this.entities.playerId;
    const allyIds   = this._allyIds();

    // Forward direction from player heading. Heading 0 = +Z (south), CW.
    // dirX = sin(h), dirZ = cos(h) — matches the server's heading convention.
    const headingRad = (this.player.heading) * Math.PI / 180;
    const dirX       = Math.sin(headingRad);
    const dirZ       = Math.cos(headingRad);
    const rangeSq    = TabTargetService.TAB_RANGE_M * TabTargetService.TAB_RANGE_M;

    const candidates = this.entities.getAll().filter(e => {
      if (e.id === playerId)    return false;
      if (allyIds.has(e.id))    return false;
      if (e.isAlive === false)  return false;
      switch (e.type) {
        case 'mob':
        case 'wildlife':
        case 'npc':
        case 'plant':
        case 'player':     break;
        case 'structure':  if (e.interactive === false) return false; break;
        default:           return false;
      }

      // Range gate (XZ).
      const dx = e.position.x - playerPos.x;
      const dz = e.position.z - playerPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > rangeSq) return false;
      if (distSq < 1e-4)    return true;  // standing inside us — always include

      // Forward cone gate. dot(toEntity_norm, forward) ≥ cos(half-angle).
      const dist = Math.sqrt(distSq);
      const dot  = (dx * dirX + dz * dirZ) / dist;
      return dot >= TabTargetService.TAB_CONE_HALF_COS;
    });

    // Hostile mobs sort first so combat tabs feel responsive; everything
    // else sorts by distance behind them.
    candidates.sort((a, b) => {
      const aH = a.hostile === true ? 0 : 1;
      const bH = b.hostile === true ? 0 : 1;
      if (aH !== bH) return aH - bH;
      return this._distSq(playerPos, a.position) - this._distSq(playerPos, b.position);
    });
    return candidates;
  }

  /** Set of ids belonging to the player's "ally" group — excluded from the
   *  Tab cycle since Ctrl+Tab handles them. Self is in here too. */
  private _allyIds(): Set<string> {
    const ids = new Set<string>();
    const selfId = this.entities.playerId;
    if (selfId) ids.add(selfId);
    for (const m of this.player.partyMembers) {
      if (m.id) ids.add(m.id);
    }
    const companionId = this.player.companion?.companionId;
    if (companionId) ids.add(companionId);
    return ids;
  }

  /** Ally cycle: self → party members → own companion. Self leads the cycle
   *  so the first Ctrl+Tab press from a non-friendly target lands on you (a
   *  controller player has no F1 and needs a way to reach self via the
   *  d-pad). Set dedupes if party roster already lists the player. */
  private _buildAllyCandidates(): Entity[] {
    const playerId    = this.entities.playerId;
    const allEntities = this.entities.getAll();
    const byId        = new Map(allEntities.map(e => [e.id, e]));

    const ids = new Set<string>();

    // Self first.
    if (playerId) ids.add(playerId);

    // Party roster (may already include the player — Set dedupes).
    for (const m of this.player.partyMembers) {
      if (m.id) ids.add(m.id);
    }

    // Own companion — visible in EntityRegistry once spawned in zone.
    const companionId = this.player.companion?.companionId;
    if (companionId) ids.add(companionId);

    // Resolve to live entities (drops anyone who isn't in this zone right now).
    const out: Entity[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (!e || e.isAlive === false) continue;
      out.push(e);
    }
    return out;
  }

  /** Squared 2-D (XZ) distance — avoids sqrt, fine for sorting. */
  private _distSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}
