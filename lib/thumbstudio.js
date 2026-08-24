// Thumbnail Studio — compose a clean, creator-style YouTube thumbnail from data PepStudio
// already has: a peak frame (cover candidates), the project's facecam box (facecam split), and
// a 1–3 word title. Pure ffmpeg (zero runtime deps — no sharp/canvas), one invocation.
//
// Layout follows the "clean thumbnail" rules: max 3 elements — blurred/saturated gameplay frame
// (background), the facecam crop with a tight cyan rim-glow on the RIGHT (YouTube's duration
// badge covers bottom-right), and bold white stroke-text bottom-LEFT, rotated -2°.
// Honest scope: the "cutout" is the rectangular facecam crop — no fake ML segmentation claims.
import { ffmpeg } from './ff.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const esc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
const ev = (n) => Math.max(2, Math.round(n) & ~1);

// file: source video · t: peak-frame time (s) · camRect: normalized {x,y,w,h} or null ·
// text: 1–3 words · fontFile: absolute font path (caller resolves; falls back to no-font drawtext)
export async function buildViralThumb(file, t, camRect, text, outFile, { fontFile = null, srcW = 1920, srcH = 1080, badge = '' } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-thumb-'));
  try {
    // Text via textfile= (same trick as the caption burner) so apostrophes/percent can't corrupt
    // the graph. Uppercased, clamped to 3 words / 28 chars — the squint-test rule.
    const words = String(text || '').trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, 28) || 'CLIPPED';
    const tf = path.join(tmp, 't.txt');
    await fs.writeFile(tf, words, 'utf8');

    const parts = [];
    let last = 'bg';
    parts.push('[0:v]split=2[b0][c0]');
    // Background: fill 1280x720, cool it down slightly + saturate + soft blur so the subject pops.
    parts.push('[b0]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=saturation=1.25:brightness=-0.05,gblur=sigma=3[bg]');

    if (camRect && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(camRect[k]))) {
      const cx = ev(camRect.x * srcW), cy = ev(camRect.y * srcH);
      const cw = ev(Math.min(camRect.w * srcW, srcW - cx)), ch = ev(Math.min(camRect.h * srcH, srcH - cy));
      const camW = 640, camH = ev(camW * ch / cw);
      // Face crop, sharpened. Tight rim-glow = a cyan card 16px larger, blurred into a
      // transparent margin (10–15px spread — the "tight glow" rule), face overlaid on top.
      parts.push(`[c0]crop=${cw}:${ch}:${cx}:${cy},scale=${camW}:${camH},unsharp=5:5:0.8:3:3:0.0[cam]`);
      const gw = camW + 16, gh = camH + 16;
      parts.push(`color=c=0x00E5FF@0.9:s=${gw}x${gh},format=rgba,pad=${gw + 40}:${gh + 40}:20:20:color=0x00000000,gblur=sigma=9[glow]`);
      const glowX = 1280 - (gw + 40) - 10, glowY = 22;
      parts.push(`[bg][glow]overlay=${glowX}:${glowY}[b1]`);
      parts.push(`[b1][cam]overlay=${glowX + 28}:${glowY + 28}[b2]`);
      last = 'b2';
    }

    // Bold white stroke-text, bottom-left, -2° tilt (rendered on a transparent canvas then
    // rotated with c=none so the tilt doesn't smear the composite).
    const dt = [
      `textfile='${esc(tf)}'`,
      fontFile ? `fontfile='${esc(fontFile)}'` : null,
      'fontsize=104', 'fontcolor=white',
      'borderw=7', 'bordercolor=black',
      'shadowcolor=black@0.8', 'shadowx=0', 'shadowy=8',
      'x=64', 'y=560',
    ].filter(Boolean).join(':');
    parts.push(`color=c=black@0.0:s=1280x720,format=rgba,drawtext=${dt}[t0]`);
    parts.push('[t0]rotate=-2*PI/180:c=none[txt]');
    // Optional top-left badge pill ("STREAM HIGHLIGHTS") — unrotated, drawn straight on the
    // composite. drawtext's box gives the red pill; kept small so it never fights the 3 elements.
    let tail = `[${last}][txt]overlay=0:0`;
    const badgeWords = String(badge || '').trim().toUpperCase().slice(0, 22);
    if (badgeWords) {
      const bf = path.join(tmp, 'b.txt');
      await fs.writeFile(bf, badgeWords, 'utf8');
      const bd = [
        `textfile='${esc(bf)}'`,
        fontFile ? `fontfile='${esc(fontFile)}'` : null,
        'fontsize=30', 'fontcolor=white',
        'box=1', 'boxcolor=0xE02020@0.95', 'boxborderw=12',
        'x=30', 'y=30',
      ].filter(Boolean).join(':');
      tail += `[t1];[t1]drawtext=${bd}`;
    }
    parts.push(`${tail},format=yuvj420p[out]`);

    await ffmpeg([
      '-nostdin', '-y', '-ss', String(t), '-i', file,
      '-filter_complex', parts.join(';'),
      '-map', '[out]', '-frames:v', '1', '-q:v', '2',
      outFile,
    ]);
    return outFile;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
