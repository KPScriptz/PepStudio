// ClipForge server: analyze, stream, render. All local, all free.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

import { analyze } from './lib/analyze.js';
import { exportLongCut, exportShort, grabFrame, canBurnCaptions } from './lib/exporter.js';
import { generateCaptions, captionsReady } from './lib/captions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const RENDERS = path.join(__dirname, 'renders');
await fsp.mkdir(DATA, { recursive: true });
await fsp.mkdir(RENDERS, { recursive: true });

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
  });
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

const PORT = process.env.PORT || 4178;
app.listen(PORT, () => console.log(`ClipForge running -> http://localhost:${PORT}`));
