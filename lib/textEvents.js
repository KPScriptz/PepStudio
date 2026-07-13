// Generic keyword-driven HUD/notification event matcher, shared by the text-notification game
// adapters (Palworld, Minecraft death-log, GTA mission cards, COD victory cards). Unlike the NBA
// scoreboard adapter — which parses structured numbers — these games surface highlight moments as
// on-screen TEXT, so the adapter OCRs a region and matches configurable keyword rules → tokens.
//
// A rule: { type, weight?, any?:[str|RegExp], all?:[...], not?:[...] }
//   any  — fires if ANY of these appear (OR)
//   all  — requires ALL of these (AND)
//   not  — suppresses if ANY of these appear
import { ocrFrame, ocrAvailable } from './ocr.js';

const has = (text, hay, k) => (k instanceof RegExp ? k.test(text) : hay.includes(String(k).toLowerCase()));

// Match one frame's OCR lines against the rules. Pure — returns [{t,type,weight,detail}].
export function matchTextEvents(lines, rules, { t = 0 } = {}) {
  const text = (lines || []).map((l) => (typeof l === 'string' ? l : l.text)).join('  ').trim();
  if (!text) return [];
  const hay = text.toLowerCase();
  const out = [];
  for (const r of rules) {
    if (r.not && r.not.some((k) => has(text, hay, k))) continue;
    if (r.all && !r.all.every((k) => has(text, hay, k))) continue;
    if (r.any && !r.any.some((k) => has(text, hay, k))) continue;
    out.push({ t, type: r.type, weight: r.weight ?? 0.5, detail: text.slice(0, 60) });
  }
  return out;
}

// Sample a HUD region across the VOD and match rules, deduping repeats of the same event type
// within `holdSec` (a notification lingers on screen across several sampled frames).
export async function scanTextEvents(file, rules, { duration, crop, everySec = 3, fast = true, holdSec = 6 } = {}) {
  if (!ocrAvailable() || !duration) return [];
  const events = [];
  const lastAt = {};
  for (let t = 0; t < duration; t += everySec) {
    const lines = await ocrFrame(file, t, { crop, fast }).catch(() => []);
    for (const e of matchTextEvents(lines, rules, { t })) {
      if (lastAt[e.type] != null && t - lastAt[e.type] < holdSec) continue;
      lastAt[e.type] = t;
      events.push(e);
    }
  }
  return events;
}
