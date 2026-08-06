// test/benchmark.test.js — vanilla Node assertions. Run: node test/benchmark.test.js
import assert from 'assert';
import { median, findOutliers, pacingMetrics, aggregateBenchmark, suggestFromBenchmark } from '../lib/benchmark.js';

console.log('🧪 PepStudio benchmark tests…');

// --- median ---
{
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5, 'even length averages the middle pair');
  assert.strictEqual(median([]), 0, 'empty is safe');
  assert.strictEqual(median([5]), 5);
  console.log('✅ median handles odd/even/empty.');
}

// --- outliers: median baseline, not mean --------------------------------------------------------
{
  // Nine ordinary uploads plus one megahit. The MEAN is dragged up by the hit itself; the median
  // is not — which is exactly why the baseline has to be the median.
  const videos = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, views: 10000 + i * 200 })),
    { id: 'hit', views: 500000 },
  ];
  const r = findOutliers(videos, { factor: 3 });
  assert.strictEqual(r.outliers.length, 1, 'exactly one outlier');
  assert.strictEqual(r.outliers[0].id, 'hit');
  assert.ok(r.outliers[0].multiple > 40, `reports the multiple (${r.outliers[0].multiple}x)`);
  const mean = videos.reduce((n, v) => n + v.views, 0) / videos.length;
  assert.ok(r.baseline < mean / 4, `median baseline (${r.baseline}) resists the outlier that mean (${Math.round(mean)}) does not`);

  // A uniformly performing channel has no outliers.
  assert.strictEqual(findOutliers(Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, views: 10000 })), { factor: 3 }).outliers.length, 0);
  // Too few videos → refuse to guess a baseline.
  const thin = findOutliers([{ id: 'a', views: 1 }, { id: 'b', views: 900000 }], { factor: 3 });
  assert.strictEqual(thin.outliers.length, 0);
  assert.ok(/at least/.test(thin.reason), 'says why it declined');
  // Degenerate.
  assert.doesNotThrow(() => findOutliers(null));
  assert.doesNotThrow(() => findOutliers([{ views: NaN }]));
  console.log(`✅ outliers: median baseline ${findOutliers(videos).baseline}, 1 hit found, thin/uniform/null all safe.`);
}

// --- pacing metrics -----------------------------------------------------------------------------
{
  // 600s video: a cut every 2s, 3 words/sec, 60s of silence.
  const sceneCuts = Array.from({ length: 300 }, (_, i) => i * 2);
  const words = Array.from({ length: 1800 }, (_, i) => ({ t0: i / 3, t1: i / 3 + 0.2, w: 'x' }));
  const m = pacingMetrics({ durationSec: 600, sceneCuts, words, silences: [[100, 160]] });
  assert.strictEqual(m.cutsPerMin, 30, '300 cuts / 10 min = 30 per min');
  assert.strictEqual(m.wordsPerMin, 180, '3 w/s = 180 wpm');
  assert.strictEqual(m.silenceRatio, 0.1, '60s of 600s');
  assert.strictEqual(m.medianCutGapSec, 2);
  assert.ok(m.act1CutsPerMin > 0 && m.act3CutsPerMin > 0, 'act split reported');
  assert.strictEqual(pacingMetrics({ durationSec: 0 }), null, 'zero duration is refused');
  assert.doesNotThrow(() => pacingMetrics({}));
  console.log(`✅ pacing metrics: ${m.cutsPerMin} cuts/min, ${m.wordsPerMin} wpm, silence ${m.silenceRatio}.`);
}

// --- aggregate: median across references, so one oddity can't set the target --------------------
{
  const refs = [
    { cutsPerMin: 30, act1CutsPerMin: 40, act3CutsPerMin: 28, wordsPerMin: 180, hookWordsPerMin: 200, silenceRatio: 0.05, medianCutGapSec: 2 },
    { cutsPerMin: 32, act1CutsPerMin: 44, act3CutsPerMin: 30, wordsPerMin: 190, hookWordsPerMin: 210, silenceRatio: 0.04, medianCutGapSec: 1.9 },
    { cutsPerMin: 4,  act1CutsPerMin: 5,  act3CutsPerMin: 4,  wordsPerMin: 60,  hookWordsPerMin: 50,  silenceRatio: 0.4,  medianCutGapSec: 15 }, // an oddity
  ];
  const b = aggregateBenchmark(refs);
  assert.strictEqual(b.sampleSize, 3);
  assert.strictEqual(b.cutsPerMin, 30, 'median ignores the slow oddity');
  assert.strictEqual(b.medianCutGapSec, 2);
  assert.strictEqual(aggregateBenchmark([]), null);
  console.log(`✅ aggregate uses medians: ${b.cutsPerMin} cuts/min from ${b.sampleSize} refs, oddity excluded.`);
}

// --- suggestions are BOUNDED and never auto-applied ----------------------------------------------
{
  const bench = { cutsPerMin: 30, wordsPerMin: 180, silenceRatio: 0.04, medianCutGapSec: 2 };
  const mine  = { cutsPerMin: 6,  wordsPerMin: 60,  silenceRatio: 0.30, medianCutGapSec: 9 };
  const current = { targetPacingInterval: 1.32, loudnessThresholdZ: 2.71 };

  const { suggestions, notes } = suggestFromBenchmark(mine, bench, { current });
  assert.ok(suggestions.length >= 1, 'proposes something when we are far off');
  for (const s of suggestions) {
    assert.ok(['targetPacingInterval', 'loudnessThresholdZ'].includes(s.knob), 'only consumer-owned knobs');
    assert.ok(s.why && s.from !== undefined && s.to !== undefined, 'every suggestion is explained');
  }
  // The pacing gap is 7s, but a single run may move the knob by at most maxStep.
  const pac = suggestions.find((s) => s.knob === 'targetPacingInterval');
  if (pac) assert.ok(Math.abs(pac.to - pac.from) <= 0.1 + 1e-9, `bounded step (${pac.from} → ${pac.to}), not a 7s jump`);
  // Clamped to the trainer's documented ranges.
  for (const s of suggestions) {
    if (s.knob === 'targetPacingInterval') assert.ok(s.to >= 0.5 && s.to <= 3);
    if (s.knob === 'loudnessThresholdZ') assert.ok(s.to >= 1.5 && s.to <= 4);
  }
  // Already matching → no churn.
  const same = suggestFromBenchmark(bench, bench, { current });
  assert.strictEqual(same.suggestions.length, 0, 'no suggestions when we already match');
  assert.ok(same.notes.length, 'and says so');
  // Missing inputs are safe.
  assert.doesNotThrow(() => suggestFromBenchmark(null, bench));
  assert.strictEqual(suggestFromBenchmark(null, null).suggestions.length, 0);
  console.log(`✅ suggestions bounded to ≤0.1/run, clamped, explained, no-op when already matching (${suggestions.length} proposed).`);
}

console.log('🚀 ALL BENCHMARK TESTS PASSED.');
