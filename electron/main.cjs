// ClipForge desktop shell: embeds the Express server and shows it in a native window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const https = require('node:https');
const { spawn, execSync, fork } = require('node:child_process');

const ROOT = path.join(__dirname, '..'); // server.js lives one level up
const TEST = process.env.CLIPFORGE_TEST === '1';
let win = null;
let serverProc = null;

function freePort(pref = 4178) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => {
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => { const p = s2.address().port; s2.close(() => resolve(p)); });
    });
    s.listen(pref, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function status(t) {
  if (TEST) { console.log('[status]', t); return; }
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(t)})`).catch(() => {});
  }
}

function which(bin) {
  try { return execSync(`command -v ${bin} 2>/dev/null`).toString().trim() || null; } catch { return null; }
}

function sh(cmd) {
  return new Promise((res) => { const c = spawn('bash', ['-lc', cmd], { stdio: 'ignore' }); c.on('close', () => res()); c.on('error', () => res()); });
}

function download(url, dest, onPct) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'ClipForge' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      const total = parseInt(res.headers['content-length'] || '0', 10); let got = 0;
      res.on('data', (d) => { got += d.length; if (total && onPct) onPct(Math.round((got / total) * 100)); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
    go(url);
  });
}

// Make sure the external tools ClipForge needs are present, pulling from the internet as needed.
async function ensureDeps(ud) {
  const binDir = path.join(ud, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', binDir, process.env.PATH || ''].join(':');

  // yt-dlp — single standalone binary, no Homebrew required.
  if (!which('yt-dlp') && !process.env.YTDLP_BIN) {
    const dest = path.join(binDir, 'yt-dlp');
    if (!fs.existsSync(dest)) {
      status('Setting up the VOD downloader…');
      await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', dest, (p) => status(`Downloading yt-dlp… ${p}%`));
      fs.chmodSync(dest, 0o755);
    }
    process.env.YTDLP_BIN = dest;
  }

  // whisper speech model into userData/models.
  const model = path.join(ud, 'models', 'ggml-base.en.bin');
  process.env.WHISPER_MODEL = model;
  if (!fs.existsSync(model)) {
    // Reuse a model from a prior install (e.g. the old ClipForge name) before downloading.
    const legacy = path.join(path.dirname(ud), 'ClipForge', 'models', 'ggml-base.en.bin');
    if (fs.existsSync(legacy)) {
      status('Reusing existing speech model…');
      fs.mkdirSync(path.dirname(model), { recursive: true });
      fs.copyFileSync(legacy, model);
    } else {
      status('Downloading the speech model (~141 MB, one time)…');
      await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', model, (p) => status(`Downloading speech model… ${p}%`));
    }
  }

  // FFmpeg (with libass) + whisper.cpp — prefer what's installed; fall back to Homebrew if present.
  const brew = which('brew');
  const ffOk = fs.existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') || which('ffmpeg');
  if (!ffOk && brew) { status('Installing FFmpeg (caption burn-in)…'); await sh(`${brew} install ffmpeg-full`); }
  if (!which('whisper-cli') && brew) { status('Installing whisper.cpp…'); await sh(`${brew} install whisper-cpp`); }
}

function waitForServer(port, ms = 20000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const r = net.connect(port, '127.0.0.1');
      r.on('connect', () => { r.end(); resolve(); });
      r.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not come up')); else setTimeout(tryOnce, 250); });
    };
    tryOnce();
  });
}

async function boot() {
  if (!TEST) {
    win = new BrowserWindow({
      width: 1320, height: 880, minWidth: 1000, minHeight: 640,
      backgroundColor: '#0b0f17', title: 'PepStudio', show: false,
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { contextIsolation: true },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    await win.loadFile(path.join(__dirname, 'splash.html'));
  }

  try {
    const ud = app.getPath('userData');
    process.env.CLIPFORGE_DATA = path.join(ud, 'data');
    process.env.CLIPFORGE_RENDERS = path.join(ud, 'renders');
    process.env.CLIPFORGE_DOWNLOADS = path.join(ud, 'downloads');
    await ensureDeps(ud);

    status('Starting PepStudio…');
    // Run the server in its own Node process (Electron's bundled node via
    // ELECTRON_RUN_AS_NODE) — avoids ESM-in-main-process issues and isolates crashes.
    // PORT=0 → the OS picks a free port; the server reports the real one over IPC.
    serverProc = fork(path.join(ROOT, 'server.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not report a port in time')), 30000);
      serverProc.on('message', (m) => { if (m && m.type === 'pepstudio-port') { clearTimeout(timer); resolve(m.port); } });
      serverProc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server process exited (code ${code})`)); });
    });
    await waitForServer(port);

    if (TEST) { console.log(`ELECTRON_BOOT_OK port=${port}`); try { serverProc.kill(); } catch {} app.quit(); return; }
    await win.loadURL(`http://localhost:${port}`);
  } catch (e) {
    if (TEST) { console.error('ELECTRON_BOOT_FAIL', e.message); app.exit(1); return; }
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="background:#0b0f17;color:#e6edf3;font:15px -apple-system;padding:40px">
       <h2>PepStudio couldn't start</h2><pre style="color:#ff8a8a;white-space:pre-wrap">${String(e.stack || e)}</pre></body>`));
  }
}

app.setName('PepStudio');
// Single instance — a second launch focuses the existing window instead of starting
// another embedded server (which is what produced the EADDRINUSE crash).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(boot);
}
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
app.on('before-quit', () => { try { serverProc && serverProc.kill(); } catch {} });
