// ClipForge server: analyze, stream, render. All local, all free.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exec } from 'node:child_process';

import { analyze } from './lib/analyze.js';
import { exportLongCut, exportShort, grabFrame, burnSubs, canBurnCaptions } from './lib/exporter.js';
import { generateCaptions, captionsReady } from './lib/captions.js';
import { downloadUrl, probeUrl, ytdlpBin, SUPPORTED_URL } from './lib/fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Writable dirs — overridable so the Electron app can point them at userData
// (the app bundle itself is read-only when packaged).
const DATA = process.env.CLIPFORGE_DATA || path.join(__dirname, 'data');
const RENDERS = process.env.CLIPFORGE_RENDERS || path.join(__dirname, 'renders');
const DOWNLOADS = process.env.CLIPFORGE_DOWNLOADS || path.join(__dirname, 'downloads');
await fsp.mkdir(DATA, { recursive: true });
await fsp.mkdir(RENDERS, { recursive: true });
await fsp.mkdir(DOWNLOADS, { recursive: true });

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDERS));

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
  res.json({
    captions: { ready: !!(cap.bin && cap.model), bin: cap.bin, model: cap.model },
    canBurn: await canBurnCaptions(),
    canDownload: !!ytdlpBin(),
  });
});

// ---- Import a VOD from a URL (YouTube / Twitch). Long-running → job + polling. ----
const jobs = new Map(); // jobId -> { status, progress, stage, error, project }

app.post('/api/import-url', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a YouTube or Twitch link.' });
  if (!ytdlpBin()) return res.status(500).json({ error: 'yt-dlp not installed. Run: brew install yt-dlp' });
  if (!SUPPORTED_URL.test(url)) return res.status(400).json({ error: 'Only YouTube and Twitch links are supported.' });

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
    const result = await analyze(file, req.body.opts || {});
    result.id = id;
    result.name = path.basename(file);
    await fsp.writeFile(path.join(DATA, id, 'analysis.json'), JSON.stringify(result), 'utf8');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Range-aware video streaming.
app.get('/api/video', async (req, res) => {
  const file = await sourceFor(req.query.id);
  if (!file || !fs.existsSync(file)) return res.status(404).end('not found');
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const type = file.toLowerCase().endsWith('.webm') ? 'video/webm'
    : file.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type });
    return fs.createReadStream(file).pipe(res);
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': type,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
});

// On-demand frame for timeline previews / thumbnails.
app.get('/api/thumb', async (req, res) => {
  try {
    const file = await sourceFor(req.query.id);
    if (!file) return res.status(404).end();
    const t = Math.max(0, parseFloat(req.query.t) || 0);
    const dir = path.join(RENDERS, req.query.id, 'thumbs');
    const out = path.join(dir, `${t.toFixed(1)}.jpg`);
    if (!fs.existsSync(out)) await grabFrame(file, t, out, { width: 480 });
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

app.post('/api/export/longcut', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const segments = (req.body.segments || []).map((s) => [s.start, s.end]);
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
    const clips = req.body.clips || [];
    if (!clips.length) return res.status(400).json({ error: 'No clips selected' });
    const subs = req.body.captions ? path.join(RENDERS, req.body.id, 'captions.ass') : undefined;
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const out = path.join(RENDERS, req.body.id, `short-${i + 1}.mp4`);
      await exportShort(file, clips[i].start, clips[i].end, out, {
        subs: subs && fs.existsSync(subs) ? subs : undefined,
      });
      results.push({ file: out, url: `/renders/${req.body.id}/short-${i + 1}.mp4` });
    }
    res.json({ shorts: results, captionsBurned: !!(subs && fs.existsSync(subs)) && await canBurnCaptions() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- TikTok pack: top moments as vertical 1080x1920 clips, each with aligned captions. ----
app.post('/api/export/tiktok', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const clips = req.body.clips || [];
    if (!clips.length) return res.status(400).json({ error: 'No clips selected' });
    const wantCaps = req.body.captions !== false && captionsReady().bin && captionsReady().model;
    const burn = wantCaps && await canBurnCaptions();
    const dir = path.join(RENDERS, req.body.id);
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const { start, end } = clips[i];
      let subs;
      if (wantCaps) {
        const ass = path.join(dir, `tiktok-${i + 1}.ass`);
        // clip-relative timestamps so captions line up with the -ss-trimmed vertical clip
        await generateCaptions(file, ass, { range: [start, end], clipRelative: true });
        if (burn) subs = ass;
      }
      const out = path.join(dir, `tiktok-${i + 1}.mp4`);
      await exportShort(file, start, end, out, { subs });
      results.push({
        file: out, url: `/renders/${req.body.id}/tiktok-${i + 1}.mp4`,
        srtUrl: wantCaps ? `/renders/${req.body.id}/tiktok-${i + 1}.srt` : null,
      });
    }
    res.json({ clips: results, captionsBurned: burn });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- YouTube cut: cold-open hook + tight (dead-air-removed) body, captions aligned to the cut. ----
app.post('/api/export/youtube', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const keep = (req.body.segments || []).map((s) => [s.start, s.end]);
    if (!keep.length) return res.status(400).json({ error: 'No segments to export' });
    const hook = req.body.hook && req.body.hook.length === 2 ? [req.body.hook[0], req.body.hook[1]] : null;
    const segs = hook ? [hook, ...keep] : keep;
    const dir = path.join(RENDERS, req.body.id);

    const raw = path.join(dir, 'youtube_raw.mp4');
    await exportLongCut(file, segs, raw); // render first, no captions

    let outUrl = `/renders/${req.body.id}/youtube_raw.mp4`;
    let outFile = raw;
    let captionsBurned = false;
    let srtUrl = null;
    if (req.body.captions !== false && captionsReady().bin && captionsReady().model) {
      const ass = path.join(dir, 'youtube.ass');
      await generateCaptions(raw, ass); // transcribe the RENDERED cut → perfectly aligned
      srtUrl = `/renders/${req.body.id}/youtube.srt`;
      if (await canBurnCaptions()) {
        const burned = path.join(dir, 'youtube.mp4');
        await burnSubs(raw, ass, burned);
        outFile = burned; outUrl = `/renders/${req.body.id}/youtube.mp4`; captionsBurned = true;
      }
    }
    res.json({ file: outFile, url: outUrl, captionsBurned, srtUrl, hook: !!hook });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Grab high-res thumbnail frames at the given times (highlight peaks).
app.post('/api/export/thumbs', async (req, res) => {
  try {
    const file = await sourceFor(req.body.id);
    if (!file) return res.status(404).json({ error: 'Unknown project id' });
    const times = req.body.times || [];
    if (!times.length) return res.status(400).json({ error: 'No times provided' });
    const results = [];
    for (let i = 0; i < times.length; i++) {
      const name = `thumb-${i + 1}.jpg`;
      const out = path.join(RENDERS, req.body.id, name);
      await grabFrame(file, times[i], out, { width: 1280 });
      results.push({ file: out, url: `/renders/${req.body.id}/${name}` });
    }
    res.json({ thumbs: results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Reveal a rendered file in Finder.
app.post('/api/reveal', async (req, res) => {
  const p = req.body.path;
  if (p && fs.existsSync(p)) exec(`open -R "${p.replace(/"/g, '')}"`);
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
      resolve(server);
    });
  });
}

// Auto-start when run directly (node server.js / npm start), but NOT when imported (Electron embeds it).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) start();
