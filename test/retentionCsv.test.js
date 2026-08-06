// test/retentionCsv.test.js — vanilla Node assertions. Run: node test/retentionCsv.test.js
import assert from 'assert';
import { parseRetentionCsv, findCliffs, clipAtOutputTime, attributeCliff, buildFeedbackRows } from '../lib/retentionCsv.js';

console.log('🧪 PepStudio retention-CSV adapter tests…');

// --- parsing real-world Studio shapes -----------------------------------------------------------
{
  // Percentage positions (the common Studio export), with a quoted header containing a comma.
  const pctCsv = ['"Video position (%)","Absolute audience retention (%)"']
    .concat(Array.from({ length: 101 }, (_, i) => `${i},${(100 - i * 0.5).toFixed(1)}`))
    .join('\n');
  const a = parseRetentionCsv(pctCsv, { videoSec: 600 });
  assert.strictEqual(a.positionUnit, 'percent', 'detects percentage positions');
  assert.strictEqual(a.rows, 101);
  assert.strictEqual(a.points[0].sec, 0);
  assert.strictEqual(a.points[100].sec, 600, '100% maps to the video duration');
  assert.strictEqual(a.points[50].sec, 300, '50% maps to the midpoint');

  // Elapsed-seconds positions.
  const secCsv = 'Elapsed video time,Audience watched\n0,100\n30,88\n60,80\n300,55';
  const b = parseRetentionCsv(secCsv, { videoSec: 300 });
  assert.strictEqual(b.positionUnit, 'seconds', 'detects second positions');
  assert.deepStrictEqual(b.points.map((p) => p.sec), [0, 30, 60, 300]);

  // Junk rows, blank lines and % signs must not break it.
  const messy = 'Video position (%),Absolute audience retention (%)\n0,100%\n\n"Totals","n/a"\n50,60%\n100,40%';
  const c = parseRetentionCsv(messy, { videoSec: 200 });
  assert.strictEqual(c.rows, 3, 'skips blank and non-numeric rows');
  assert.strictEqual(c.points[2].pct, 40, 'strips % signs');

  // Headerless numeric CSV falls back to the first two numeric columns.
  const bare = '0,100\n10,90\n20,70';
  assert.strictEqual(parseRetentionCsv(bare).rows, 3, 'headerless CSV still parses');

  // Degenerate input.
  assert.strictEqual(parseRetentionCsv('').rows, 0);
  assert.strictEqual(parseRetentionCsv(null).rows, 0);
  assert.doesNotThrow(() => parseRetentionCsv('garbage\nlines\nhere'));
  console.log('✅ parses percent + seconds exports, quoted headers, % signs, junk rows, headerless, empty.');
}

// --- cliff detection ----------------------------------------------------------------------------
{
  // Gentle slide (1%/10s) must NOT trip a 5%/10s threshold.
  const gentle = Array.from({ length: 60 }, (_, i) => ({ sec: i * 10, pct: 100 - i }));
  assert.strictEqual(findCliffs(gentle, { dropPct: 5, windowSec: 10 }).length, 0, 'a slow decline is not a cliff');

  // A real cliff: 20 points lost across 10s at t=120.
  const withCliff = [
    { sec: 100, pct: 80 }, { sec: 110, pct: 79 }, { sec: 120, pct: 78 },
    { sec: 125, pct: 62 }, { sec: 130, pct: 58 }, { sec: 140, pct: 57 },
  ];
  const cliffs = findCliffs(withCliff, { dropPct: 5, windowSec: 10 });
  assert.ok(cliffs.length >= 1, 'finds the cliff');
  assert.ok(cliffs[0].drop >= 15, `reports the magnitude (${cliffs[0].drop}%)`);
  assert.ok(cliffs[0].atSec >= 110 && cliffs[0].atSec <= 125, `located near the drop (${cliffs[0].atSec}s)`);
  // Overlapping windows merge to one cliff, not one per sample.
  assert.ok(cliffs.length <= 2, `overlapping windows merged (${cliffs.length})`);

  assert.strictEqual(findCliffs([], {}).length, 0);
  assert.strictEqual(findCliffs([{ sec: 0, pct: 100 }], {}).length, 0, 'a single point cannot be a cliff');
  console.log(`✅ cliff detection: ignores gentle decline, catches a ${cliffs[0].drop}% drop, merges overlaps.`);
}

// --- output-time → clip mapping -----------------------------------------------------------------
{
  const clips = [{ id: 'a', start: 100, end: 110 }, { id: 'b', start: 900, end: 920 }];
  assert.strictEqual(clipAtOutputTime(0, clips).clip.id, 'a');
  assert.strictEqual(clipAtOutputTime(9.9, clips).clip.id, 'a');
  assert.strictEqual(clipAtOutputTime(10, clips).clip.id, 'b', 'boundary belongs to the next clip');
  assert.strictEqual(clipAtOutputTime(29.9, clips).clip.id, 'b');
  assert.strictEqual(clipAtOutputTime(99, clips), null, 'past the end of the cut');
  assert.strictEqual(clipAtOutputTime(5, clips).offsetInClip, 5);
  console.log('✅ output-time → clip mapping, including boundaries and out-of-range.');
}

// --- attribution: evidence-based, and never fabricated -------------------------------------------
{
  const clips = [{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 500, end: 560 }];

  // Dead air under the cliff → BORING_FILLER (raise the energy gate).
  const boring = attributeCliff({ atSec: 30, drop: 9 }, {
    clips, criticIssues: [{ type: 'dead_air', atSec: 25, endSec: 35 }],
  });
  assert.strictEqual(boring.reason, 'BORING_FILLER');

  // A long stretch with no interrupt → PACING (cut faster).
  const pacing = attributeCliff({ atSec: 30, drop: 9 }, {
    clips, criticIssues: [{ type: 'no_pattern_interrupt', atSec: 20, endSec: 45 }],
  });
  assert.strictEqual(pacing.reason, 'PACING');

  // A cliff ON a cut boundary reads as a jarring edit, not boring content.
  const boundary = attributeCliff({ atSec: 60, drop: 9 }, {
    clips, criticIssues: [{ type: 'dead_air', atSec: 55, endSec: 65 }],
  });
  assert.strictEqual(boundary.reason, 'BAD_TIMING', 'boundary wins over content');

  // No evidence → null. An unexplained cliff must not become a random nudge.
  assert.strictEqual(attributeCliff({ atSec: 30, drop: 9 }, { clips, criticIssues: [] }), null);
  console.log('✅ attribution uses critic evidence; an unexplained cliff returns null, never a guess.');
}

// --- rows match the consumer's schema, and MISSED_SETUP is never emitted -------------------------
{
  const clips = [{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 500, end: 560 }];
  const criticIssues = [
    { type: 'dead_air', atSec: 20, endSec: 40 },
    { type: 'no_pattern_interrupt', atSec: 70, endSec: 100 },
  ];
  const cliffs = [
    { atSec: 30, drop: 12 }, { atSec: 80, drop: 8 },
    { atSec: 45, drop: 20 }, { atSec: 200, drop: 30 },   // 200s is past the cut → unexplained
  ];
  const { rows, skipped, considered } = buildFeedbackRows(cliffs, { projectId: 'p1', videoId: 'yt123', clips, criticIssues });

  assert.strictEqual(considered, 4);
  assert.ok(rows.length >= 2, `emitted rows (${rows.length})`);
  // EXACT schema the consumer reads.
  for (const r of rows) {
    assert.strictEqual(r.action, 'human_correction', 'action matches the consumer');
    assert.ok(r.detail && typeof r.detail.reason === 'string', 'detail.reason present');
    assert.ok(['BAD_TIMING', 'BORING_FILLER', 'PACING'].includes(r.detail.reason), `reason is consumer-known (${r.detail.reason})`);
    assert.notStrictEqual(r.detail.reason, 'MISSED_SETUP', 'MISSED_SETUP must never be auto-emitted');
    assert.strictEqual(r.source, 'youtube_retention', 'provenance recorded');
    assert.ok(Number.isFinite(r.detail.outSec) && Number.isFinite(r.detail.dropPct));
  }
  // The unexplained cliff was skipped with a stated reason rather than silently dropped.
  assert.ok(skipped.some((s) => /no evidence/.test(s.why)), 'unexplained cliffs are reported as skipped');
  // The 20% cliff at 45s sits outside every critic issue and away from any boundary, so it is
  // correctly refused as unexplained — proving magnitude alone never buys a row.
  assert.ok(!rows.some((r) => r.detail.dropPct === 20), 'a big but unexplained cliff is still rejected');
  // Budget goes to the strongest ATTRIBUTABLE cliff.
  const budgeted = buildFeedbackRows(cliffs, { projectId: 'p1', clips, criticIssues, maxRows: 1 });
  assert.strictEqual(budgeted.rows.length, 1, 'row budget enforced');
  assert.strictEqual(budgeted.rows[0].detail.dropPct, 12, 'the biggest EXPLAINED drop wins the budget');
  console.log(`✅ rows match the consumer schema exactly; ${rows.length} emitted, ${skipped.length} skipped with reasons.`);
}

// --- end-to-end: CSV text → rows ------------------------------------------------------------------
{
  const csv = 'Video position (%),Absolute audience retention (%)\n'
    + Array.from({ length: 101 }, (_, i) => {
      const pct = i < 10 ? 100 - i : (i < 12 ? 90 - (i - 9) * 12 : 54 - (i - 12) * 0.3);
      return `${i},${pct.toFixed(1)}`;
    }).join('\n');
  const { points } = parseRetentionCsv(csv, { videoSec: 240 });
  const cliffs = findCliffs(points, { dropPct: 5, windowSec: 10 });
  assert.ok(cliffs.length >= 1, 'end-to-end finds the engineered cliff');
  const { rows } = buildFeedbackRows(cliffs, {
    projectId: 'nba', clips: [{ id: 'h1', start: 0, end: 240 }],
    criticIssues: [{ type: 'low_speech_density', atSec: 0, endSec: 80 }],
  });
  assert.ok(rows.length >= 1, 'produces at least one bounded row');
  assert.strictEqual(rows[0].detail.clipId, 'h1', 'row carries the clip id it blames');
  console.log(`✅ end-to-end: CSV → ${cliffs.length} cliff(s) → ${rows.length} bounded feedback row(s).`);
}

console.log('🚀 ALL RETENTION-CSV TESTS PASSED.');

// --- consumer truncation guard (found by actually exercising the loop) ---------------------------
// The cursor is a line COUNT. If the log is rotated/truncated (or the app moves to a fresh data
// dir), the cursor can point past EOF and slice() silently yields nothing — the loop would ignore
// every future correction forever while reporting "no new corrections". Now it rewinds.
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { consumeFeedback } = await import('../lib/feedbackConsumer.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-fb-'));
  const fbPath = path.join(dir, 'feedback.jsonl');
  const hPath = path.join(dir, 'gaming_heuristics.json');
  const row = { action: 'human_correction', projectId: 'p', detail: { reason: 'BORING_FILLER' } };
  fs.writeFileSync(fbPath, JSON.stringify(row) + '\n');
  // Cursor far past EOF, exactly as a rotated log would leave it.
  fs.writeFileSync(hPath, JSON.stringify({ loudnessThresholdZ: 2.71, feedbackConsumedLines: 999 }));

  const r = consumeFeedback({ feedbackPath: fbPath, heuristicsPath: hPath });
  assert.strictEqual(r.rewound, true, 'detects the cursor is past EOF');
  assert.strictEqual(r.applied, true, 'and actually consumes the row instead of going deaf');
  assert.ok(r.changes.loudnessThresholdZ[1] > r.changes.loudnessThresholdZ[0], 'the knob moved');

  // Still idempotent afterwards.
  const again = consumeFeedback({ feedbackPath: fbPath, heuristicsPath: hPath });
  assert.strictEqual(again.applied, false, 'second run is a no-op');
  assert.strictEqual(again.rewound, false, 'and does not rewind again');

  // A normal cursor is untouched.
  fs.writeFileSync(hPath, JSON.stringify({ loudnessThresholdZ: 2.71, feedbackConsumedLines: 0 }));
  assert.strictEqual(consumeFeedback({ feedbackPath: fbPath, heuristicsPath: hPath }).rewound, false, 'valid cursor never rewinds');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✅ truncation guard: a rotated log revives the loop instead of silently killing it.');
}

console.log('🚀 RETENTION LOOP GUARD TESTS PASSED.');
