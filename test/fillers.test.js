// test/fillers.test.js — vanilla Node assertions. Run: node test/fillers.test.js
import assert from 'assert';
import { detectFillers, stripFillers, CORE_FILLERS, SOFT_FILLERS } from '../lib/fillers.js';

// One word entry per second starting at `t0` — the shape whisper hands back.
const seq = (start, arr) => arr.map((w, i) => ({ t0: start + i, t1: start + i + 0.5, w }));

function run() {
  console.log('🧪 PepStudio filler-word unit tests…');

  // --- core fillers detected, real words untouched ---
  const words = seq(100, ['so', 'um', 'i', 'hit', 'uh', 'the', 'shot']);
  const core = detectFillers(words);
  assert.deepStrictEqual(core.map((h) => h.w), ['um', 'uh'], 'only um/uh by default');
  assert.ok(core.every((h) => h.t1 > h.t0), 'hits have positive duration');
  console.log(`✅ core pass found ${core.length} filler(s), left "so" alone.`);

  // --- aggressive adds the soft set ---
  const agg = detectFillers(words, { aggressive: true });
  assert.ok(agg.length > core.length, 'aggressive catches more');
  assert.ok(agg.some((h) => h.w === 'so'), 'aggressive catches "so"');
  console.log(`✅ aggressive found ${agg.length} (adds the soft set).`);

  // --- phrases match across consecutive entries ---
  const ph = detectFillers(seq(200, ['it', 'you', 'know', 'went', 'in']));
  assert.deepStrictEqual(ph.map((h) => h.w), ['you know'], 'matches the two-word phrase');
  assert.ok(Math.abs(ph[0].t0 - 201) < 1e-6 && Math.abs(ph[0].t1 - 202.5) < 1e-6, 'phrase spans both words');
  console.log('✅ "you know" matched as one span across two entries.');

  // --- a grouped entry is a sentence, not a filler beat ---
  const grouped = detectFillers([{ t0: 5, t1: 8, w: 'um so i think we won' }]);
  assert.strictEqual(grouped.length, 0, 'multi-word entry is never a filler hit');
  console.log('✅ grouped multi-word entry left alone (no false positive).');

  // --- substring words are not fillers ---
  const sub = detectFillers(seq(300, ['likely', 'summer', 'ahead', 'humming']));
  assert.strictEqual(sub.length, 0, 'substrings of filler words are not fillers');
  console.log('✅ "likely"/"summer"/"ahead" not mistaken for like/so/ah.');

  // --- punctuation and case are normalized ---
  const punc = detectFillers(seq(400, ['Um,', 'we', 'UH!', 'won']));
  assert.strictEqual(punc.length, 2, 'case + punctuation normalized');
  console.log('✅ "Um," and "UH!" normalized to hits.');

  // --- stripFillers: complement spans, no overlap, sums correctly ---
  const clip = { start: 100, end: 130 };
  const hits = [{ t0: 105, t1: 105.8, w: 'um' }, { t0: 120, t1: 121, w: 'you know' }];
  const st = stripFillers(clip, hits, { pad: 0 });
  assert.strictEqual(st.cuts, 2, 'both fillers cut');
  assert.ok(Math.abs(st.removedSec - 1.8) < 0.01, 'removes 0.8 + 1.0 = 1.8s');
  assert.ok(Math.abs(st.tightSec - 28.2) < 0.01, '30s → 28.2s');
  for (let i = 1; i < st.segments.length; i++) {
    assert.ok(st.segments[i].start >= st.segments[i - 1].end, 'segments never overlap');
  }
  assert.ok(st.segments[0].start === 100 && st.segments[st.segments.length - 1].end === 130, 'clip bounds preserved');
  console.log(`✅ strip: ${st.origSec}s → ${st.tightSec}s (${st.cuts} cuts, -${st.removedSec}s).`);

  // --- pad shrinks each cut (keeps the word edges safe) ---
  const padded = stripFillers(clip, hits, { pad: 0.04 });
  assert.ok(padded.removedSec < st.removedSec, 'padding removes slightly less');
  console.log(`✅ pad protects word edges (-${padded.removedSec}s vs -${st.removedSec}s).`);

  // --- cuts shorter than minCut are skipped ---
  const tiny = stripFillers(clip, [{ t0: 105, t1: 105.1, w: 'um' }], { pad: 0, minCut: 0.12 });
  assert.strictEqual(tiny.cuts, 0, 'sub-threshold filler not worth a splice');
  assert.strictEqual(tiny.segments.length, 1, 'clip stays whole');
  console.log('✅ a 0.1s "um" is left in (not worth the splice).');

  // --- hits outside the clip are ignored; degenerate clips return empty ---
  const outside = stripFillers(clip, [{ t0: 10, t1: 11, w: 'um' }], { pad: 0 });
  assert.strictEqual(outside.cuts, 0, 'out-of-clip hits ignored');
  assert.strictEqual(stripFillers({ start: 5, end: 5 }, hits).segments.length, 0, 'degenerate clip → []');
  assert.strictEqual(detectFillers(null).length, 0, 'null words → []');
  console.log('✅ out-of-range hits ignored; degenerate input safe.');

  // --- overlapping hits merge into one cut ---
  const merged = detectFillers([{ t0: 1, t1: 3, w: 'um' }, { t0: 2, t1: 4, w: 'uh' }]);
  assert.strictEqual(merged.length, 1, 'overlapping hits merge');
  assert.ok(merged[0].t0 === 1 && merged[0].t1 === 4, 'merged span covers both');
  console.log('✅ overlapping hits merged into one span.');

  assert.ok(CORE_FILLERS.length && SOFT_FILLERS.length, 'lexicons exported non-empty');
  assert.ok(!CORE_FILLERS.some((w) => SOFT_FILLERS.includes(w)), 'core and soft sets are disjoint');

  console.log('🚀 ALL FILLER-WORD TESTS PASSED.');
}

run();
