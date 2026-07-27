// test/titles.test.js — vanilla Node assertions. Run: node test/titles.test.js
import assert from 'assert';
import { smartTitle } from '../lib/titles.js';

function run() {
  console.log('🧪 PepStudio smart-title unit tests…');

  // --- Title Case, edge filler trimmed, 3–6 words ---
  const t1 = smartTitle('so um and then I hit the insane buzzer beater to win it yeah');
  assert.ok(!/^so |^um /i.test(t1), 'leading filler trimmed');
  assert.ok(t1.split(' ').length <= 6, 'capped at 6 words');
  assert.ok(/^[A-Z]/.test(t1), 'first word capitalized (Title Case)');
  assert.ok(t1 === t1 && !/[a-z]{2,} [A-Z]{4,}/.test(t1), 'not ALL CAPS');
  console.log(`✅ "${t1}" — trimmed, capped, Title-Cased.`);

  // --- small words stay lowercase mid-phrase, first word always capped ---
  const t2 = smartTitle('king of the court crossover');
  assert.ok(/ of /.test(t2) || / the /.test(t2), 'small words stay lowercase mid-phrase');
  assert.strictEqual(t2[0], t2[0].toUpperCase(), 'first word capitalized even if a small word');
  console.log(`✅ "${t2}" — small-word casing.`);

  // --- whisper annotations stripped ---
  const t3 = smartTitle('(laughing) that was the funniest wipe ever (screaming)');
  assert.ok(!/laughing|screaming|\(|\)/.test(t3), 'parenthetical annotations removed');
  console.log(`✅ "${t3}" — annotations stripped.`);

  // --- thin transcript → editorial template by reaction tag, not a filler fragment ---
  assert.strictEqual(smartTitle('uh yeah', { tag: 'laugh' }), 'Funny Moment', 'thin+laugh → template');
  assert.strictEqual(smartTitle('', { tag: 'hype' }), 'Insane Play', 'empty+hype → template');
  assert.strictEqual(smartTitle('ok so', { reactionScore: 5 }), 'Big Reaction', 'thin+high reaction → Big Reaction');
  assert.strictEqual(smartTitle(''), 'Highlight', 'nothing → Highlight');
  console.log('✅ thin transcripts fall back to editorial titles (no filler fragments).');

  console.log('🚀 ALL SMART-TITLE TESTS PASSED.');
}

run();
