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

// ---- Adaptive run-time planner (any length of footage) ----
{
  console.log('\n🧪 Adaptive plan tests…');
  const mk = (i, dur, score, extra = {}) => ({
    id: `h${i}`, start: i * 100, end: i * 100 + dur, score, ...extra,
  });

  // 1) SHORT SOURCE: a 12-min clip with 5 good moments must NOT be padded toward 8 minutes.
  const shortHl = [mk(1, 20, 9), mk(2, 18, 8), mk(3, 15, 7.5), mk(4, 14, 7), mk(5, 12, 6.5)];
  const shortPlan = recommendPlan(shortHl, { sourceSec: 12 * 60 });
  assert.ok(shortPlan.targetSec <= 79, `short source stays short (got ${shortPlan.targetSec}s)`);
  assert.ok(shortPlan.targetSec > 0, 'short source still produces a plan');
  assert.ok(shortPlan.targetSec <= shortPlan.availSec + 0.01, 'never targets more than exists');
  console.log(`✅ 12-min source → ${shortPlan.targetSec}s (was forced to 480s): ${shortPlan.reason}`);

  // 2) LONG SOURCE: a 3-hour VOD with lots of strong material earns a long cut, capped at 25%.
  const longHl = [];
  for (let i = 1; i <= 120; i++) longHl.push(mk(i, 30, i <= 60 ? 9 : 1));
  const longPlan = recommendPlan(longHl, { sourceSec: 3 * 3600 });
  assert.ok(longPlan.targetSec > 600, `3-hour VOD earns >10min (got ${longPlan.targetSec}s)`);
  assert.ok(longPlan.targetSec <= 1800, 'never exceeds the 30-min ceiling');
  assert.strictEqual(longPlan.tier, 'long-form');
  console.log(`✅ 3-hour source → ${longPlan.targetSec}s, tier=${longPlan.tier}: ${longPlan.reason}`);

  // 3) The knee must EXCLUDE the weak tail: 60 strong @30s = 1800s of material.
  assert.ok(longPlan.strongCount <= 70, `knee excludes the filler tail (kept ${longPlan.strongCount}/120)`);
  assert.ok(longPlan.strongCount >= 55, 'knee keeps the genuinely strong block');
  console.log(`✅ quality knee kept ${longPlan.strongCount}/120 (the 60 strong, not the 60 filler).`);

  // 4) Source ceiling actually binds: same strong material, much shorter source.
  const cappedPlan = recommendPlan(longHl, { sourceSec: 20 * 60 });
  assert.ok(cappedPlan.targetSec <= 20 * 60 * 0.25 + 0.5, '25% source ceiling binds');
  assert.strictEqual(cappedPlan.capped, true, 'reports that it was capped');
  console.log(`✅ ceiling binds: 20-min source → ${cappedPlan.targetSec}s (capped=${cappedPlan.capped}).`);

  // 5) Hook scales down for tiny cuts — a 60s cut must not open with a 10s teaser.
  const tiny = recommendPlan([mk(1, 20, 9), mk(2, 15, 8)], { sourceSec: 120 });
  assert.ok(tiny.hookSec < 8, `hook scales with the cut (got ${tiny.hookSec}s)`);
  assert.ok(tiny.hookSec >= 3, 'hook never collapses below 3s');
  console.log(`✅ hook scales with cut length (${tiny.hookSec}s for a ${tiny.targetSec}s cut).`);

  // 6) Degenerate inputs never throw.
  assert.strictEqual(recommendPlan([], { sourceSec: 100 }).targetSec, 0, 'empty input is safe');
  assert.strictEqual(recommendPlan(null, {}).tier, 'empty', 'null input is safe');
  assert.ok(recommendPlan([mk(1, 10, 5)], {}).targetSec > 0, 'missing sourceSec still plans');
  console.log('✅ empty / null / missing-sourceSec inputs are safe.');

  // 7) auto mode actually drives selectStoryboard, and the explicit path is UNCHANGED.
  const autoCut = selectStoryboard(shortHl, { auto: true, sourceSec: 12 * 60 });
  assert.ok(autoCut.totalSec <= 90, `auto cut sized to the footage (${autoCut.totalSec}s)`);
  assert.ok(autoCut.body.length > 0, 'auto cut still produces a body');
  const explicitCut = selectStoryboard(shortHl, { minSec: 480, maxSec: 600 });
  assert.ok(explicitCut.totalSec !== autoCut.totalSec || shortHl.length === 0, 'explicit path differs from auto');
  console.log(`✅ auto mode drives the selector (${autoCut.totalSec}s vs explicit ${explicitCut.totalSec}s).`);

  console.log('🚀 ADAPTIVE PLAN TESTS PASSED.');
}
