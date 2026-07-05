// lib/trainer.js — PepAI daily self-tuning worker (zero-dependency).
//
// Writes data/gaming_heuristics.json, which lib/retention.js loads to bias the funny
// ranking. Repeated passes (1) expand the retention-trigger lexicon monotonically and
// (2) converge the numeric weights toward the current comedy targets via an EMA, so the
// curation engine sharpens over time with no GUI and no network calls.
//
// Path is pinned to <clipforge>/data via __dirname so the trainer and the running server
// always agree on the file regardless of how the server was launched (native app / Electron
// / npm start each set CLIPFORGE_DATA differently — the GLOBAL heuristics file is not per-run).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const WEIGHTS_PATH = path.join(DATA_DIR, 'gaming_heuristics.json');

// Current archetype: squad-chaos multiplayer comedy (Vanoss-style) — hyper-aggressive
// cut cadence, a raised loudness gate that ignores normal talking and isolates screams /
// wheezing laughter / sandbox explosions, and whip-fast post-punchline snapping.
function currentTrendSnapshot() {
  return {
    retentionTriggers: [
      'WASTED', 'FAIL', 'PHYSICS', 'KARMA', 'COP', 'MODS', 'NO WAY', 'BROKEN', 'INSANE',
      'IMPOSSIBLE', 'WTF', 'GLITCH', 'BUSTED', 'LAUNCHED', 'SPEEDRUN', 'RAGDOLL', 'COLLISION',
      'BUST', 'WIPEOUT', 'SCREAM', 'CAUGHT', 'WANTED', 'CHOPPER', 'CLUTCH', 'ACE', 'DUB',
      'EMOTIONAL DAMAGE', 'DOWN BAD', 'ONE SHOT', 'HEADSHOT',
      // squad-chaos banter markers
      'YEET', 'FLIP', 'WATCH THIS', 'LOOK AT HIM', 'WHAT ARE YOU DOING', 'STOP', 'DIED',
      'EXPLODED', 'SPAWNED', 'GET OUT', 'RUN', 'GOT HIM', 'TRAPPED', 'BETRAYAL', 'PRANK',
      'TROLLING',
    ],
    targetPacingInterval: 1.15, // hyper-aggressive punchline cadence
    loudnessThresholdZ: 3.10,   // ignore normal talking; isolate screams/laughter/explosions
    comedicDelayTailMs: 80,     // whip-fast snap after the punchline peak
    triggerWeight: 0.6,         // score boost per trigger-word hit (see retention.triggerBoost)
    hookPenalty: -1.5,          // demotion for weak/filler openers
  };
}

const DEFAULTS = {
  updatesCount: 0, retentionTriggers: [],
  targetPacingInterval: 1.4, loudnessThresholdZ: 2.5, comedicDelayTailMs: 150,
  triggerWeight: 0.5, hookPenalty: -1.2,
};
const ema = (cur, target, a = 0.3) => +((cur * (1 - a)) + target * a).toFixed(3);

export function runTrainingCycle() {
  console.log('[PepAI Trainer] weight calibration pass…');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let w = { ...DEFAULTS };
    if (fs.existsSync(WEIGHTS_PATH)) {
      try { w = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')) }; }
      catch { console.warn('[PepAI Trainer] corrupt weights — reset to baseline'); }
    }
    const t = currentTrendSnapshot();
    w.retentionTriggers = Array.from(new Set([...(w.retentionTriggers || []), ...t.retentionTriggers]));
    w.targetPacingInterval = ema(w.targetPacingInterval, t.targetPacingInterval);
    w.loudnessThresholdZ = ema(w.loudnessThresholdZ, t.loudnessThresholdZ);
    w.comedicDelayTailMs = Math.round(ema(w.comedicDelayTailMs, t.comedicDelayTailMs));
    w.triggerWeight = ema(w.triggerWeight, t.triggerWeight);
    w.hookPenalty = ema(w.hookPenalty, t.hookPenalty);
    w.updatesCount = (w.updatesCount || 0) + 1;
    w.lastUpdate = new Date().toISOString();
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(w, null, 2), 'utf8');
    console.log(`[PepAI Trainer] ok — ${w.retentionTriggers.length} triggers, pacing ${w.targetPacingInterval}s, z ${w.loudnessThresholdZ}, pass #${w.updatesCount}`);
    return w;
  } catch (err) {
    console.error('[PepAI Trainer] failed:', err.message);
    return null;
  }
}

// Allow `node lib/trainer.js` (and the LaunchAgent) to run a single pass.
if (process.argv[1] && process.argv[1].endsWith('trainer.js')) runTrainingCycle();
