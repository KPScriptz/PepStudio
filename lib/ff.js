// Thin helpers around ffmpeg / ffprobe.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Nice value for spawned encoders. ffmpeg/whisper are CPU-hungry; running them a few notches below
// normal priority keeps the Node event loop (status polls) and the Electron UI thread responsive
// during a big export, at negligible throughput cost on the 6 perf cores. PEP_NICE overrides;
// PEP_NICE=0 disables. Positive nice is always permitted (no elevated privileges needed).
const CHILD_NICE = Number.isFinite(Number(process.env.PEP_NICE)) ? Number(process.env.PEP_NICE) : 5;
export function deprioritize(pid) {
  if (!CHILD_NICE || !pid) return;
  try { os.setPriority(pid, CHILD_NICE); } catch { /* not fatal — priority is best-effort */ }
}

// Prefer a libass-enabled build (keg-only ffmpeg-full) so we can burn captions,
// then an explicit override, then whatever is on PATH.
function resolveBin(envVar, full, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  if (fs.existsSync(full)) return full;
  return fallback;
}
const FFMPEG = resolveBin('FFMPEG_PATH', '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', 'ffmpeg');
const FFPROBE = resolveBin('FFPROBE_PATH', '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe', 'ffprobe');

// Run a process, collect stdout as a Buffer and stderr as a string.
// onStderr (optional) is called with each stderr chunk for progress parsing.
export function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    deprioritize(child.pid);
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else if (signal || code === null) {
        // Killed, not failed (code is null when a signal ended the process). Say so —
        // "exited null" + a stderr dump reads like corruption when it's just an interrupt.
        reject(new Error(`${path.basename(bin)} was interrupted (${signal || 'killed'}) — run it again.`));
      } else {
        // Real failure: surface only the last meaningful stderr lines. ffmpeg interleaves
        // progress spam with the actual error, and a 4KB wall in a UI toast buries the cause.
        const tail = err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join('\n').slice(-400);
        reject(new Error(`${path.basename(bin)} exited ${code}: ${tail}`));
      }
    });
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, args, opts);
export const ffprobe = (args, opts) => run(FFPROBE, args, opts);

// Cache of available filter names for capability checks (e.g. whether we can burn captions).
let _filters = null;
export async function hasFilter(name) {
  if (!_filters) {
    try {
      const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters']);
      _filters = new Set(
        stdout.toString().split('\n')
          .map((l) => l.trim().split(/\s+/)[1])
          .filter(Boolean),
      );
    } catch { _filters = new Set(); }
  }
  return _filters.has(name);
}

// Video encoder selection (probed once, cached).
const SW_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
const HW_ENCODE = ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
// Benchmarked 2026-07-02 on M1 Pro (60s 1080x1920 vertical, lanczos+unsharp chain):
// libx264 veryfast 7.4s / VT q:v65 9.2s and +20% file size — this pipeline is
// filter-bound, so software x264 stays the DEFAULT. Set PEP_ENCODER=vt to opt into
// hardware encoding when you want the CPU free (battery, concurrent whisper/analysis).
let _encArgs = null;
export async function videoEncodeArgs() {
  if (_encArgs) return _encArgs;
  if (process.env.PEP_ENCODER === 'vt') {
    try {
      await run(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
        '-c:v', 'h264_videotoolbox', '-f', 'null', '-']);
      console.log('[encode] VideoToolbox hardware encoder active (PEP_ENCODER=vt)');
      return (_encArgs = HW_ENCODE);
    } catch { console.log('[encode] VideoToolbox unavailable — falling back to libx264'); }
  }
  return (_encArgs = SW_ENCODE);
}

// Escape a file path for use inside an ffmpeg filtergraph (subtitles=...).
export function filterEscapePath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Probe basic media info.
export async function probe(file) {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(stdout.toString() || '{}');
  const v = (j.streams && j.streams[0]) || {};
  const fmtDur = j.format && parseFloat(j.format.duration);
  const strDur = v.duration && parseFloat(v.duration);
  const duration = Number.isFinite(fmtDur) ? fmtDur : (Number.isFinite(strDur) ? strDur : 0);
  let fps = 30;
  if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  return { width: v.width || 0, height: v.height || 0, fps: Math.round(fps * 100) / 100, duration };
}

// Whether an audio stream exists.
export async function hasAudio(file) {
  try {
    const { stdout } = await ffprobe([
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file,
    ]);
    return stdout.toString().trim().startsWith('audio');
  } catch {
    return false;
  }
}
