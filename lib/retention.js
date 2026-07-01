// Retention heuristics — pure, zero-dependency. The loudness/reaction/silence-boundary
// signals already live in analyze.js / reactions.js / trim.js; this adds the one thing
// they don't: demoting weak HOOKS (boring intros / filler openers) so the strongest
// moments rank first, plus a light pacing tag for display.

// "Hey guys", "okay so basically", "as you can see"… — classic retention killers.
const WEAK_OPENERS = /^(hey guys|hi guys|hello|welcome back|welcome|what'?s up|what is up|okay so|ok so|so basically|basically|as you can see|like i said|anyway|alright so|today (we|i)|in this (video|one))/i;

// Score delta (<= 0) for a candidate based on its opening line. Scaled to the funny
// endpoint's fused score (audioScore + 1.5*reactionScore, typically ~0–10).
export function hookPenalty(text) {
  const t = (text || '').trim();
  return t && WEAK_OPENERS.test(t) ? -1.5 : 0;
}

// Words-per-second → pacing tag (GTA comedy = chaotic/fast vs slow driving/setup).
export function pacingTag(words) {
  if (!words || words.length < 2) return 'steady';
  const span = Math.max(0.5, words[words.length - 1].t1 - words[0].t0);
  const wps = words.length / span;
  return wps >= 2.8 ? 'fast' : wps <= 1.2 ? 'slow' : 'steady';
}
