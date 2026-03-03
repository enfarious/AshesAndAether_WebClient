import type { Entity, Vector3 }  from '@/network/Protocol';
import type { EntityRegistry }   from '@/state/EntityRegistry';
import type { PlayerState }      from '@/state/PlayerState';

const TARGETABLE_TYPES = ['player', 'npc', 'mob', 'wildlife', 'plant', 'companion'];

/**
 * TabTargetService — FFXI / FFXIV-style keyboard target cycling.
 *
 *  Tab / Shift+Tab   — cycle nearby entities (nearest-first).
 *  F1                — target self.
 *  F2-F8             — target party member by slot.
 *  Ctrl+Up / Down    — cycle through party members sequentially.
 *
 * In combat the Tab list narrows to hostile mobs / wildlife only.
 */
export class TabTargetService {
  constructor(
    private readonly entities:          EntityRegistry,
    private readonly player:            PlayerState,
    private readonly getPlayerPosition: () => Vector3,
  ) {}

  /* ── Entity cycling (Tab / Shift+Tab) ──────────────────────────────────── */

  cycleTarget(direction: 1 | -1): void {
    const candidates = this._buildCandidateList();
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

  /* ── Party cycling (Ctrl+Arrow) ────────────────────────────────────────── */

  cyclePartyTarget(direction: 1 | -1): void {
    const members = this.player.partyMembers;
    if (members.length === 0) return;

    const currentIdx = members.findIndex(m => m.id === this.player.targetId);
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : members.length - 1;
    } else {
      nextIdx = (currentIdx + direction + members.length) % members.length;
    }

    const member = members[nextIdx]!;
    this.player.setTarget(member.id, member.name);
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

  private _buildCandidateList(): Entity[] {
    const playerPos = this.getPlayerPosition();
    const inCombat  = this.player.combat.inCombat;
    const playerId  = this.entities.playerId;

    const candidates = this.entities.getAll().filter(e => {
      if (e.id === playerId)      return false;
      if (e.isAlive === false)    return false;
      if (e.type === 'structure') return false;

      if (inCombat) {
        return (e.type === 'mob' || e.type === 'wildlife') && e.hostile === true;
      }
      return TARGETABLE_TYPES.includes(e.type);
    });

    candidates.sort((a, b) => this._distSq(playerPos, a.position) - this._distSq(playerPos, b.position));
    return candidates;
  }

  /** Squared 2-D (XZ) distance — avoids sqrt, fine for sorting. */
  private _distSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}
