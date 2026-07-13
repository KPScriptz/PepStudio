// NBA 2K scoreboard adapter. Samples the top-center HUD with the OCR bridge, parses each frame
// into a scoreboard state, and turns the state-over-time into narrative event tokens (made shots,
// lead changes, buzzer-beaters, clutch late-game scoring) that downstream ranking can boost.
//
// The parser + detector are pure (no I/O) so they're fully unit-testable; scanScoreboard() is the
// only part that touches ffmpeg/Vision.
import { ocrFrame, ocrAvailable } from './ocr.js';

// Default HUD crop for NBA 2K's top-center scoreboard (normalized 0–1). Calibrate per capture with
// PEP_NBA_CROP="x,y,w,h" if a stream's overlay sits elsewhere.
export const NBA_SCOREBOARD_CROP = (() => {
  const env = (process.env.PEP_NBA_CROP || '').split(',').map(Number);
  if (env.length === 4 && env.every(Number.isFinite)) return { x: env[0], y: env[1], w: env[2], h: env[3] };
  return { x: 0.30, y: 0.0, w: 0.40, h: 0.16 };
})();

const QUARTER = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };

// Parse OCR text lines → { teams:[{tag,score}], quarter, clockSec } or null if it doesn't look
// like a scoreboard. Tolerant of the score sitting on one combined line or split across lines.
export function parseScoreboard(lines) {
  const text = (lines || []).map((l) => (typeof l === 'string' ? l : l.text)).join('  ');
  const teams = [];
  const teamRe = /\b([A-Z]{2,4})\s+(\d{1,3})\b/g;
  let m;
  while ((m = teamRe.exec(text)) !== null) {
    teams.push({ tag: m[1], score: Number(m[2]) });
    if (teams.length === 2) break;
  }
  let quarter = null;
  const qm = text.match(/\b([1-4])(?:st|nd|rd|th)\b/i);
  if (qm) quarter = Number(qm[1]);
  else if (/\bOT\b/i.test(text)) quarter = 5;
  let clockSec = null;
  const cm = text.match(/\b(\d{1,2}):(\d{2})(?:\.(\d))?\b/);
  if (cm) clockSec = Number(cm[1]) * 60 + Number(cm[2]) + (cm[3] ? Number(cm[3]) / 10 : 0);
  if (teams.length < 2 && quarter == null) return null; // not a scoreboard frame
  return { teams, quarter, clockSec };
}

// Walk a time-ordered list of {t, state} samples and emit event tokens. Each token:
// { t, type, weight, detail }. Weights are pre-normalized 0–1 for the ranker to fold in.
export function detectScoreboardEvents(samples) {
  const events = [];
  const clean = (samples || []).filter((s) => s.state && s.state.teams && s.state.teams.length === 2);
  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1];
    const cur = clean[i];
    const pT = prev.state.teams, cT = cur.state.teams;
    // Match teams by tag so we compare the same side even if OCR order flips.
    const byTag = (arr, tag) => arr.find((x) => x.tag === tag);
    let scored = false;
    for (const c of cT) {
      const p = byTag(pT, c.tag);
      if (!p) continue;
      const delta = c.score - p.score;
      if (delta >= 2 && delta <= 4) {
        scored = true;
        const lateQ = (cur.state.quarter >= 4) ;
        const clutchClock = cur.state.clockSec != null && cur.state.clockSec <= 3;
        // Buzzer-beater: a bucket with ~no clock left. Highest weight.
        if (clutchClock) {
          events.push({ t: cur.t, type: 'buzzer_beater', weight: 1.0, detail: `${c.tag} +${delta} @ ${fmtClock(cur.state.clockSec)}` });
        } else {
          events.push({ t: cur.t, type: delta === 3 ? 'three_pointer' : 'bucket', weight: lateQ ? 0.55 : 0.4, detail: `${c.tag} +${delta}` });
        }
      }
    }
    // Lead change: sign of (teamA - teamB) flips between samples.
    if (pT.length === 2 && cT.length === 2) {
      const pLead = leadOf(pT), cLead = leadOf(cT);
      if (pLead && cLead && pLead !== cLead) {
        events.push({ t: cur.t, type: 'lead_change', weight: 0.6, detail: `${cLead} take the lead` });
      }
    }
  }
  return events;
}

function leadOf(teams) {
  if (teams[0].score === teams[1].score) return null;
  return teams[0].score > teams[1].score ? teams[0].tag : teams[1].tag;
}
function fmtClock(s) { if (s == null) return '?'; const m = Math.floor(s / 60); const r = Math.round(s % 60); return `${m}:${String(r).padStart(2, '0')}`; }

// Sample the scoreboard across the VOD and return time-ordered { t, state } entries. everySec
// controls cadence (default 4s). Uses fast Vision mode by default — HUD digits are high-contrast.
export async function scanScoreboard(file, { duration, crop = NBA_SCOREBOARD_CROP, everySec = 4, fast = true } = {}) {
  if (!ocrAvailable() || !duration) return [];
  const samples = [];
  for (let t = 0; t < duration; t += everySec) {
    const lines = await ocrFrame(file, t, { crop, fast }).catch(() => []);
    const state = parseScoreboard(lines);
    if (state) samples.push({ t, state });
  }
  return samples;
}

// Convenience: scan + detect in one call. Returns { samples, events }.
export async function analyzeNBA(file, opts = {}) {
  const samples = await scanScoreboard(file, opts);
  return { samples, events: detectScoreboardEvents(samples) };
}
