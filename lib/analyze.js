// Core analysis: loudness envelope, silence/active segments, scene cuts, highlight ranking.
import { ffmpeg, probe, hasAudio } from './ff.js';

const ENV_RATE = 1000;        // Hz we decode audio to for the loudness envelope
const ENV_WIN = 0.25;         // seconds per envelope bucket

// Decode mono low-rate PCM + run silencedetect in a single pass.
// Phantasm engine #1 (audio): quiet below silenceDb for silenceMin seconds => ghost.
async function audioPass(file, { silenceDb = -35, silenceMin = 2.5 } = {}) {
  let stderr = '';
  const { stdout } = await ffmpeg([
    '-nostdin', '-i', file,
    '-map', '0:a:0',
    '-af', `aresample=${ENV_RATE},aformat=sample_fmts=flt:channel_layouts=mono,silencedetect=noise=${silenceDb}dB:d=${silenceMin}`,
    '-ar', String(ENV_RATE), '-ac', '1', '-f', 'f32le', 'pipe:1',
  ], { onStderr: (s) => { stderr += s; } });

  // Build RMS envelope.
  const floats = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
  const per = Math.max(1, Math.round(ENV_RATE * ENV_WIN));
  const env = [];
  for (let i = 0; i < floats.length; i += per) {
    let sum = 0; let n = 0;
    for (let j = i; j < i + per && j < floats.length; j++) { sum += floats[j] * floats[j]; n++; }
    const rms = n ? Math.sqrt(sum / n) : 0;
    env.push({ t: +(i / ENV_RATE).toFixed(3), rms });
  }

  // Parse silencedetect intervals.
  const silences = [];
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let m; let openStart = null;
  while ((m = re.exec(stderr))) {
    if (m[1] === 'start') openStart = parseFloat(m[2]);
    else if (m[1] === 'end' && openStart != null) {
      silences.push([openStart, parseFloat(m[2])]);
      openStart = null;
    }
  }
  return { env, silences };
}

// One downscaled video pass that yields BOTH scene cuts and Phantasm engine #2
// (freeze/static detection: loading screens, lobbies, paused menus held >freezeMin).
async function videoPass(file, duration, { threshold = 0.30, freezeDb = -50, freezeMin = 3 } = {}) {
  let stderr = '';
  await ffmpeg([
    '-nostdin', '-i', file,
    '-filter:v',
    `scale=320:-2,fps=10,freezedetect=n=${freezeDb}dB:d=${freezeMin},select='gt(scene,${threshold})',showinfo`,
    '-an', '-f', 'null', '-',
  ], { onStderr: (s) => { stderr += s; } }).catch(() => {});

  const cuts = [];
  let m;
  const cutRe = /pts_time:([0-9.]+)/g;
  while ((m = cutRe.exec(stderr))) cuts.push(+parseFloat(m[1]).toFixed(2));

  // freezedetect prints freeze_start / freeze_end metadata lines.
  const freezes = [];
  const fRe = /freeze_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let open = null;
  while ((m = fRe.exec(stderr))) {
    if (m[1] === 'start') open = parseFloat(m[2]);
    else if (m[1] === 'end' && open != null) { freezes.push([+open.toFixed(2), +parseFloat(m[2]).toFixed(2)]); open = null; }
  }
  if (open != null) freezes.push([+open.toFixed(2), +duration.toFixed(2)]); // freeze ran to EOF
  return { cuts, freezes };
}

// Merge near-adjacent intervals (gap <= joinGap).
function mergeIntervals(list, joinGap = 0) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + joinGap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// PHANTASM: tag the whole timeline green (keep) / red (ghost) without deleting anything.
// A slice is a ghost if it is silent (audio engine) OR a static screen (video engine).
// Reasons: 'silence' (quiet, moving), 'static' (frozen screen, maybe talking), 'dead' (both).
// `risky` flags a silence-only ghost that still has scene activity — likely a silent stealth play.
export function buildPhantasm(silences, freezes, sceneCuts, duration, { minSeg = 1.5 } = {}) {
  const step = 0.2;
  const n = Math.max(1, Math.ceil(duration / step));
  const sil = new Array(n).fill(false);
  const stat = new Array(n).fill(false);
  const mark = (arr, s, e) => {
    for (let i = Math.max(0, Math.floor(s / step)); i < Math.min(n, Math.ceil(e / step)); i++) arr[i] = true;
  };
  silences.forEach(([s, e]) => mark(sil, s, e));
  freezes.forEach(([s, e]) => mark(stat, s, e));

  // Per-bucket reason. Coalesce contiguous buckets that share a reason, so an
  // adjacent static screen and silent stretch stay as SEPARATE ghosts (each
  // independently keepable — that's how a silent stealth play survives).
  const reasonAt = (i) => (stat[i] && sil[i] ? 'dead' : stat[i] ? 'static' : sil[i] ? 'silence' : 'active');
  const raw = [];
  let i = 0;
  while (i < n) {
    const key = reasonAt(i);
    let j = i;
    while (j < n && reasonAt(j) === key) j++;
    raw.push({
      start: +(i * step).toFixed(2),
      end: +Math.min(duration, j * step).toFixed(2),
      reason: key,
      state: key === 'active' ? 'keep' : 'ghost',
    });
    i = j;
  }

  // Absorb sub-minSeg slivers into the previous segment; merge same-reason neighbours.
  const merged = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (s.end - s.start < minSeg)) { prev.end = s.end; continue; }
    if (prev && prev.reason === s.reason) { prev.end = s.end; continue; }
    merged.push({ ...s });
  }

  return merged.map((s, idx) => ({
    id: `p${idx + 1}`,
    start: s.start,
    end: s.end,
    state: s.state,
    reason: s.reason,
    risky: s.state === 'ghost' && s.reason === 'silence' && sceneCuts.some((c) => c >= s.start && c <= s.end),
  }));
}

// Complement of silence over [0,duration] = "active" (talking / action) segments.
export function activeSegments(silences, duration, pad = 0.25, minLen = 0.8) {
  const segs = [];
  let cur = 0;
  for (const [s, e] of silences) {
    if (s - cur > 0) segs.push([cur, s]);
    cur = e;
  }
  if (cur < duration) segs.push([cur, duration]);
  // Pad inward boundaries a touch and drop tiny slivers.
  return segs
    .map(([s, e]) => [Math.max(0, s - pad), Math.min(duration, e + pad)])
    .filter(([s, e]) => e - s >= minLen)
    .reduce((acc, seg) => { // merge overlaps created by padding
      const last = acc[acc.length - 1];
      if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
      else acc.push(seg);
      return acc;
    }, []);
}

// Rank highlight moments by combining loudness peaks, onset spikes, and scene-cut density.
// `onset` (a sharp loudness rise after a quieter beat) is the tell-tale of a sudden
// laugh / yell / "WHAT just happened" reaction — the funny signal we care about.
function rankHighlights(env, cuts, duration, { count = 8, clip = 30, minGap = 18, idPrefix = 'h' } = {}) {
  if (!env.length) return [];
  const win = ENV_WIN;
  const rmsVals = env.map((e) => e.rms);
  const mean = rmsVals.reduce((a, b) => a + b, 0) / rmsVals.length;
  const sd = Math.sqrt(rmsVals.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsVals.length) || 1e-6;

  // Scene density per envelope bucket (cuts within +/- 2s).
  const sceneDensity = (t) => cuts.reduce((n, c) => n + (Math.abs(c - t) <= 2 ? 1 : 0), 0);

  // Smoothed loudness (~2s) per bucket.
  const smoothN = Math.max(1, Math.round(2 / win));
  const smooth = env.map((_, i) => {
    let s = 0; let k = 0;
    for (let j = i - smoothN; j <= i + smoothN; j++) { if (env[j]) { s += env[j].rms; k++; } }
    return k ? s / k : 0;
  });
  // Onset = how much louder this moment is than ~1.5s earlier (a sudden spike).
  const lag = Math.max(1, Math.round(1.5 / win));
  const scored = env.map((e, i) => {
    const loudZ = (smooth[i] - mean) / sd;
    const onset = Math.max(0, (smooth[i] - smooth[Math.max(0, i - lag)]) / sd);
    return { t: e.t, score: loudZ + 0.5 * onset + 0.6 * sceneDensity(e.t) };
  });

  // Greedy peak picking with a minimum gap.
  const order = [...scored].sort((a, b) => b.score - a.score);
  const picks = [];
  for (const p of order) {
    if (picks.length >= count) break;
    if (picks.some((q) => Math.abs(q.t - p.t) < minGap)) continue;
    picks.push(p);
  }
  picks.sort((a, b) => a.t - b.t);

  return picks.map((p, i) => {
    const half = clip / 2;
    const start = Math.max(0, p.t - half);
    const end = Math.min(duration, start + clip);
    return {
      id: `${idPrefix}${i + 1}`,
      t: +p.t.toFixed(2),
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      score: +p.score.toFixed(2),
      keep: true,
    };
  });
}

function thresholdsFrom(opts) {
  return {
    audioDb: opts.silenceDb ?? -35, audioMin: opts.silenceMin ?? 2.5,
    videoDb: opts.freezeDb ?? -50, videoMin: opts.freezeMin ?? 3,
  };
}

// PHASE 1 — audio-only structure. No video frames are decoded, so this runs at ~100×
// realtime: loudness envelope, silence map, active blocks, and audio-energy highlight +
// candidate ranking (cuts=[] for now). This is everything the funny-moments engine needs,
// so the UI + "Rank funny moments" button unlock immediately. Returns `_env` (the raw
// envelope) for the caller to hand to analyzeVideo; strip it before transport/persist.
export async function analyzeAudio(file, opts = {}) {
  const meta = await probe(file);
  const duration = meta.duration || 0;
  const audio = await hasAudio(file);

  let env = []; let silences = []; let active = [];
  if (audio) {
    const a = await audioPass(file, opts);
    env = a.env; silences = a.silences;
    active = activeSegments(silences, duration);
  } else {
    active = [[0, duration]];
  }

  // Audio-only ranking — no scene cuts yet. The funny gate is energy-based, so these
  // candidates are exactly right; analyzeVideo upgrades `highlights` with scene density later.
  const highlights = audio ? rankHighlights(env, [], duration, opts) : [];
  // Scale the candidate pool with VOD length (~1 per 90s, 24–80) instead of a flat 24 — an 85-min
  // session was getting the same 24 moments as a 10-min clip, leaving the 8-10 min Storyboard Cut
  // no room to SELECT the best. More candidates → real selectivity. (The rank's energy gate + audio
  // budget still bound how many get transcribed, so this doesn't blow up cost.)
  const candCount = Math.min(80, Math.max(24, Math.round(duration / 90)));
  const candidates = audio
    ? rankHighlights(env, [], duration, { count: candCount, clip: 24, minGap: 12, idPrefix: 'c' })
    : [];

  // Down-sample envelope for transport (cap ~2000 points).
  const step = Math.max(1, Math.ceil(env.length / 2000));
  const envOut = env.filter((_, i) => i % step === 0);
  const maxRms = envOut.reduce((m, e) => Math.max(m, e.rms), 0) || 1;

  // PRELIMINARY Phantasm from audio only — silence ghosts, no static/risky yet (those need the
  // phase-2 video decode). The client renders `phantasm` on load (loadProject → draw), so this
  // paints the dead-air timeline in ~13s instead of waiting the ~2min full video scan; phase 2
  // then refines it in place (adds static-screen ghosts + risky-stealth flags via analyzeVideo).
  const prelimPhantasm = audio ? buildPhantasm(silences, [], [], duration, opts) : [];
  const prelimGhosts = prelimPhantasm.filter((s) => s.state === 'ghost');
  const prelimGhostDur = prelimGhosts.reduce((a, s) => a + (s.end - s.start), 0);

  return {
    meta: { ...meta, hasAudio: audio },
    duration,
    envelope: envOut.map((e) => ({ t: e.t, v: +(e.rms / maxRms).toFixed(3) })),
    silences,
    active,
    highlights,
    candidates,
    // Scene cuts / static screens still need phase 2; the phantasm below is the audio-only
    // preliminary, refined in place when videoReady flips.
    sceneCuts: [],
    freezes: [],
    phantasm: prelimPhantasm,
    phantasmStats: {
      ghostCount: prelimGhosts.length,
      ghostDuration: +prelimGhostDur.toFixed(1),
      cutDuration: +(duration - prelimGhostDur).toFixed(1),
      riskyCount: 0,
      thresholds: thresholdsFrom(opts),
      preliminary: true,
    },
    audioReady: true,
    videoReady: false,
    _env: env,
  };
}

// PHASE 2 — video structure + Phantasm. Decodes frames (the slow part), so it runs lazily
// in the background. Needs the raw env + silences from phase 1 to upgrade highlight ranking
// (scene density) and build the green/red dead-air cut.
export async function analyzeVideo(file, duration, env, silences, opts = {}) {
  const { cuts, freezes } = await videoPass(file, duration, opts);
  const highlights = env.length ? rankHighlights(env, cuts, duration, opts) : [];
  const phantasm = buildPhantasm(silences, freezes, cuts, duration, opts);

  const ghosts = phantasm.filter((s) => s.state === 'ghost');
  const ghostDuration = ghosts.reduce((a, s) => a + (s.end - s.start), 0);

  return {
    sceneCuts: cuts,
    freezes,
    highlights,
    phantasm,
    phantasmStats: {
      ghostCount: ghosts.length,
      ghostDuration: +ghostDuration.toFixed(1),
      cutDuration: +(duration - ghostDuration).toFixed(1),
      riskyCount: ghosts.filter((s) => s.risky).length,
      thresholds: thresholdsFrom(opts),
    },
    audioReady: true,
    videoReady: true,
  };
}

// Combined full analysis (back-compat for callers that want one blocking result, e.g. the
// URL-import job). Equivalent to phase 1 + phase 2.
export async function analyze(file, opts = {}) {
  const a = await analyzeAudio(file, opts);
  const v = await analyzeVideo(file, a.duration, a._env, a.silences, opts);
  delete a._env;
  return { ...a, ...v };
}
