import type { EntityRegistry } from '@/state/EntityRegistry';

/**
 * Per-viewer combat narrative substitution.
 *
 * Server emits templates with `{attacker}` / `{target}` / `{attacker_pos}`
 * / `{target_pos}` placeholders + IDs in eventTypeData; client fills in
 * "You/you/Your/your" for self and the entity name (from the registry)
 * for everyone else. Verbs on the server are past-tense so the same
 * sentence reads naturally regardless of which side substitutes to "you".
 */

export function localizeCombatNarrative(
  template:        string,
  attackerId:      string | undefined,
  targetId:        string | undefined,
  selfId:          string,
  selfName:        string,
  registry:        EntityRegistry,
): string {
  const attackerIsSelf = !!attackerId && attackerId === selfId;
  const targetIsSelf   = !!targetId   && targetId   === selfId;

  const attackerName = attackerIsSelf
    ? selfName
    : (attackerId ? (registry.get(attackerId)?.name ?? attackerId) : '');
  const targetName = targetIsSelf
    ? selfName
    : (targetId ? (registry.get(targetId)?.name ?? targetId) : '');

  // Possessive first so `{attacker_pos}` doesn't accidentally match the
  // `{attacker}` regex.
  let s = template;
  s = s.replace(/\{attacker_pos\}/g, attackerIsSelf ? 'your' : `${attackerName}'s`);
  s = s.replace(/\{target_pos\}/g,   targetIsSelf   ? 'your' : `${targetName}'s`);
  s = s.replace(/\{attacker\}/g,     attackerIsSelf ? 'you'  : attackerName);
  s = s.replace(/\{target\}/g,       targetIsSelf   ? 'you'  : targetName);

  // Capitalize the start of the sentence — handles "you/your" subject at
  // sentence start where we want "You/Your". Names are already
  // capitalized so this is a no-op for them.
  if (s.length > 0) s = s.charAt(0).toUpperCase() + s.slice(1);
  // Also any sentence break ". " (rare in current narratives but
  // future-proofs longer combat blurbs).
  s = s.replace(/(\.\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());

  return s;
}
