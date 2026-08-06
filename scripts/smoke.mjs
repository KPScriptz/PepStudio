#!/usr/bin/env node
// End-to-end smoke test. Boots the real server, synthesises a clip with ffmpeg, then drives the
// actual analyze → export pipeline and probes the rendered file.
//
// Cross-platform ON PURPOSE: this is the check that PepStudio genuinely runs on Windows, which
// cannot be verified from a Mac. It exercises exactly the things the port had to fix — binary
// resolution, PATH assembly, concat-demuxer list files, filtergraph path escaping and drawtext
// fonts — so a Windows-specific regression fails here loudly instead of silently producing a
// broken render.
//
// Whisper is NOT required: captions/ranking are skipped when whisper is absent (CI runners don't
// have it), and the pure /api/transcript/cut span math is asserted instead.
//
// Usage: node scripts/smoke.mjs   (exit 0 = pass, 1 = fail)
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT) || 4187;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const ok = (msg) => { passed++; console.log(`✅ ${msg}`); };
const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(route, body) {
  const res = await fetch(BASE + route, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is a failure the caller reports */ }
  return { status: res.status, json, text };
}

function runTool(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${bin} failed: ${err.message}\n${stderr}`)) : resolve(stdout.toString()));
  });
}

let server = null;
async function startServer(tmp) {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLIPFORGE_DATA: path.join(tmp, 'data'),
      CLIPFORGE_RENDERS: path.join(tmp, 'renders'),
      CLIPFORGE_DOWNLOADS: path.join(tmp, 'downloads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`server exited ${code}\n${log}`);
  });
  // Poll until it answers, rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) fail(`server died during boot (exit ${server.exitCode})\n${log}`);
    await sleep(500);
  }
  fail(`server never answered on ${PORT}\n${log}`);
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pep-smoke-'));
  console.log(`# platform=${process.platform} arch=${process.arch} node=${process.version}`);
  console.log(`# scratch=${tmp}`);

  // --- the external tools must resolve at all (this is the ENOENT/PATH class of bug) ---
  const { ffmpeg, ffprobe } = await import(path.join(ROOT, 'lib', 'ff.js'));
  const probeOut = await ffprobe(['-version']).catch((e) => fail(`ffprobe did not resolve: ${e.message}`));
  check(/ffprobe version/i.test(probeOut.stdout.toString()), 'ffprobe resolves and runs');

  // --- synthesise a source clip (no fixture to check in, works on any runner) ---
  // A path WITH A SPACE on purpose: Windows user dirs have spaces, and unquoted paths are a
  // classic concat/filtergraph failure.
  const srcDir = path.join(tmp, 'my clips');
  await fsp.mkdir(srcDir, { recursive: true });
  const src = path.join(srcDir, 'smoke source.mp4');
  await ffmpeg(['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  check(fs.existsSync(src), 'built a test clip at a path containing a space');

  await startServer(tmp);
  ok('server booted');

  // --- status / health routes ---
  const status = await api('/api/status');
  check(status.status === 200 && status.json, 'GET /api/status returns JSON');
  const whisper = !!(status.json.captions && status.json.captions.ready);
  console.log(`   (whisper ${whisper ? 'present' : 'absent — caption steps will be skipped'})`);

  const busy = await api('/api/busy');
  check(busy.json && busy.json.busy === false, 'GET /api/busy reports idle');
  const session = await api('/api/session');
  check(session.json && typeof session.json.crashed === 'boolean', 'GET /api/session reports a crash flag');

  // --- analyze: the step that dies first when binary resolution or PATH is wrong ---
  const an = await api('/api/analyze', { path: src });
  check(an.status === 200 && an.json && an.json.id, `POST /api/analyze succeeded (${an.json?.error || 'id ' + an.json?.id})`);
  check(Math.abs((an.json.duration || 0) - 8) < 1.5, `analyze read the duration (${an.json.duration}s)`);
  const id = an.json.id;

  // --- pure span math (no whisper needed) ---
  const cut = await api('/api/transcript/cut', {
    clips: [{ id: 'a', start: 0, end: 8 }],
    cuts: [{ t0: 3, t1: 5, w: 'test' }],
  });
  check(cut.status === 200 && cut.json.removedSec === 2, 'transcript cut math removes exactly the struck span');
  check(JSON.stringify(cut.json.clips[0].segments) === JSON.stringify([{ start: 0, end: 3 }, { start: 5, end: 8 }]),
    'transcript cut returns the surviving spans');

  // --- render a multi-clip sequence: exercises the CONCAT DEMUXER list file, which silently
  //     resolves to garbage on Windows if backslashes leak into it ---
  const seq = await api('/api/export/sequence', {
    id, vertical: false, zoom: false,
    clips: [{ start: 0, end: 2, overlays: [] }, { start: 4, end: 6, overlays: [] }],
  });
  check(seq.status === 200 && seq.json.file, `sequence export succeeded (${seq.json?.error || 'ok'})`);
  check(fs.existsSync(seq.json.file), 'sequence file exists on disk');
  const sp = await runTool(process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_name',
     '-of', 'default=nw=1:nk=1', seq.json.file]);
  check(/h264/.test(sp), 'sequence output is real h264');
  const seqDur = parseFloat(sp.trim().split(/\r?\n/).pop());
  check(Math.abs(seqDur - 4) < 1.0, `sequence is the concatenation of both clips (${seqDur.toFixed(2)}s ≈ 4s)`);

  // --- a vertical short with a text overlay: exercises DRAWTEXT (needs a real fontfile on
  //     Windows) plus the crop/scale filter chain ---
  const short = await api('/api/export/sequence', {
    id, vertical: true, zoom: false,
    clips: [{ start: 0, end: 3, overlays: [{ text: 'SMOKE TEST', startTime: 0, endTime: 3 }] }],
  });
  check(short.status === 200 && short.json.file, `vertical + drawtext render succeeded (${short.json?.error || 'ok'})`);
  const vp = await runTool(process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
     '-of', 'csv=p=0', short.json.file]);
  check(/1080,1920/.test(vp.replace(/\s/g, '')), `vertical output is 1080x1920 (got ${vp.trim()})`);

  // --- reveal must not throw even where the file manager differs ---
  const rev = await api('/api/reveal', { path: seq.json.file });
  check(rev.status === 200, 'POST /api/reveal is handled on this platform');

  console.log(`\n🚀 SMOKE PASSED — ${passed} checks on ${process.platform}.`);
}

main()
  .then(() => { server?.kill(); process.exit(0); })
  .catch((e) => {
    console.error(`\n❌ SMOKE FAILED: ${e.message}`);
    server?.kill();
    process.exit(1);
  });
