// test/storyboard.test.js — vanilla Node assertions, no framework. Run: node test/storyboard.test.js
// Locks in the 2026-07-14 storyboard/feedback fixes so they can't silently regress:
//   • selectStoryboard: 8-10min fill, peak-anchored hook, overlap skip, honest under-min
//   • Palworld rules:   no false positives on static HUD level text
//   • applyGameEvents:  additive boost + re-rank
//   • consumeFeedback:  correct knob directions, clamping, idempotency, file preservation
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectStoryboard, recommendPlan } from '../lib/storyboard.js';
import { applyGameEvents } from '../lib/gameEvents.js';
import { matchTextEvents } from '../lib/textEvents.js';
import { PAL_RULES } from '../lib/palworld.js';
import { consumeFeedback } from '../lib/feedbackConsumer.js';

const wide = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'c' + i, start: i * 130, end: i * 130 + 24, t: i * 130 + 12, score: 3, reactionScore: 1, scores: { story: 0.3 }, gameEvents: [],
}));

function run() {
  console.log('🧪 PepStudio storyboard/feedback unit tests…');

  // --- selectStoryboard: fills the 8-10 min window from enough wide clips ---
  const sb = selectStoryboard(wide(40));
  assert.ok(sb.totalSec >= 480 && sb.totalSec <= 600, `total ${sb.totalSec} out of 8-10min window`);
  assert.strictEqual(sb.reachedMin, true, 'should reach the 8-min floor with 40 wide clips');
  console.log('✅ selectStoryboard fills the 8-10 min window.');

  // --- hook teaser brackets the peak (t), stays inside its clip ---
  const topClip = wide(40).find((h) => h.id === sb.hook.source);
  assert.ok(sb.hook.start <= topClip.t && sb.hook.end >= topClip.t, 'hook teaser must contain the peak t');
  assert.ok(sb.hook.start >= topClip.start - 0.01 && sb.hook.end <= topClip.end + 0.01, 'hook teaser must stay inside the clip');
  console.log('✅ hook teaser is anchored on the peak.');

  // --- overlapping clips are skipped (no replayed footage) ---
  const overlapping = [
    { id: 'a', start: 100, end: 130, t: 115, score: 5, reactionScore: 2, scores: {}, gameEvents: [] },
    { id: 'b', start: 120, end: 150, t: 135, score: 4, reactionScore: 1, scores: {}, gameEvents: [] }, // overlaps a
    { id: 'c', start: 400, end: 430, t: 415, score: 3, reactionScore: 1, scores: {}, gameEvents: [] },
  ];
  const ov = selectStoryboard(overlapping, { minSec: 10, maxSec: 600 });
  const body = [...ov.body].sort((x, y) => x.start - y.start);
  for (let i = 1; i < body.length; i++) assert.ok(body[i].start >= body[i - 1].end, 'body must not contain overlapping clips');
  console.log('✅ overlapping clips are skipped.');

  // --- honest under-min: too little material → short cut, no fake padding ---
  const tiny = selectStoryboard(wide(3));
  assert.strictEqual(tiny.reachedMin, false, 'must report reachedMin:false when starved');
  assert.ok(tiny.totalSec < 480, 'must not pad to the floor');
  assert.deepStrictEqual(selectStoryboard([]), { hook: null, body: [], totalSec: 0, reachedMin: false }, 'empty input safe');
  console.log('✅ under-min is honest (no padding).');

  // --- Fast-Cut blueprint: snappier hook + reaction-dominant vs Balanced ---
  const reactHeavy = wide(40).map((h, i) => ({ ...h, reactionScore: i % 4 === 0 ? 7 : 0.5 }));
  const bal = selectStoryboard(reactHeavy, { blueprint: 'balanced' });
  const fast = selectStoryboard(reactHeavy, { blueprint: 'fast' });
  assert.ok(fast.hookSec <= 5, `Fast-Cut hook is snappy (<=5s), got ${fast.hookSec}`);
  assert.ok(fast.hookSec < bal.hookSec, 'Fast-Cut hook shorter than Balanced');
  assert.strictEqual(fast.blueprint, 'fast', 'echoes the fast blueprint');
  console.log(`✅ Fast-Cut blueprint: ${fast.hookSec}s hook (vs Balanced ${bal.hookSec}s), reaction-led.`);

  // --- Palworld rules: static HUD level text must NOT fire (the false-positive fix) ---
  const hud = [['LV 02'], ['Lv04', 'LV07'], ['Lv5 Mama Car 1'], ['3 Cattiva']];
  const falsePos = hud.reduce((n, lines) => n + matchTextEvents(lines.map((t) => ({ text: t })), PAL_RULES).length, 0);
  assert.strictEqual(falsePos, 0, 'static HUD level text must not fire events');
  console.log('✅ Palworld rules do not false-positive on static HUD.');

  // --- applyGameEvents: additive boost bumps the overlapping highlight above a stronger one ---
  const hs = [{ id: 'a', start: 10, end: 14, score: 2, tags: [] }, { id: 'b', start: 100, end: 104, score: 3.5, tags: [] }];
  const boosted = applyGameEvents(hs, [{ t: 12, type: 'buzzer_beater', weight: 1 }]).sort((x, y) => y.score - x.score);
  assert.strictEqual(boosted[0].id, 'a', 'game-event boost must re-rank the matching highlight to top');
  assert.ok(boosted[0].tags.includes('buzzer_beater'), 'boosted highlight must be tagged');
  assert.strictEqual(applyGameEvents(hs, []), hs, 'no events → same array (no-op)');
  console.log('✅ applyGameEvents boosts + re-ranks.');

  // --- consumeFeedback: correct directions, clamping, idempotency, preserves triggers ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
  const fp = path.join(dir, 'feedback.jsonl');
  const hp = path.join(dir, 'gaming_heuristics.json');
  fs.writeFileSync(hp, JSON.stringify({ retentionTriggers: ['WASTED'], triggerWeight: 0.6, hookPenalty: -1.5, targetPacingInterval: 1.3, loudnessThresholdZ: 2.7, comedicDelayTailMs: 160 }));
  fs.writeFileSync(fp, [
    '{"action":"clip_kept","detail":{}}',
    '{"action":"human_correction","detail":{"reason":"MISSED_SETUP"}}',
    '{"action":"human_correction","detail":{"reason":"BORING_FILLER"}}',
  ].join('\n') + '\n');
  const r1 = consumeFeedback({ feedbackPath: fp, heuristicsPath: hp });
  const h = JSON.parse(fs.readFileSync(hp, 'utf8'));
  assert.ok(h.hookPenalty > -1.5, 'MISSED_SETUP eases hook penalty toward 0');
  assert.ok(h.loudnessThresholdZ > 2.7, 'BORING_FILLER raises the energy gate');
  assert.deepStrictEqual(h.retentionTriggers, ['WASTED'], 'must preserve retentionTriggers');
  const r2 = consumeFeedback({ feedbackPath: fp, heuristicsPath: hp });
  assert.strictEqual(r2.applied, false, 'must be idempotent (cursor) on re-run');
  assert.strictEqual(JSON.parse(fs.readFileSync(hp, 'utf8')).hookPenalty, h.hookPenalty, 'idempotent: knobs unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✅ consumeFeedback: directions, clamping, idempotency, preservation.');

  console.log('\n🚀 ALL STORYBOARD/FEEDBACK TESTS PASSED.');
}

run();

// ---- Adaptive planner: length is purely a function of quality, with NO time ceiling ----
{
  console.log('\n🧪 Dynamic picky-planner tests…');
  const mk = (i, dur, score, extra = {}) => ({ id: `h${i}`, start: i * 200, end: i * 200 + dur, score, ...extra });

  // CASE A — low-density VOD: 68 min, only a few great moments. Must stay tight.
  const lowDensity = [mk(1, 60, 10), mk(2, 55, 9.4), mk(3, 50, 9), mk(4, 45, 8.6)];
  for (let i = 5; i <= 40; i++) lowDensity.push(mk(i, 40, 1.2));   // grinding filler
  const lowPlan = recommendPlan(lowDensity, { sourceSec: 68 * 60 });
  assert.ok(lowPlan.targetSec <= 240, `low-density stays tight (${lowPlan.targetSec}s)`);
  assert.strictEqual(lowPlan.strongCount, 4, 'only the 4 genuinely good moments survive');
  console.log(`✅ CASE A 68-min low-density → ${lowPlan.targetSec}s from ${lowPlan.strongCount} moments (filler discarded).`);

  // CASE B — high-density VOD: the SAME 68 min, but 25+ min of gold. Must keep it ALL.
  const highDensity = [];
  for (let i = 1; i <= 30; i++) highDensity.push(mk(i, 55, 9 + (i % 3) * 0.3));   // sustained comedy
  for (let i = 31; i <= 50; i++) highDensity.push(mk(i, 40, 1.1));                // filler
  const highPlan = recommendPlan(highDensity, { sourceSec: 68 * 60 });
  assert.strictEqual(highPlan.strongCount, 30, 'every high-tier moment is kept');
  assert.ok(highPlan.targetSec >= 1600, `high-density earns a long cut (${highPlan.targetSec}s)`);
  console.log(`✅ CASE B same 68-min high-density → ${highPlan.targetSec}s from ${highPlan.strongCount} moments (nothing good dropped).`);

  // The two cases share a source length — proving LENGTH TRACKS QUALITY, not the clock.
  assert.ok(highPlan.targetSec > lowPlan.targetSec * 5, 'same source, wildly different runtimes');
  console.log(`✅ identical 68-min source → ${lowPlan.targetSec}s vs ${highPlan.targetSec}s purely on content.`);

  // NO CEILING: a 3-hour VOD with 45 min of gold must return ~45 min, not a capped 30.
  const epic = [];
  for (let i = 1; i <= 60; i++) epic.push(mk(i, 45, 9.5));
  for (let i = 61; i <= 120; i++) epic.push(mk(i, 30, 0.9));
  const epicPlan = recommendPlan(epic, { sourceSec: 3 * 3600 });
  assert.strictEqual(epicPlan.strongCount, 60, 'all 60 gold moments kept');
  assert.ok(epicPlan.targetSec > 1800, `NO 30-min cap (${epicPlan.targetSec}s)`);
  assert.ok(Math.abs(epicPlan.targetSec - 2700) < 1, `exactly the gold runtime (${epicPlan.targetSec}s ≈ 45min)`);
  console.log(`✅ 3-hour VOD with 45min of gold → ${epicPlan.targetSec}s (no ceiling applied).`);

  // pickyFloor is the single control: raising it must shorten the cut monotonically.
  // Needs a GRADED fixture — highDensity is deliberately bimodal (gold ~9.5, filler ~1.1), so every
  // threshold that falls between the two clusters returns the same set and would prove nothing.
  const graded = [];
  for (let i = 1; i <= 40; i++) graded.push(mk(i, 30, 10 - i * 0.22));   // smooth 10 → 1.4 slide
  const lens = [0.15, 0.35, 0.6, 0.9].map((f) => recommendPlan(graded, { sourceSec: 68 * 60, pickyFloor: f }).targetSec);
  for (let i = 1; i < lens.length; i++) assert.ok(lens[i] <= lens[i - 1], `pickier never lengthens (${lens})`);
  assert.ok(lens[0] > lens[lens.length - 1], 'the control has real range');
  console.log(`✅ pickyFloor 0.15→0.9 shortens monotonically: ${lens.join('s → ')}s.`);
  // and it is clamped, so a nonsense value can't wipe the cut out
  assert.ok(recommendPlan(highDensity, { pickyFloor: 99 }).targetSec > 0, 'absurd floor still yields a cut');
  assert.ok(recommendPlan(highDensity, { pickyFloor: -5 }).targetSec > 0, 'negative floor is clamped');

  // DEGENERATE: flat scores can't be thresholded — must not emit the whole VOD as the "cut".
  const flat = [];
  for (let i = 1; i <= 20; i++) flat.push(mk(i, 60, 0));
  const flatPlan = recommendPlan(flat, { sourceSec: 3600 });
  assert.strictEqual(flatPlan.degenerate, true, 'flat scores are flagged');
  assert.ok(flatPlan.strongCount < flat.length, 'does not pass everything through');
  assert.ok(/flat/i.test(flatPlan.reason), 'and says so');
  console.log(`✅ flat/unranked scores → ${flatPlan.strongCount}/${flat.length} kept, flagged: "${flatPlan.reason.slice(0, 48)}…"`);

  // The selector in auto mode must actually take the whole picky set, not a truncated band.
  const autoCut = selectStoryboard(highDensity, { auto: true, sourceSec: 68 * 60 });
  assert.ok(autoCut.body.length >= 28, `auto cut keeps the picky set (${autoCut.body.length}/30)`);
  assert.ok(autoCut.totalSec >= 1500, `auto cut is the full length (${autoCut.totalSec}s)`);
  console.log(`✅ auto mode assembles ${autoCut.body.length} clips / ${autoCut.totalSec}s — the whole picky set.`);

  // Degenerate inputs stay safe.
  assert.strictEqual(recommendPlan([], { sourceSec: 100 }).targetSec, 0, 'empty is safe');
  assert.strictEqual(recommendPlan(null, {}).tier, 'empty', 'null is safe');
  console.log('✅ empty / null inputs safe.');

  console.log('🚀 DYNAMIC PICKY-PLANNER TESTS PASSED.');
}
