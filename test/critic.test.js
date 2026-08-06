// test/critic.test.js — vanilla Node assertions. Run: node test/critic.test.js
import assert from 'assert';
import { auditCut, toOutputTime, outputDuration, CRITIC_DEFAULTS } from '../lib/critic.js';

// Dense speech: `n` words per second across [from,to) in SOURCE time.
const talk = (from, to, wps = 3) => {
  const out = [];
  const step = 1 / wps;
  for (let t = from; t < to - 1e-9; t += step) out.push({ t0: +t.toFixed(3), t1: +(t + step * 0.8).toFixed(3), w: 'x' });
  return out;
};

console.log('🧪 PepStudio deterministic critic tests…');

// --- output-time mapping: the core of measuring what a VIEWER experiences ---
{
  const clips = [{ id: 'a', start: 100, end: 110 }, { id: 'b', start: 500, end: 505 }];
  assert.strictEqual(outputDuration(clips), 15);
  assert.strictEqual(toOutputTime(100, clips), 0, 'first frame maps to 0');
  assert.strictEqual(toOutputTime(105, clips), 5, 'mid first clip');
  assert.strictEqual(toOutputTime(500, clips), 10, 'second clip starts right after the first');
  assert.strictEqual(toOutputTime(503, clips), 13);
  // The 390s of source BETWEEN the clips was cut — it does not exist for the viewer.
  assert.strictEqual(toOutputTime(300, clips), null, 'cut-away source time has no output position');
  console.log('✅ output-time mapping collapses cut-away source time (a viewer never sees it).');
}

// --- a good cut passes ---
{
  const clips = [];
  for (let i = 0; i < 10; i++) clips.push({ id: `c${i}`, start: i * 100, end: i * 100 + 8 });
  const words = clips.flatMap((c) => talk(c.start, c.end, 3));
  const r = auditCut({ clips, words });
  assert.strictEqual(r.pass, true, `dense, frequently-cut sequence passes (issues: ${JSON.stringify(r.issues)})`);
  assert.ok(r.score >= 90, `high score (${r.score})`);
  assert.strictEqual(r.stats.clipCount, 10);
  assert.ok(r.stats.wordsPerSec >= 2.5, `density reported (${r.stats.wordsPerSec} w/s)`);
  console.log(`✅ a tight cut passes: score ${r.score}, ${r.stats.wordsPerSec} w/s, ${r.stats.interruptsPerMin} interrupts/min.`);
}

// --- 1. speech density floor ---
{
  // 30s single clip with speech only in the first 5s → a long quiet tail.
  const clips = [{ id: 'a', start: 0, end: 30 }];
  const r = auditCut({ clips, words: talk(0, 5, 4) });
  const low = r.issues.filter((i) => i.type === 'low_speech_density');
  assert.ok(low.length, 'flags the quiet stretch');
  assert.strictEqual(r.pass, false, 'a long silent tail fails');
  assert.ok(low[0].endSec > low[0].atSec, 'reports a span, not a point');
  // merged into ONE issue rather than one per sliding window
  assert.ok(low.length <= 2, `quiet stretch merged into ${low.length} issue(s), not dozens`);
  console.log(`✅ low speech density flagged as ${low.length} merged span: "${low[0].detail}"`);
}

// --- 2. pattern interrupt gaps ---
{
  const clips = [{ id: 'long', start: 0, end: 60 }];
  const words = talk(0, 60, 3);                       // dense speech, so ONLY the gap can fail it
  const bare = auditCut({ clips, words });
  const gaps = bare.issues.filter((i) => i.type === 'no_pattern_interrupt');
  assert.ok(gaps.length, 'a 60s unbroken clip is flagged');
  assert.strictEqual(bare.pass, false, '60s with no interrupt fails');

  // Same clip, now with zooms/overlays/SFX every ~10s → no gap.
  const dressed = auditCut({
    clips: [{
      id: 'long', start: 0, end: 60,
      zooms: [{ t: 10 }, { t: 40 }],
      overlays: [{ startTime: 20 }],
      sfx: [{ time: 30 }, { time: 50 }],
    }],
    words,
  });
  assert.ok(!dressed.issues.some((i) => i.type === 'no_pattern_interrupt'), 'interrupts clear the gap');
  assert.ok(dressed.stats.interrupts > bare.stats.interrupts, 'zooms/overlays/SFX all count as interrupts');
  console.log(`✅ interrupt gap: bare 60s clip fails, same clip with 5 hits passes (${bare.stats.interrupts} → ${dressed.stats.interrupts} interrupts).`);
}

// --- 3. dead air that SURVIVED the cut ---
{
  const clips = [{ id: 'a', start: 0, end: 20 }];
  const words = talk(0, 20, 3);
  // A 3s silence inside the kept clip → must be flagged.
  const inside = auditCut({ clips, words, silences: [[5, 8]] });
  assert.ok(inside.issues.some((i) => i.type === 'dead_air'), 'silence inside a kept clip is flagged');
  assert.ok(inside.stats.deadAirSec >= 3, `dead air measured (${inside.stats.deadAirSec}s)`);
  // The SAME silence outside the kept range was already cut — it must NOT be reported.
  const outside = auditCut({ clips, words, silences: [[500, 503]] });
  assert.ok(!outside.issues.some((i) => i.type === 'dead_air'), 'already-cut silence is not a defect');
  assert.strictEqual(outside.stats.deadAirSec, 0);
  // A silence shorter than the floor is fine.
  const tiny = auditCut({ clips, words, silences: [[5, 5.3]] });
  assert.ok(!tiny.issues.some((i) => i.type === 'dead_air'), '0.3s pause is under the floor');
  console.log('✅ dead air: counts only silence that survived into the cut, ignores sub-floor pauses.');
}

// --- 4. weak cold open ---
{
  const clips = [{ id: 'a', start: 0, end: 40 }];
  const words = talk(20, 40, 4);                      // nothing said for the first 20s
  const r = auditCut({ clips, words });
  assert.ok(r.issues.some((i) => i.type === 'weak_cold_open'), 'a slow build is flagged');
  assert.strictEqual(r.pass, false);
  console.log('✅ weak cold open flagged when the first 15s has no speech and no interrupt.');
}

// --- scoring + ordering + determinism ---
{
  const clips = [{ id: 'a', start: 0, end: 60 }];
  const r1 = auditCut({ clips, words: talk(30, 60, 1) });
  const r2 = auditCut({ clips, words: talk(30, 60, 1) });
  assert.deepStrictEqual(r1, r2, 'identical input gives an identical verdict — no LLM nondeterminism');
  assert.ok(r1.score < 100 && r1.score >= 0, `score in range (${r1.score})`);
  if (r1.issues.length > 1) {
    const sev = r1.issues.map((i) => i.severity);
    assert.ok(sev.indexOf('warn') === -1 || sev.lastIndexOf('fail') < sev.indexOf('warn'), 'fails sort before warnings');
  }
  assert.ok(r1.issues.every((i) => i.fix && i.detail), 'every issue carries a detail and a fix');
  console.log(`✅ deterministic, bounded score (${r1.score}), fails first, every issue actionable.`);
}

// --- degenerate input ---
{
  const empty = auditCut({ clips: [] });
  assert.strictEqual(empty.pass, false);
  assert.strictEqual(empty.score, 0);
  assert.strictEqual(empty.issues[0].type, 'empty_sequence');
  assert.doesNotThrow(() => auditCut({}), 'no arguments at all is safe');
  assert.doesNotThrow(() => auditCut({ clips: [{ start: 5, end: 1 }] }), 'inverted clip is filtered, not fatal');
  assert.doesNotThrow(() => auditCut({ clips: [{ start: 0, end: 10 }], words: [{ t0: NaN, t1: 3 }], silences: [[NaN, 2]] }), 'NaN input is safe');
  console.log('✅ empty / malformed / NaN input never throws.');
}

// --- thresholds are configurable ---
{
  const clips = [{ id: 'a', start: 0, end: 40 }];
  const words = talk(0, 40, 2);                       // 2 w/s — under the 2.5 default
  assert.ok(auditCut({ clips, words }).issues.some((i) => i.type === 'low_speech_density'), 'fails at the default floor');
  assert.ok(!auditCut({ clips, words }, { minWordsPerSec: 1.5 }).issues.some((i) => i.type === 'low_speech_density'), 'passes with a relaxed floor');
  assert.strictEqual(CRITIC_DEFAULTS.minWordsPerSec, 2.5);
  assert.strictEqual(CRITIC_DEFAULTS.maxInterruptGapSec, 15);
  console.log('✅ every threshold overridable per call; documented defaults match the spec.');
}

console.log('🚀 ALL CRITIC TESTS PASSED.');
