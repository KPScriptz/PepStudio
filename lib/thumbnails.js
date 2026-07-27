// Thumbnail cover selection — pick the frame timestamps most likely to make a great cover. A strong
// thumbnail lands on the PEAK: the loudest reaction or the moment of impact, not a random frame. Pure
// (no I/O) so it's unit-testable; the caller (grabFrame) renders the actual stills at these times.
//   clip: { start, end, t? }  ·  envelope: [{ t, v(0..1) }]  ·  sceneCuts: [t, ...]

// Ranked candidate cover-frame times for one clip. Offers: the clip's reaction peak (`t`, where the
// funny/impact lands), the loudest audio frame in the window, and the scene cut nearest the middle
// (a clean visual "hit"), plus an early-frame fallback. Deduped within 0.4s, clamped inside the clip,
// best-first. Returns [{ t, label }].
export function coverCandidates(clip, { envelope = [], sceneCuts = [], count = 3 } = {}) {
  const s = Number(clip && clip.start), e = Number(clip && clip.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  const clamp = (t) => Math.min(e, Math.max(s, t));
  const cands = [];

  // 1. reaction peak — where the moment actually lands.
  if (Number.isFinite(clip.t) && clip.t >= s && clip.t <= e) cands.push({ t: +clip.t.toFixed(2), label: 'Reaction peak' });
  // 2. loudest audio frame in the window (scream / impact).
  const win = envelope.filter((p) => p && p.t >= s && p.t <= e);
  if (win.length) {
    const loud = win.reduce((m, p) => ((p.v || 0) > (m.v || 0) ? p : m), win[0]);
    cands.push({ t: +(+loud.t).toFixed(2), label: 'Loudest moment' });
  }
  // 3. scene cut nearest the clip's midpoint — a clean, composed frame.
  const mid = (s + e) / 2;
  const cutsIn = sceneCuts.filter((t) => t >= s && t <= e).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  if (cutsIn.length) cands.push({ t: +cutsIn[0].toFixed(2), label: 'Scene change' });
  // 4. fallback: a frame a third of the way in (past any lead-in).
  cands.push({ t: +clamp(s + Math.min(2, (e - s) / 3)).toFixed(2), label: 'Early frame' });

  // dedupe within 0.4s, preserve best-first order.
  const out = [];
  for (const c of cands) {
    if (out.some((o) => Math.abs(o.t - c.t) < 0.4)) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}
