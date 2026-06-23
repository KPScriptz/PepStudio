// Captions via whisper.cpp (free, local, Apple-Silicon fast). Produces chunked .ass for a punchy style.
import { spawn, execSync } from 'node:child_process';
import { ffmpeg } from './ff.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root resolved from this file, NOT process.cwd() (launcher cwd varies).
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    const args = ['-m', model, '-f', wav, '-oj', '-of', outBase, '-ml', '1', '-sow'];
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

[Events]
Format: Layer, Start, End, Style, Text`;
  const lines = chunks.map((c) => {
    const txt = c.text.toUpperCase().replace(/\n/g, ' ');
    const fx = `{\\fad(60,40)\\t(0,120,\\fscx118\\fscy118)\\t(120,200,\\fscx100\\fscy100)}`;
    return `Dialogue: 0,${ts(c.start)},${ts(c.end)},Pop,,0,0,0,,${fx}${txt}`;
  });
  return `${header}\n${lines.join('\n')}\n`;
}

// Full pipeline: transcribe (optionally a range) and write an .ass file. Returns { ass, chunks }.
// clipRelative=true keeps timestamps 0-based (for a clip trimmed with -ss, whose PTS resets).
export async function generateCaptions(file, assPath, { range, clipRelative = false } = {}) {
  const bin = whisperBin();
  const model = whisperModel();
  if (!bin) throw new Error('whisper.cpp not found. Install with: brew install whisper-cpp');
  if (!model) throw new Error('No whisper model. Download one, e.g.:\n  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-cap-'));
  const wav = path.join(tmp, 'a.wav');
  const outBase = path.join(tmp, 'out');
  await extractWav(file, wav, range);
  await runWhisper(bin, model, wav, outBase);
  const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
  const offset = clipRelative ? 0 : (range ? range[0] : 0);
  const chunks = chunkTokens(json.transcription || [], 3, offset);
  await fsp.mkdir(path.dirname(assPath), { recursive: true });
  await fsp.writeFile(assPath, buildAss(chunks), 'utf8');
  const srtPath = assPath.replace(/\.ass$/, '.srt');
  await fsp.writeFile(srtPath, buildSrt(chunks), 'utf8');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return { ass: assPath, srt: srtPath, chunks };
}
