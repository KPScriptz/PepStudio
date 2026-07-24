// Hook health — a heuristic 1–10 estimate of how strong a cold-open teaser is, computed from
// signals PepStudio already produces. Deliberately NOT a trained retention model: the app is
// 100% local, nothing is uploaded, so there is no view/retention dataset to learn from. This is an
// honest pre-export estimate — "does this window open loud, active, and interesting?" — over three
// grounded axes:
//   • audio    — peak loudness in the window + how hard it RISES into that peak (a hook crescendos)
//   • motion   — scene-cut density in the window (visual activity / action, not a static menu)
//   • intrigue — the source moment's already-scored reaction strength (laughter/hype/keywords)
//
// `envelope` is the peak-normalized loudness curve [{ t, v(0..1) }] (v=1 is the VOD's loudest
// moment). `sceneCuts` is a sorted array of cut timestamps. Pure (no I/O), so it's unit-testable
// and reusable by the backend route.

// Score one [start,end] window. Returns { score:1..10, audio, motion, intrigue, cuts, peak }.
export function scoreHook({ start, end } = {}, { envelope = [], sceneCuts = [], reactionScore = 0 } = {}) {
  const s = Number(start); const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    return { score: 1, audio: 0, motion: 0, intrigue: 0, cuts: 0, peak: 0 };
  }
  const dur = e - s;

  // audio: peak loudness (0..1) blended with the crescendo from the window's opening to its peak.
  const win = envelope.filter((p) => p && p.t >= s && p.t <= e);
  const peak = win.length ? Math.max(...win.map((p) => p.v || 0)) : 0;
  const openV = win.length ? (win[0].v || 0) : 0;
  const rise = Math.max(0, peak - openV);                 // reward building INTO the peak
  const audio = Math.min(1, 0.7 * peak + 0.6 * rise);

  // motion: scene cuts per second, saturating at ~1 cut / 2s (0.5/s) = lively action.
  const cuts = sceneCuts.reduce((n, t) => n + (t >= s && t <= e ? 1 : 0), 0);
  const motion = Math.min(1, (cuts / dur) / 0.5);

  // intrigue: the source moment's reaction strength (already scored ~0..8 by reactions.js).
  const intrigue = Math.min(1, Math.max(0, reactionScore) / 6);

  const blended = 0.42 * audio + 0.28 * motion + 0.30 * intrigue;
  const score = Math.max(1, Math.min(10, Math.round(1 + 9 * blended)));
  return { score, audio: +audio.toFixed(2), motion: +motion.toFixed(2), intrigue: +intrigue.toFixed(2), cuts, peak: +peak.toFixed(2) };
}

// Build up to `count` DISTINCT cold-open candidates from a priority-ordered highlight list. Each is
// a peak-anchored teaser (same geometry as selectStoryboard's hook: the teaser builds into the
// clip's loudest-reaction timestamp `t` and cuts ~1s past it), scored by scoreHook. "Distinct" =
// non-overlapping source clips, so you audition genuinely different openers, not three angles on the
// same scream. Sorted best-first so the top candidate is the recommended hook.
export function hookCandidates(rankedHighlights, { hookSec = 8, envelope = [], sceneCuts = [], count = 3 } = {}) {
  const out = [];
  for (const h of (rankedHighlights || [])) {
    if (!(h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start)) continue;
    if (out.some((c) => h.start < c.srcEnd && h.end > c.srcStart)) continue;   // distinct source clip
    const hkDur = Math.min(hookSec, h.end - h.start);
    const peak = Number.isFinite(h.t) ? h.t : h.end - hkDur / 2;
    let st = peak + 1 - hkDur;
    st = Math.min(Math.max(st, h.start), h.end - hkDur);
    const win = { start: +st.toFixed(2), end: +(st + hkDur).toFixed(2) };
    const health = scoreHook(win, { envelope, sceneCuts, reactionScore: h.reactionScore || 0 });
    out.push({
      id: `hook_${h.id}`, source: h.id, start: win.start, end: win.end,
      srcStart: h.start, srcEnd: h.end, score: health.score, breakdown: health,
    });
    if (out.length >= count * 3) break;   // scan a few extra, then keep the best `count`
  }
  return out.sort((a, b) => b.score - a.score).slice(0, count);
}
