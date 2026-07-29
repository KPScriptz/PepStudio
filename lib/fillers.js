// Filler-word purge — find the "um / uh / like / you know" beats inside a clip and cut just
// those, leaving the speech either side intact. Pure (no I/O): the caller transcribes the clip
// (whisper word timestamps) and hands the words here; this returns the KEEP sub-segments, in the
// same shape lib/pacing.js emits, so both feed the existing sequence export unchanged.
//
// Deliberately conservative: a false positive deletes real speech, which is far worse than
// leaving an "um" in. Hence single-word fillers only fire when they stand ALONE in their
// timestamp (whisper often groups several words into one), and the ambiguous ones ("like",
// "so", "right") are opt-in rather than default.

// Always-on: these are filler in essentially every context.
export const CORE_FILLERS = ['um', 'uh', 'umm', 'uhh', 'erm', 'hmm', 'mmm', 'ah', 'eh'];
// Opt-in (`aggressive`): real words that are USUALLY filler in gameplay commentary but carry
// meaning often enough that purging them by default would eat real speech.
export const SOFT_FILLERS = ['like', 'so', 'basically', 'literally', 'actually', 'right'];
// Multi-word phrases, matched across consecutive word entries.
export const FILLER_PHRASES = [['you', 'know'], ['i', 'mean'], ['kind', 'of'], ['sort', 'of']];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z']/g, '');

// Find filler spans in a word list. `words` is [{t0,t1,w}] in ABSOLUTE source time (what
// transcribeWindows/transcribeRange return). Returns [{t0,t1,w}] sorted, non-overlapping.
export function detectFillers(words, { aggressive = false, phrases = true } = {}) {
  const list = (words || [])
    .map((x) => ({ t0: Number(x.t0), t1: Number(x.t1), raw: String(x.w || '') }))
    .filter((x) => Number.isFinite(x.t0) && Number.isFinite(x.t1) && x.t1 > x.t0);

  const single = new Set(aggressive ? [...CORE_FILLERS, ...SOFT_FILLERS] : CORE_FILLERS);
  const hits = [];
  const used = new Set();

  // Phrases first (longest match wins), so "you know" isn't half-eaten by a later single pass.
  if (phrases) {
    for (let i = 0; i < list.length; i++) {
      for (const ph of FILLER_PHRASES) {
        if (i + ph.length > list.length) continue;
        // Only match when each entry is exactly one word of the phrase — a grouped entry like
        // "you know what I mean" is a sentence, not a filler beat.
        const ok = ph.every((w, k) => norm(list[i + k].raw) === w && !used.has(i + k));
        if (!ok) continue;
        hits.push({ t0: list[i].t0, t1: list[i + ph.length - 1].t1, w: ph.join(' ') });
        for (let k = 0; k < ph.length; k++) used.add(i + k);
        break;
      }
    }
  }

  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const n = norm(list[i].raw);
    // The entry must BE the filler word, not merely contain it.
    if (!n || !single.has(n)) continue;
    if (list[i].raw.trim().split(/\s+/).length !== 1) continue;
    hits.push({ t0: list[i].t0, t1: list[i].t1, w: n });
  }

  hits.sort((a, b) => a.t0 - b.t0);
  // Merge any overlap so the cut list stays clean.
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.t0 <= last.t1) { last.t1 = Math.max(last.t1, h.t1); last.w += ` ${h.w}`; }
    else merged.push({ ...h });
  }
  return merged;
}

// Given a clip [start,end] and its filler hits (absolute source time), return the KEEP spans +
// stats — same contract as pacing.tightenClip. `pad` shrinks each cut so the removal lands inside
// the filler rather than clipping the word either side; `minCut` skips removals too short to be
// worth a splice (each cut costs a keyframe boundary and risks an audible seam).
export function stripFillers(clip, hits, { pad = 0.04, minCut = 0.12 } = {}) {
  const s = Number(clip && clip.start), e = Number(clip && clip.end);
  const empty = { segments: [], removedSec: 0, cuts: 0, origSec: 0, tightSec: 0, words: [] };
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return empty;

  const cuts = [];
  const kept = [];
  for (const h of (hits || [])) {
    const a = Math.max(s, Number(h.t0)), b = Math.min(e, Number(h.t1));
    if (!(b > a)) continue;
    const ca = a + pad, cb = b - pad;
    if (cb - ca < minCut) continue;
    cuts.push([ca, cb]);
    kept.push(h.w);
  }
  cuts.sort((a, b) => a[0] - b[0]);

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
    words: kept,
    origSec: +origSec.toFixed(2),
    tightSec: +tightSec.toFixed(2),
    removedSec: +(origSec - tightSec).toFixed(2),
  };
}
