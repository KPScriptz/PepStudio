// Retention heuristics — near-zero-dependency (fs/path only, to load the trainer's weights).
// The loudness/reaction/silence-boundary signals live in analyze.js / reactions.js / trim.js;
// this adds: demoting weak HOOKS (filler intros), a keyword-trigger BOOST fed by the daily
// trainer (lib/trainer.js), and a light pacing tag for display.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Global tuning file written by lib/trainer.js (daily LaunchAgent) AND lib/feedbackConsumer.js
// (the in-app correction loop). Honors CLIPFORGE_DATA so the reader here and those writers all
// resolve the SAME file (in a packaged app that's userData, not the read-only bundle). Missing/
// corrupt → graceful defaults.
const WEIGHTS_PATH = path.join(process.env.CLIPFORGE_DATA || path.join(__dirname, '..', 'data'), 'gaming_heuristics.json');
const H_DEFAULTS = {
  retentionTriggers: [], triggerWeight: 0.6, hookPenalty: -1.5,
  targetPacingInterval: 1.32, loudnessThresholdZ: 2.71, comedicDelayTailMs: 160,
};
let _h = null, _mtime = -1;
// Load, and hot-reload whenever the trainer rewrites the file. Falls back to defaults.
export function heuristics() {
  try {
    const m = fs.statSync(WEIGHTS_PATH).mtimeMs;
    if (!_h || m !== _mtime) { _h = { ...H_DEFAULTS, ...JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')) }; _mtime = m; }
  } catch { if (!_h) _h = { ...H_DEFAULTS }; }
  return _h;
}

// "Hey guys", "okay so basically", "as you can see"… — classic retention killers.
const WEAK_OPENERS = /^(hey guys|hi guys|hello|welcome back|welcome|what'?s up|what is up|okay so|ok so|so basically|basically|as you can see|like i said|anyway|alright so|today (we|i)|in this (video|one))/i;

// Score delta (<= 0) for a candidate based on its opening line. Magnitude is trainer-tunable.
export function hookPenalty(text) {
  const t = (text || '').trim();
  return t && WEAK_OPENERS.test(t) ? (heuristics().hookPenalty ?? -1.5) : 0;
}

// Score delta (>= 0): boost candidates whose transcript hits the trainer's retention-trigger
// lexicon (WASTED / FAIL / CLUTCH …). Capped at 3 hits so one clip can't run away with it.
export function triggerBoost(text) {
  const h = heuristics();
  const list = h.retentionTriggers || [];
  if (!list.length || !text) return 0;
  const up = text.toUpperCase();
  let hits = 0;
  for (const kw of list) { if (kw && up.includes(kw)) { hits++; if (hits >= 3) break; } }
  return +(hits * (h.triggerWeight || 0.6)).toFixed(2);
}

// Words-per-second → pacing tag (GTA comedy = chaotic/fast vs slow driving/setup).
export function pacingTag(words) {
  if (!words || words.length < 2) return 'steady';
  const span = Math.max(0.5, words[words.length - 1].t1 - words[0].t0);
  const wps = words.length / span;
  return wps >= 2.8 ? 'fast' : wps <= 1.2 ? 'slow' : 'steady';
}
