// test/hooks.test.js — vanilla Node assertions, no framework. Run: node test/hooks.test.js
// Covers: scoreHook axis behavior + clamping, hookCandidates distinctness + best-first order.
import assert from 'assert';
import { scoreHook, hookCandidates } from '../lib/hooks.js';

function run() {
  console.log('🧪 PepStudio hook-health unit tests…');

  // --- degenerate windows are a floor of 1, never NaN ---
  assert.strictEqual(scoreHook({ start: 5, end: 5 }).score, 1, 'zero-length window floors at 1');
  assert.strictEqual(scoreHook({ start: NaN, end: 3 }).score, 1, 'NaN start floors at 1');
  assert.strictEqual(scoreHook({}).score, 1, 'missing window floors at 1');
  console.log('✅ degenerate windows floor at 1 (no NaN).');

  // --- a loud, rising, active, high-reaction window scores high; a flat quiet one scores low ---
  const envRise = [{ t: 0, v: 0.1 }, { t: 1, v: 0.3 }, { t: 2, v: 0.6 }, { t: 3, v: 0.95 }];
  const strong = scoreHook({ start: 0, end: 3 }, { envelope: envRise, sceneCuts: [0.4, 1.2, 2.1], reactionScore: 6 });
  const envFlat = [{ t: 0, v: 0.12 }, { t: 1, v: 0.11 }, { t: 2, v: 0.12 }, { t: 3, v: 0.10 }];
  const weak = scoreHook({ start: 0, end: 3 }, { envelope: envFlat, sceneCuts: [], reactionScore: 0 });
  assert.ok(strong.score > weak.score, `strong (${strong.score}) must beat weak (${weak.score})`);
  assert.ok(strong.score >= 7, `loud+rising+active+funny should score high, got ${strong.score}`);
  assert.ok(weak.score <= 3, `flat+quiet+silent should score low, got ${weak.score}`);
  console.log(`✅ scoreHook separates strong (${strong.score}) from weak (${weak.score}) hooks.`);

  // --- score is clamped to 1..10 ---
  const maxed = scoreHook({ start: 0, end: 1 }, { envelope: [{ t: 0, v: 0 }, { t: 1, v: 1 }], sceneCuts: [0.1, 0.3, 0.5, 0.7, 0.9], reactionScore: 999 });
  assert.ok(maxed.score >= 1 && maxed.score <= 10, `score in range, got ${maxed.score}`);
  console.log('✅ score clamps to 1–10 under extreme inputs.');

  // --- hookCandidates: distinct sources, best-first, respects count ---
  const ranked = [
    { id: 'a', start: 0, end: 30, t: 20, reactionScore: 1 },     // low reaction
    { id: 'b', start: 10, end: 40, t: 25, reactionScore: 8 },    // OVERLAPS a → must be dropped
    { id: 'c', start: 100, end: 130, t: 118, reactionScore: 7 }, // distinct, strong
    { id: 'd', start: 200, end: 230, t: 215, reactionScore: 3 }, // distinct, medium
  ];
  const env = [{ t: 118, v: 0.9 }, { t: 215, v: 0.5 }, { t: 20, v: 0.4 }];
  const cands = hookCandidates(ranked, { hookSec: 8, envelope: env, sceneCuts: [117, 118, 214], count: 3 });
  const sources = cands.map((c) => c.source);
  assert.ok(!(sources.includes('a') && sources.includes('b')), 'overlapping sources a & b must not both appear');
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].score >= cands[i].score, 'candidates must be best-first');
  assert.ok(cands.length <= 3, 'respects count');
  assert.ok(cands.every((c) => c.end > c.start && c.start >= 0), 'candidate windows are valid');
  console.log(`✅ hookCandidates: ${cands.length} distinct, best-first [${cands.map((c) => `${c.source}:${c.score}`).join(', ')}].`);

  console.log('🚀 ALL HOOK TESTS PASSED.');
}

run();
