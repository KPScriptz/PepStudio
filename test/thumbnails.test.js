// test/thumbnails.test.js — vanilla Node assertions. Run: node test/thumbnails.test.js
import assert from 'assert';
import { coverCandidates } from '../lib/thumbnails.js';

function run() {
  console.log('🧪 PepStudio thumbnail-cover unit tests…');

  const clip = { start: 100, end: 130, t: 118 };
  const envelope = [{ t: 105, v: 0.3 }, { t: 112, v: 0.95 }, { t: 125, v: 0.4 }];
  const sceneCuts = [90, 116, 140];

  const c = coverCandidates(clip, { envelope, sceneCuts, count: 3 });
  // reaction peak leads
  assert.strictEqual(c[0].label, 'Reaction peak', 'reaction peak is first candidate');
  assert.strictEqual(c[0].t, 118, 'reaction peak at clip.t');
  // all candidates fall inside the clip
  assert.ok(c.every((x) => x.t >= 100 && x.t <= 130), 'all candidates inside the clip window');
  // loudest picks the 0.95 envelope point
  assert.ok(c.some((x) => x.label === 'Loudest moment' && x.t === 112), 'loudest = the 0.95 frame at 112');
  // scene change picks the in-window cut (116), not the out-of-window ones
  assert.ok(c.some((x) => x.label === 'Scene change' && x.t === 116), 'scene change uses the in-window cut');
  assert.ok(c.length <= 3, 'respects count');
  console.log(`✅ candidates: [${c.map((x) => `${x.label}@${x.t}`).join(', ')}]`);

  // --- dedupe within 0.4s ---
  const dupClip = { start: 0, end: 20, t: 10 };
  const dup = coverCandidates(dupClip, { envelope: [{ t: 10.1, v: 1 }], sceneCuts: [10.2], count: 4 });
  for (let i = 1; i < dup.length; i++) {
    for (let j = 0; j < i; j++) assert.ok(Math.abs(dup[i].t - dup[j].t) >= 0.4, 'no two candidates within 0.4s');
  }
  console.log(`✅ near-identical peaks deduped → ${dup.length} distinct frame(s).`);

  // --- no signals → still returns a usable fallback frame inside the clip ---
  const bare = coverCandidates({ start: 50, end: 80 }, {});
  assert.ok(bare.length >= 1 && bare[0].t >= 50 && bare[0].t <= 80, 'bare clip yields a fallback frame');
  console.log('✅ bare clip (no signals) yields a fallback frame.');

  // --- degenerate ---
  assert.deepStrictEqual(coverCandidates({ start: 5, end: 5 }, {}), [], 'zero-length clip → no candidates');
  assert.deepStrictEqual(coverCandidates(null, {}), [], 'null clip → no candidates');
  console.log('✅ degenerate clips return [] (no ffmpeg on garbage).');

  console.log('🚀 ALL THUMBNAIL-COVER TESTS PASSED.');
}

run();
