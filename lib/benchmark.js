// lib/benchmark.js — measure what actually-performing videos do, then move our targets toward it.
//
// Two halves, both pure:
//
//   1. OUTLIER DETECTION. A creator's own median is the honest baseline — comparing a video to the
//      channel mean is skewed by the very outliers we're hunting, so we use the median and require
//      a multiple of it. This needs no third-party analytics service: per-video view counts from
//      the official YouTube Data API (or any source) are enough to answer "which upload
//      overperformed", which is the only question step 1 actually asks.
//
//   2. PACING METRICS. Cut density, vocal velocity and silence ratio computed from the SAME signals
//      PepStudio already extracts for its own VODs (scene cuts, whisper words, detected silences).
//      Pointing the existing pipeline at a downloaded reference video is orchestration, not new
//      capability — so a competitor's numbers and ours are measured identically and are comparable
//      by construction.
//
// Deliberately conservative on the write side: suggestions are BOUNDED deltas against the same
// clamped knobs the feedback consumer uses, never direct writes. Copying another channel's numbers
// wholesale would overwrite everything the retention loop has learned from your own audience.

const round = (n, p = 2) => +(+n || 0).toFixed(p);

export function median(nums) {
  const xs = (nums || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Videos that massively outperformed the channel's own median.
 * @param {Array<{id,title?,views,publishedAt?}>} videos
 * @param {{factor?:number, minVideos?:number}} opts
 */
export function findOutliers(videos, { factor = 3, minVideos = 5 } = {}) {
  const vids = (videos || []).filter((v) => v && Number.isFinite(v.views));
  if (vids.length < minVideos) {
    return { baseline: 0, outliers: [], reason: `need at least ${minVideos} videos to establish a baseline (got ${vids.length})` };
  }
  const baseline = median(vids.map((v) => v.views));
  if (!baseline) return { baseline: 0, outliers: [], reason: 'median view count is zero' };
  const outliers = vids
    .filter((v) => v.views / baseline >= factor)
    .map((v) => ({ ...v, multiple: round(v.views / baseline, 2) }))
    .sort((a, b) => b.multiple - a.multiple);
  return { baseline, outliers, considered: vids.length, factor };
}

/**
 * Structural pacing metrics for one video, from signals PepStudio already produces.
 *
 * @param {object} a
 *   durationSec  total runtime
 *   sceneCuts    [sec, ...]        detected scene changes
 *   words        [{t0,t1,w}]       whisper words
 *   silences     [[start,end], ..] detected silence
 *   actSplit     fraction marking the end of "Act 1" (default 0.15)
 */
export function pacingMetrics(a = {}) {
  const dur = Number(a.durationSec) || 0;
  if (dur <= 0) return null;
  const cuts = (a.sceneCuts || []).filter(Number.isFinite).sort((x, y) => x - y);
  const words = (a.words || []).filter((w) => w && Number.isFinite(w.t0));
  const sil = (a.silences || []).filter((s) => Array.isArray(s) && s.length === 2 && s[1] > s[0]);
  const split = dur * (Number(a.actSplit) || 0.15);

  const silentSec = sil.reduce((n, [s, e]) => n + Math.min(e, dur) - Math.max(s, 0), 0);
  const cutsIn = (from, to) => cuts.filter((c) => c >= from && c < to).length;
  const wordsIn = (from, to) => words.filter((w) => w.t0 >= from && w.t0 < to).length;

  // Gaps between consecutive cuts — the closest proxy for "seconds between pattern interrupts"
  // available without the reference video's overlay/SFX track.
  const gaps = [];
  for (let i = 1; i < cuts.length; i++) gaps.push(cuts[i] - cuts[i - 1]);
  gaps.sort((x, y) => x - y);

  return {
    durationSec: round(dur),
    cutsPerMin: round((cuts.length / dur) * 60),
    act1CutsPerMin: split > 0 ? round((cutsIn(0, split) / split) * 60) : 0,
    act3CutsPerMin: dur > split ? round((cutsIn(split, dur) / (dur - split)) * 60) : 0,
    wordsPerMin: round((words.length / dur) * 60),
    hookWordsPerMin: split > 0 ? round((wordsIn(0, Math.min(15, dur)) / Math.min(15, dur)) * 60) : 0,
    silenceRatio: round(silentSec / dur, 3),
    medianCutGapSec: round(median(gaps)),
    maxCutGapSec: round(gaps.length ? gaps[gaps.length - 1] : dur),
  };
}

// Aggregate a set of reference videos into one benchmark (median of each metric, so one weird
// reference can't drag the target).
export function aggregateBenchmark(metricsList) {
  const list = (metricsList || []).filter(Boolean);
  if (!list.length) return null;
  const keys = ['cutsPerMin', 'act1CutsPerMin', 'act3CutsPerMin', 'wordsPerMin', 'hookWordsPerMin', 'silenceRatio', 'medianCutGapSec'];
  const out = { sampleSize: list.length };
  for (const k of keys) out[k] = round(median(list.map((m) => m[k])));
  return out;
}

/**
 * Compare our pacing to a benchmark and propose BOUNDED nudges to the same knobs the feedback
 * consumer owns. Returns suggestions only — nothing is written here, and each delta is capped so a
 * single benchmarking run can't overwrite what the retention loop learned from real viewers.
 */
export function suggestFromBenchmark(mine, benchmark, { current = {}, maxStep = 0.1 } = {}) {
  if (!mine || !benchmark) return { suggestions: [], notes: ['need both our metrics and a benchmark'] };
  const cur = {
    targetPacingInterval: current.targetPacingInterval ?? 1.32,
    loudnessThresholdZ: current.loudnessThresholdZ ?? 2.71,
  };
  const suggestions = [];
  const notes = [];
  const cap = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // They cut faster than us → shorten our target interval, by at most maxStep per run.
  if (benchmark.medianCutGapSec > 0 && mine.medianCutGapSec > 0) {
    const delta = mine.medianCutGapSec - benchmark.medianCutGapSec;
    if (Math.abs(delta) > 0.15) {
      const step = cap(delta, -maxStep, maxStep);
      const next = +cap(cur.targetPacingInterval - step, 0.5, 3).toFixed(3);
      if (next !== cur.targetPacingInterval) {
        suggestions.push({
          knob: 'targetPacingInterval', from: cur.targetPacingInterval, to: next,
          why: `reference cuts every ${benchmark.medianCutGapSec}s vs our ${mine.medianCutGapSec}s`,
        });
      }
    }
  }
  // They carry less dead air → be pickier about what counts as energy.
  if (Number.isFinite(benchmark.silenceRatio) && mine.silenceRatio - benchmark.silenceRatio > 0.03) {
    const next = +cap(cur.loudnessThresholdZ + 0.08, 1.5, 4).toFixed(3);
    if (next !== cur.loudnessThresholdZ) {
      suggestions.push({
        knob: 'loudnessThresholdZ', from: cur.loudnessThresholdZ, to: next,
        why: `our silence ratio ${mine.silenceRatio} vs reference ${benchmark.silenceRatio}`,
      });
    }
  }
  if (Number.isFinite(benchmark.wordsPerMin) && mine.wordsPerMin < benchmark.wordsPerMin * 0.7) {
    notes.push(`Speech density is well under the reference (${mine.wordsPerMin} vs ${benchmark.wordsPerMin} wpm) — tighten between lines rather than changing a knob.`);
  }
  if (!suggestions.length && !notes.length) notes.push('Pacing already matches the benchmark; no changes suggested.');
  return { suggestions, notes };
}
