// Rendering: stitch the long cut, cut vertical shorts, grab thumbnails. Optional burned-in captions.
import { ffmpeg, hasFilter, filterEscapePath } from './ff.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';

// True only when this ffmpeg build can render text (libass).
export async function canBurnCaptions() { return hasFilter('subtitles'); }

const esc = filterEscapePath;

// A concrete font for drawtext (overlay text). drawtext needs an explicit font on builds
// without fontconfig wired up; pick the first macOS system font that exists.
const DRAWTEXT_FONT = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/HelveticaNeue.ttc',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
].find((f) => { try { return existsSync(f); } catch { return false; } }) || null;

// Build a trim+concat filtergraph for a list of [start,end] segments (video+audio).
function concatGraph(segments) {
  const parts = [];
  const labels = [];
  segments.forEach(([s, e], i) => {
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=1[v][a]`);
  return parts.join(';');
}

// Multi-track sequence render: trim each clip in the given OUTPUT order, burn its text
// overlays, and concat — all in ONE filter_complex pass. `segments` (ordered):
//   [{ start, end, overlays?: [{ type:'text', content, startTime?, endTime?,
//                                style?: { fontSize, fontColor, x, y } }] }]
// Overlay start/endTime are CLIP-RELATIVE (each segment's PTS resets to 0). `vertical` → 1080x1920.
export async function exportSequence(file, segments, outFile, { vertical = true } = {}) {
  if (!segments || !segments.length) throw new Error('No segments to render.');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-seq-'));
  try {
    // Collect b-roll image overlays → extra ffmpeg inputs (input 0 = the source video).
    // Existing image files only, so one bad path can't fail the whole render.
    const slotOf = new Map();
    const imageInputs = [];
    for (const seg of segments) {
      for (const ov of (seg.overlays || [])) {
        if (ov && ov.type === 'broll' && ov.content && existsSync(ov.content)) {
          slotOf.set(ov, imageInputs.length + 1);
          imageInputs.push(ov.content);
        }
      }
    }

    // Audio assets (ASSET-AGNOSTIC — only user-supplied paths that exist; never bundled/named
    // sounds). Inputs come AFTER the video + b-roll images; one -i per occurrence so the same
    // file reused twice can't trip ffmpeg's "input label referenced multiple times".
    const audioSlot = new Map();
    const audioInputs = [];
    const audioBase = 1 + imageInputs.length;
    for (const seg of segments) {
      const auto = seg.automation || {};
      if (auto.bgMusic && auto.bgMusic.path && existsSync(auto.bgMusic.path)) {
        audioSlot.set(auto.bgMusic, audioBase + audioInputs.length);
        audioInputs.push(auto.bgMusic.path);
      }
      for (const sfx of (auto.sfxTrack || [])) {
        if (sfx && sfx.asset && existsSync(sfx.asset)) {
          audioSlot.set(sfx, audioBase + audioInputs.length);
          audioInputs.push(sfx.asset);
        }
      }
    }

    const parts = [];
    const pairs = [];
    const base = vertical ? 'crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1,' : '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      parts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS,${base}format=yuv420p[v${i}b]`);
      let cur = `v${i}b`;

      // Emphasis punch-in zoom (scale-up→crop) BEFORE overlays, so text/images aren't distorted.
      if (seg.zoomFilter) { parts.push(`[${cur}]${seg.zoomFilter}[v${i}z]`); cur = `v${i}z`; }

      // Text overlays (burned via textfile to dodge drawtext escaping of apostrophes/colons/%).
      const texts = (seg.overlays || []).filter((o) => o && o.type === 'text' && o.content);
      for (let k = 0; k < texts.length; k++) {
        const ov = texts[k];
        const st = ov.style || {};
        const tf = path.join(tmp, `t${i}_${k}.txt`);
        await fs.writeFile(tf, String(ov.content), 'utf8');
        const dt = [
          `textfile='${esc(tf)}'`,
          DRAWTEXT_FONT ? `fontfile='${esc(DRAWTEXT_FONT)}'` : null,
          `fontcolor=${st.fontColor || 'white'}`,
          `fontsize=${st.fontSize || 56}`,
          `x=${st.x || '(w-tw)/2'}`,
          `y=${st.y || 'h-h/6'}`,
          'box=1:boxcolor=black@0.45:boxborderw=16',
          (Number.isFinite(ov.startTime) && Number.isFinite(ov.endTime))
            ? `enable='between(t,${ov.startTime},${ov.endTime})'` : null,
        ].filter(Boolean).join(':');
        const next = `v${i}t${k}`;
        parts.push(`[${cur}]drawtext=${dt}[${next}]`);
        cur = next;
      }

      // B-roll image overlays: scale the asset to ~70% width, composite centered during its window.
      const brolls = (seg.overlays || []).filter((o) => slotOf.has(o));
      for (let k = 0; k < brolls.length; k++) {
        const ov = brolls[k];
        const slot = slotOf.get(ov);
        const img = `bi${i}_${k}`;
        parts.push(`[${slot}:v]scale=756:-2[${img}]`);
        const en = (Number.isFinite(ov.startTime) && Number.isFinite(ov.endTime))
          ? `:enable='between(t,${ov.startTime},${ov.endTime})'` : '';
        const next = `v${i}o${k}`;
        parts.push(`[${cur}][${img}]overlay=x=(W-w)/2:y=(H-h)/2${en}[${next}]`);
        cur = next;
      }

      // Audio: speech, optionally mixed with ducked bgMusic + delayed SFX. amix normalize=0
      // keeps speech full-volume and adds the layers on top (default would average/quiet it).
      parts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}s]`);
      const auto = seg.automation || {};
      const mixLabels = [`a${i}s`];
      const dur = (seg.end - seg.start).toFixed(3);
      if (auto.bgMusic && audioSlot.has(auto.bgMusic)) {
        const ms = audioSlot.get(auto.bgMusic);
        parts.push(`[${ms}:a]atrim=end=${dur},asetpts=PTS-STARTPTS,volume=${Number(auto.bgMusic.volume) || 0.15}[a${i}m]`);
        mixLabels.push(`a${i}m`);
      }
      (auto.sfxTrack || []).forEach((sfx, k) => {
        if (!audioSlot.has(sfx)) return;
        const ss = audioSlot.get(sfx);
        const delayMs = Math.max(0, Math.round((Number(sfx.time) || 0) * 1000));
        parts.push(`[${ss}:a]adelay=${delayMs}|${delayMs},volume=${Number(sfx.volume) || 0.5}[a${i}x${k}]`);
        mixLabels.push(`a${i}x${k}`);
      });
      let aLabel = `a${i}s`;
      if (mixLabels.length > 1) {
        aLabel = `a${i}mix`;
        parts.push(`${mixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[${aLabel}]`);
      }
      pairs.push(`[${cur}][${aLabel}]`);
    }
    parts.push(`${pairs.join('')}concat=n=${segments.length}:v=1:a=1[v][a]`);

    const inputs = ['-i', file];
    for (const img of imageInputs) inputs.push('-i', img);
    for (const a of audioInputs) inputs.push('-i', a);
    await ffmpeg([
      '-y', ...inputs,
      '-filter_complex', parts.join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-movflags', '+faststart',
      outFile,
    ]);
    return outFile;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Long-form cut: keep only the provided segments, optionally burn subtitles (.ass path).
export async function exportLongCut(file, segments, outFile, { subs } = {}) {
  const segs = segments.filter(([s, e]) => e - s > 0.05);
  if (!segs.length) throw new Error('No segments to export');
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  let graph = concatGraph(segs);
  let vmap = '[v]';
  const burn = subs && (await canBurnCaptions());
  if (burn) {
    // Append subtitle burn after concat.
    graph = graph.replace('[v]', '[vc]') + `;[vc]subtitles='${esc(subs)}'[v]`;
  }
  const args = [
    '-nostdin', '-y', '-i', file,
    '-filter_complex', graph,
    '-map', vmap, '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outFile,
  ];
  await ffmpeg(args);
  return outFile;
}

// One vertical 9:16 short from [start,end], center-cropped, optional captions.
export async function exportShort(file, start, end, outFile, { subs, zoomFilter } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let vf = `crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1`;
  // Emphasis punch-in (scale-up-per-frame → constant center crop). `-ss` input-trim makes
  // vf `t` clip-relative, matching the zoom's clip-relative `between(t,...)` windows.
  if (zoomFilter) vf += `,${zoomFilter}`;
  if (subs && (await canBurnCaptions())) vf += `,subtitles='${esc(subs)}'`;
  const args = [
    '-nostdin', '-y',
    '-ss', String(start), '-to', String(end), '-i', file,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outFile,
  ];
  await ffmpeg(args);
  return outFile;
}

// Burn an .ass onto an already-rendered file (2nd pass). Used for the YouTube cut, whose
// captions must be transcribed AFTER the re-timed concat so they line up perfectly.
export async function burnSubs(file, assPath, outFile) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await ffmpeg([
    '-nostdin', '-y', '-i', file,
    '-vf', `subtitles='${esc(assPath)}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'copy', '-movflags', '+faststart', outFile,
  ]);
  return outFile;
}

// Single still frame at time t (for thumbnails / timeline previews).
export async function grabFrame(file, t, outFile, { width = 1280 } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await ffmpeg([
    '-nostdin', '-y', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', outFile,
  ]);
  return outFile;
}
