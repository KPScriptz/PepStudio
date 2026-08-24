// Rendering: stitch the long cut, cut vertical shorts, grab thumbnails. Optional burned-in captions.
import { ffmpeg, ffprobe, probe, hasFilter, filterEscapePath, videoEncodeArgs } from './ff.js';
import { concatLine, hwDecodeArgs, fontCandidates } from './platform.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';

// Hardware-accelerated DECODE of the source (Apple VideoToolbox media engine). Applied per
// source `-i` so ffmpeg offloads H.264/HEVC decode off the CPU, leaving cores free for the
// software filter chains (crop/scale/subtitles) and the parallel pack's whisper passes. Frames
// are auto-downloaded to system memory for those filters. Independent of the ENCODER policy in
// ff.js (x264 stays the default). Set PEP_HWDECODE=off to fall back to software decode.
const HWDECODE = hwDecodeArgs();

// True only when this ffmpeg build can render text (libass).
export async function canBurnCaptions() { return hasFilter('subtitles'); }

const esc = filterEscapePath;

// A concrete font for drawtext (overlay text). drawtext needs an explicit font on builds
// without fontconfig wired up; pick the first macOS system font that exists.
export const DRAWTEXT_FONT = fontCandidates().find((f) => { try { return existsSync(f); } catch { return false; } }) || null;

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
export async function exportSequence(file, segments, outFile, { vertical = true, fps, draft = false, res = 0, crf = 0, gainDb = 0, lut = null, look = null, watermark = null, vstyle = 'crop', voiceclean = false } = {}) {
  if (!segments || !segments.length) throw new Error('No segments to render.');
  // Highlight/story cuts are for upload, not mastering — 30fps is the platform standard and halves
  // the frames to encode (measured ~1.56x faster + smaller files than a 60fps source). Overridable
  // via the `fps` option or PEP_SEQ_FPS (e.g. set 60 for a full-rate render). A fixed fps also
  // keeps every temp clip identical, which is what makes the final concat a pure stream copy.
  const outFps = Number(fps) || Number(process.env.PEP_SEQ_FPS) || 30;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-seq-'));
  try {
    // Resolution preset: vertical → target WIDTH (720→720x1280, 1080→1920, 1440→2560);
    // horizontal → target HEIGHT via scale=-2 (caller clamps to source so we never upscale).
    const vw = Number(res) || 1080;
    const vh = Math.round(vw * 16 / 9 / 2) * 2;
    const base = vertical
      ? `crop=ih*9/16:ih,scale=${vw}:${vh}:flags=lanczos,setsar=1,`
      : (Number(res) ? `scale=-2:${Number(res)}:flags=lanczos,` : '');
    // Primary color correction (brightness/contrast/saturation), applied BEFORE the creative
    // LUT — the colorist order: correct first, then grade. Defaults build NO filter step, so an
    // untouched Look card keeps the chain byte-identical.
    const lk = look || {};
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const bri = Math.max(-0.3, Math.min(0.3, num(lk.bri, 0)));
    const con = Math.max(0.5, Math.min(1.5, num(lk.con, 1)));
    const sat = Math.max(0, Math.min(2, num(lk.sat, 1)));
    const eqStep = (bri !== 0 || con !== 1 || sat !== 1) ? `eq=brightness=${bri}:contrast=${con}:saturation=${sat},` : '';
    // Watermark overlay (user-supplied PNG, asset-agnostic): sized as a fraction of the OUTPUT
    // width, so geometry is fixed per export and every temp clip stays concat-identical. The
    // still image repeats for the clip's whole duration (overlay's default eof_action).
    let wmSpec = null;
    if (watermark && watermark.path && existsSync(watermark.path)) {
      let outW = vw;
      if (!vertical) {
        const meta = await probe(file);
        const srcW = meta.width || 1920, srcH = meta.height || 1080;
        outW = Number(res) ? Math.round(srcW * Number(res) / srcH / 2) * 2 : srcW;
      }
      const frac = Math.max(0.05, Math.min(0.3, num(watermark.size, 0.12)));
      const op = Math.max(0.1, Math.min(1, num(watermark.opacity, 0.6)));
      const m = Math.max(8, Math.round(outW * 0.02));
      const xy = {
        tl: `${m}:${m}`, tr: `W-w-${m}:${m}`,
        bl: `${m}:H-h-${m}`, br: `W-w-${m}:H-h-${m}`,
      }[watermark.pos] || `W-w-${m}:H-h-${m}`;
      wmSpec = { path: watermark.path, w: Math.max(16, Math.round(outW * frac / 2) * 2), op, xy };
    }
    // Quality preset: an explicit CRF forces the software x264 path (the quality knob is an x264
    // CRF; VideoToolbox's q:v is a different scale). No crf → the benchmarked default policy.
    const encArgs = draft
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
      : (Number(crf)
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p']
        : await videoEncodeArgs());
    const clipFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const dur = (seg.end - seg.start).toFixed(3);
      // Per-clip playback speed (Clip Insight, beta item 112): 0.25–4x. Video PTS divides; audio
      // runs an atempo chain (tempo without pitch shift — slow-mo stays natural, not chipmunked).
      // Everything time-based downstream (fades, mute windows, overlay enables) is converted to
      // OUTPUT seconds; the emphasis zoom's precomputed 1x windows can't be, so speed skips it.
      const speed = Math.max(0.25, Math.min(4, Number(seg.speed) || 1));
      const outDur = (seg.end - seg.start) / speed;
      const vpts = speed !== 1 ? `setpts=(PTS-STARTPTS)/${speed}` : 'setpts=PTS-STARTPTS';
      const ot = (t) => (speed !== 1 ? +(t / speed).toFixed(3) : t);   // source-rel → output seconds

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
      // Color look (user-supplied .cube LUT, asset-agnostic like music) — applied per clip so
      // every temp encodes identically and the final concat stays a pure stream copy.
      const lutStep = lut && existsSync(lut) ? `lut3d='${esc(lut)}',` : '';
      if (vertical && vstyle === 'blur') {
        // Blur-fill vertical: the FULL 16:9 frame centered over a blurred, zoomed copy of itself
        // (the standard Shorts letterbox look) instead of hard-cropping to 9:16. The background
        // is scaled to cover, cropped, then box-blurred; the foreground keeps every pixel.
        parts.push(`[0:v]${vpts},split=2[bf0${i}][bf1${i}]`);
        parts.push(`[bf0${i}]scale=${vw}:${vh}:force_original_aspect_ratio=increase:flags=bilinear,crop=${vw}:${vh},boxblur=luma_radius=24:luma_power=2:chroma_radius=12:chroma_power=1[bg${i}]`);
        parts.push(`[bf1${i}]scale=${vw}:-2:flags=lanczos[fg${i}]`);
        parts.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,${eqStep}${lutStep}format=yuv420p[vb]`);
      } else {
        parts.push(`[0:v]${vpts},${base}${eqStep}${lutStep}format=yuv420p[vb]`);
      }
      let cur = 'vb';

      // Emphasis punch-in zoom (scale-up→crop) BEFORE overlays, so text/images aren't distorted.
      // Skipped on speed clips — the zoom's between(t,...) windows were computed at 1x.
      if (seg.zoomFilter && speed === 1) { parts.push(`[${cur}]${seg.zoomFilter}[vz]`); cur = 'vz'; }

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
            ? `enable='between(t,${ot(ov.startTime)},${ot(ov.endTime)})'` : null,
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
          ? `:enable='between(t,${ot(ov.startTime)},${ot(ov.endTime)})'` : '';
        parts.push(`[${cur}][bi${k}]overlay=x=(W-w)/2:y=(H-h)/2${en}[vo${k}]`);
        cur = `vo${k}`;
      }

      // Watermark sits ON TOP of text/b-roll overlays (it brands the finished frame). Alpha via
      // colorchannelmixer; format back to yuv420p so every temp stays concat-identical.
      if (wmSpec) {
        const ws = audioBase + audioInputs.length;
        parts.push(`[${ws}:v]scale=${wmSpec.w}:-1,format=rgba,colorchannelmixer=aa=${wmSpec.op}[wm]`);
        parts.push(`[${cur}][wm]overlay=${wmSpec.xy},format=yuv420p[vwm]`);
        cur = 'vwm';
      }

      // Draft/preview: downscale this clip to 720p — a fast, low-res proof to iterate on
      // before committing to the full-res render.
      if (draft) { parts.push(`[${cur}]scale=-2:720[vd]`); cur = 'vd'; }

      // Audio: speech, optionally mixed with ducked bgMusic + delayed SFX. amix normalize=0
      // keeps speech full-volume and adds the layers on top (default would average/quiet it).
      // Audio fades: per-clip fade-in/out (0–3s, from the clip inspector), with a 4ms floor on
      // BOTH edges even when unset — micro-fades at every cut boundary kill the click/pop a hard
      // concat seam can produce (beta item 190). st is clip-relative (PTS reset above).
      const fIn = Math.max(0.004, Math.min(3, Number(seg.fadeIn) || 0));
      const fOut = Math.max(0.004, Math.min(3, Number(seg.fadeOut) || 0));
      // Export gain (mixer): one honest knob — the sequence has a single real audio stream, so
      // this IS the master fader at export. Clamped ±12 dB; 0 = untouched chain.
      const gain = Math.max(-12, Math.min(12, Number(gainDb) || 0));
      const aSteps = ['asetpts=PTS-STARTPTS'];
      // Voice clean (beta items 163/165): 80 Hz high-pass kills rumble/handling noise, afftdn is
      // ffmpeg's built-in FFT denoiser (no external model — asset-agnostic by construction).
      // BEFORE atempo so the denoiser sees natural audio.
      if (voiceclean) aSteps.push('highpass=f=80', 'afftdn=nf=-30');
      if (speed !== 1) {
        // atempo is only defined on [0.5, 2] per instance — chain octave steps to reach 0.25–4x.
        let r = speed;
        while (r > 2) { aSteps.push('atempo=2'); r /= 2; }
        while (r < 0.5) { aSteps.push('atempo=0.5'); r *= 2; }
        aSteps.push(`atempo=${+r.toFixed(4)}`);
      }
      aSteps.push(`afade=t=in:st=0:d=${fIn}`, `afade=t=out:st=${Math.max(0, outDur - fOut).toFixed(3)}:d=${fOut}`);
      // Profanity mute windows (beta item 186): [start,end] pairs in clip-relative SOURCE seconds
      // (built server-side from the word-level transcript); ±40ms pad covers word edges.
      if (Array.isArray(seg.mutes) && seg.mutes.length) {
        const en = seg.mutes
          .map(([a, b]) => `between(t,${Math.max(0, ot(a - 0.04)).toFixed(3)},${Math.min(outDur, ot(b + 0.04)).toFixed(3)})`)
          .join('+');
        aSteps.push(`volume=0:enable='${en}'`);
      }
      if (gain) aSteps.push(`volume=${gain}dB`);
      parts.push(`[0:a]${aSteps.join(',')}[as]`);
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
      if (wmSpec) inputs.push('-i', wmSpec.path);

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
      await fs.writeFile(listFile, clipFiles.map((f) => concatLine(f)).join('\n'), 'utf8');
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

// Mix project music ONTO a finished render — a fast post-pass: video stream-copied (never
// re-encoded), audio mixed once. Music loops to the cut's length, fades out over the last
// seconds, and AUTO-DUCKS under speech via sidechaincompress (the music is compressed by the
// speech signal — real ducking, no volume keyframes). ASSET-AGNOSTIC: musicPath is always a
// user-supplied file; nothing is bundled.
// Measured on real gameplay footage (440Hz tone vs the NBA 2K VOD's audio): gentle ≈ −3 dB and
// strong ≈ −5..6 dB in speech windows. Constant game/crowd audio keys the sidechain the whole
// time, so duck-vs-pause contrast is inherently modest on gameplay VODs — with real mic pauses
// the music recovers fully. Honest ceiling, stated in the UI.
const DUCK_PRESETS = {
  off: null,
  gentle: 'threshold=0.02:ratio=6:attack=250:release=900',
  strong: 'threshold=0.003:ratio=20:attack=150:release=600',
};
export async function mixMusicOnto(videoFile, musicPath, { volume = 0.15, duck = 'gentle', fadeOut = 3 } = {}) {
  if (!existsSync(musicPath)) throw new Error(`Music file not found: ${musicPath}`);
  const meta = await probe(videoFile);
  const dur = meta.duration || 0;
  if (!dur) throw new Error('Could not read the render duration.');
  const v = Math.max(0.03, Math.min(0.6, Number(volume) || 0.15));
  const fade = Math.min(fadeOut, Math.max(1, dur / 4));
  const sc = DUCK_PRESETS[duck] ?? DUCK_PRESETS.gentle;
  // aformat on BOTH sidechain inputs is load-bearing: with mismatched rates/layouts (44.1k mono
  // music vs 48k stereo source) sidechaincompress silently never engages (measured 0.0 dB duck).
  const AF = 'aformat=sample_rates=48000:channel_layouts=stereo';
  const musicPrep = `[1:a]volume=${v},afade=t=out:st=${(dur - fade).toFixed(2)}:d=${fade},${AF}[m0]`;
  const graph = sc
    ? `${musicPrep};[0:a]${AF}[key];[m0][key]sidechaincompress=${sc}[md];[0:a][md]amix=inputs=2:duration=first:normalize=0[aout]`
    : `${musicPrep};[0:a][m0]amix=inputs=2:duration=first:normalize=0[aout]`;
  const tmpOut = `${videoFile}.${process.pid}-${++_tmpSeq}.tmp.mp4`;
  try {
    await ffmpeg([
      '-nostdin', '-y', '-i', videoFile, '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex', graph,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      tmpOut,
    ]);
    await fs.rename(tmpOut, videoFile);
  } finally {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
  return videoFile;
}

// Real EBU R128 measurement (ffmpeg loudnorm analysis pass) — audio-only decode, a few seconds.
export async function measureLoudness(file) {
  let err = '';
  await ffmpeg(['-nostdin', '-i', file, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
    { onStderr: (s) => { err += s; } });
  const m = err.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!m) throw new Error('loudnorm produced no measurement');
  const j = JSON.parse(m[0]);
  return { i: +j.input_i, lra: +j.input_lra, tp: +j.input_tp };
}

// Normalize a finished render to a loudness target — measure the REAL integrated LUFS, apply the
// exact dB offset, and brickwall-limit true peaks (level=false: alimiter must only catch peaks,
// never re-normalize upward). Post-pass like mixMusicOnto: video stream-copied, seconds not a
// re-encode. Runs AFTER any music mix so the target reflects the audience's actual mix.
export async function normalizeLoudness(videoFile, { targetI = -14, tp = -1 } = {}) {
  const before = await measureLoudness(videoFile);
  const offset = Math.max(-20, Math.min(20, targetI - before.i));
  const limit = Math.pow(10, tp / 20).toFixed(4);
  const tmpOut = `${videoFile}.${process.pid}-${++_tmpSeq}.tmp.mp4`;
  try {
    await ffmpeg([
      '-nostdin', '-y', '-i', videoFile,
      '-af', `volume=${offset.toFixed(2)}dB,alimiter=limit=${limit}:level=false`,
      '-map', '0:v', '-map', '0:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      tmpOut,
    ]);
    await fs.rename(tmpOut, videoFile);
  } finally {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
  return { measured: +before.i.toFixed(1), applied: +offset.toFixed(1) };
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

    // OVERSHOOT GUARD. Snapping only errs by a fraction of a GOP on normal footage (~6s here), so
    // a few seconds of extra lead-in is the right trade for skipping a full re-encode. But the
    // GOP is a property of the SOURCE, and some encoders emit almost none — a screen capture with
    // a single keyframe snaps every span back to 0 and silently returns the whole video. Measured
    // on a fixture with one keyframe: 8s of requested spans came back as 12s, a 50% overshoot,
    // with nothing to tell the user their cut was wrong. When snapping inflates the cut past a
    // quarter, the copy path is simply the wrong tool — fall back to the frame-exact re-encode.
    const wantSec = segs.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);
    const gotSec = merged.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);
    if (wantSec > 0 && gotSec > wantSec * 1.25) {
      console.log(`[longcut] keyframe snapping would inflate ${wantSec.toFixed(1)}s -> ${gotSec.toFixed(1)}s `
        + `(${kfs.length} keyframes); falling back to exact re-encode.`);
      return null;   // caller re-runs the precise path
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
    await fs.writeFile(listFile, parts.map((f) => concatLine(f)).join('\n'), 'utf8');
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
  // Returns null when keyframe snapping would distort the cut (sparse-keyframe source) — fall
  // through to the exact path rather than shipping a silently-wrong duration.
  const burn = subs && (await canBurnCaptions());
  if (!burn && process.env.PEP_EXACT_CUT !== '1') {
    const copied = await exportLongCutCopy(file, segs, outFile);
    if (copied) return copied;
  }

  let graph = concatGraph(segs);
  const vmap = '[v]';
  // This used to assume ONLY the caption-burn path got here, so it appended a subtitles filter
  // unconditionally. That stopped being true once the copy path could bail out (sparse-keyframe
  // sources), and an unguarded burn built `subtitles='undefined'` and killed the render. Burn only
  // when there is actually something to burn.
  if (burn) graph = graph.replace('[v]', '[vc]') + `;[vc]subtitles='${esc(subs)}'[v]`;
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
export async function exportShort(file, start, end, outFile, { subs, zoomFilter, layout } = {}) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  // fps cap FIRST in the chain: 30fps is the social-platform standard and halves the frames the
  // WHOLE pipeline processes — including the per-frame emphasis-zoom rescale (eval=frame), the
  // pack's most expensive filter. Zoom windows are time-based (between(t,...)) so 30fps is
  // unaffected. PEP_SHORT_FPS overrides (set 60 for full-rate gameplay smoothness).
  const shortFps = Number(process.env.PEP_SHORT_FPS) || 30;
  const burn = subs && (await canBurnCaptions());
  const post = `,unsharp=5:5:0.5:3:3:0.0${burn ? `,subtitles='${esc(subs)}'` : ''}`;

  // Facecam split layout: stack the facecam crop (top) over a centered gameplay crop (bottom)
  // into the 1080x1920 frame — the vertical-shorts creator layout. `layout` arrives with all
  // geometry precomputed in SOURCE pixels: { camCrop:[w,h,x,y], camOutH, gameCrop:[w,h,x,y] }.
  // Emphasis zooms are skipped in this mode (they assume the single center-crop geometry).
  if (layout && layout.camCrop && layout.gameCrop) {
    const [cw, chh, cx, cy] = layout.camCrop;
    const [gw, gh, gx, gy] = layout.gameCrop;
    const camH = layout.camOutH; const gameH = 1920 - camH;
    const graph =
      `[0:v]fps=${shortFps},split=2[c0][g0];` +
      `[c0]crop=${cw}:${chh}:${cx}:${cy},scale=1080:${camH}:flags=lanczos[cam];` +
      `[g0]crop=${gw}:${gh}:${gx}:${gy},scale=1080:${gameH}:flags=lanczos[game];` +
      `[cam][game]vstack=inputs=2,setsar=1${post}[vv]`;
    await ffmpeg([
      '-nostdin', '-y', ...HWDECODE,
      '-ss', String(start), '-to', String(end), '-i', file,
      '-filter_complex', graph, '-map', '[vv]', '-map', '0:a?',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      ...(await videoEncodeArgs()),
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      outFile,
    ]);
    return outFile;
  }

  let vf = `fps=${shortFps},crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1`;
  // Emphasis punch-in (scale-up-per-frame → constant center crop). `-ss` input-trim makes
  // vf `t` clip-relative, matching the zoom's clip-relative `between(t,...)` windows.
  if (zoomFilter) vf += `,${zoomFilter}`;
  // Light edge-preservation sharpen on the final pixels — BEFORE the caption burn so
  // glyph edges stay clean (no ringing). Makes game detail pop on phone screens.
  vf += post;
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
