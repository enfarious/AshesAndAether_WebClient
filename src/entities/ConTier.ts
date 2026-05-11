/**
 * ConTier — relative-difficulty ladder for nameplate display.
 *
 * The viewer-vs-target level difference maps to one of seven tiers
 * (`too_weak` → `omg_dont`). Each tier carries a glyph string (the
 * ↓↓↓ / = / ↑↑↑ arrows) and a hint color the renderer can use to
 * tint the arrows on the plate.
 *
 * Aligned with the server's GRAY_CON_LEVEL_DIFF = 7 gate: at diff ≥ 7
 * the mob is "too weak" and won't aggro the viewer; the symmetric
 * lower bound (diff ≤ -7) is "omg_dont" — the inverse pole where a
 * mob 7+ above you is treated as deadly.
 *
 * Notorious Monsters short-circuit this: `formatConForNotorious()`
 * returns `??` regardless of level diff.
 */

export type ConTier =
  | 'too_weak'
  | 'real_weak'
  | 'weak'
  | 'even'
  | 'tough'
  | 'real_tough'
  | 'omg_dont';

export interface ConReadout {
  tier:  ConTier;
  /** Short glyph string for the plate (e.g. "↓↓↓", "=", "↑↑↑"). */
  arrows: string;
  /** Hex color hint for the arrows. Pure aggro coloring lives on the
   *  name; arrows carry a mild con tint so the plate is readable at a
   *  glance even when the name color is the same (two friendly mobs of
   *  different levels read distinctly). */
  color: string;
  /** True for tiers where the viewer outclasses the target hard enough
   *  that the server's gray-con aggro gate kicks in. Useful if we ever
   *  want a "won't fight you back" hint. */
  grayCon: boolean;
}

const TIERS: Record<ConTier, { arrows: string; color: string; grayCon: boolean }> = {
  too_weak:   { arrows: '↓↓↓', color: '#7d8a8e', grayCon: true  }, // ↓↓↓ dim gray
  real_weak:  { arrows: '↓↓',       color: '#9bb5a3', grayCon: false }, // ↓↓ pale green-gray
  weak:       { arrows: '↓',             color: '#a8d8a8', grayCon: false }, // ↓ green
  even:       { arrows: '=',                  color: '#e8e8e8', grayCon: false }, // = white
  tough:      { arrows: '↑',             color: '#f0c878', grayCon: false }, // ↑ yellow
  real_tough: { arrows: '↑↑',       color: '#f09848',  grayCon: false }, // ↑↑ orange
  omg_dont:   { arrows: '↑↑↑', color: '#e85040', grayCon: false }, // ↑↑↑ red
};

/** Compute the con tier readout for `target.level` from the viewer's POV.
 *  Returns undefined when either level is unknown (entity hasn't shipped
 *  level yet, or local player hasn't logged in). */
export function computeConTier(viewerLevel: number | undefined, targetLevel: number | undefined): ConReadout | undefined {
  if (typeof viewerLevel !== 'number' || typeof targetLevel !== 'number') return undefined;
  const diff = targetLevel - viewerLevel;
  let tier: ConTier;
  if (diff >=  7) tier = 'omg_dont';
  else if (diff >=  4) tier = 'real_tough';
  else if (diff >=  2) tier = 'tough';
  else if (diff >= -1) tier = 'even';
  else if (diff >= -3) tier = 'weak';
  else if (diff >= -6) tier = 'real_weak';
  else                 tier = 'too_weak';
  const t = TIERS[tier];
  return { tier, arrows: t.arrows, color: t.color, grayCon: t.grayCon };
}

/** Special-case readout for Notorious Monsters — level is hidden. */
export const NOTORIOUS_READOUT: ConReadout = {
  tier:    'omg_dont',
  arrows:  '??',
  color:   '#e85040',
  grayCon: false,
};

/** Color used for the entity name based on aggro disposition. Mobs use
 *  this; friendly players/NPCs/wildlife default to the friendly color. */
export function aggroNameColor(disposition: string | undefined, isFriendly: boolean): string {
  if (isFriendly) return '#a8d4ff';            // soft blue — players / party / friendly
  switch (disposition) {
    case 'hostile':  return '#ff6a5a';         // red — will attack on sight
    case 'neutral':  return '#f0d068';         // yellow — wary, fight-back only
    case 'friendly': return '#88e0a8';         // green — won't attack you
    default:         return '#e8e8e8';         // unknown → near-white neutral
  }
}
