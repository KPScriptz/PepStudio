// Captions via whisper.cpp (free, local, Apple-Silicon fast). Produces chunked .ass for a punchy style.
import { spawn, execSync } from 'node:child_process';
import { ffmpeg, deprioritize } from './ff.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Project root resolved from this file, NOT process.cwd() (launcher cwd varies).
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Content-addressed caption cache ----------------------------------------------------------
// Transcription (whisper) is the dominant cost of every caption export, and re-exporting the same
// clip — toggling zoom/captions, re-running the pack — used to re-transcribe byte-identical audio.
// Key = resolved source path + mtime + model + range/flags, so ANY edit to the source auto-busts
// the entry. Hit → copy cached .ass/.srt into place and return chunks; whisper never runs.
const CAP_CACHE = process.env.PEP_CAPCACHE || path.join(os.tmpdir(), 'pep-capcache');
function capKey(file, parts) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch {}
  const model = whisperModel() || '';
  return crypto.createHash('sha1')
    .update([path.resolve(file), mtime, path.basename(model), ...parts].join('|'))
    .digest('hex').slice(0, 16);
}
const srtOf = (assPath) => assPath.replace(/\.ass$/, '.srt');
async function capCacheGet(key, assPath) {
  try {
    const chunks = JSON.parse(await fsp.readFile(path.join(CAP_CACHE, `${key}.json`), 'utf8'));
    await fsp.mkdir(path.dirname(assPath), { recursive: true });
    await fsp.copyFile(path.join(CAP_CACHE, `${key}.ass`), assPath);
    await fsp.copyFile(path.join(CAP_CACHE, `${key}.srt`), srtOf(assPath));
    return { ass: assPath, srt: srtOf(assPath), chunks, cached: true };
  } catch { return null; }
}
async function capCachePut(key, assPath, chunks) {
  try {
    await fsp.mkdir(CAP_CACHE, { recursive: true });
    await fsp.copyFile(assPath, path.join(CAP_CACHE, `${key}.ass`));
    await fsp.copyFile(srtOf(assPath), path.join(CAP_CACHE, `${key}.srt`));
    await fsp.writeFile(path.join(CAP_CACHE, `${key}.json`), JSON.stringify(chunks), 'utf8');
    await capCachePrune();
  } catch { /* cache is best-effort; a write failure must never fail the export */ }
}
// Bound the cache: keep the newest MAX entries (one entry = the .json + its .ass/.srt), evicting
// oldest-by-mtime. Without this the cache grew unbounded (every distinct clip range = a new entry).
const CAP_CACHE_MAX = Math.max(1, Number(process.env.PEP_CAPCACHE_MAX) || 300);
async function capCachePrune() {
  try {
    const names = await fsp.readdir(CAP_CACHE);
    const keys = names.filter((n) => n.endsWith('.json'));
    if (keys.length <= CAP_CACHE_MAX) return;
    const stamped = await Promise.all(keys.map(async (n) => ({
      key: n.slice(0, -5),
      mtime: (await fsp.stat(path.join(CAP_CACHE, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
    })));
    stamped.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const { key } of stamped.slice(0, keys.length - CAP_CACHE_MAX)) {
      for (const ext of ['.json', '.ass', '.srt']) {
        await fsp.rm(path.join(CAP_CACHE, `${key}${ext}`), { force: true }).catch(() => {});
      }
    }
  } catch { /* prune is best-effort */ }
}

// Locate a whisper.cpp CLI binary.
export function whisperBin() {
  if (process.env.WHISPER_BIN && fs.existsSync(process.env.WHISPER_BIN)) return process.env.WHISPER_BIN;
  for (const c of ['whisper-cli', 'whisper-cpp', 'whisper', 'main']) {
    try {
      const p = execSync(`command -v ${c} 2>/dev/null`).toString().trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

// Locate a model file (.bin). Override with WHISPER_MODEL.
export function whisperModel() {
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL)) return process.env.WHISPER_MODEL;
  const dirs = [
    path.join(PROJECT_ROOT, 'models'),
    path.join(process.cwd(), 'models'),
    '/opt/homebrew/share/whisper-cpp/models',
    path.join(os.homedir(), 'whisper.cpp', 'models'),
  ];
  const names = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-tiny.en.bin'];
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function captionsReady() {
  return { bin: whisperBin(), model: whisperModel() };
}

// Extract a 16kHz mono wav for whisper (optionally a sub-range).
async function extractWav(file, wavPath, range) {
  const args = ['-nostdin', '-y'];
  if (range) { args.push('-ss', String(range[0]), '-to', String(range[1])); }
  args.push('-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath);
  await ffmpeg(args);
}

function runWhisper(bin, model, wav, outBase) {
  return new Promise((resolve, reject) => {
    // Greedy decode (-bs 1 -bo 1): whisper.cpp defaults to beam-size 5 / best-of 5, which is
    // ~2-3x slower for no gain on our short, punchy 1-2 word gameplay captions. Flash-attn is
    // already on by default in this build. -ml 1 -sow keep the token-level word timing the
    // zoom/emphasis engine needs. Threads overridable via WHISPER_THREADS (default 4).
    const threads = process.env.WHISPER_THREADS || '4';
    const args = ['-m', model, '-f', wav, '-oj', '-of', outBase,
      '-ml', '1', '-sow', '-bs', '1', '-bo', '1', '-t', threads];
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    deprioritize(child.pid);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`whisper exited ${code}\n${err.slice(-2000)}`)));
  });
}

// Group whisper tokens into short on-screen chunks (Hormozi style: a few words each).
function chunkTokens(transcription, wordsPerChunk = 3, offset = 0) {
  const words = [];
  for (const seg of transcription) {
    const txt = (seg.text || '').trim();
    if (!txt) continue;
    words.push({ t0: seg.offsets.from / 1000 + offset, t1: seg.offsets.to / 1000 + offset, w: txt });
  }
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const grp = words.slice(i, i + wordsPerChunk);
    if (!grp.length) continue;
    chunks.push({
      start: grp[0].t0,
      end: grp[grp.length - 1].t1,
      text: grp.map((g) => g.w).join(' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return chunks;
}

// High-retention words that get isolated + emphasized (color/scale pop).
const RETENTION_TRIGGERS = /^(REAL|INSANE|CRAZY|HOW|NEVER|EVERYTHING|OMG|STOP|LOOK|BRO|HUGE|WTF|NO|WHAT|YES|WOW|WAIT|LETS|GO|DUDE|HOLY|FINALLY|ACTUALLY|WASTED|FAIL|BROKEN|IMPOSSIBLE|KARMA|BUGGED|RAGDOLL)$/;

// Core bucketer: rapid-fire 1–2 word blocks from absolute {t0,t1,w} tokens. A trigger word
// stands alone and is flagged for emphasis styling; everything else buckets in pairs.
function bucketPunchy(words) {
  const chunks = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      start: buf[0].t0,
      end: buf[buf.length - 1].t1,
      // Strip edge punctuation (commas/periods) for clean rapid-fire reading; keep apostrophes.
      text: buf.map((b) => b.w.replace(/^[^\w']+|[^\w']+$/g, '')).join(' ').replace(/\s+/g, ' ').trim(),
      emphasis: buf.some((b) => b.trigger),
    });
    buf = [];
  };
  for (const wd of words) {
    const trigger = RETENTION_TRIGGERS.test((wd.w || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    if (trigger) { flush(); buf.push({ ...wd, trigger: true }); flush(); continue; }
    buf.push({ ...wd, trigger: false });
    if (buf.length >= 2) flush();
  }
  flush();
  return chunks;
}

// From whisper-JSON transcription → punchy caption chunks (TikTok pacing). Used by .ass gen.
function chunkPunchy(transcription, offset = 0) {
  const words = [];
  for (const seg of transcription) {
    const txt = (seg.text || '').trim();
    if (txt) words.push({ t0: seg.offsets.from / 1000 + offset, t1: seg.offsets.to / 1000 + offset, w: txt });
  }
  return bucketPunchy(words);
}

// From absolute {t0,t1,w} word tokens (e.g. transcribeWindows output) → CLIP-RELATIVE punchy
// chunks with emphasis flags. Used to drive sequence-export zoom punch-ins.
export function emphasisChunks(words, clipStart = 0) {
  const rel = (words || []).map((w) => ({
    t0: +(w.t0 - clipStart).toFixed(3), t1: +(w.t1 - clipStart).toFixed(3), w: w.w,
  }));
  return bucketPunchy(rel);
}

function ts(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function srtTs(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Plain .srt — imports straight into YouTube Studio, CapCut, Premiere, etc.
export function buildSrt(chunks) {
  return chunks.map((c, i) =>
    `${i + 1}\n${srtTs(c.start)} --> ${srtTs(c.end)}\n${c.text}\n`).join('\n') + '\n';
}

// Bold, high-contrast caption style with a pop-in scale animation.
export function buildAss(chunks, { w = 1080, h = 1920, fontSize = 96 } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Pop,Arial Black,${fontSize},&H00FFFFFF,&H00000000,&H64000000,1,1,6,3,2,80,80,260
Style: Emph,Arial Black,${Math.round(fontSize * 1.12)},&H0000F0FF,&H00000000,&H64000000,1,1,6,3,2,80,80,260

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const lines = chunks.map((c) => {
    const txt = c.text.toUpperCase().replace(/\n/g, ' ');
    // Emphasis (trigger) chunks pop harder in amber; normal chunks get the standard pop-in.
    const fx = c.emphasis
      ? `{\\fad(40,40)\\t(0,100,\\fscx135\\fscy135)\\t(100,200,\\fscx100\\fscy100)}`
      : `{\\fad(60,40)\\t(0,120,\\fscx118\\fscy118)\\t(120,200,\\fscx100\\fscy100)}`;
    return `Dialogue: 0,${ts(c.start)},${ts(c.end)},${c.emphasis ? 'Emph' : 'Pop'},,0,0,0,,${fx}${txt}`;
  });
  return `${header}\n${lines.join('\n')}\n`;
}

// Transcribe one time range and return absolute-timestamped word tokens: [{ t0, t1, w }].
// Used by the "funny moments" pass to mine reactions in candidate windows only
// (so we never transcribe the whole hour). Returns [] if whisper isn't installed.
export async function transcribeRange(file, range) {
  const bin = whisperBin();
  const model = whisperModel();
  if (!bin || !model) return [];
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-tr-'));
  const wav = path.join(tmp, 'a.wav');
  const outBase = path.join(tmp, 'out');
  try {
    await extractWav(file, wav, range);
    await runWhisper(bin, model, wav, outBase);
    const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
    const offset = range ? range[0] : 0;
    return (json.transcription || [])
      .map((seg) => ({
        t0: seg.offsets.from / 1000 + offset,
        t1: seg.offsets.to / 1000 + offset,
        w: (seg.text || '').trim(),
      }))
      .filter((x) => x.w);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Batch-transcribe many short windows in ONE whisper pass — the fast path for the
// funny-moments engine. Extracts every window into a single concatenated 16k wav with
// one ffmpeg filter_complex spawn (atrim+concat, no video frames touched) and runs
// whisper ONCE, so the model loads a single time instead of once per window. Each
// word's concat-time is then remapped back to absolute source-time.
// Returns the input windows, each with an added `words: [{t0,t1,w}]`.
// Falls back to per-window transcription if the batched graph/whisper fails.
export async function transcribeWindows(file, windows, { model } = {}) {
  const bin = whisperBin();
  const mdl = model || whisperModel();
  if (!bin || !mdl || !windows.length) return windows.map((w) => ({ ...w, words: [] }));

  // Lay each window end-to-end on a virtual "concat timeline" and remember the offset.
  // Round s/e to ms HERE so the atrim filter and the concat-offset table consume the
  // exact same numbers — otherwise cumulative rounding drifts the remap over many windows.
  const segs = windows.map((w) => {
    const s = +Math.max(0, w.start).toFixed(3);
    const e = +Math.max(s + 0.1, w.end).toFixed(3);
    return { w, s, e, dur: +(e - s).toFixed(3), cat: 0, words: [] };
  });
  let acc = 0;
  for (const seg of segs) { seg.cat = acc; acc += seg.dur; }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-batch-'));
  const wav = path.join(tmp, 'a.wav');
  const outBase = path.join(tmp, 'out');
  try {
    const trims = segs
      .map((seg, i) => `[0:a]atrim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
      .join(';');
    const chain = segs.map((_, i) => `[a${i}]`).join('') + `concat=n=${segs.length}:v=0:a=1[out]`;
    await ffmpeg(['-nostdin', '-y', '-i', file, '-filter_complex', `${trims};${chain}`,
      '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    await runWhisper(bin, mdl, wav, outBase);
    const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));

    for (const tok of (json.transcription || [])) {
      const txt = (tok.text || '').trim();
      if (!txt) continue;
      const ct = tok.offsets.from / 1000;   // concat-time
      const ct1 = tok.offsets.to / 1000;
      // Bucket = last window whose concat-start is <= this token's time.
      let seg = segs[0];
      for (const cand of segs) { if (ct + 1e-6 >= cand.cat) seg = cand; else break; }
      const off = Math.max(0, Math.min(seg.dur, ct - seg.cat));
      const off1 = Math.max(0, Math.min(seg.dur, ct1 - seg.cat));
      seg.words.push({ t0: +(seg.s + off).toFixed(3), t1: +(seg.s + off1).toFixed(3), w: txt });
    }
    return segs.map((seg) => ({ ...seg.w, words: seg.words }));
  } catch {
    // Resilience: a malformed graph or whisper crash shouldn't lose every window.
    const out = [];
    for (const w of windows) {
      out.push({ ...w, words: await transcribeRange(file, [Math.max(0, w.start), w.end]).catch(() => []) });
    }
    return out;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Full pipeline: transcribe (optionally a range) and write an .ass file. Returns { ass, chunks }.
// clipRelative=true keeps timestamps 0-based (for a clip trimmed with -ss, whose PTS resets).
export async function generateCaptions(file, assPath, { range, clipRelative = false, punchy = false } = {}) {
  const bin = whisperBin();
  const model = whisperModel();
  if (!bin) throw new Error('whisper.cpp not found. Install with: brew install whisper-cpp');
  if (!model) throw new Error('No whisper model. Download one, e.g.:\n  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin');

  const key = capKey(file, ['gc', range ? range[0] : 0, range ? range[1] : '', clipRelative ? 1 : 0, punchy ? 1 : 0]);
  const hit = await capCacheGet(key, assPath);
  if (hit) return hit;

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-cap-'));
  const wav = path.join(tmp, 'a.wav');
  const outBase = path.join(tmp, 'out');
  await extractWav(file, wav, range);
  await runWhisper(bin, model, wav, outBase);
  const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
  const offset = clipRelative ? 0 : (range ? range[0] : 0);
  const chunks = punchy ? chunkPunchy(json.transcription || [], offset) : chunkTokens(json.transcription || [], 3, offset);
  await fsp.mkdir(path.dirname(assPath), { recursive: true });
  await fsp.writeFile(assPath, buildAss(chunks), 'utf8');
  const srtPath = assPath.replace(/\.ass$/, '.srt');
  await fsp.writeFile(srtPath, buildSrt(chunks), 'utf8');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await capCachePut(key, assPath, chunks);
  return { ass: assPath, srt: srtPath, chunks };
}

// Transcribe a MULTI-SEGMENT cut and write .ass + .srt whose 0-based timestamps line up with
// the video that exportLongCut produces from the SAME segments. The trick: extract only the
// concatenated AUDIO of the cut in one audio-only ffmpeg pass (no video frames decoded), so the
// YouTube cut can burn captions in a SINGLE video encode instead of the old render-raw → transcribe
// → re-encode-to-burn (two full video passes). `segments` = array of [start, end] source ranges.
// Returns { ass, srt, chunks }.
export async function generateCutCaptions(file, assPath, segments, { punchy = false } = {}) {
  const bin = whisperBin();
  const model = whisperModel();
  if (!bin) throw new Error('whisper.cpp not found. Install with: brew install whisper-cpp');
  if (!model) throw new Error('No whisper model. Download one, e.g.:\n  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin');
  const segs = (segments || []).filter(([s, e]) => e - s > 0.01);
  if (!segs.length) throw new Error('No segments to caption');

  const key = capKey(file, ['cut', punchy ? 1 : 0, ...segs.flat()]);
  const hit = await capCacheGet(key, assPath);
  if (hit) return hit;

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-cut-'));
  const wav = path.join(tmp, 'a.wav');
  const outBase = path.join(tmp, 'out');
  try {
    // Concat the segments' audio end-to-end (PTS reset per segment → 0-based over the cut, exactly
    // matching concatGraph's video re-timing in exporter.js). Audio-only: no video is decoded.
    const trims = segs
      .map(([s, e], i) => `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`)
      .join(';');
    const chain = segs.map((_, i) => `[a${i}]`).join('') + `concat=n=${segs.length}:v=0:a=1[out]`;
    await ffmpeg(['-nostdin', '-y', '-i', file, '-filter_complex', `${trims};${chain}`,
      '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    await runWhisper(bin, model, wav, outBase);
    const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
    const chunks = punchy ? chunkPunchy(json.transcription || [], 0) : chunkTokens(json.transcription || [], 3, 0);
    await fsp.mkdir(path.dirname(assPath), { recursive: true });
    await fsp.writeFile(assPath, buildAss(chunks), 'utf8');
    const srtPath = assPath.replace(/\.ass$/, '.srt');
    await fsp.writeFile(srtPath, buildSrt(chunks), 'utf8');
    await capCachePut(key, assPath, chunks);
    return { ass: assPath, srt: srtPath, chunks };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
