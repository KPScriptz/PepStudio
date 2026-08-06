// lib/critic.js — the deterministic retention auditor.
//
// A pure pass/fail review of a cut map BEFORE it reaches ffmpeg. Deliberately NOT an LLM: every
// rule here is a measurement over data the app already has (whisper word timestamps, clip
// boundaries, zoom/overlay/SFX hits, detected silences), so it costs no tokens, adds no latency,
// and returns the same verdict every time. An LLM critic can't beat a stopwatch at counting
// seconds — and a non-deterministic gate on every render would be its own bug source.
//
// Everything is measured in OUTPUT time (what a viewer experiences), not source time. That's the
// whole point: retention is about the finished video's timeline, so a 40-minute gap in the source
// between two adjacent kept clips is not a dead spot — it doesn't exist for the viewer.
//
// No I/O, no ffmpeg, no DOM.

// Defaults are the published retention heuristics, all overridable per call.
export const CRITIC_DEFAULTS = {
  minWordsPerSec: 2.5,      // sustained speech density floor
  densityWindowSec: 3,      // ...measured over a window at least this long
  maxInterruptGapSec: 15,   // longest stretch allowed with no cut/zoom/overlay/SFX
  maxDeadAirSec: 0.5,       // un-purged silence inside a kept clip
  hookEnergySec: 15,        // the cold open must earn attention within this
};

const round = (n) => +(+n || 0).toFixed(2);

// Map a source-time instant onto the output timeline built by concatenating `clips` in order.
// Returns null when the instant isn't inside any kept clip (it was cut, so the viewer never sees it).
export function toOutputTime(sourceSec, clips) {
  let acc = 0;
  for (const c of clips) {
    const dur = c.end - c.start;
    if (sourceSec >= c.start && sourceSec <= c.end) return round(acc + (sourceSec - c.start));
    acc += dur;
  }
  return null;
}

// Total runtime of the assembled cut.
export function outputDuration(clips) {
  return round((clips || []).reduce((n, c) => n + Math.max(0, c.end - c.start), 0));
}

/**
 * Audit a cut map.
 *
 * @param {object} cut
 *   clips     [{id,start,end,overlays?,zooms?,sfx?}]  absolute SOURCE ranges, in output order
 *   words     [{t0,t1,w}]        absolute source times (whisper)
 *   silences  [[start,end], ...] absolute source ranges of detected silence
 *   hook      {start,end}        optional prepended cold open
 * @param {object} opts  overrides for CRITIC_DEFAULTS
 * @returns {{pass:boolean, score:number, issues:Array, stats:object}}
 */
export function auditCut(cut = {}, opts = {}) {
  const cfg = { ...CRITIC_DEFAULTS, ...opts };
  const clips = (cut.clips || []).filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  const issues = [];

  if (!clips.length) {
    return {
      pass: false, score: 0,
      issues: [{ type: 'empty_sequence', severity: 'fail', atSec: 0, detail: 'No clips in the cut map.', fix: 'Keep at least one moment before rendering.' }],
      stats: { outputSec: 0, clipCount: 0, wordsPerSec: 0, interrupts: 0, deadAirSec: 0 },
    };
  }

  const outSec = outputDuration(clips);
  const words = (cut.words || []).filter((w) => w && Number.isFinite(w.t0) && Number.isFinite(w.t1));

  // ---- Words placed on the OUTPUT timeline (a word inside a cut-away region simply vanishes) ----
  const outWords = [];
  for (const w of words) {
    const t = toOutputTime(w.t0, clips);
    if (t != null) outWords.push(t);
  }
  outWords.sort((a, b) => a - b);

  // ---- 1. Speech density -----------------------------------------------------------------------
  // Slide a window across the output and flag sustained stretches below the floor. Reported as
  // merged spans so one quiet passage is a single issue, not fifty overlapping ones.
  const win = cfg.densityWindowSec;
  const lowSpans = [];
  if (outSec >= win) {
    const step = 0.5;
    for (let t = 0; t + win <= outSec + 1e-9; t += step) {
      const a = t, b = t + win;
      let n = 0;
      for (const wt of outWords) { if (wt >= a && wt < b) n++; else if (wt >= b) break; }
      if (n / win < cfg.minWordsPerSec) {
        const last = lowSpans[lowSpans.length - 1];
        if (last && a <= last.end + 1e-9) last.end = b;   // extend the current quiet stretch
        else lowSpans.push({ start: a, end: b });
      }
    }
  }
  for (const s of lowSpans) {
    const dur = s.end - s.start;
    let n = 0;
    for (const wt of outWords) if (wt >= s.start && wt < s.end) n++;
    issues.push({
      type: 'low_speech_density',
      severity: dur >= win * 3 ? 'fail' : 'warn',
      atSec: round(s.start), endSec: round(s.end),
      detail: `${round(dur)}s at ${round(n / dur)} words/sec (floor ${cfg.minWordsPerSec}).`,
      fix: 'Tighten or drop this stretch, or cover it with a pattern interrupt.',
    });
  }

  // ---- 2. Pattern interrupts -------------------------------------------------------------------
  // Every cut boundary is an interrupt; so is a zoom, an overlay, or an SFX hit. Gaps longer than
  // the threshold are where a viewer's attention drifts.
  const interrupts = [0];
  let acc = 0;
  for (const c of clips) {
    const dur = c.end - c.start;
    for (const z of (c.zooms || [])) {
      const t = Number(z.t ?? z.start);
      if (Number.isFinite(t) && t >= c.start && t <= c.end) interrupts.push(round(acc + (t - c.start)));
    }
    for (const o of (c.overlays || [])) {
      const t = Number(o.startTime ?? o.t);
      if (Number.isFinite(t)) interrupts.push(round(acc + Math.max(0, Math.min(t, dur))));
    }
    for (const s of (c.sfx || [])) {
      const t = Number(s.time ?? s.t);
      if (Number.isFinite(t)) interrupts.push(round(acc + Math.max(0, Math.min(t, dur))));
    }
    acc += dur;
    interrupts.push(round(acc));               // the cut itself
  }
  const uniq = [...new Set(interrupts)].sort((a, b) => a - b);
  for (let i = 1; i < uniq.length; i++) {
    const gap = uniq[i] - uniq[i - 1];
    if (gap > cfg.maxInterruptGapSec) {
      issues.push({
        type: 'no_pattern_interrupt',
        severity: gap > cfg.maxInterruptGapSec * 2 ? 'fail' : 'warn',
        atSec: uniq[i - 1], endSec: uniq[i],
        detail: `${round(gap)}s with no cut, zoom, overlay or SFX (max ${cfg.maxInterruptGapSec}s).`,
        fix: 'Add a jump-zoom, caption pop or SFX hit inside this stretch.',
      });
    }
  }

  // ---- 3. Un-purged dead air -------------------------------------------------------------------
  // Only the part of a silence that actually SURVIVES into a kept clip counts.
  let deadAirSec = 0;
  for (const [ss, se] of (cut.silences || [])) {
    if (!Number.isFinite(ss) || !Number.isFinite(se) || se <= ss) continue;
    for (const c of clips) {
      const a = Math.max(ss, c.start), b = Math.min(se, c.end);
      const dur = b - a;
      if (dur > cfg.maxDeadAirSec) {
        deadAirSec += dur;
        issues.push({
          type: 'dead_air',
          severity: 'warn',
          atSec: toOutputTime(a, clips) ?? 0,
          detail: `${round(dur)}s of silence survived in ${c.id ?? 'a clip'} (max ${cfg.maxDeadAirSec}s).`,
          fix: 'Run the micro-cut pacing pass, or lower the pause floor.',
        });
      }
    }
  }

  // ---- 4. Cold open ----------------------------------------------------------------------------
  // The opening seconds decide whether anyone stays, so they get their own check.
  const hookWords = outWords.filter((t) => t < cfg.hookEnergySec).length;
  const hookInterrupts = uniq.filter((t) => t > 0 && t < cfg.hookEnergySec).length;
  if (outSec >= cfg.hookEnergySec && hookWords / cfg.hookEnergySec < cfg.minWordsPerSec && !hookInterrupts) {
    issues.push({
      type: 'weak_cold_open',
      severity: 'fail',
      atSec: 0, endSec: cfg.hookEnergySec,
      detail: `First ${cfg.hookEnergySec}s has ${round(hookWords / cfg.hookEnergySec)} words/sec and no interrupt.`,
      fix: 'Lead with the highest-energy moment; a cold open cannot be a slow build.',
    });
  }

  const fails = issues.filter((i) => i.severity === 'fail').length;
  const warns = issues.length - fails;
  // Transparent score: fails cost 15, warnings 4, floored at 0.
  const score = Math.max(0, 100 - fails * 15 - warns * 4);

  return {
    pass: fails === 0,
    score,
    issues: issues.sort((a, b) => (a.severity === b.severity ? a.atSec - b.atSec : a.severity === 'fail' ? -1 : 1)),
    stats: {
      outputSec: outSec,
      clipCount: clips.length,
      wordsPerSec: outSec ? round(outWords.length / outSec) : 0,
      interrupts: uniq.length,
      interruptsPerMin: outSec ? round((uniq.length / outSec) * 60) : 0,
      deadAirSec: round(deadAirSec),
      fails, warns,
    },
  };
}
