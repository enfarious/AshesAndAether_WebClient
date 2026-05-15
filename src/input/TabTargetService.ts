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
  /** Max XZ distance for Tab candidates, in metres. Beyond this, the entity
   *  is invisible enough that auto-targeting it would feel arbitrary. No
   *  forward-cone gate — ASD-strafing means the model rarely points where
   *  the player is engaging from, and the camera/model are independent.
   *  Tab cycles all hostiles in range, hostile-first by distance. */
  private static readonly TAB_RANGE_M       = 50;
  /** Optional source of "panel-ordered ally ids" — wired from PartyWindow.
   *  When provided, Ctrl+Tab and F1-F8 walk this exact order so muscle memory
   *  matches what's on screen. When null (PartyWindow not mounted yet), fall
   *  back to the legacy self → party → companion order. */
  private orderedAllyIds: (() => string[]) | null = null;
  constructor(
    private readonly entities:          EntityRegistry,
    private readonly player:            PlayerState,
    private readonly getPlayerPosition: () => Vector3,
  ) {}

  /** Late-bind the panel-order provider. PartyWindow calls this once after
   *  construction so Ctrl+Tab cycles in the same order the user sees. */
  setOrderedAllyIdsProvider(fn: () => string[]): void {
    this.orderedAllyIds = fn;
  }

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
    // F1 = self, F2-F8 = subsequent panel rows (so a controller player can
    // reach a hireling with F2 if their cluster sorts second in the panel).
    // Fall back to the legacy "party members minus self" mapping when the
    // panel-order provider isn't wired yet.
    const ordered = this._panelOrderedAllyIds();
    if (ordered.length > 0) {
      const id = ordered[slot];
      if (!id) return;
      const e = this.entities.get(id);
      this.player.setTarget(id, e?.name ?? '');
      return;
    }

    if (slot === 0) {
      const selfId = this.player.id;
      if (selfId) this.player.setTarget(selfId, this.player.name);
      return;
    }
    const others = this.player.partyMembers.filter(m => m.id !== this.player.id);
    const idx = slot - 1;
    if (idx < 0 || idx >= others.length) return;
    const member = others[idx]!;
    this.player.setTarget(member.id, member.name);
  }

  /** Acquire the nearest hostile-first candidate in front of the camera and
   *  set it as the main target. No-op if nothing is in view. Used by the
   *  gamepad's confirm-with-no-target path: first press picks a target, the
   *  second press fires the TargetWindow action (usually Attack).
   *
   *  forwardX / forwardZ are the camera's normalized forward vector in world
   *  space. fovDot is the dot-product threshold for "in view": 0.5 ≈ ±60°,
   *  0 = front hemisphere (180°). */
  targetClosestInView(forwardX: number, forwardZ: number, fovDot = 0.5): boolean {
    const candidates = this._buildEnemyCandidates();
    if (candidates.length === 0) return false;
    const playerPos = this.getPlayerPosition();

    for (const e of candidates) {
      const dx = e.position.x - playerPos.x;
      const dz = e.position.z - playerPos.z;
      const len = Math.hypot(dx, dz);
      if (len === 0) continue;
      const dot = (dx / len) * forwardX + (dz / len) * forwardZ;
      if (dot < fovDot) continue;
      this.player.setTarget(e.id, e.name);
      return true;
    }
    return false;
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  /** Tab cycles "engagement candidates" — non-ally entities within 50m.
   *  Hostile-first sort, then by distance. No facing/cone gate: the player's
   *  model rotation rarely matches camera or intent during ASD strafing,
   *  and using camera heading would still miss anything not directly under
   *  the cursor. Modern WoW-style "cycle nearest enemy" is the simpler fit. */
  private _buildEnemyCandidates(): Entity[] {
    const playerPos = this.getPlayerPosition();
    const playerId  = this.entities.playerId;
    const allyIds   = this._allyIds();
    const rangeSq   = TabTargetService.TAB_RANGE_M * TabTargetService.TAB_RANGE_M;

    const candidates = this.entities.getAll().filter(e => {
      if (e.id === playerId)    return false;
      if (allyIds.has(e.id))    return false;
      if (e.isAlive === false)  return false;
      switch (e.type) {
        case 'mob':
        case 'wildlife':
        case 'npc':
        case 'player':     break;
        case 'structure':  if (e.interactive === false) return false; break;
        // 'plant' (trees, harvestable plants) intentionally excluded —
        // harvest is proximity-based via /harvest + F-key, no targeting
        // needed. Including plants in the cycle was just noise.
        default:           return false;
      }

      // Range gate (XZ) only.
      const dx = e.position.x - playerPos.x;
      const dz = e.position.z - playerPos.z;
      return (dx * dx + dz * dz) <= rangeSq;
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
   *  Tab cycle since Ctrl+Tab handles them. Includes self, party members,
   *  every party member's summoned companion + hirelings. */
  private _allyIds(): Set<string> {
    const ids = new Set<string>();
    const selfId = this.entities.playerId;
    if (selfId) ids.add(selfId);

    // Party roster (may already include self — Set dedupes).
    for (const m of this.player.partyMembers) {
      if (m.id) ids.add(m.id);
    }

    // Sweep entity registry for companions + hirelings of self or any party
    // member. Owner relationship is on the entity (server populates
    // ownerCharacterId on entity broadcasts).
    const ownerSet = new Set<string>(ids);
    for (const e of this.entities.getAll()) {
      const t = (e.type ?? '').toLowerCase();
      if (t !== 'companion' && t !== 'hireling') continue;
      if (e.ownerCharacterId && ownerSet.has(e.ownerCharacterId)) {
        ids.add(e.id);
      }
    }
    return ids;
  }

  /** Ally cycle in PARTY-PANEL ORDER when the provider's wired up: self →
   *  own pets → next player → their pets → … (matching what the user sees
   *  on screen). Falls back to the legacy self → party → own-companion
   *  ordering when the panel isn't mounted yet. */
  private _buildAllyCandidates(): Entity[] {
    const ordered = this._panelOrderedAllyIds();
    const out: Entity[] = [];

    if (ordered.length > 0) {
      for (const id of ordered) {
        const e = this.entities.get(id);
        if (!e || e.isAlive === false) continue;
        out.push(e);
      }
      return out;
    }

    // Legacy fallback — same shape as before the extended-party panel landed.
    const playerId    = this.entities.playerId;
    const byId        = new Map(this.entities.getAll().map(e => [e.id, e]));
    const ids: string[] = [];
    if (playerId) ids.push(playerId);
    for (const m of this.player.partyMembers) {
      if (m.id && !ids.includes(m.id)) ids.push(m.id);
    }
    const companionId = this.player.companion?.companionId;
    if (companionId && !ids.includes(companionId)) ids.push(companionId);
    for (const id of ids) {
      const e = byId.get(id);
      if (!e || e.isAlive === false) continue;
      out.push(e);
    }
    return out;
  }

  /** Snapshot of the panel's ordered ally ids, or empty array when the
   *  provider hasn't been wired (PartyWindow not yet mounted). */
  private _panelOrderedAllyIds(): string[] {
    if (!this.orderedAllyIds) return [];
    try { return this.orderedAllyIds(); }
    catch { return []; }
  }

  /** Squared 2-D (XZ) distance — avoids sqrt, fine for sorting. */
  private _distSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}
