// Micro-cut pacing — jump-cut the internal dead air out of a single clip so short-form stays
// relentless. Pure (no I/O): the caller detects the clip's fine silences (silencedetect) and hands
// them here; this returns the KEEP sub-segments (clip minus dead air) + pacing stats. Rendering the
// returned segments through the existing sequence export produces the tightened clip.

// How aggressively to trim, as a minimum-silence threshold (seconds). Natural only cuts real pauses;
// Relentless cuts the breath between sentences. `db` is the silencedetect noise floor.
export const PACING_LEVELS = {
  natural: { label: 'Natural', minSilence: 1.2, db: -32 },
  tight: { label: 'Tight', minSilence: 0.7, db: -32 },
  relentless: { label: 'Relentless', minSilence: 0.4, db: -30 },
};

// Parse silencedetect stderr → [[start, end], ...] (in the timebase ffmpeg emitted, which is
// clip-relative when the clip was reached via `-ss` input seek). Pure.
export function parseSilences(stderr) {
  const out = [];
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let m; let open = null;
  while ((m = re.exec(String(stderr || '')))) {
    if (m[1] === 'start') open = parseFloat(m[2]);
    else if (m[1] === 'end' && open != null) { out.push([Math.max(0, open), parseFloat(m[2])]); open = null; }
  }
  return out;
}

// Given a clip [start,end] (absolute source time) and its internal silences (SAME timebase, absolute
// source time), return the KEEP spans + stats. A `pad` leaves a beat of silence at each cut so speech
// doesn't sound clipped — the cut lands inside the pause, not on the word.
export function tightenClip(clip, silences, { minSilence = 0.4, pad = 0.12 } = {}) {
  const s = Number(clip && clip.start), e = Number(clip && clip.end);
  const empty = { segments: [], removedSec: 0, cuts: 0, origSec: 0, tightSec: 0 };
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return empty;

  // Clamp silences to the clip, keep only those still >= minSilence, then shrink by `pad` per side.
  const cuts = [];
  for (const x of (silences || [])) {
    const a = Math.max(s, Array.isArray(x) ? x[0] : x.start);
    const b = Math.min(e, Array.isArray(x) ? x[1] : x.end);
    if (b - a < minSilence) continue;
    const ca = a + pad, cb = b - pad;
    if (cb - ca > 0.05) cuts.push([ca, cb]);
  }
  cuts.sort((a, b) => a[0] - b[0]);

  // Complement of the cuts within [s,e] = the kept spans.
  const segments = [];
  let cur = s;
  for (const [a, b] of cuts) {
    if (a > cur + 0.05) segments.push({ start: +cur.toFixed(3), end: +a.toFixed(3) });
    cur = Math.max(cur, b);
  }
  if (e > cur + 0.05) segments.push({ start: +cur.toFixed(3), end: +e.toFixed(3) });

  const origSec = e - s;
  const tightSec = segments.reduce((n, g) => n + (g.end - g.start), 0);
  return {
    segments,
    cuts: cuts.length,
    origSec: +origSec.toFixed(2),
    tightSec: +tightSec.toFixed(2),
    removedSec: +(origSec - tightSec).toFixed(2),
  };
}
