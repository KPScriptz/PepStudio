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
// Priority order (this is what makes it work for Palworld, where reactions alone miss quiet
// catches): OCR game events » story chains » strong audio reactions » raw score.
export function selectStoryboard(highlights, { minSec = 480, maxSec = 600, hookSec = 8 } = {}) {
  const hs = (highlights || []).filter((h) => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  if (!hs.length) return { hook: null, body: [], totalSec: 0, reachedMin: false };

  const prio = (h) => {
    const gameEvent = (h.gameEvents && h.gameEvents.length) ? 1 : 0;      // boss/raid/caught — structural
    const chain = (h.scores && h.scores.story >= 0.6) ? 1 : 0;            // setup↔payoff arc
    const react = h.reactionScore || 0;                                   // audio excitement
    return gameEvent * 100 + chain * 10 + react * 2 + (Number(h.score) || 0);
  };
  const ranked = [...hs].sort((a, b) => prio(b) - prio(a));

  // Hook = highest-priority moment; teaser = the last hookSec (the climax) of that clip.
  const top = ranked[0];
  const hkDur = Math.min(hookSec, top.end - top.start);
  const hook = { id: `hook_${top.id}`, source: top.id, start: +(top.end - hkDur).toFixed(2), end: +top.end.toFixed(2) };

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
  return { hook, body, totalSec, hookSec: +hkDur.toFixed(1), reachedMin: totalSec >= minSec };
}
