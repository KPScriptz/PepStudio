// Rendering: stitch the long cut, cut vertical shorts, grab thumbnails. Optional burned-in captions.
import { ffmpeg, hasFilter, filterEscapePath } from './ff.js';
import path from 'node:path';
import fs from 'node:fs/promises';

// True only when this ffmpeg build can render text (libass).
export async function canBurnCaptions() { return hasFilter('subtitles'); }

const esc = filterEscapePath;

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
export async function exportShort(file, start, end, outFile, { subs } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let vf = `crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1`;
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

// Single still frame at time t (for thumbnails / timeline previews).
export async function grabFrame(file, t, outFile, { width = 1280 } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await ffmpeg([
    '-nostdin', '-y', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', outFile,
  ]);
  return outFile;
}
