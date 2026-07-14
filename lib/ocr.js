// OCR bridge: extract a (optionally cropped) video frame with ffmpeg, then recognize on-device
// text with the Swift/Vision helper (native/pep-ocr). Game adapters call ocrFrame() to read HUD
// regions (scoreboard, killfeed, chat) and turn them into narrative event tokens. On-device Vision
// → no network, no API key, Neural-Engine accelerated.
import { execFile } from 'node:child_process';
import { ffmpeg } from './ff.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native');
const SRC = path.join(NATIVE, 'pep-ocr.swift');
// The compiled binary must go to a WRITABLE dir — inside a packaged .app the bundle (and thus
// native/) is read-only, so compiling next to the source fails at runtime. Default to a temp cache;
// PEP_OCR_BIN overrides (e.g. the Electron shell can point it at userData). swiftc is ~1s so a
// tmp-cache miss after reboot is cheap.
const BIN = process.env.PEP_OCR_BIN || path.join(os.tmpdir(), 'pep-ocr');

// Compile the Swift helper on first use (and whenever the source is newer than the binary). The
// binary is a build artifact — gitignored — so a fresh checkout builds it once via swiftc.
let _compiling = null;
async function ensureBinary() {
  try {
    const [b, s] = await Promise.all([fsp.stat(BIN), fsp.stat(SRC)]);
    if (b.mtimeMs >= s.mtimeMs) return BIN;
  } catch { /* missing binary → compile below */ }
  if (!_compiling) {
    _compiling = new Promise((resolve, reject) => {
      execFile('swiftc', ['-O', '-o', BIN, SRC, '-framework', 'Vision', '-framework', 'AppKit'],
        (err) => (err ? reject(new Error(`pep-ocr compile failed (need Xcode swiftc): ${err.message}`)) : resolve(BIN)));
    }).finally(() => { _compiling = null; });
  }
  return _compiling;
}

// True when OCR can run here (source present so it can be built, or already built).
export function ocrAvailable() { return fs.existsSync(SRC) || fs.existsSync(BIN); }

// Recognize text in an image file. Returns [{text, confidence, x, y, w, h}] — box normalized 0–1,
// top-left origin (so it maps straight onto the crop rect below).
export async function ocrImage(imgPath, { fast = false } = {}) {
  const bin = await ensureBinary();
  const stdout = await new Promise((resolve, reject) => {
    execFile(bin, fast ? [imgPath, 'fast'] : [imgPath], { maxBuffer: 8 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });
  try { return JSON.parse(stdout).lines || []; } catch { return []; }
}

// Extract one frame at time `t`, optionally cropped to a normalized rect {x,y,w,h} (0–1), and OCR
// it. Small HUD glyphs are upscaled (scale) first so Vision resolves them reliably.
export async function ocrFrame(file, t, { crop, fast = false, scale = 2 } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pep-ocr-'));
  const png = path.join(tmp, 'f.png');
  try {
    const filters = [];
    if (crop) filters.push(`crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`);
    if (scale && scale !== 1) filters.push(`scale=iw*${scale}:ih*${scale}:flags=lanczos`);
    const vf = filters.length ? ['-vf', filters.join(',')] : [];
    await ffmpeg(['-nostdin', '-y', '-ss', String(Math.max(0, t)), '-i', file, ...vf, '-frames:v', '1', png]);
    return await ocrImage(png, { fast });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
