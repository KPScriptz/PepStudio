// Palworld adapter. Palworld's highlight moments show up as on-screen NOTIFICATION text — catching
// a Pal, Alpha/boss encounters, deaths, base raids, level-ups — so this uses the generic keyword
// matcher (lib/textEvents.js) over a notification region rather than the NBA number-parser.
//
// ⚠️ The rules + crop below are STARTER DEFAULTS. Palworld's exact on-screen wording and the
// notification position must be calibrated against a real capture: tune the region with
// PEP_PAL_CROP="x,y,w,h" and adjust PAL_RULES keywords once we see actual frames. The matching
// ENGINE is verified; these specific strings are not yet confirmed against live footage.
import { matchTextEvents, scanTextEvents } from './textEvents.js';

export const PAL_NOTIFY_CROP = (() => {
  const env = (process.env.PEP_PAL_CROP || '').split(',').map(Number);
  if (env.length === 4 && env.every(Number.isFinite)) return { x: env[0], y: env[1], w: env[2], h: env[3] };
  // Full-frame by default: real Palworld events are scattered across the HUD (encounter/boss bar
  // center ~y0.37, quests right, Pal status bottom-left), so a small crop misses them. Narrow this
  // via PEP_PAL_CROP once the exact notification region is confirmed on a labeled event frame.
  return { x: 0, y: 0, w: 1, h: 1 };
})();

// ⚠️ Rules below marked (unverified) have NOT been confirmed against real Palworld footage yet —
// no capture/death/raid frames were found in the sampled action moments. `level_up` previously
// matched any static "Lv##" HUD text (party levels, boss level) → false positives on nearly every
// frame; it now requires an explicit "Level Up!" event string. Reliable rules need labeled example
// frames (see the OCR-calibration note below).
export const PAL_RULES = [
  { type: 'pal_caught', weight: 0.7, any: [/\bcaught\b/i, /captur/i] },                 // unverified
  { type: 'boss_alpha', weight: 0.85, any: [/\balpha\b/i, /\blord\b/i, /\bboss\b/i] },   // unverified
  { type: 'death', weight: 0.6, any: [/you died/i, /respawn/i, /you were defeated/i] },  // unverified
  { type: 'raid', weight: 0.8, any: [/raid/i, /under attack/i, /invad/i] },              // unverified
  { type: 'lucky_rare', weight: 0.9, any: [/lucky/i, /\brare\b/i] },                     // unverified
  { type: 'level_up', weight: 0.35, any: [/level up!/i] },   // was /lv\d+/ → matched STATIC HUD (fixed)
];

// Scan a Palworld VOD → highlight-worthy event tokens. Options pass through to scanTextEvents
// (duration, everySec, holdSec, fast). Crop defaults to PAL_NOTIFY_CROP.
export async function analyzePalworld(file, opts = {}) {
  const events = await scanTextEvents(file, PAL_RULES, { crop: PAL_NOTIFY_CROP, ...opts });
  return { events };
}
