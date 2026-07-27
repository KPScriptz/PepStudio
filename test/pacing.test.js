// test/pacing.test.js — vanilla Node assertions. Run: node test/pacing.test.js
import assert from 'assert';
import { tightenClip, parseSilences, PACING_LEVELS } from '../lib/pacing.js';

function run() {
  console.log('🧪 PepStudio micro-cut pacing unit tests…');

  // clip 100–130 (30s) with two internal silences: 106–109 (3s) and 120–120.6 (0.6s).
  const clip = { start: 100, end: 130 };
  const silences = [[106, 109], [120, 120.6]];

  // --- Natural (>=1.2s): only the 3s pause is cut; the 0.6s survives ---
  const nat = tightenClip(clip, silences, { minSilence: 1.2, pad: 0 });
  assert.strictEqual(nat.cuts, 1, 'natural cuts only the long pause');
  assert.ok(Math.abs(nat.removedSec - 3) < 0.01, 'natural removes ~3s');
  // kept spans cover [100,106] + [109,130] = 27s, contiguous, non-overlapping
  assert.ok(Math.abs(nat.tightSec - 27) < 0.01, '30s → 27s');
  for (let i = 1; i < nat.segments.length; i++) assert.ok(nat.segments[i].start >= nat.segments[i - 1].end, 'no overlap');
  console.log(`✅ natural: ${nat.origSec}s → ${nat.tightSec}s (${nat.cuts} cut, -${nat.removedSec}s).`);

  // --- Relentless (>=0.4s): both silences cut ---
  const rel = tightenClip(clip, silences, { minSilence: 0.4, pad: 0 });
  assert.strictEqual(rel.cuts, 2, 'relentless cuts both pauses');
  assert.ok(rel.removedSec > nat.removedSec, 'relentless removes more than natural');
  console.log(`✅ relentless: ${rel.origSec}s → ${rel.tightSec}s (${rel.cuts} cuts, -${rel.removedSec}s).`);

  // --- pad keeps a breath: removed < raw silence duration ---
  const padded = tightenClip(clip, silences, { minSilence: 0.4, pad: 0.12 });
  assert.ok(padded.removedSec < rel.removedSec, 'padding keeps a beat, removes slightly less');
  console.log(`✅ pad keeps a breath (-${padded.removedSec}s vs -${rel.removedSec}s unpadded).`);

  // --- kept segments always land inside the clip ---
  assert.ok(rel.segments.every((g) => g.start >= 100 && g.end <= 130), 'segments inside clip');

  // --- no silences → whole clip kept as one segment ---
  const none = tightenClip(clip, [], { minSilence: 0.4 });
  assert.strictEqual(none.cuts, 0, 'no silences → no cuts');
  assert.strictEqual(none.segments.length, 1, 'whole clip is one kept span');
  assert.ok(Math.abs(none.tightSec - 30) < 0.01, 'nothing removed');
  console.log('✅ silence-free clip stays whole.');

  // --- degenerate ---
  assert.deepStrictEqual(tightenClip({ start: 5, end: 5 }, silences).segments, [], 'zero-length clip → []');

  // --- parseSilences reads silencedetect stderr into pairs ---
  const stderr = '[silencedetect] silence_start: 6.62\n[silencedetect] silence_end: 9.68 | silence_duration: 3.06\n'
    + '[silencedetect] silence_start: 20\n[silencedetect] silence_end: 20.6 | silence_duration: 0.6\n';
  const parsed = parseSilences(stderr);
  assert.deepStrictEqual(parsed, [[6.62, 9.68], [20, 20.6]], 'parses silence pairs');
  console.log('✅ parseSilences reads silencedetect output.');

  // --- levels are ordered natural < tight < relentless in aggression ---
  assert.ok(PACING_LEVELS.natural.minSilence > PACING_LEVELS.tight.minSilence, 'natural less aggressive than tight');
  assert.ok(PACING_LEVELS.tight.minSilence > PACING_LEVELS.relentless.minSilence, 'tight less aggressive than relentless');
  console.log('✅ pacing levels ordered by aggression.');

  console.log('🚀 ALL MICRO-CUT PACING TESTS PASSED.');
}

run();
