// lib/retentionCsv.js — turn a YouTube Studio retention export into bounded editorial feedback.
//
// This is the missing half of the flywheel. The learning machinery already exists and is tested:
// data/feedback.jsonl (the corpus), lib/feedbackConsumer.js (bounded, clamped, idempotent knob
// nudges) and lib/trainer.js (daily convergence). All that was missing was a signal source other
// than the human tapping correction chips. This adapter supplies it — real viewers leaving at real
// timestamps — WITHOUT inventing a new schema or a new learning path.
//
// Two deliberate constraints:
//
//  1. It emits ONLY the existing four reasons, so every update still flows through the clamped
//     consumer. No free-form rules, no new knobs, no way for a bad CSV to move anything unbounded.
//
//  2. It never emits MISSED_SETUP. That reason EASES the hook penalty (letting quieter openers
//     survive), so firing it on a cold-open cliff would make hooks progressively worse — the exact
//     opposite of what the data is saying. "Viewers left" does not tell us they lacked context, so
//     that inference isn't available from a curve and we don't fake it.
//
// Attribution is evidence-based rather than guessed: each cliff is matched against what the
// deterministic critic already found at that OUTPUT timestamp.
//
// Pure — no I/O here. The caller writes the rows.

const num = (s) => {
  const v = parseFloat(String(s).replace(/[%"\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

// Split a CSV line honouring quoted fields (YouTube quotes any header containing a comma).
function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a YouTube Studio audience-retention export.
 *
 * Studio's column names vary by locale and export vintage ("Video position (%)",
 * "Elapsed video time", "Absolute audience retention (%)"), so columns are detected by keyword and
 * fall back to "first two numeric columns" rather than failing on an unrecognised header.
 *
 * Position may be a PERCENTAGE of the video or elapsed SECONDS; pass videoSec to normalise
 * percentages into seconds.
 *
 * @returns {{points: Array<{sec:number, pct:number}>, positionUnit: 'percent'|'seconds', rows:number}}
 */
export function parseRetentionCsv(text, { videoSec = 0 } = {}) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { points: [], positionUnit: 'seconds', rows: 0 };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const headerIsText = header.some((h) => /[a-z]/.test(h));
  const find = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));

  let posIdx = headerIsText ? find('position', 'elapsed', 'time', 'duration') : 0;
  let pctIdx = headerIsText ? find('retention', 'watched', 'audience', 'percentage') : 1;

  const body = headerIsText ? lines.slice(1) : lines;
  // Unknown header → fall back to the first two numeric columns of the first data row.
  if (posIdx < 0 || pctIdx < 0) {
    const first = splitCsvLine(body[0] || '');
    const numeric = first.map((c, i) => (num(c) != null ? i : -1)).filter((i) => i >= 0);
    posIdx = posIdx < 0 ? (numeric[0] ?? 0) : posIdx;
    pctIdx = pctIdx < 0 ? (numeric[1] ?? 1) : pctIdx;
  }

  const raw = [];
  for (const line of body) {
    const cells = splitCsvLine(line);
    const p = num(cells[posIdx]);
    const r = num(cells[pctIdx]);
    if (p == null || r == null) continue;          // skip totals/blank/annotation rows
    raw.push({ pos: p, pct: r });
  }
  if (!raw.length) return { points: [], positionUnit: 'seconds', rows: 0 };

  // Percentage positions never exceed 100 and Studio always emits a 0 row; seconds on a real video
  // run past 100 unless the video is under 100s, so require BOTH signals before assuming percent.
  const maxPos = Math.max(...raw.map((r) => r.pos));
  const isPercent = maxPos <= 100 && (videoSec > 100 || raw.length > 50);
  const points = raw
    .map((r) => ({
      sec: isPercent && videoSec > 0 ? +((r.pos / 100) * videoSec).toFixed(2) : +r.pos.toFixed(2),
      pct: r.pct,
    }))
    .sort((a, b) => a.sec - b.sec);

  return { points, positionUnit: isPercent ? 'percent' : 'seconds', rows: points.length };
}

/**
 * Find drop-off cliffs: retention falling more than `dropPct` within `windowSec`.
 * Overlapping cliffs are merged and reported at their steepest point.
 */
export function findCliffs(points, { dropPct = 5, windowSec = 10 } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p.sec) && Number.isFinite(p.pct));
  if (pts.length < 2) return [];
  const cliffs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    let worst = null;
    for (let j = i + 1; j < pts.length && pts[j].sec - a.sec <= windowSec; j++) {
      const drop = a.pct - pts[j].pct;
      if (drop >= dropPct && (!worst || drop > worst.drop)) {
        worst = { drop: +drop.toFixed(2), start: a.sec, end: pts[j].sec };
      }
    }
    if (worst) {
      const last = cliffs[cliffs.length - 1];
      if (last && worst.start <= last.end) {
        // Overlapping window — keep whichever loses more viewers.
        if (worst.drop > last.drop) { last.drop = worst.drop; last.start = worst.start; last.end = worst.end; }
      } else cliffs.push(worst);
    }
  }
  return cliffs.map((c) => ({ ...c, atSec: c.start }));
}

// Which clip was on screen at an OUTPUT timestamp. `clips` are the absolute source ranges that were
// exported, in order — the same manifest the render used.
export function clipAtOutputTime(outSec, clips) {
  let acc = 0;
  for (const c of clips || []) {
    const dur = c.end - c.start;
    if (outSec >= acc && outSec < acc + dur) {
      return { clip: c, offsetInClip: +(outSec - acc).toFixed(2), clipStartOut: +acc.toFixed(2), clipEndOut: +(acc + dur).toFixed(2) };
    }
    acc += dur;
  }
  return null;
}

// Attribute a cliff to one of the consumer's existing reasons, using the critic's findings as
// evidence. Returns null when nothing explains it — an unexplained cliff must NOT become a random
// knob nudge, because a wrong signal is worse than no signal.
export function attributeCliff(cliff, { clips = [], criticIssues = [], boundaryTolSec = 1.5 } = {}) {
  const hit = clipAtOutputTime(cliff.atSec, clips);

  // A cliff landing on a cut boundary reads as a jarring edit, not boring content.
  if (hit && (cliff.atSec - hit.clipStartOut <= boundaryTolSec || hit.clipEndOut - cliff.atSec <= boundaryTolSec)) {
    return { reason: 'BAD_TIMING', evidence: 'cliff lands on a cut boundary' };
  }
  const covering = (criticIssues || []).filter((i) => {
    const a = Number(i.atSec), b = Number(i.endSec ?? i.atSec);
    return Number.isFinite(a) && cliff.atSec >= a - 0.01 && cliff.atSec <= Math.max(b, a) + 0.01;
  });
  if (covering.some((i) => i.type === 'dead_air' || i.type === 'low_speech_density')) {
    return { reason: 'BORING_FILLER', evidence: covering.find((i) => i.type === 'dead_air' || i.type === 'low_speech_density').type };
  }
  if (covering.some((i) => i.type === 'no_pattern_interrupt')) {
    return { reason: 'PACING', evidence: 'no_pattern_interrupt' };
  }
  return null;
}

/**
 * Build feedback rows for the EXISTING consumer.
 *
 * `maxRows` caps how hard one video can push the weights. The consumer scales each knob by the
 * number of rows, so an unbounded dump from a single upload could swing the ranker on one data
 * point. Strongest cliffs win the budget.
 */
export function buildFeedbackRows(cliffs, { projectId, videoId = null, clips = [], criticIssues = [], maxRows = 12 } = {}) {
  const scored = [...(cliffs || [])].sort((a, b) => b.drop - a.drop);
  const rows = [];
  const skipped = [];
  for (const c of scored) {
    if (rows.length >= maxRows) { skipped.push({ atSec: c.atSec, why: 'row budget reached' }); continue; }
    const att = attributeCliff(c, { clips, criticIssues });
    if (!att) { skipped.push({ atSec: c.atSec, why: 'no evidence — not guessed' }); continue; }
    const hit = clipAtOutputTime(c.atSec, clips);
    rows.push({
      action: 'human_correction',           // the schema the consumer already reads
      projectId,
      source: 'youtube_retention',          // provenance, ignored by the consumer
      detail: {
        reason: att.reason,
        evidence: att.evidence,
        videoId,
        outSec: c.atSec,
        dropPct: c.drop,
        clipId: hit ? (hit.clip.id ?? null) : null,
      },
    });
  }
  return { rows, skipped, considered: scored.length };
}
