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

// ---- Candidate pool sizing --------------------------------------------------------------------
// How many moments to rank, and how much audio whisper is allowed to hear, for a given source
// length. These were fixed constants tuned on a ~68-minute VOD, which silently capped what a
// longer stream could ever become: 40 candidates is ~20 minutes of material no matter how long the
// VOD is. That contradicts the adaptive planner — "3 hours with 45 minutes of gold gives a 45-min
// cut" is impossible when the pool upstream can only hold 20. Both grow with duration now.
//
// The reference length is pinned so a 68-minute VOD produces byte-identical numbers to before:
// this widens long sources without re-tuning the case the defaults were measured on. The upper
// bounds exist because the audio budget is the dominant ranking cost — whisper time scales with
// it — so a 6-hour VOD samples a smaller fraction rather than running unbounded.
export const POOL_REF_SEC = 4080;
export function candidatePool(durationSec, { storyboard = false } = {}) {
  if (!storyboard) return { keepN: 8, budgetSec: 540, scale: 1 };
  const scale = durationSec > 0 ? Math.max(1, durationSec / POOL_REF_SEC) : 1;
  return {
    keepN: Math.min(200, Math.round(40 * scale)),
    budgetSec: Math.min(3600, Math.round(1500 * scale)),
    scale: +scale.toFixed(3),
  };
}

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
// The cut is exactly as long as it deserves to be, and not one second longer. No hardcoded target,
// and deliberately NO time ceiling: length is purely a function of how much material clears the
// quality bar. 4 minutes of gold in a 68-minute stream gives a 4-minute cut; 25 minutes of gold in
// the same stream gives the full 25-minute epic.
//
// `pickyFloor` (0-1, default 0.35) is the single control: a moment must score at least that
// fraction of the VOD's best moment to survive. Raise it to be more ruthless, lower it to keep more.
//
// Pure and synchronous, so the UI can recompute it live as the footage or the bar changes.
export function recommendPlan(highlights, { sourceSec = 0, blueprint = 'balanced', hookSec, pickyFloor } = {}) {
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

  // PICKY FLOOR — the only thing that governs length. Keep every moment scoring at least
  // `pickyFloor` of the best moment in the VOD, and let the runtime be whatever that adds up to:
  // 4 minutes of gold gives a 4-minute cut, 25 minutes of gold gives a 25-minute cut. There is
  // deliberately NO time ceiling — a cap would throw away material that already cleared the bar,
  // which is the opposite of what the bar is for. Raise pickyFloor to be more ruthless.
  //
  // Note this is a FILTER, not a knee-finder. An earlier version also looked for the steepest
  // quality cliff, but that could cut BELOW the floor and discard moments that had passed it.
  // When the rule is "keep everything above the bar", the bar has to be the only authority.
  const floorFrac = Number.isFinite(pickyFloor) ? Math.min(0.95, Math.max(0.02, pickyFloor)) : 0.35;

  // Degenerate case: no spread in the scores (all zero, or every moment identical) means the
  // ranking can't discriminate, so a relative threshold is meaningless and would pass everything —
  // silently turning a 3-hour VOD into a 3-hour "cut". Keep the top half by score and say so.
  const spread = top > 0 && scores[scores.length - 1] < top;
  let kept, degenerate = false;
  if (!spread) {
    degenerate = true;
    kept = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  } else {
    kept = ranked.filter((h) => priorityOf(h, blueprint) >= top * floorFrac);
  }
  const strongCount = kept.length;

  // De-overlapped runtime of everything that cleared the bar — overlapping windows would otherwise
  // double-count seconds the selector drops anyway.
  const chrono = [...kept].sort((a, b) => a.start - b.start);
  let strongSec = 0, lastEnd = -Infinity;
  for (const h of chrono) {
    const s = Math.max(h.start, lastEnd);
    if (h.end > s) { strongSec += h.end - s; lastEnd = h.end; }
  }
  const target = Math.min(strongSec, availSec);

  // Hook scales gently with the cut: a 60-second cut shouldn't open with a 10-second teaser.
  const hk = Number.isFinite(hookSec) ? hookSec : Math.max(3, Math.min(bp.hookSec, Math.max(50, target) * 0.06));

  const tier = target < 120 ? 'clip' : target < 480 ? 'short' : target < 1200 ? 'standard' : 'long-form';
  const density = sourceSec > 0 ? target / sourceSec : 0;
  const reason = degenerate
    ? `Scores are flat — kept the top ${strongCount} of ${ranked.length} moments (${fmtMin(target)}). Rank the VOD for a sharper cut.`
    : `${strongCount} of ${ranked.length} moments cleared the ${Math.round(floorFrac * 100)}% bar = ${fmtMin(target)}`
      + (sourceSec > 0 ? ` (${Math.round(density * 100)}% of a ${fmtMin(sourceSec)} stream).` : '.');

  return {
    targetSec: +target.toFixed(1),
    // The selector fills by descending priority until it reaches minSec. Sitting minSec just under
    // the target and giving maxSec a little headroom lets it take EVERY clip that cleared the bar
    // and still land on clip boundaries rather than slicing one in half.
    minSec: +Math.max(1, target * 0.98).toFixed(1),
    maxSec: +Math.min(availSec, Math.max(target * 1.08, target + 30)).toFixed(1),
    hookSec: +hk.toFixed(1),
    strongCount,
    totalCount: ranked.length,
    availSec: +availSec.toFixed(1),
    strongSec: +strongSec.toFixed(1),
    pickyFloor: +floorFrac.toFixed(2),
    density: +density.toFixed(3),
    degenerate,
    tier, blueprint, reason,
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
export function selectStoryboard(highlights, { minSec = 480, maxSec = 600, hookSec, blueprint = 'balanced', auto = false, sourceSec = 0, pickyFloor } = {}) {
  if (auto) {
    const plan = recommendPlan(highlights, { sourceSec, blueprint, hookSec, pickyFloor });
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
