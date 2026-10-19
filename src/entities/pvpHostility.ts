import type { Entity } from '@/network/Protocol';

/**
 * Client-side open-PvP hostility classifier.
 *
 * Mirrors the server's `pvpHostility` rule: an armed peer who isn't in
 * the viewer's guild registers as hostile. Both sides must be armed —
 * if you're not in the `armed` state yourself, no peer is hostile to you
 * (the damage veto would block any swing anyway).
 *
 * Pure function — call it everywhere the client previously read
 * `entity.hostile` directly and you need to include the PvP case.
 */

/** Friend-or-foe context the app refreshes every frame: who WE are beyond
 *  pvp/guild. Mirrors the server's _reaverTruce / _defenseSides. */
interface FoFContext { selfId: string | null; selfReaver: boolean; selfDefenseRaider: boolean; inDefense: boolean; }
let fof: FoFContext = { selfId: null, selfReaver: false, selfDefenseRaider: false, inDefense: false };
export function setFoFContext(c: FoFContext): void { fof = c; }

/** Reaver-faction mob vs a Reaver viewer: truce, both ways. */
export function isReaverTruce(entity: Entity): boolean {
  return fof.selfReaver && entity.type === 'mob' && entity.faction === 'reaver';
}

export function isPvpHostileToSelf(
  entity:       Entity,
  selfPvpArmed: boolean,
  selfGuildId:  string | null,
): boolean {
  if (entity.type !== 'player') return false;
  if (entity.id === fof.selfId) return false;
  // Settlement defense: militia vs raiders, always, whatever guild or PvP state.
  if (fof.inDefense) return (entity.defenseRaider === true) !== fof.selfDefenseRaider;
  if (!entity.pvpArmed)         return false;
  if (!selfPvpArmed)            return false;
  // Same-guild: never hostile. Both nulls fall through (guildless players
  // CAN fight each other — they don't share a faction).
  if (selfGuildId && entity.guildId && entity.guildId === selfGuildId) return false;
  return true;
}

/** Combine the server's `entity.hostile` flag with the open-PvP rule.
 *  Use this anywhere the client previously read `entity.hostile`. */
export function isEffectivelyHostile(
  entity:       Entity,
  selfPvpArmed: boolean,
  selfGuildId:  string | null,
): boolean {
  if (isReaverTruce(entity)) return false;
  if (entity.hostile === true) return true;
  return isPvpHostileToSelf(entity, selfPvpArmed, selfGuildId);
}
