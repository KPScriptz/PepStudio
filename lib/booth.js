// Confessional Booth — server side of the one-button reality-show recorder.
//
// The browser can only hand us what MediaRecorder produces: a WebM (VP8/VP9 + Opus) blob, or on
// newer Chromium an MP4 (avc1 + aac) one. Neither is editor-ready as-is:
//   * A live-recorded WebM carries NO duration in its header (the muxer never seeks back to write
//     it), so players report Infinity and scrubbing is broken.
//   * MediaRecorder output is variable-frame-rate — fine for playback, a drift hazard in an NLE.
//   * MP4 from MediaRecorder is fragmented with the moov box at the END, so it can't stream.
// So every take is normalized to a faststart, constant-frame-rate H.264/AAC MP4 before it lands
// in the library. That is the file PepStudio's analyze/whisper/export chain then treats like any
// other source.
//
// Everything here is pure path/arg construction plus one ffmpeg call, so it unit-tests without a
// camera, a browser, or a filesystem.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, videoEncodeArgs } from './ff.js';

// Container the browser gave us, by its MIME type. Only the part before ';' matters.
export function extForMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/x-matroska') return 'mkv';
  return 'webm';
}

// A take's slug is used verbatim in a filename, so it is whitelisted rather than blacklisted:
// anything that is not an ASCII letter, digit or dash becomes a dash. That makes shell
// metacharacters, path separators, '..' and leading dots structurally impossible — the result
// can only ever be a plain name inside the recordings directory.
export function sanitizeSlug(s, fallback = 'confessional') {
  const out = String(s == null ? '' : s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return out || fallback;
}

// Local (not UTC) calendar date — a take shot at 11pm belongs to that evening's shoot, not
// tomorrow's, which is what a UTC-derived stamp would claim for most of the Americas.
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function takeName({ slug, date, take, ext = 'mp4' }) {
  return `${slug}-${date}-take${String(take).padStart(2, '0')}.${ext}`;
}

// Next free take number for this slug+date. Reads what is actually on disk rather than trusting a
// counter in the browser, so two booth windows (or a relaunched app) can never overwrite a take.
export async function nextTake(dir, slug, date) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return 1; }
  const re = new RegExp(`^${slug}-${date}-take(\\d+)\\.`);
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  return max + 1;
}

// ffmpeg arguments that turn a browser recording into an editable master.
//   -fps_mode cfr   constant frame rate (kills the VFR audio drift an NLE would inherit)
//   +faststart      moov box up front, so the file plays/scrubs while still being copied
// Exported so the test suite can assert the shape without running ffmpeg.
export function normalizeArgs(src, out, encodeArgs, { cfr = true } = {}) {
  return [
    '-y', '-hide_banner',
    '-fflags', '+genpts',          // MediaRecorder's first packet is not always at t=0
    '-i', src,
    ...(cfr ? ['-fps_mode', 'cfr'] : []),
    ...encodeArgs,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ];
}

// Transcode `src` (whatever the browser recorded) to a faststart MP4 at `out`.
// `-fps_mode` only exists from ffmpeg 5.1; on an older build the first pass fails immediately on
// the unknown option, so we retry once without it rather than refusing the take.
export async function normalizeTake(src, out) {
  const enc = await videoEncodeArgs();
  try {
    await ffmpeg(normalizeArgs(src, out, enc));
  } catch (e) {
    if (!/fps_mode|Unrecognized option|Option not found/i.test(String(e.message || e))) throw e;
    await ffmpeg(normalizeArgs(src, out, enc, { cfr: false }));
  }
  return out;
}

// Takes already in the library, newest first — what the booth's strip and the "last take" link
// read. Cheap enough to call on every booth open (one readdir + stat per file).
export async function listTakes(dir, limit = 24) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/\.(mp4|webm|mkv|mov)$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      out.push({ name, path: full, bytes: st.size, ts: st.mtimeMs });
    } catch { /* vanished between readdir and stat — just skip it */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
