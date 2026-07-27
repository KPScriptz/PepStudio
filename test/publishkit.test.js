// test/publishkit.test.js — vanilla Node assertions. Run: node test/publishkit.test.js
import assert from 'assert';
import { buildChapters, suggestHashtags, buildDescription } from '../lib/publishkit.js';

function run() {
  console.log('🧪 PepStudio publish-kit unit tests…');

  const clips = [
    { start: 100, end: 130, title: 'insane buzzer beater to win it' },
    { start: 400, end: 428, snippet: 'no way that just happened bro' },
    { start: 900, end: 930, title: 'clutch defensive stop' },
    { start: 1200, end: 1224, title: 'trash talk after the dunk' },
  ];

  // --- chapters: first at 0:00, output-time (cumulative), >=10s apart, valid needs >=3 ---
  const ch = buildChapters(clips);
  assert.strictEqual(ch.chapters[0].tOut, 0, 'first chapter must be at 0:00');
  assert.ok(ch.valid, '4 well-spaced clips must yield a valid (>=3) chapter set');
  for (let i = 1; i < ch.chapters.length; i++) {
    assert.ok(ch.chapters[i].tOut - ch.chapters[i - 1].tOut >= 10, 'chapters must be >=10s apart (YouTube rule)');
  }
  // output timeline, not source: 2nd chapter at 30s (first clip is 30s), not 400s
  assert.strictEqual(ch.chapters[1].tOut, 30, '2nd chapter is on the OUTPUT timeline (cumulative), not source time');
  assert.ok(/^0:00 /.test(ch.text.split('\n')[0]), 'text starts with 0:00');
  console.log(`✅ chapters: ${ch.chapters.length}, 0:00-anchored, output-time, >=10s apart.`);

  // --- hook prepend shifts the body + adds a cold-open chapter at 0:00 ---
  const chHook = buildChapters(clips, { hookSec: 12 });
  assert.strictEqual(chHook.chapters[0].tOut, 0, 'cold open at 0:00');
  assert.strictEqual(chHook.chapters[0].title, 'Cold open', 'first chapter is the cold open');
  console.log('✅ hook prepend adds a 0:00 cold-open chapter.');

  // --- too-few / degenerate ---
  assert.strictEqual(buildChapters([]).valid, false, 'empty clips → invalid');
  assert.strictEqual(buildChapters([{ start: 0, end: 5, title: 'x' }]).valid, false, '1 clip → invalid (needs >=3)');
  console.log('✅ under-3 chapters reported invalid (no fake chapter list).');

  // --- hashtags: game first, generics, then keyword-frequency; all #-prefixed, deduped, capped ---
  const tags = suggestHashtags(clips, { game: 'NBA 2K26 GOAT', max: 8 });
  assert.ok(tags.length <= 8, 'respects max');
  assert.ok(tags.every((t) => t.startsWith('#')), 'all hashtags #-prefixed');
  assert.strictEqual(tags[0], '#nba2k26goat', 'game-derived tag leads');
  assert.strictEqual(new Set(tags).size, tags.length, 'no duplicate hashtags');
  assert.ok(!tags.includes('#the') && !tags.includes('#that'), 'stopwords excluded');
  console.log(`✅ hashtags: [${tags.join(' ')}]`);

  // --- description assembles title + chapters + hashtags; omits invalid chapters ---
  const desc = buildDescription({ title: 'GOAT plays', chapters: ch, hashtags: tags });
  assert.ok(desc.includes('GOAT plays') && desc.includes('Chapters:') && desc.includes('#nba2k26goat'), 'description has all parts');
  const descNoCh = buildDescription({ title: 'x', chapters: buildChapters([]), hashtags: tags });
  assert.ok(!descNoCh.includes('Chapters:'), 'invalid chapters omitted from description');
  console.log('✅ description assembles parts; drops invalid chapters.');

  console.log('🚀 ALL PUBLISH-KIT TESTS PASSED.');
}

run();
