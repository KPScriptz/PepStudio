// ClipForge desktop shell: embeds the Express server and shows it in a native window.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const https = require('node:https');
const { spawn, execFileSync, fork } = require('node:child_process');
const P = require('../lib/platform.cjs');

const ROOT = path.join(__dirname, '..'); // server.js lives one level up
const TEST = process.env.CLIPFORGE_TEST === '1';
let win = null;
let serverProc = null;
let serverPort = 0;

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

// Locate an executable WITHOUT a shell. `command -v` is a POSIX shell builtin, so the old
// implementation could not work on Windows at all; `where` is the Windows equivalent and both
// are invoked argv-style so an odd PATH entry can't inject.
function which(bin) {
  const w = P.whichCmd(P.binName(bin));
  try {
    const out = execFileSync(w.cmd, w.args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const first = out.split(/\r?\n/)[0].trim();   // `where` may print several matches
    return first && fs.existsSync(first) ? first : null;
  } catch { return null; }
}

// Run a package-manager install. macOS/Linux only — there is no single package manager we can
// assume on Windows, so callers must not reach this there (ensureDeps guards on process.platform).
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
  // A GUI-launched app inherits a bare PATH — NOT the shell's — so tools in ~/.local/bin (macOS)
  // or a scoop/winget shim dir (Windows) are invisible and spawn with ENOENT. buildPath prepends
  // the platform's tool dirs using the RIGHT delimiter; joining with ':' on Windows would collapse
  // the entire PATH into one bogus entry and break every spawn downstream.
  process.env.PATH = P.buildPath(binDir);

  // BUNDLED TOOLS (Windows): ffmpeg/ffprobe ship inside the app under resources/bin, so a fresh
  // install works with ZERO setup — no winget, no PATH surgery, nothing for the user to install.
  // It goes FIRST so the shipped, known-good build (with libass, so captions can burn in) wins over
  // whatever random ffmpeg might already be on the machine. In dev, process.resourcesPath points
  // into electron's own bundle and simply won't contain bin/, so this is a no-op there.
  const bundled = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;
  if (bundled && fs.existsSync(bundled)) {
    process.env.PATH = [bundled, process.env.PATH].filter(Boolean).join(P.pathDelim());
    // Pin the exact binaries too: PATH alone can be defeated by a stale shim earlier in the list.
    const ff = path.join(bundled, P.binName('ffmpeg'));
    const fp = path.join(bundled, P.binName('ffprobe'));
    const wc = path.join(bundled, P.binName('whisper-cli'));
    if (fs.existsSync(ff)) process.env.FFMPEG_PATH = ff;
    if (fs.existsSync(fp)) process.env.FFPROBE_PATH = fp;
    if (fs.existsSync(wc)) process.env.WHISPER_BIN = wc;
  }

  // CI boot check (CLIPFORGE_TEST=1) only proves the packaged app starts and serves — it must not
  // pull ~170MB of yt-dlp + speech model on every run. Skip the downloads; the PATH is already set.
  if (TEST) return;

  // yt-dlp — one standalone binary per OS, so no package manager is needed anywhere.
  if (!which('yt-dlp') && !process.env.YTDLP_BIN) {
    const dest = path.join(binDir, P.binName('yt-dlp'));
    if (!fs.existsSync(dest)) {
      status('Setting up the VOD downloader…');
      await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${P.ytdlpAsset()}`, dest, (p) => status(`Downloading yt-dlp… ${p}%`));
      if (!P.isWin()) fs.chmodSync(dest, 0o755);   // NTFS has no exec bit
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

  // FFmpeg (with libass) + whisper.cpp. On macOS/Linux we can auto-install via Homebrew. Windows
  // has no package manager we can assume is present, so we do NOT silently install anything —
  // missingTools() reports what's absent and boot() shows actionable instructions instead.
  if (!P.isWin()) {
    const brew = which('brew');
    const ffOk = fs.existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') || which('ffmpeg');
    if (!ffOk && brew) { status('Installing FFmpeg (caption burn-in)…'); await sh(`${brew} install ffmpeg-full`); }
    if (!which('whisper-cli') && brew) { status('Installing whisper.cpp…'); await sh(`${brew} install whisper-cpp`); }
  }
}

// Which external tools are still missing after ensureDeps. ffmpeg/ffprobe are hard requirements
// (no analyze, no render without them); whisper is soft (captions/ranking degrade).
function missingTools() {
  const miss = [];
  for (const t of ['ffmpeg', 'ffprobe']) if (!which(t)) miss.push({ tool: t, hard: true, hint: P.installHint('ffmpeg') });
  if (!which('whisper-cli') && !which('whisper-cpp')) miss.push({ tool: 'whisper-cli', hard: false, hint: P.installHint('whisper-cli') });
  return miss;
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

const IS_MAC = process.platform === 'darwin';

// ---- Window options, in ONE place -------------------------------------------------------------
// There are two BrowserWindow constructions (first boot and reopen-after-close); they used to be
// copy-pasted, which is how the two silently drift apart. Mac-only chrome is applied here and
// nowhere else.
//
// On macOS: hiddenInset floats the traffic lights over the content for the unified title bar Pro
// apps use, and `vibrancy` gives the real NSVisualEffectView translucency — the genuine article,
// not a CSS approximation. Both are ignored on Windows/Linux, where the standard frame is correct
// and expected, so this is additive rather than a cross-platform regression.
function windowOptions() {
  const base = {
    width: 1320, height: 880, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0b0f17', title: 'PepStudio', show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  };
  if (!IS_MAC) return base;
  return {
    ...base,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },   // vertically centred against the 48px header
    vibrancy: 'under-window',
    visualEffectState: 'active',              // stay vibrant when the window is not focused
    backgroundColor: '#00000000',             // let the vibrancy through
  };
}

// Restore the last window position/size, ignoring a geometry that no longer fits any connected
// display (unplugging an external monitor would otherwise reopen the app off-screen).
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8'));
    if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
    const { screen } = require('electron');
    const fits = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x >= a.x - 40 && b.y >= a.y - 40 && b.x + b.width <= a.x + a.width + 40 && b.y + b.height <= a.y + a.height + 40;
    });
    return fits ? b : null;
  } catch { return null; }
}
function trackBounds(w) {
  const save = () => {
    try {
      if (!w || w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify(w.getBounds()));
    } catch { /* geometry is a convenience — never fail the app over it */ }
  };
  let t = null;
  const debounced = () => { clearTimeout(t); t = setTimeout(save, 400); };
  w.on('resize', debounced);
  w.on('move', debounced);
  w.on('close', save);
}

function makeWindow() {
  const w = new BrowserWindow({ ...windowOptions(), ...(savedBounds() || {}) });
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  trackBounds(w);
  return w;
}

// Recreate just the window against the already-running server (used after the quit guard's
// "Keep Working" with no window left, and dock re-activation). boot() must not run twice — it
// would fork a second server and re-register the ipcMain handler.
function reopenWindow() {
  win = makeWindow();
  win.loadURL(`http://localhost:${serverPort}`);
}

async function boot() {
  if (!TEST) {
    win = makeWindow();
    // Native file-open dialog for the renderer's "Choose file…" button (preload → window.electron).
    ipcMain.handle('dialog:openVideo', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'PepStudio — choose source footage',
        buttonLabel: 'Import',
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
      });
      return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
    });

    // ---- Native desktop integration -----------------------------------------------------------
    // The renderer is a web page, so it can't reach the OS on its own. These three are the ones
    // that actually change how the app FEELS native, and two of them are wins on Windows too.

    // The user's chosen system accent colour (macOS System Settings). Windows/Linux return null and
    // the CSS keeps its own accent, so this is additive.
    ipcMain.handle('sys:accent', () => {
      try {
        const { systemPreferences } = require('electron');
        if (!IS_MAC || typeof systemPreferences.getAccentColor !== 'function') return null;
        const hex = systemPreferences.getAccentColor();      // 'RRGGBBAA'
        return hex ? `#${String(hex).slice(0, 6)}` : null;
      } catch { return null; }
    });
    ipcMain.handle('sys:platform', () => process.platform);

    // Render progress on the Dock icon (macOS) AND the taskbar button (Windows) — same call, so
    // this is not a Mac-only nicety. -1 clears it.
    ipcMain.handle('sys:progress', (_e, value) => {
      try {
        if (win && !win.isDestroyed()) win.setProgressBar(Number.isFinite(value) ? value : -1);
      } catch {}
      return true;
    });

    // Native OS notification when a long render finishes — Notification Center on macOS, toast on
    // Windows. Only fires when the window isn't focused, so it never interrupts active work.
    ipcMain.handle('sys:notify', (_e, { title, body } = {}) => {
      try {
        const { Notification } = require('electron');
        if (!Notification.isSupported()) return false;
        if (win && !win.isDestroyed() && win.isFocused()) return false;
        new Notification({ title: String(title || 'PepStudio'), body: String(body || '') }).show();
        return true;
      } catch { return false; }
    });
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
    serverPort = port;

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
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length !== 0) return;
  if (serverPort) reopenWindow(); else boot();
});
// Quit guard: if an export / whisper pass is mid-flight, confirm before abandoning it.
// preventDefault must run synchronously, so the busy check re-triggers quit via the flag.
let quitConfirmed = false;
app.on('before-quit', (e) => {
  if (quitConfirmed || TEST || !serverPort) { try { serverProc && serverProc.kill(); } catch {} return; }
  e.preventDefault();
  (async () => {
    let busy = false;
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/api/busy`, { signal: AbortSignal.timeout(1500) });
      busy = !!(await r.json()).busy;
    } catch { /* server unreachable — nothing to protect, just quit */ }
    if (busy) {
      const opts = {
        type: 'warning',
        buttons: ['Keep Working', 'Quit Anyway'],
        defaultId: 0, cancelId: 0,
        message: 'An export or analysis is still running.',
        detail: 'Quitting now abandons the render in progress. Finished files stay in your library.',
      };
      // Red-button close destroys the window before before-quit — fall back to a parentless dialog.
      const { response } = (win && !win.isDestroyed())
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      if (response !== 1) {
        // Keep working — if the red-button close took the window with it, bring one back.
        if (!win || win.isDestroyed()) reopenWindow();
        return;
      }
    }
    quitConfirmed = true;
    app.quit();
  })();
});
