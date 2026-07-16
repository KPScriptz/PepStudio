// Rendering: stitch the long cut, cut vertical shorts, grab thumbnails. Optional burned-in captions.
import { ffmpeg, hasFilter, filterEscapePath, videoEncodeArgs } from './ff.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';

// Hardware-accelerated DECODE of the source (Apple VideoToolbox media engine). Applied per
// source `-i` so ffmpeg offloads H.264/HEVC decode off the CPU, leaving cores free for the
// software filter chains (crop/scale/subtitles) and the parallel pack's whisper passes. Frames
// are auto-downloaded to system memory for those filters. Independent of the ENCODER policy in
// ff.js (x264 stays the default). Set PEP_HWDECODE=off to fall back to software decode.
const HWDECODE = process.env.PEP_HWDECODE === 'off' ? [] : ['-hwaccel', 'videotoolbox'];

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

// Sanitize drawtext style fields that flow from request bodies into the filter_complex string.
// drawtext options are colon-delimited and the graph itself is comma/semicolon/bracket-delimited,
// so ONE stray delimiter in a color/position corrupts the whole graph and fails the render. Colors
// allow alnum + # @ . (hex, named, name@alpha); positions allow ffmpeg expression chars only
// ((w-tw)/2, h-h/6); anything else falls back to the default. Font size is coerced + clamped.
const safeColor = (c, fb) => (typeof c === 'string' && /^[\w@#.]+$/.test(c) ? c : fb);
const safePos = (p, fb) => (
  typeof p === 'number' && Number.isFinite(p) ? String(p)
    : typeof p === 'string' && /^[\w\s.+\-*/()]+$/.test(p) ? p : fb
);
const safeSize = (s) => { const n = Number(s); return Number.isFinite(n) ? Math.min(400, Math.max(8, Math.round(n))) : 56; };

// Monotonic counter for unique temp filenames (two concurrent grabs of the SAME timestamp must
// not collide on the temp path they render to before the atomic rename).
let _tmpSeq = 0;

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
export async function exportSequence(file, segments, outFile, { vertical = true, fps, draft = false } = {}) {
  if (!segments || !segments.length) throw new Error('No segments to render.');
  // Highlight/story cuts are for upload, not mastering — 30fps is the platform standard and halves
  // the frames to encode (measured ~1.56x faster + smaller files than a 60fps source). Overridable
  // via the `fps` option or PEP_SEQ_FPS (e.g. set 60 for a full-rate render).
  const outFps = Number(fps) || Number(process.env.PEP_SEQ_FPS) || 30;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-seq-'));
  try {
    // Collect b-roll image overlays → extra ffmpeg inputs (input 0 = the source video).
    // Existing image files only, so one bad path can't fail the whole render.
    const slotOf = new Map();
    const imageInputs = [];
    for (const seg of segments) {
      for (const ov of (seg.overlays || [])) {
        if (ov && ov.type === 'broll' && ov.content && existsSync(ov.content)) {
          // Inputs are: N video clips (0..N-1), then images, then audio. Image slot = after the clips.
          slotOf.set(ov, segments.length + imageInputs.length);
          imageInputs.push(ov.content);
        }
      }
    }

    // Audio assets (ASSET-AGNOSTIC — only user-supplied paths that exist; never bundled/named
    // sounds). Inputs come AFTER the video + b-roll images; one -i per occurrence so the same
    // file reused twice can't trip ffmpeg's "input label referenced multiple times".
    const audioSlot = new Map();
    const audioInputs = [];
    const audioBase = segments.length + imageInputs.length;
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
      // Input `i` is already fast-seeked to this clip (-ss/-t), so just reset PTS — no filter trim
      // (a filter trim on a single input would force decoding the whole source up to seg.start).
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,${base}format=yuv420p[v${i}b]`);
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
          `fontcolor=${safeColor(st.fontColor, 'white')}`,
          `fontsize=${safeSize(st.fontSize)}`,
          `x=${safePos(st.x, '(w-tw)/2')}`,
          `y=${safePos(st.y, 'h-h/6')}`,
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
      parts.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}s]`);
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
    if (draft) {
      // Draft/preview: concat then downscale to 720p — a fast, low-res proof you can iterate on
      // before committing to the full-res render.
      parts.push(`${pairs.join('')}concat=n=${segments.length}:v=1:a=1[vc][a]`);
      parts.push('[vc]scale=-2:720[v]');
    } else {
      parts.push(`${pairs.join('')}concat=n=${segments.length}:v=1:a=1[v][a]`);
    }

    // Fast per-clip input seek: one `-ss start -t dur -i file` per segment so ffmpeg decodes only
    // each clip's span (keyframe-accurate seek), NOT the whole source from 0. On a long VOD this is
    // the difference between seconds and a full 68-min decode — the fix that made "Edit for Me" hang.
    // Software decode here (no per-segment -hwaccel): a sequence has ONE VideoToolbox decode session
    // per clip, and a real storyboard (~19 clips) blows past the media engine's ~16-session limit,
    // collapsing the encode to ~0.06x realtime (an 8-min cut would take ~2 hours). This chain is
    // filter-bound on x264 anyway, so hardware decode bought little. Single-clip renders keep it.
    const inputs = [];
    for (const seg of segments) {
      inputs.push('-ss', String(seg.start), '-t', String((seg.end - seg.start).toFixed(3)), '-i', file);
    }
    for (const img of imageInputs) inputs.push('-i', img);
    for (const a of audioInputs) inputs.push('-i', a);
    await ffmpeg([
      '-y', ...inputs,
      '-filter_complex', parts.join(';'),
      '-map', '[v]', '-map', '[a]',
      '-r', String(outFps),
      ...(draft ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : await videoEncodeArgs()),
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
  // Clamp start to 0 and keep only real, finite, forward ranges — a negative or NaN start would
  // otherwise reach `trim=start=...` and make ffmpeg behave unpredictably per build.
  const segs = segments
    .map(([s, e]) => [Math.max(0, Number(s)), Number(e)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e - s > 0.05);
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
    '-nostdin', '-y', ...HWDECODE, '-i', file,
    '-filter_complex', graph,
    '-map', vmap, '-map', '[a]',
    ...(await videoEncodeArgs()),
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
  // Light edge-preservation sharpen on the final pixels — BEFORE the caption burn so
  // glyph edges stay clean (no ringing). Makes game detail pop on phone screens.
  vf += ',unsharp=5:5:0.5:3:3:0.0';
  if (subs && (await canBurnCaptions())) vf += `,subtitles='${esc(subs)}'`;
  const args = [
    '-nostdin', '-y', ...HWDECODE,
    '-ss', String(start), '-to', String(end), '-i', file,
    '-vf', vf,
    // Mobile loudness target (-16 LUFS): quiet clips come up, screams stop clipping.
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    ...(await videoEncodeArgs()),
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
    '-nostdin', '-y', ...HWDECODE, '-i', file,
    '-vf', `subtitles='${esc(assPath)}'`,
    ...(await videoEncodeArgs()),
    '-c:a', 'copy', '-movflags', '+faststart', outFile,
  ]);
  return outFile;
}

// Single still frame at time t (for thumbnails / timeline previews). Renders to a unique temp
// file then atomically renames into place, so two overlapping requests for the same output can
// never make `res.sendFile` read a half-written JPEG (rename is atomic within a filesystem).
export async function grabFrame(file, t, outFile, { width = 1280 } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const tmpOut = `${outFile}.${process.pid}-${_tmpSeq++}.tmp.jpg`;
  try {
    await ffmpeg([
      '-nostdin', '-y', ...HWDECODE, '-ss', String(t), '-i', file,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', tmpOut,
    ]);
    await fs.rename(tmpOut, outFile);
  } finally {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
  return outFile;
}
