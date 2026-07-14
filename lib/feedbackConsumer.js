// Feedback consumer — the missing "learning half". Reads the real correction rows the app logs to
// data/feedback.jsonl and nudges the REAL numeric knobs in data/gaming_heuristics.json (the flat
// shape retention.js live-reads), so tapping the "Why did you change this?" chips actually shifts
// how the ranker cuts on the next import.
//
// Real row shape (from public/app.js promptCorrection → logEdit):
//   { action:"human_correction", projectId, detail:{ ..., reason:"MISSED_SETUP"|"PACING"|... } }
// Real knobs + trainer ranges (lib/trainer.js / retention.js):
//   targetPacingInterval ~0.5-3 · loudnessThresholdZ 1.5-4 · comedicDelayTailMs 40-400 · hookPenalty -4..0
//
// Design notes:
//  • MERGE into the existing file — never rewrite the schema; retentionTriggers/updatesCount kept.
//  • IDEMPOTENT — a `feedbackConsumedLines` cursor means only NEW corrections are applied, so
//    re-running (or an accidental double-fire) can't swing weights twice.
//  • A single chip has no explicit direction, so directions follow the creator archetype (fast,
//    aggressive, keep setups). Every step is bounded + clamped so no pass moves a knob wildly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CLIPFORGE_DATA || path.join(__dirname, '..', 'data');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const REASONS = ['BAD_TIMING', 'MISSED_SETUP', 'BORING_FILLER', 'PACING'];

export function consumeFeedback({
  feedbackPath = path.join(DATA, 'feedback.jsonl'),
  heuristicsPath = path.join(DATA, 'gaming_heuristics.json'),
} = {}) {
  if (!fs.existsSync(feedbackPath)) return { ok: false, reason: 'no feedback log', counts: null };

  // Load existing heuristics (preserve every key — triggers, updatesCount, schemaVersion, cursor).
  let h = {};
  try { h = JSON.parse(fs.readFileSync(heuristicsPath, 'utf8')); } catch { /* start from {} → defaults below */ }

  const lines = fs.readFileSync(feedbackPath, 'utf8').split('\n').filter((l) => l.trim());
  const cursor = h.feedbackConsumedLines || 0;
  const fresh = lines.slice(cursor);                 // only corrections we haven't applied yet

  const counts = Object.fromEntries(REASONS.map((r) => [r, 0]));
  for (const line of fresh) {
    try {
      const e = JSON.parse(line);
      if (e.action !== 'human_correction') continue;
      const r = e.detail && e.detail.reason;
      if (Object.prototype.hasOwnProperty.call(counts, r)) counts[r]++;
    } catch { /* skip malformed row */ }
  }
  const total = REASONS.reduce((a, r) => a + counts[r], 0);

  // Advance the cursor even with 0 corrections so non-correction rows aren't rescanned forever.
  if (total === 0) {
    const next = { ...h, feedbackConsumedLines: lines.length };
    atomicWrite(heuristicsPath, next);
    return { ok: true, applied: false, counts, reason: 'no new corrections' };
  }

  // Current knob values (fall back to retention.js defaults).
  const cur = {
    targetPacingInterval: h.targetPacingInterval ?? 1.32,
    loudnessThresholdZ: h.loudnessThresholdZ ?? 2.71,
    comedicDelayTailMs: h.comedicDelayTailMs ?? 160,
    hookPenalty: h.hookPenalty ?? -1.5,
  };

  // Map chips → knob nudges (magnitude scales with tap count, clamped to trainer ranges):
  //  MISSED_SETUP  → ease hook penalty toward 0 so quieter setup openers survive
  //  BORING_FILLER → raise the energy gate (ignore more normal talking)
  //  PACING        → faster cadence + snappier tail (Vanoss smash-cut)
  //  BAD_TIMING    → give cut boundaries a touch more tail room (opposes PACING; net = who taps more)
  const hookPenalty = +clamp(cur.hookPenalty + counts.MISSED_SETUP * 0.15, -4, 0).toFixed(3);
  const loudnessThresholdZ = +clamp(cur.loudnessThresholdZ + counts.BORING_FILLER * 0.08, 1.5, 4).toFixed(3);
  const targetPacingInterval = +clamp(cur.targetPacingInterval - counts.PACING * 0.03, 0.5, 3).toFixed(3);
  const comedicDelayTailMs = Math.round(clamp(cur.comedicDelayTailMs - counts.PACING * 8 + counts.BAD_TIMING * 6, 40, 400));

  const updated = {
    ...h,
    targetPacingInterval, loudnessThresholdZ, comedicDelayTailMs, hookPenalty,
    updatesCount: (h.updatesCount || 0) + 1,
    feedbackConsumedLines: lines.length,
  };
  atomicWrite(heuristicsPath, updated);

  return {
    ok: true, applied: true, counts,
    changes: {
      hookPenalty: [cur.hookPenalty, hookPenalty],
      loudnessThresholdZ: [cur.loudnessThresholdZ, loudnessThresholdZ],
      targetPacingInterval: [cur.targetPacingInterval, targetPacingInterval],
      comedicDelayTailMs: [cur.comedicDelayTailMs, comedicDelayTailMs],
    },
  };
}

function atomicWrite(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);   // atomic: retention.js never sees a half-written file
}
