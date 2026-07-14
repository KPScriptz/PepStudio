// ClipForge server: analyze, stream, render. All local, all free.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

import { analyze, analyzeAudio, analyzeVideo } from './lib/analyze.js';
import { exportLongCut, exportShort, grabFrame, canBurnCaptions, exportSequence } from './lib/exporter.js';
import { generateCaptions, generateCutCaptions, captionsReady, transcribeRange, transcribeWindows, emphasisChunks, whisperFastModel } from './lib/captions.js';
import { scoreWindow } from './lib/reactions.js';
import { heuristicMeta } from './lib/titles.js';
import { pepaiReady, generateClipMeta, chatWithPepAI } from './lib/pepai.js';
import { tightBounds } from './lib/trim.js';
import { buildTimelineZoomExpression } from './lib/zooms.js';
import { hookPenalty, pacingTag, triggerBoost } from './lib/retention.js';
import { downloadUrl, probeUrl, ytdlpBin, SUPPORTED_URL } from './lib/fetch.js';
import { buildEDL, buildFcp7Xml } from './lib/interchange.js';
import { probe } from './lib/ff.js';
import { ocrAvailable } from './lib/ocr.js';
import { analyzeNBA } from './lib/nba2k.js';
import { analyzePalworld } from './lib/palworld.js';
import { applyGameEvents } from './lib/gameEvents.js';
import { selectStoryboard } from './lib/storyboard.js';
import { consumeFeedback } from './lib/feedbackConsumer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Writable dirs — overridable so the Electron app can point them at userData
// (the app bundle itself is read-only when packaged).
const DATA = process.env.CLIPFORGE_DATA || path.join(__dirname, 'data');
const RENDERS = process.env.CLIPFORGE_RENDERS || path.join(__dirname, 'renders');
const DOWNLOADS = process.env.CLIPFORGE_DOWNLOADS || path.join(__dirname, 'downloads');
await fsp.mkdir(DATA, { recursive: true });
await fsp.mkdir(RENDERS, { recursive: true });
await fsp.mkdir(DOWNLOADS, { recursive: true });

// Pack render concurrency. Each clip runs an independent whisper→zoom→encode pipeline; running
// them all at once on a 6-perf-core Mac oversubscribes the CPU and thrashes. A small pool keeps
// every core busy without context-switch churn — measured sweet spot is ~3 (see CLAUDE.md).
const PACK_CONCURRENCY = Math.max(1, Number(process.env.PEP_PACK_CONCURRENCY) || 3);

// Hard ceiling on how many clips/segments/frames one export request may enqueue. Without it a
// single body (8MB limit = thousands of tiny clip objects) could spawn thousands of ffmpeg/whisper
// pipelines, run for hours, and fill the disk. No real project exceeds this.
const MAX_BATCH = Math.max(1, Number(process.env.PEP_MAX_BATCH) || 200);
const capBatch = (arr) => (Array.isArray(arr) ? arr.slice(0, MAX_BATCH) : []);

// Run async `fn` over `items` with at most `limit` in flight; results keep input order.
// Rejections propagate (Promise.all semantics) so a failed clip still surfaces its error.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// A standing concurrency gate for AD-HOC async work (not a fixed array). Used to bound the
// on-demand `/api/thumb` frame grabs: the timeline fires a burst of them on load, each a cold
// ffmpeg spawn — without a cap, a big project's filmstrip could launch dozens at once and thrash.
function makeGate(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || !queue.length) return;
    active++;
    const run = queue.shift();
    run();
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); }));
    pump();
  });
}
const thumbGate = makeGate(Math.max(2, PACK_CONCURRENCY));

// Coerce + validate a clip's [start, end] before it reaches ffmpeg. Returns a clamped [s, e] or
// null when unusable (NaN/Infinity, or shorter than a frame or two) — callers skip null clips
// instead of spawning ffmpeg on garbage, which otherwise emits a broken file or hangs.
function cleanRange(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const a = Math.max(0, s);
  if (e - a < 0.05) return null;
  return [a, e];
}

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDERS));

// Refuse an export up front when the render volume is nearly full, rather than filling the disk
// and failing mid-encode with a cryptic ffmpeg error. Scoped to /api/export/* so it guards every
// render route in one place. PEP_MIN_FREE_GB overrides (default 2GB); statfs failure never blocks.
const MIN_FREE_GB = Math.max(0, Number(process.env.PEP_MIN_FREE_GB) || 2);
app.use('/api/export', async (req, res, next) => {
  try {
    const st = await fsp.statfs(RENDERS);
    const freeGB = (st.bsize * st.bavail) / 1e9;
    if (freeGB < MIN_FREE_GB) {
      return res.status(507).json({ error: `Low disk space: ${freeGB.toFixed(1)}GB free, need ${MIN_FREE_GB}GB. Free up space and retry.` });
    }
  } catch { /* statfs unsupported/unreadable — don't block the render on a check we can't make */ }
  next();
});

// id <-> source path registry (kept in memory + persisted per project)
const sources = new Map();
const idFor = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 12);

async function rememberSource(id, srcPath) {
  sources.set(id, srcPath);
  await fsp.mkdir(path.join(DATA, id), { recursive: true });
  await fsp.writeFile(path.join(DATA, id, 'source.txt'), srcPath, 'utf8');
}
async function sourceFor(id) {
  if (sources.has(id)) return sources.get(id);
  try {
    const p = (await fsp.readFile(path.join(DATA, id, 'source.txt'), 'utf8')).trim();
    sources.set(id, p);
    return p;
  } catch { return null; }
}

const tildeExpand = (p) => (p && p.startsWith('~') ? path.join(process.env.HOME, p.slice(1)) : p);

app.get('/api/status', async (req, res) => {
  const cap = captionsReady();
  const pep = await pepaiReady();
  res.json({
    captions: { ready: !!(cap.bin && cap.model), bin: cap.bin, model: cap.model },
    canBurn: await canBurnCaptions(),
    canDownload: !!ytdlpBin(),
    pepai: { ready: pep.ready, model: pep.model || null },
  });
});

// ---- Editorial feedback recorder: append every real human edit decision to a local
// JSONL corpus (data/feedback.jsonl). This is the SUBSTRATE for supervised learning from
// real editorial decisions — it collects; a model that trains on it is the next milestone.
app.post('/api/feedback', async (req, res) => {
  try {
    const { action, projectId, detail } = req.body || {};
    if (!action || typeof action !== 'string') return res.status(400).json({ error: 'action required' });
    const rec = { t: Date.now(), projectId: projectId || null, action, detail: (detail && typeof detail === 'object') ? detail : {} };
    await fsp.appendFile(path.join(DATA, 'feedback.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Count of recorded decisions (for the UI's "N decisions recorded" indicator).
app.get('/api/feedback/count', async (req, res) => {
  try {
    const txt = await fsp.readFile(path.join(DATA, 'feedback.jsonl'), 'utf8').catch(() => '');
    res.json({ count: txt ? txt.trimEnd().split('\n').filter(Boolean).length : 0 });
  } catch { res.json({ count: 0 }); }
});

// Consume accumulated correction chips → nudge the live ranking weights (gaming_heuristics.json).
// The "learning half": turns tapped feedback into behavior. Idempotent (cursor), bounded, clamped.
app.post('/api/feedback/apply', (req, res) => {
  try {
    res.json(consumeFeedback({
      feedbackPath: path.join(DATA, 'feedback.jsonl'),
      heuristicsPath: path.join(DATA, 'gaming_heuristics.json'),
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Import a VOD from a URL (YouTube / Twitch). Long-running → job + polling. ----
const jobs = new Map(); // jobId -> { status, progress, stage, error, project }

// Evict the oldest finished jobs once the map grows past a cap. Map preserves insertion order, so
// the first still-terminal entries are the oldest — drop those (each `done` job also pins a full
// analysis object, so this is a real memory bound, not just housekeeping).
function pruneJobs(max = 50) {
  if (jobs.size <= max) return;
  for (const [id, j] of jobs) {
    if (jobs.size <= max) break;
    if (j.status === 'done' || j.status === 'error') jobs.delete(id);
  }
}

app.post('/api/import-url', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a YouTube or Twitch link.' });
  if (!ytdlpBin()) return res.status(500).json({ error: 'yt-dlp not installed. Run: brew install yt-dlp' });
  if (!SUPPORTED_URL.test(url)) return res.status(400).json({ error: 'Only YouTube and Twitch links are supported.' });

  pruneJobs();
  const jobId = crypto.randomBytes(6).toString('hex');
  jobs.set(jobId, { status: 'downloading', progress: 0, stage: 'starting' });
  res.json({ jobId });

  (async () => {
    const job = jobs.get(jobId);
    try {
      const meta = await probeUrl(url).catch(() => null);
      if (meta?.title) job.title = meta.title;
      const file = await downloadUrl(url, DOWNLOADS, {
        base: jobId,
        onProgress: (p) => { job.progress = p; },
        onStage: (s) => { job.stage = s; },
      });
      job.status = 'analyzing'; job.stage = 'analyzing'; job.progress = 100;
      const id = idFor(file);
      await rememberSource(id, file);
      const result = await analyze(file, req.body.opts || {});
      result.id = id;
      result.name = meta?.title ? meta.title : path.basename(file);
      result.sourceUrl = url;
      await fsp.writeFile(path.join(DATA, id, 'analysis.json'), JSON.stringify(result), 'utf8');
      job.status = 'done'; job.project = result;
    } catch (e) {
      job.status = 'error'; job.error = String(e.message || e);
    }
  })();
});

app.get('/api/import-url/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  const { project, ...rest } = job;
  res.json(job.status === 'done' ? { ...rest, project } : rest);
});

app.post('/api/analyze', async (req, res) => {
  try {
    let file = tildeExpand((req.body.path || '').trim());
    if (!file) return res.status(400).json({ error: 'Provide a path to a video file.' });
    if (!fs.existsSync(file)) return res.status(404).json({ error: `File not found: ${file}` });
    const id = idFor(file);
    await rememberSource(id, file);
    const opts = req.body.opts || {};
    const analysisPath = path.join(DATA, id, 'analysis.json');

    // PHASE 1 — audio-only structure. Fast: respond immediately so the timeline renders
    // and "Rank funny moments" is interactive while phase 2 is still decoding frames.
    const a = await analyzeAudio(file, opts);
    const env = a._env; delete a._env;
    a.id = id;
    a.name = path.basename(file);
    await fsp.writeFile(analysisPath, JSON.stringify(a), 'utf8');
    res.json(a);

    // PHASE 2 — video + Phantasm. Un-awaited: decodes frames in the background, then merges
    // scene cuts / freezes / phantasm into the persisted analysis. The UI polls
    // GET /api/analysis/:id and patches the canvas in when videoReady flips true.
    analyzeVideo(file, a.duration, env, a.silences, opts)
      .then((v) => fsp.writeFile(analysisPath, JSON.stringify({ ...a, ...v }), 'utf8'))
      .catch((err) => fsp.writeFile(
        analysisPath,
        JSON.stringify({ ...a, videoReady: false, videoFailed: String(err?.message || err) }),
        'utf8',
      ).catch(() => {}));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Poll the persisted analysis — phase-2 (Phantasm / scene cuts) lands here when the
// background video pass finishes. Returns the raw JSON as-is.
app.get('/api/analysis/:id', async (req, res) => {
  try {
    const json = await fsp.readFile(path.join(DATA, req.params.id, 'analysis.json'), 'utf8');
    res.type('application/json').send(json);
  } catch {
    res.status(404).json({ error: 'No analysis for that id' });
  }
});

// Stream a byte range to the client with a stream-level error handler so a mid-read failure
// (file truncated/removed while playing) ends the response instead of throwing an uncaught
// exception that crashes the process.
function pipeRange(res, file, opts) {
  const s = fs.createReadStream(file, opts);
  s.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
  s.pipe(res);
}

// Range-aware video streaming. Parses ALL three RFC 7233 range forms — `bytes=N-M`, open
// `bytes=N-`, and suffix `bytes=-N` (last N bytes) — clamps to the file, and answers an
// out-of-range request with 416 instead of throwing (`m[1]` on a null match) or emitting a
// negative Content-Length. A browser <video> and download managers all send these forms.
app.get('/api/video', async (req, res) => {
  try {
    const file = await sourceFor(req.query.id);
    if (!file || !fs.existsSync(file)) return res.status(404).end('not found');
    const stat = fs.statSync(file);
    const size = stat.size;
    const type = file.toLowerCase().endsWith('.webm') ? 'video/webm'
      : file.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      return pipeRange(res, file);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    let start; let end;
    if (m[1] === '') {                       // suffix: last N bytes
      const n = Math.min(parseInt(m[2], 10), size);
      start = size - n; end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024, size - 1);
    }
    end = Math.min(end, size - 1);
    if (!Number.isFinite(start) || start > end || start >= size || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    pipeRange(res, file, { start, end });
  } catch (e) {
    if (!res.headersSent) res.status(500).end(String(e.message || e));
  }
});

// On-demand frame for timeline previews / thumbnails.
app.get('/api/thumb', async (req, res) => {
  try {
    const file = await sourceFor(req.query.id);
    if (!file) return res.status(404).end();
    const t = Math.max(0, parseFloat(req.query.t) || 0);
    const dir = path.join(RENDERS, req.query.id, 'thumbs');
    const out = path.join(dir, `${t.toFixed(1)}.jpg`);
    if (!fs.existsSync(out)) await thumbGate(() => grabFrame(file, t, out, { width: 480 }));
    res.sendFile(out);
  } catch (e) { res.status(500).end(String(e.message || e)); }
});

app.post('/api/captions', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const assPath = path.join(RENDERS, req.body.id, 'captions.ass');
    const range = req.body.range && req.body.range.length === 2 ? req.body.range : undefined;
    const { chunks, srt } = await generateCaptions(file, assPath, { range });
    res.json({
      ass: assPath, srt, chunks, count: chunks.length,
      canBurn: await canBurnCaptions(),
      srtUrl: `/renders/${req.body.id}/captions.srt`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Funny moments: transcribe candidate windows, score reactions, re-rank. ----
// Only the candidate windows are transcribed (not the whole VOD), so this stays fast.
app.post('/api/highlights/funny', async (req, res) => {
  try {
    const id = req.body.id;
    const file = await sourceFor(id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const cap = captionsReady();
    if (!cap.bin || !cap.model) {
      return res.status(400).json({ error: 'Reaction ranking needs whisper.cpp. Install it: brew install whisper-cpp' });
    }

    // Candidate windows: prefer the broad analyze pool, fall back to highlights.
    let analysis = {};
    try { analysis = JSON.parse(await fsp.readFile(path.join(DATA, id, 'analysis.json'), 'utf8')); } catch {}
    let pool = (analysis.candidates?.length ? analysis.candidates : analysis.highlights) || [];
    if (Array.isArray(req.body.candidates) && req.body.candidates.length) pool = req.body.candidates;
    if (!pool.length) return res.status(400).json({ error: 'No candidate moments — run Analyze first.' });

    const duration = analysis.duration || (await probe(file)).duration || 0;
    // Storyboard mode needs a MUCH bigger candidate pool — an 8-10 min cut is ~15-25 clips, so the
    // default keep=8 / 9-min budget would starve it. Scale both up when the caller asks for it.
    const storyboard = req.body.storyboard === true;
    const keepN = req.body.keep || (storyboard ? 40 : 8);
    const pad = 1.5;
    const minScore = req.body.minScore ?? (storyboard ? 0.3 : 0.5);  // lower gate → more candidates survive
    const budgetSec = req.body.budgetSec ?? (storyboard ? 1500 : 540); // audio sent to whisper (~25 min vs ~9)
    const tighten = req.body.tighten !== false;    // snap clips to the reaction beat (default on)

    // Energy gate + budget — this is what keeps a 2-hour VOD fast: rank candidates by
    // audio score, drop anything below the gate, and keep only the hottest windows until
    // the budget fills. Whisper never sees more than ~9 min of the loudest audio.
    const padded = (c) => ({
      ...c,
      start: Math.max(0, c.start - pad),
      end: duration ? Math.min(duration, c.end + pad) : c.end + pad,
    });
    const gated = [];
    let budget = 0;
    for (const c of [...pool].sort((a, b) => (b.score || 0) - (a.score || 0))) {
      if ((Number(c.score) || 0) < minScore) continue;
      const w = padded(c);
      const dur = w.end - w.start;
      if (budget + dur > budgetSec) continue;
      gated.push(w);
      budget += dur;
    }
    if (!gated.length) {
      return res.json({ highlights: [], scoredCount: 0, note: 'No candidates above the energy gate.' });
    }

    // Parallel chunked whisper across the gated windows, using the small/fast model (tiny.en) —
    // ranking only needs keyword-level accuracy, so this is a big speed win for zero quality cost.
    const transcribed = await transcribeWindows(file, gated, { model: whisperFastModel() });
    const scored = transcribed.map((w) => {
      const r = scoreWindow(w.words || []);
      const audioScore = Number(w.score) || 0;
      // Fuse: audio peak + reaction signal (reaction weighted higher — it's the funny part),
      // minus a weak-hook penalty so boring "hey guys" intros don't rank at the top.
      const hook = hookPenalty(r.snippet);
      const boost = triggerBoost(r.snippet);   // daily-trained retention-trigger lexicon
      const total = +(audioScore + 1.5 * r.reactionScore + hook + boost).toFixed(2);
      // Zero-dep heuristic title/tags (instant). PepAI can upgrade these on demand later.
      const meta = heuristicMeta(w.words || [], r.hits);
      // Snap to the reaction beat — trim dead air before the setup and silence after the
      // payoff. `tighten:false` (or `trim:{leadIn,tailOut}`) overrides.
      const tb = tighten
        ? tightBounds(w.words || [], { start: w.start, end: w.end, t: w.t },
            { ...(req.body.trim || {}), active: analysis.active || [] })   // snap cuts to silence gaps
        : { start: w.start, end: w.end, snapped: false };
      return {
        id: w.id, t: w.t,
        start: +tb.start.toFixed(2), end: +tb.end.toFixed(2),
        originalStart: +(+w.start).toFixed(2), originalEnd: +(+w.end).toFixed(2),
        snapped: tb.snapped,
        audioScore: +audioScore.toFixed(2),
        reactionScore: r.reactionScore,
        score: total,
        snippet: r.snippet,
        hits: [...new Set(r.hits.map((h) => h.tag))],
        title: meta.title,
        tags: meta.tags,
        titleSource: meta.titleSource,
        pacing: pacingTag(w.words),
        keep: true,
      };
    });

    // Optional game-adapter boost. When the caller tags the VOD's game, OCR the HUD across the VOD
    // (Apple Vision), turn scoreboard/notification tokens into events, and fold them into the score
    // via applyGameEvents (one more additive term). No game tag → skipped entirely, so normal
    // ranking is byte-identical. OCR failure never breaks ranking. NOTE: the scan is inline here;
    // for a long VOD it belongs in the Analyze phase later — fine as an opt-in for now.
    let gameEvents = [];
    const game = (req.body.game || '').toLowerCase();
    if (game && ocrAvailable() && duration) {
      try {
        const everySec = req.body.ocrEverySec;
        if (game === 'nba' || game === 'nba2k') ({ events: gameEvents } = await analyzeNBA(file, { duration, everySec: everySec || 4 }));
        else if (game === 'palworld' || game === 'pal') ({ events: gameEvents } = await analyzePalworld(file, { duration, everySec: everySec || 3 }));
      } catch { gameEvents = []; }
    }
    const ranked = gameEvents.length ? applyGameEvents(scored, gameEvents) : scored;

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, keepN).sort((a, b) => a.start - b.start);
    res.json({ highlights: top, scoredCount: ranked.length, gameEvents: gameEvents.length, game: game || null, audioSentSec: +budget.toFixed(1) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Storyboard: compile scored highlights into an 8-10 min hook-driven plan. The frontend can't
// import lib/ (plain script), so it POSTs its highlights here and gets back { hook, body, totalSec }.
// The frontend then sets keep on the body clips (rebuilding seqMap natively) and stashes the hook
// for the export-time prepend. Pure compile — no ffmpeg, fast. ----
app.post('/api/storyboard', (req, res) => {
  try {
    const highlights = req.body.highlights;
    if (!Array.isArray(highlights) || !highlights.length) {
      return res.status(400).json({ error: 'Provide a non-empty highlights array.' });
    }
    const opts = {};
    if (Number.isFinite(req.body.minSec)) opts.minSec = req.body.minSec;
    if (Number.isFinite(req.body.maxSec)) opts.maxSec = req.body.maxSec;
    if (Number.isFinite(req.body.hookSec)) opts.hookSec = req.body.hookSec;
    res.json(selectStoryboard(highlights, opts));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- PepAI (optional): upgrade specific clips' titles/tags via a local Ollama model. ----
// On-demand only, off the funny hot path. 400s cleanly if Ollama isn't running so the UI
// can keep the heuristic titles. Body: { clips: [{ id, transcript }] }.
app.post('/api/pepai/enhance', async (req, res) => {
  try {
    const status = await pepaiReady();
    if (!status.ready) {
      return res.status(400).json({ error: 'PepAI not detected. Start Ollama and pull a model, e.g. `ollama pull llama3.2`.' });
    }
    const clips = Array.isArray(req.body.clips) ? req.body.clips.slice(0, 12) : [];
    const results = [];
    for (const c of clips) {
      const meta = await generateClipMeta(c.transcript || '', { model: status.model });
      results.push({ id: c.id, ok: !!meta, ...(meta || {}) });
    }
    res.json({ model: status.model, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Multi-track sequence export: clips in OUTPUT (array) order, each with optional text
// overlays, composited + concatenated in ONE filter_complex pass. Body:
//   { id, clips: [{ start, end, overlays?: [...] }], vertical?: true }
// ---- PepAI interactive console: multi-turn chat + LIVE tuning mutations. ----
// The model may return [MUTATION]{...}; keys are whitelisted + clamped here and merged
// into data/gaming_heuristics.json — lib/retention.js hot-reloads it (mtime check), so
// the very next "Rank funny moments" run uses the new weights. Chat cannot touch clips.
app.post('/api/pepai/chat', async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-16) : [];
    if (!messages.length) return res.status(400).json({ error: 'No messages' });
    const WPATH = path.join(__dirname, 'data', 'gaming_heuristics.json');
    let weights = {};
    try { weights = JSON.parse(await fsp.readFile(WPATH, 'utf8')); } catch {}
    const out = await chatWithPepAI(messages, { heuristics: {
      targetPacingInterval: weights.targetPacingInterval,
      loudnessThresholdZ: weights.loudnessThresholdZ,
      comedicDelayTailMs: weights.comedicDelayTailMs,
      triggerWeight: weights.triggerWeight,
      hookPenalty: weights.hookPenalty,
      triggerCount: (weights.retentionTriggers || []).length,
    } });
    if (!out) return res.status(503).json({ error: 'PepAI offline (Ollama not reachable)' });

    let applied = null;
    if (out.mutations && typeof out.mutations === 'object') {
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
      const m = out.mutations; const a = {};
      if (Number.isFinite(+m.targetPacingInterval)) a.targetPacingInterval = +clamp(m.targetPacingInterval, 0.5, 3).toFixed(3);
      if (Number.isFinite(+m.loudnessThresholdZ)) a.loudnessThresholdZ = +clamp(m.loudnessThresholdZ, 1.5, 4).toFixed(3);
      if (Number.isFinite(+m.comedicDelayTailMs)) a.comedicDelayTailMs = Math.round(clamp(m.comedicDelayTailMs, 40, 400));
      if (Number.isFinite(+m.triggerWeight)) a.triggerWeight = +clamp(m.triggerWeight, 0, 2).toFixed(3);
      if (Number.isFinite(+m.hookPenalty)) a.hookPenalty = +clamp(m.hookPenalty, -4, 0).toFixed(3);
      let addedTriggers = [];
      if (Array.isArray(m.addTriggers)) {
        addedTriggers = m.addTriggers.map((t) => String(t).toUpperCase().trim())
          .filter((t) => t && t.length <= 40).slice(0, 12);
        if (addedTriggers.length) {
          weights.retentionTriggers = Array.from(new Set([...(weights.retentionTriggers || []), ...addedTriggers]));
        }
      }
      if (Object.keys(a).length || addedTriggers.length) {
        Object.assign(weights, a);
        weights.lastUpdate = new Date().toISOString();
        await fsp.mkdir(path.dirname(WPATH), { recursive: true });
        await fsp.writeFile(WPATH, JSON.stringify(weights, null, 2), 'utf8');
        applied = { ...a };
        if (addedTriggers.length) applied.addTriggers = addedTriggers;
      }
    }
    res.json({ reply: out.reply, applied, model: out.model });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/export/sequence', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const clips = capBatch(req.body.clips);
    if (!clips.length) return res.status(400).json({ error: 'No clips in the sequence.' });

    // Zoom parity with the TikTok pack: ONE batched whisper pass over the clips → per-clip
    // emphasis chunks → punch-in zoom filter, attached to each segment. Off the hot path.
    let segs = clips;
    let zoomed = false;
    const cap = captionsReady();
    if (req.body.zoom !== false && cap.bin && cap.model) {
      const transcribed = await transcribeWindows(file, clips);
      segs = clips.map((c, i) => {
        const z = buildTimelineZoomExpression(emphasisChunks(transcribed[i]?.words || [], c.start), 0);
        if (z.hasZoom) { zoomed = true; return { ...c, zoomFilter: z.filter }; }
        return c;
      });
    }

    const out = path.join(RENDERS, req.body.id, 'sequence.mp4');
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await exportSequence(file, segs, out, { vertical: req.body.vertical !== false });
    res.json({ url: `/renders/${req.body.id}/sequence.mp4`, file: out, clips: clips.length, zoomed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/export/longcut', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const segments = capBatch(req.body.segments).map((s) => [s.start, s.end]);
    if (!segments.length) return res.status(400).json({ error: 'No segments selected' });
    const out = path.join(RENDERS, req.body.id, 'longcut.mp4');
    const subs = req.body.captions ? path.join(RENDERS, req.body.id, 'captions.ass') : undefined;
    const wantSubs = subs && fs.existsSync(subs);
    await exportLongCut(file, segments, out, { subs: wantSubs ? subs : undefined });
    res.json({ file: out, url: `/renders/${req.body.id}/longcut.mp4`, captionsBurned: wantSubs && await canBurnCaptions() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/export/shorts', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const clips = capBatch(req.body.clips);
    if (!clips.length) return res.status(400).json({ error: 'No clips selected' });
    const subs = req.body.captions ? path.join(RENDERS, req.body.id, 'captions.ass') : undefined;
    const useSubs = subs && fs.existsSync(subs) ? subs : undefined;
    // Bounded-parallel + partial-success: each short is an independent encode (per-call
    // mkdtemp/output path); a single bad clip is isolated so the rest still come back.
    const settled = await mapLimit(clips, PACK_CONCURRENCY, async (clip, i) => {
      try {
        const r = cleanRange(clip.start, clip.end);
        if (!r) throw new Error(`Invalid clip range [${clip.start}, ${clip.end}]`);
        const out = path.join(RENDERS, req.body.id, `short-${i + 1}.mp4`);
        await exportShort(file, r[0], r[1], out, { subs: useSubs });
        return { ok: true, value: { file: out, url: `/renders/${req.body.id}/short-${i + 1}.mp4` } };
      } catch (err) {
        return { ok: false, index: i, error: String(err.message || err) };
      }
    });
    const results = settled.filter((r) => r.ok).map((r) => r.value);
    const failed = settled.filter((r) => !r.ok).map((r) => ({ clip: r.index + 1, error: r.error }));
    if (!results.length) return res.status(500).json({ error: 'All shorts failed to render', failed });
    res.json({ shorts: results, captionsBurned: !!(subs && fs.existsSync(subs)) && await canBurnCaptions(), failed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- TikTok pack: top moments as vertical 1080x1920 clips, each with aligned captions. ----
app.post('/api/export/tiktok', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const clips = capBatch(req.body.clips);
    if (!clips.length) return res.status(400).json({ error: 'No clips selected' });
    const wantCaps = req.body.captions !== false && captionsReady().bin && captionsReady().model;
    const burn = wantCaps && await canBurnCaptions();
    const zoomOn = req.body.zoom !== false;   // beat-synced punch-ins on emphasis words
    const dir = path.join(RENDERS, req.body.id);
    let zoomed = false;
    // Render the pack in BOUNDED PARALLEL — each clip's transcribe→zoom→encode pipeline is fully
    // independent (whisper + exportShort both use per-call mkdtemp/output paths). A pool of
    // PACK_CONCURRENCY keeps every core saturated without the context-switch thrash that
    // unbounded fan-out causes on large packs, so wall time ≈ slowest few clips, not the sum.
    // Partial-success: one bad clip must NOT nuke the whole pack (the old throw-through lost every
    // successful render). Each clip is isolated in try/catch; survivors come back in `clips`, the
    // rest in `failed` so the caller can retry or report them.
    const settled = await mapLimit(clips, PACK_CONCURRENCY, async (clip, i) => {
      try {
        const r = cleanRange(clip.start, clip.end);
        if (!r) throw new Error(`Invalid clip range [${clip.start}, ${clip.end}]`);
        const [start, end] = r;
        let subs; let zoomFilter = null;
        if (wantCaps) {
          const ass = path.join(dir, `tiktok-${i + 1}.ass`);
          // clip-relative timestamps so captions line up with the -ss-trimmed vertical clip
          const { chunks } = await generateCaptions(file, ass, { range: [start, end], clipRelative: true, punchy: req.body.punchy !== false });
          if (burn) subs = ass;
          // Punch-in zooms keyed to the emphasis caption blocks (already clip-relative → clipStart 0).
          if (zoomOn) { const z = buildTimelineZoomExpression(chunks || [], 0); zoomFilter = z.filter; if (z.hasZoom) zoomed = true; }
        }
        const out = path.join(dir, `tiktok-${i + 1}.mp4`);
        await exportShort(file, start, end, out, { subs, zoomFilter });
        return { ok: true, value: {
          file: out, url: `/renders/${req.body.id}/tiktok-${i + 1}.mp4`,
          srtUrl: wantCaps ? `/renders/${req.body.id}/tiktok-${i + 1}.srt` : null,
        } };
      } catch (err) {
        return { ok: false, index: i, error: String(err.message || err) };
      }
    });
    const results = settled.filter((r) => r.ok).map((r) => r.value);
    const failed = settled.filter((r) => !r.ok).map((r) => ({ clip: r.index + 1, error: r.error }));
    if (!results.length) return res.status(500).json({ error: 'All clips failed to render', failed });
    res.json({ clips: results, captionsBurned: burn, zoomed, failed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- YouTube cut: cold-open hook + tight (dead-air-removed) body, captions aligned to the cut. ----
app.post('/api/export/youtube', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const keep = capBatch(req.body.segments).map((s) => [s.start, s.end]);
    if (!keep.length) return res.status(400).json({ error: 'No segments to export' });
    const hook = req.body.hook && req.body.hook.length === 2 ? [req.body.hook[0], req.body.hook[1]] : null;
    const segs = hook ? [hook, ...keep] : keep;
    const dir = path.join(RENDERS, req.body.id);

    // SINGLE-PASS: transcribe the cut from an audio-only concat extraction (cheap, no video decode)
    // so the captions align to the re-timed cut WITHOUT rendering a throwaway `raw` first. Then
    // concat + burn in one video encode. Old path did two full video encodes (raw, then re-burn).
    let subs;
    let srtUrl = null;
    let captionsBurned = false;
    if (req.body.captions !== false && captionsReady().bin && captionsReady().model) {
      const ass = path.join(dir, 'youtube.ass');
      await generateCutCaptions(file, ass, segs); // 0-based timing matches exportLongCut's concat
      srtUrl = `/renders/${req.body.id}/youtube.srt`;
      if (await canBurnCaptions()) { subs = ass; captionsBurned = true; }
    }

    const out = path.join(dir, 'youtube.mp4');
    await exportLongCut(file, segs, out, { subs }); // one encode, captions burned inline when able
    res.json({ file: out, url: `/renders/${req.body.id}/youtube.mp4`, captionsBurned, srtUrl, hook: !!hook });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Premiere / NLE handoff: EDL + FCP7 XML of the Phantasm cut (relinks to source). ----
app.post('/api/export/premiere', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const segments = capBatch(req.body.segments).filter((s) => s && s.end > s.start);
    if (!segments.length) return res.status(400).json({ error: 'No segments to hand off' });

    // Meta (fps/dims) from cached analysis if present, else probe.
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(DATA, req.body.id, 'analysis.json'), 'utf8')).meta; } catch {}
    if (!meta || !meta.fps) meta = await probe(file);
    const fps = meta.fps || 30;
    const name = path.basename(file);

    const dir = path.join(RENDERS, req.body.id);
    await fsp.mkdir(dir, { recursive: true });
    const edl = buildEDL(segments, fps, { clipName: name });
    const xml = buildFcp7Xml(file, meta, segments, req.body.markers || [], { title: `${name} — PepStudio cut` });
    await fsp.writeFile(path.join(dir, 'premiere.edl'), edl, 'utf8');
    await fsp.writeFile(path.join(dir, 'premiere.xml'), xml, 'utf8');

    const srt = path.join(dir, 'captions.srt');
    res.json({
      edl: path.join(dir, 'premiere.edl'), edlUrl: `/renders/${req.body.id}/premiere.edl`,
      xml: path.join(dir, 'premiere.xml'), xmlUrl: `/renders/${req.body.id}/premiere.xml`,
      srtUrl: fs.existsSync(srt) ? `/renders/${req.body.id}/captions.srt` : null,
      segments: segments.length, fps,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Grab high-res thumbnail frames at the given times (highlight peaks).
app.post('/api/export/thumbs', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const times = capBatch(req.body.times);
    if (!times.length) return res.status(400).json({ error: 'No times provided' });
    // Single-frame grabs are cheap and independent — grab them in parallel, isolating failures.
    const settled = await mapLimit(times, PACK_CONCURRENCY, async (t, i) => {
      try {
        const tt = Number(t);
        if (!Number.isFinite(tt) || tt < 0) throw new Error(`Invalid time ${t}`);
        const name = `thumb-${i + 1}.jpg`;
        const out = path.join(RENDERS, req.body.id, name);
        await grabFrame(file, tt, out, { width: 1280 });
        return { ok: true, value: { file: out, url: `/renders/${req.body.id}/${name}` } };
      } catch (err) {
        return { ok: false, index: i, error: String(err.message || err) };
      }
    });
    const results = settled.filter((r) => r.ok).map((r) => r.value);
    const failed = settled.filter((r) => !r.ok).map((r) => ({ frame: r.index + 1, error: r.error }));
    if (!results.length) return res.status(500).json({ error: 'All thumbnails failed', failed });
    res.json({ thumbs: results, failed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Reveal a rendered file in Finder. execFile (no shell) with the path as a discrete argv entry —
// a filename containing shell metacharacters (backticks, $(), ;) can't be interpreted as a command.
app.post('/api/reveal', async (req, res) => {
  const p = req.body.path;
  if (p && typeof p === 'string' && fs.existsSync(p)) execFile('open', ['-R', p], () => {});
  res.json({ ok: true });
});

// Start listening. Returns the http.Server once it's up (used by the desktop shell).
// PORT=0 lets the OS pick a guaranteed-free port; the actual port is reported back
// to the Electron parent over IPC so there's never an EADDRINUSE race.
export function start(port = process.env.PORT || 4178) {
  return new Promise((resolve) => {
    const server = app.listen(Number(port), () => {
      const actual = server.address().port;
      console.log(`PepStudio running -> http://localhost:${actual}`);
      if (process.send) { try { process.send({ type: 'pepstudio-port', port: actual }); } catch {} }
      // Learning loop: apply any correction chips tapped since last boot to the ranking weights.
      // Idempotent (cursor) + bounded, and logged so the shift is never silent. PEP_NO_FEEDBACK=1 to skip.
      if (process.env.PEP_NO_FEEDBACK !== '1') {
        try {
          const r = consumeFeedback({ feedbackPath: path.join(DATA, 'feedback.jsonl'), heuristicsPath: path.join(DATA, 'gaming_heuristics.json') });
          if (r.applied) console.log(`[feedback] applied corrections ${JSON.stringify(r.counts)} → weights ${JSON.stringify(r.changes)}`);
        } catch (e) { console.log('[feedback] skip:', String(e.message || e)); }
      }
      resolve(server);
    });
  });
}

// Auto-start when run directly (node server.js / npm start), but NOT when imported (Electron embeds it).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) start();
