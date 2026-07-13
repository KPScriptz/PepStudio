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
  return { x: 0.28, y: 0.12, w: 0.44, h: 0.22 }; // center-upper notification band (starter guess)
})();

export const PAL_RULES = [
  { type: 'pal_caught', weight: 0.7, any: [/\bcaught\b/i, /captur/i] },
  { type: 'boss_alpha', weight: 0.85, any: [/\balpha\b/i, /\blord\b/i, /\bboss\b/i] },
  { type: 'death', weight: 0.6, any: [/you died/i, /respawn/i, /you were defeated/i] },
  { type: 'raid', weight: 0.8, any: [/raid/i, /under attack/i, /invad/i] },
  { type: 'lucky_rare', weight: 0.9, any: [/lucky/i, /\brare\b/i] },
  { type: 'level_up', weight: 0.35, any: [/level up/i, /\blv\.?\s*\d+/i] },
];

// Scan a Palworld VOD → highlight-worthy event tokens. Options pass through to scanTextEvents
// (duration, everySec, holdSec, fast). Crop defaults to PAL_NOTIFY_CROP.
export async function analyzePalworld(file, opts = {}) {
  const events = await scanTextEvents(file, PAL_RULES, { crop: PAL_NOTIFY_CROP, ...opts });
  return { events };
}
