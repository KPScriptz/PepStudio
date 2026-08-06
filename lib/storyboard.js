// Hook-driven narrative package selector. Pure (no I/O, no DOM) so it's headlessly verifiable and
// reusable by either a backend route or the frontend assembler. Turns scored highlights into an
// 8–10 minute cut that LEADS with a cold-open hook then plays the story chronologically.
//
// Design that fits the real app (unlike a seqMap-shaped assembler):
//   • body[]  = the chronological kept clips → the frontend renders these as the timeline/seqMap
//               using the EXISTING model (no change to the {h,s} seqMap shape, no playhead break).
//   • hook    = a short teaser {start,end} of the single best moment → the caller PREPENDS it at
//               export exactly like the proven YouTube-cut hook path (server.js /api/export/youtube
//               already accepts a `hook` segment). The hook clip also stays in body, so the cold
//               open teases the climax and the body reveals how they got there (the smash-cut).
//
// Named narrative BLUEPRINTS — genre presets that reweight which moments win the budget and set the
// cold-open length. Each only shifts EMPHASIS + hook feel; the body stays chronological (setups
// precede payoffs for free), so no risky non-linear re-ordering. 'balanced' reproduces the original
// weighting EXACTLY (100/10/2, hook 8s) — the default path and its test are byte-for-byte unchanged.
export const STORYBOARD_BLUEPRINTS = {
  // Neutral: OCR game events » story chains » reactions » raw score. The proven default.
  balanced: { label: 'Balanced', w: { gameEvent: 100, chain: 10, react: 2 }, hookSec: 8 },
  // Vanoss-style chaos: laughter/reaction spikes carry it; short, punchy cold open, snappy cuts.
  chaos: { label: 'Chaos', w: { gameEvent: 30, chain: 6, react: 8 }, hookSec: 5 },
  // Clutch vs Fail: tense game-state moments + setup→payoff arcs lead; long slow-burn cold open.
  clutch: { label: 'Clutch vs Fail', w: { gameEvent: 200, chain: 24, react: 2 }, hookSec: 10 },
  // Storytime: narrative chains (setup/payoff) carry it, reactions secondary.
  story: { label: 'Storytime', w: { gameEvent: 80, chain: 40, react: 3 }, hookSec: 8 },
  // Fast-Cut: high-density social format — snappy 4s cold open, reaction spikes dominate, chains
  // secondary. Pairs with Relentless micro-cut pacing (the UI sets that when you pick it).
  fast: { label: 'Fast-Cut', w: { gameEvent: 50, chain: 6, react: 9 }, hookSec: 4 },
};

// The scoring function, shared by the planner and the selector so they can never disagree about
// what "strong" means. Exported for tests.
export function priorityOf(h, blueprint = 'balanced') {
  const bp = STORYBOARD_BLUEPRINTS[blueprint] || STORYBOARD_BLUEPRINTS.balanced;
  const gameEvent = (h.gameEvents && h.gameEvents.length) ? 1 : 0;
  const chain = (h.scores && h.scores.story >= 0.6) ? 1 : 0;
  const react = h.reactionScore || 0;
  return gameEvent * bp.w.gameEvent + chain * bp.w.chain + react * bp.w.react + (Number(h.score) || 0);
}

// ---- Adaptive run-time planner ----------------------------------------------------------------
// Replaces the hardcoded 8-10 minute target so ANY length of footage works: a 12-minute clip
// shouldn't be padded to 8 minutes, and a 3-hour stream shouldn't be squeezed into 10.
//
// The length is driven by HOW MUCH GOOD MATERIAL ACTUALLY EXISTS, not by the clock. We rank every
// candidate, find the quality KNEE (where marginal quality falls off a cliff), and sum the runtime
// above it. Source length only supplies a sanity ceiling — a long VOD permits a longer cut, but it
// never manufactures one out of weak material.
//
// Pure and synchronous, so the UI can recompute it live as the blueprint changes.
export function recommendPlan(highlights, { sourceSec = 0, blueprint = 'balanced', hookSec } = {}) {
  const hs = (highlights || []).filter((h) => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  const bp = STORYBOARD_BLUEPRINTS[blueprint] || STORYBOARD_BLUEPRINTS.balanced;
  const empty = {
    targetSec: 0, minSec: 0, maxSec: 0, hookSec: 0, strongCount: 0, availSec: 0,
    tier: 'empty', reason: 'No usable moments yet — rank the VOD first.',
  };
  if (!hs.length) return empty;

  const ranked = [...hs].sort((a, b) => priorityOf(b, blueprint) - priorityOf(a, blueprint));
  const scores = ranked.map((h) => priorityOf(h, blueprint));
  const availSec = hs.reduce((n, h) => n + (h.end - h.start), 0);
  const top = scores[0] || 0;

  // KNEE: walk down the ranking and stop where quality collapses. Two signals, whichever fires
  // first — an absolute floor (a fixed fraction of the best moment) and the steepest relative drop
  // in the upper half. The drop test catches a tight cluster of greats followed by filler; the
  // floor test catches a long gentle slide with no obvious cliff.
  let knee = ranked.length;
  const FLOOR_FRAC = 0.22;
  for (let i = 1; i < scores.length; i++) {
    if (top > 0 && scores[i] < top * FLOOR_FRAC) { knee = i; break; }
  }
  let steepest = 0, steepestAt = 0;
  for (let i = 1; i < Math.min(scores.length, Math.max(3, Math.ceil(knee * 0.75))); i++) {
    const drop = scores[i - 1] - scores[i];
    if (drop > steepest) { steepest = drop; steepestAt = i; }
  }
  // Only honour the cliff when it's genuinely a cliff (a third of the whole range) and it doesn't
  // throw away almost everything.
  if (top > 0 && steepest > top * 0.33 && steepestAt >= Math.max(3, Math.ceil(ranked.length * 0.15))) {
    knee = Math.min(knee, steepestAt);
  }
  knee = Math.max(1, Math.min(knee, ranked.length));

  // Runtime of the material above the knee, ignoring overlap the selector would drop anyway.
  const strong = ranked.slice(0, knee).sort((a, b) => a.start - b.start);
  let strongSec = 0, lastEnd = -Infinity;
  for (const h of strong) {
    const s = Math.max(h.start, lastEnd);
    if (h.end > s) { strongSec += h.end - s; lastEnd = h.end; }
  }

  // Sanity ceiling from the source: 25% of the VOD, held between 3 and 30 minutes. A 3-hour stream
  // can justify a 30-minute cut; a 6-minute clip cannot justify 8.
  const ceilFromSource = sourceSec > 0
    ? Math.min(1800, Math.max(180, sourceSec * 0.25))
    : 1800;
  const target = Math.max(45, Math.min(strongSec, ceilFromSource, availSec));

  // Hook scales gently with the cut: a 60-second cut shouldn't open with a 10-second teaser.
  const hk = Number.isFinite(hookSec) ? hookSec : Math.max(3, Math.min(bp.hookSec, target * 0.06));

  const tier = target < 120 ? 'clip' : target < 480 ? 'short' : target < 1200 ? 'standard' : 'long-form';
  const capped = target >= ceilFromSource - 0.5 && strongSec > ceilFromSource;
  const reason = capped
    ? `${knee} strong moments (${fmtMin(strongSec)} of material) — capped at 25% of the ${fmtMin(sourceSec)} source.`
    : `${knee} strong moments above the quality knee = ${fmtMin(target)}.`;

  return {
    targetSec: +target.toFixed(1),
    // A ±12% band gives the selector room to land on clip boundaries instead of cutting mid-moment.
    minSec: +Math.max(30, target * 0.88).toFixed(1),
    maxSec: +Math.min(availSec, target * 1.12).toFixed(1),
    hookSec: +hk.toFixed(1),
    strongCount: knee,
    availSec: +availSec.toFixed(1),
    strongSec: +strongSec.toFixed(1),
    ceilSec: +ceilFromSource.toFixed(1),
    tier, capped, blueprint, reason,
  };
}
const fmtMin = (s) => {
  const t = Math.max(0, Math.round(s || 0));
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`;
};

// Priority order (this is what makes it work for Palworld, where reactions alone miss quiet
// catches): OCR game events » story chains » strong audio reactions » raw score. A `blueprint`
// preset reweights these; explicit `hookSec` still overrides the preset's hook length.
//
// minSec/maxSec default to the original 8-10 min for back-compat. Pass `auto: true` (with
// `sourceSec`) to size the cut to the footage instead — see recommendPlan.
export function selectStoryboard(highlights, { minSec = 480, maxSec = 600, hookSec, blueprint = 'balanced', auto = false, sourceSec = 0 } = {}) {
  if (auto) {
    const plan = recommendPlan(highlights, { sourceSec, blueprint, hookSec });
    if (plan.targetSec > 0) {
      minSec = plan.minSec; maxSec = plan.maxSec;
      if (!Number.isFinite(hookSec)) hookSec = plan.hookSec;
    }
  }
  const hs = (highlights || []).filter((h) => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  if (!hs.length) return { hook: null, body: [], totalSec: 0, reachedMin: false };

  const bp = STORYBOARD_BLUEPRINTS[blueprint] || STORYBOARD_BLUEPRINTS.balanced;
  const hookLen = Number.isFinite(hookSec) ? hookSec : bp.hookSec;
  const prio = (h) => priorityOf(h, blueprint);
  const ranked = [...hs].sort((a, b) => prio(b) - prio(a));

  // Hook = highest-priority moment. Teaser BUILDS INTO the actual peak (`t`, the loudest-reaction
  // timestamp) and cuts ~1s after it — a cold open should land on the scream, not an arbitrary tail.
  // Falls back to the clip's end when `t` is missing.
  const top = ranked[0];
  const hkDur = Math.min(hookLen, top.end - top.start);
  const peak = Number.isFinite(top.t) ? top.t : top.end - hkDur / 2;
  let hStart = peak + 1 - hkDur;                       // teaser ends ~1s past the peak
  hStart = Math.min(Math.max(hStart, top.start), top.end - hkDur);   // keep it inside the clip
  const hook = { id: `hook_${top.id}`, source: top.id, start: +hStart.toFixed(2), end: +(hStart + hkDur).toFixed(2) };

  // Fill the body by descending priority until we reach the 8-min floor, never breaching the
  // 10-min ceiling (the hook eats into the ceiling). Low-priority filler is naturally excluded
  // once the budget fills → "trim resource-grinding first" falls out of the ordering for free.
  const ceiling = maxSec - hkDur;
  const floor = minSec - hkDur;
  const chosen = [];
  let used = 0;
  for (const h of ranked) {
    const d = h.end - h.start;
    if (used + d > ceiling) continue;
    // Skip clips that overlap one already chosen — with wide contextual windows, adjacent moments
    // can share footage, and the higher-priority one is already in (ranked is priority-ordered), so
    // this drops the duplicate instead of replaying the same seconds twice in the cut.
    if (chosen.some((c) => h.start < c.end && h.end > c.start)) continue;
    chosen.push(h);
    used += d;
    if (used >= floor) break;
  }

  const body = chosen.sort((a, b) => a.start - b.start);
  const totalSec = +(hkDur + used).toFixed(1);
  // `ranked` (priority-ordered by the active blueprint) is exposed so callers can build hook
  // candidates with the SAME ranking without re-deriving the private prio. The route strips it.
  return { hook, body, totalSec, hookSec: +hkDur.toFixed(1), reachedMin: totalSec >= minSec, blueprint, ranked };
}
