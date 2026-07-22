// Rendering: stitch the long cut, cut vertical shorts, grab thumbnails. Optional burned-in captions.
import { ffmpeg, ffprobe, hasFilter, filterEscapePath, videoEncodeArgs } from './ff.js';
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

// Multi-track sequence render: render each clip (in the given OUTPUT order) INDEPENDENTLY —
// fast input seek, vertical reframe, emphasis zoom, text/b-roll overlays, audio mix — to a
// temp file with IDENTICAL encode params, then concat-copy the temps (measured ~1s, no second
// encode pass). One clip at a time lets each encode use the whole machine; N fast-seek inputs
// sharing one filter_complex measured ~3.4x slower end-to-end (I/O contention pulling a
// multi-GB source through N handles at once). `segments` (ordered):
//   [{ start, end, overlays?: [{ type:'text', content, startTime?, endTime?,
//                                style?: { fontSize, fontColor, x, y } }], zoomFilter?, automation? }]
// Overlay start/endTime are CLIP-RELATIVE (each clip's PTS resets to 0). `vertical` → 1080x1920.
export async function exportSequence(file, segments, outFile, { vertical = true, fps, draft = false } = {}) {
  if (!segments || !segments.length) throw new Error('No segments to render.');
  // Highlight/story cuts are for upload, not mastering — 30fps is the platform standard and halves
  // the frames to encode (measured ~1.56x faster + smaller files than a 60fps source). Overridable
  // via the `fps` option or PEP_SEQ_FPS (e.g. set 60 for a full-rate render). A fixed fps also
  // keeps every temp clip identical, which is what makes the final concat a pure stream copy.
  const outFps = Number(fps) || Number(process.env.PEP_SEQ_FPS) || 30;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-seq-'));
  try {
    const base = vertical ? 'crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1,' : '';
    const encArgs = draft
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
      : await videoEncodeArgs();
    const clipFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const dur = (seg.end - seg.start).toFixed(3);

      // Per-clip extra inputs: input 0 = this fast-seeked clip; then b-roll images; then audio
      // assets (ASSET-AGNOSTIC — only user-supplied paths that exist; never bundled/named
      // sounds). One -i per occurrence so a file reused twice can't trip label collisions.
      const slotOf = new Map();
      const imageInputs = [];
      for (const ov of (seg.overlays || [])) {
        if (ov && ov.type === 'broll' && ov.content && existsSync(ov.content)) {
          slotOf.set(ov, 1 + imageInputs.length);
          imageInputs.push(ov.content);
        }
      }
      const audioSlot = new Map();
      const audioInputs = [];
      const audioBase = 1 + imageInputs.length;
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

      const parts = [];
      // Input 0 is already fast-seeked to [start, start+dur) — just reset PTS + reframe.
      // (A filter trim here would force decoding the whole source up to seg.start.)
      parts.push(`[0:v]setpts=PTS-STARTPTS,${base}format=yuv420p[vb]`);
      let cur = 'vb';

      // Emphasis punch-in zoom (scale-up→crop) BEFORE overlays, so text/images aren't distorted.
      if (seg.zoomFilter) { parts.push(`[${cur}]${seg.zoomFilter}[vz]`); cur = 'vz'; }

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
        parts.push(`[${cur}]drawtext=${dt}[vt${k}]`);
        cur = `vt${k}`;
      }

      // B-roll image overlays: scale the asset to ~70% width, composite centered during its window.
      const brolls = (seg.overlays || []).filter((o) => slotOf.has(o));
      for (let k = 0; k < brolls.length; k++) {
        const ov = brolls[k];
        const slot = slotOf.get(ov);
        parts.push(`[${slot}:v]scale=756:-2[bi${k}]`);
        const en = (Number.isFinite(ov.startTime) && Number.isFinite(ov.endTime))
          ? `:enable='between(t,${ov.startTime},${ov.endTime})'` : '';
        parts.push(`[${cur}][bi${k}]overlay=x=(W-w)/2:y=(H-h)/2${en}[vo${k}]`);
        cur = `vo${k}`;
      }

      // Draft/preview: downscale this clip to 720p — a fast, low-res proof to iterate on
      // before committing to the full-res render.
      if (draft) { parts.push(`[${cur}]scale=-2:720[vd]`); cur = 'vd'; }

      // Audio: speech, optionally mixed with ducked bgMusic + delayed SFX. amix normalize=0
      // keeps speech full-volume and adds the layers on top (default would average/quiet it).
      parts.push('[0:a]asetpts=PTS-STARTPTS[as]');
      const mixLabels = ['as'];
      if (auto.bgMusic && audioSlot.has(auto.bgMusic)) {
        const ms = audioSlot.get(auto.bgMusic);
        parts.push(`[${ms}:a]atrim=end=${dur},asetpts=PTS-STARTPTS,volume=${Number(auto.bgMusic.volume) || 0.15}[am]`);
        mixLabels.push('am');
      }
      (auto.sfxTrack || []).forEach((sfx, k) => {
        if (!audioSlot.has(sfx)) return;
        const ss = audioSlot.get(sfx);
        const delayMs = Math.max(0, Math.round((Number(sfx.time) || 0) * 1000));
        parts.push(`[${ss}:a]adelay=${delayMs}|${delayMs},volume=${Number(sfx.volume) || 0.5}[ax${k}]`);
        mixLabels.push(`ax${k}`);
      });
      let aLabel = 'as';
      if (mixLabels.length > 1) {
        aLabel = 'amix';
        parts.push(`${mixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[amix]`);
      }

      // Software decode (no -hwaccel): this chain is filter-bound on x264, and hw decode measured
      // SLOWER here (GPU→CPU frame download at full res dominates). Sequential per-clip renders
      // would be VT-session-safe, but there's nothing to win.
      const inputs = ['-ss', String(seg.start), '-t', dur, '-i', file];
      for (const img of imageInputs) inputs.push('-i', img);
      for (const a of audioInputs) inputs.push('-i', a);

      const clipOut = path.join(tmp, `clip${String(i).padStart(3, '0')}.mp4`);
      await ffmpeg([
        '-nostdin', '-y', ...inputs,
        '-filter_complex', parts.join(';'),
        '-map', `[${cur}]`, '-map', `[${aLabel}]`,
        '-r', String(outFps),
        ...encArgs,
        '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart',
        clipOut,
      ]);
      clipFiles.push(clipOut);
    }

    // Concat-copy the identically-encoded temps — measured ~1s. No second encode pass.
    if (clipFiles.length === 1) {
      await fs.copyFile(clipFiles[0], outFile);
    } else {
      const listFile = path.join(tmp, 'concat.txt');
      await fs.writeFile(listFile, clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
      await ffmpeg([
        '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', outFile,
      ]);
    }
    return outFile;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Zero-re-encode long cut: concat-demuxer inpoint/outpoint spans of the SAME source with
// `-c copy` — pixels are never touched, so the whole cut is I/O-bound (seconds instead of a
// full re-encode of ~45 min of video). Trade: stream copy can only start a span at a keyframe,
// so each seam snaps BACK to the previous keyframe (~6s GOP on this footage) — i.e. the cut
// errs toward keeping a few seconds of extra lead-in context instead of chopping mid-word.
// Right trade for dead-air removal; anything needing pixel work (caption burn) re-encodes.
async function exportLongCutCopy(file, segs, outFile) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-cut-'));
  try {
    // Keyframe scan is packet headers only, no decode — measured 2s on a 2.2GB 68-min VOD.
    // Snapping every span's START back to a keyframe keeps each copied GOP self-contained,
    // which is what keeps the seam timestamps monotonic (unsnapped inpoints measured 25
    // dts-order errors across 6 seams — players stutter there).
    const { stdout } = await ffprobe([
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file,
    ]);
    const kfs = String(stdout).split('\n')
      .filter((l) => l.includes('K'))
      .map((l) => parseFloat(l))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const snapBack = (t) => {
      let lo = 0, hi = kfs.length - 1, best = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (kfs[m] <= t) { best = kfs[m]; lo = m + 1; } else hi = m - 1; }
      return best;
    };
    // Snap starts back, then merge anything that now overlaps or touches.
    const snapped = segs.map(([s, e]) => [kfs.length ? snapBack(s) : s, e]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of snapped) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 0.01) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }

    // Copy-extract each span to its own temp file, then concat the FILES (no inpoint/outpoint).
    // Each extract rebases timestamps to 0, so the final stitch is monotonic — inpoint/outpoint
    // on one shared source measured residual dts-order collisions at seams (B-frame dts<pts
    // crossing each boundary offset). This is the LosslessCut architecture.
    const parts = [];
    for (let i = 0; i < merged.length; i++) {
      const [s, e] = merged[i];
      const segFile = path.join(tmp, `seg${String(i).padStart(3, '0')}.mp4`);
      await ffmpeg([
        '-nostdin', '-y', '-ss', s.toFixed(3), '-t', (e - s).toFixed(3), '-i', file,
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', segFile,
      ]);
      parts.push(segFile);
    }
    const listFile = path.join(tmp, 'concat.txt');
    await fs.writeFile(listFile, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    await ffmpeg([
      '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart', outFile,
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

  // No caption burn = no pixel work = stream-copy fast path (measured 24s vs a 10+ min
  // re-encode on a real 68-min VOD). Cuts snap to keyframes (looser but pixel-perfect);
  // PEP_EXACT_CUT=1 forces the frame-exact re-encode path when tightness matters more.
  const burn = subs && (await canBurnCaptions());
  if (!burn && process.env.PEP_EXACT_CUT !== '1') return exportLongCutCopy(file, segs, outFile);

  let graph = concatGraph(segs);
  let vmap = '[v]';
  // Only the caption-burn path reaches here (everything else stream-copies above).
  graph = graph.replace('[v]', '[vc]') + `;[vc]subtitles='${esc(subs)}'[v]`;
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
