// Snap engine — tighten a clip to the reaction beat. Trims the dead-air runway before the
// setup and the trailing silence after the payoff, so every exported short opens on the
// moment and closes clean. Anchors on lexicon reaction spans (multiword/laughter-aware via
// reactions.reactionSpans); falls back to the audio-energy peak `t`; falls back to the
// original window if neither exists. ms-rounded, consistent with the float-drift fix.
import { reactionSpans } from './reactions.js';

// Nudge a cut point into the nearest silence gap so clips never start/end mid-syllable.
// `active` is the analyzer's [[s,e]] pairs of ACTIVE (speech) blocks; the gaps between them
// are the quiet zones. Only snaps if a gap center is within `radius` of the target.
// A clip head snaps to where speech resumes (gapEnd); a tail snaps to where speech ends (gapStart).
function snapToSilenceGap(targetTime, active = [], radius = 0.5, position = 'start') {
  if (!Array.isArray(active) || active.length < 2) return targetTime;
  let best = targetTime;
  let minDist = radius;
  for (let i = 0; i < active.length - 1; i++) {
    const gapStart = active[i][1];        // end of active block i
    const gapEnd = active[i + 1][0];      // start of active block i+1
    if (gapEnd <= gapStart) continue;
    const dist = Math.abs(targetTime - (gapStart + (gapEnd - gapStart) / 2));
    if (dist < minDist) {
      minDist = dist;
      best = position === 'start' ? gapEnd : gapStart;
    }
  }
  return best;
}

export function tightBounds(words, win, opts = {}) {
  const { leadIn = 1.2, tailOut = 2.2, minLen = 4, maxLen = 40, active = [] } = opts;
  const lo = Math.min(win.start, win.end);
  const hi = Math.max(win.start, win.end);
  const clamp = (v) => Math.max(lo, Math.min(hi, v));

  let anchorStart = null;
  let anchorEnd = null;

  const spans = reactionSpans(words);
  if (spans.length) {
    anchorStart = spans[0].t0;
    anchorEnd = spans[spans.length - 1].t1;
  } else if (Number.isFinite(win.t)) {
    anchorStart = win.t;            // no lexicon hit (e.g. a wordless scream) — snap to the peak
    anchorEnd = win.t;
  } else {
    return { start: +lo.toFixed(3), end: +hi.toFixed(3), snapped: false };
  }

  let start = clamp(anchorStart - leadIn);
  let end = clamp(anchorEnd + tailOut);

  // Snap each boundary into a nearby silence gap (within 0.5s) so we cut cleanly on a pause.
  start = clamp(snapToSilenceGap(start, active, 0.5, 'start'));
  end = clamp(snapToSilenceGap(end, active, 0.5, 'end'));

  // Don't produce a stub; grow symmetrically toward minLen, then cap at maxLen.
  if (end - start < minLen) {
    const mid = (start + end) / 2;
    start = clamp(mid - minLen / 2);
    end = clamp(mid + minLen / 2);
  }
  if (end - start > maxLen) end = clamp(start + maxLen);

  return { start: +start.toFixed(3), end: +end.toFixed(3), snapped: true };
}
