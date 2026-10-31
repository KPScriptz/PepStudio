// Confessional Booth — one button, two pickers, a camera.
//
// The whole point is that there is nothing to learn: open it, the camera is already live on the
// right devices (remembered from last time), hit the big button, talk, hit it again. The take is
// written straight into the PepStudio library as an editable MP4 and offered to the editor.
//
// Plain ES module, no build step — the browser loads it and ./bg.js directly.
import { Background, KEY_GREEN } from './bg.js';

const $ = (s) => document.querySelector(s);

const PREFS = 'pep_booth_prefs_v1';
const PENDING = 'pep_booth_pending';   // browser fallback handoff to the editor tab

// MediaRecorder containers in the order we want them. Explicit H.264+AAC MP4 first, because
// that one needs no transcoding at all; otherwise WebM.
//
// Bare 'video/mp4' is DELIBERATELY ABSENT, and re-adding it is a trap: Chromium accepts it and
// then hands back VP9/Opus inside an MP4 container. That file claims .mp4, so an editor opens it
// and then refuses the video stream — worse than an honestly-labelled .webm, and it only bites
// when ffmpeg is missing and the raw take is what the user keeps. Measured, not assumed.
const MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const state = {
  stream: null,
  rec: null,
  chunks: [],
  recording: false,
  arming: false,          // counting down, not yet rolling
  busy: false,
  startedAt: 0,
  tick: null,
  cams: [],
  mics: [],
  guides: 0,              // 0 off · 1 thirds · 2 vertical safe · 3 both
  mirror: true,
  prompt: '',
  slug: 'confessional',
  nextTake: 1,
  last: null,
  audio: { ctx: null, node: null, raf: 0, data: null },
  bg: { mode: 'off', matte: 'chroma', key: KEY_GREEN, tol: 85, soft: 75, spill: 60, imageUrl: null },
};

// Live background compositor (see bg.js). Constructed eagerly but it does not touch the GPU
// until a background is actually switched on, so the plain recorder costs nothing.
const bg = new Background($('#preview'));
$('#camLayer').appendChild(bg.canvas);

// ---- small helpers ----------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 3200);
}
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      cam: $('#camSel').value, mic: $('#micSel').value,
      guides: state.guides, mirror: state.mirror, prompt: state.prompt, slug: state.slug,
      // The background image itself is not persisted (it is an object URL for a local file the
      // user re-picks); everything that describes HOW the key is pulled is.
      bg: { ...state.bg, imageUrl: null },
    }));
  } catch { /* private mode — preferences are a nicety */ }
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch { return {}; }
}

// ---- devices ----------------------------------------------------------------------------------
// Labels only exist once a camera/mic permission has been granted, so this always runs AFTER the
// first getUserMedia. Selections survive a replug by deviceId, falling back to position.
async function refreshDevices(want = {}) {
  const all = await navigator.mediaDevices.enumerateDevices();
  state.cams = all.filter((d) => d.kind === 'videoinput');
  state.mics = all.filter((d) => d.kind === 'audioinput');

  const fill = (sel, list, wanted, noun) => {
    const keep = wanted || sel.value;
    sel.innerHTML = list.length
      ? list.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `${noun} ${i + 1}`)}</option>`).join('')
      : `<option value="">No ${noun.toLowerCase()} found</option>`;
    if (keep && list.some((d) => d.deviceId === keep)) sel.value = keep;
  };
  fill($('#camSel'), state.cams, want.cam, 'Camera');
  fill($('#micSel'), state.mics, want.mic, 'Microphone');
}

// Open (or re-open) the capture stream on the chosen devices and show it. The previous stream's
// tracks are stopped only AFTER the new one is live, so a device switch never leaves a black
// preview if the new device is busy — we fall back to what was already working.
async function openStream({ cam, mic } = {}) {
  const camId = cam ?? $('#camSel').value;
  const micId = mic ?? $('#micSel').value;
  const constraints = {
    video: {
      ...(camId ? { deviceId: { exact: camId } } : {}),
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
    },
    audio: {
      ...(micId ? { deviceId: { exact: micId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      channelCount: 1, sampleRate: 48000,
    },
  };
  const next = await navigator.mediaDevices.getUserMedia(constraints);
  const prev = state.stream;
  state.stream = next;
  $('#preview').srcObject = next;
  if (prev) for (const t of prev.getTracks()) t.stop();
  startMeter(next);
  $('#camError').classList.add('hidden');
  return next;
}

function describeMediaError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return ['Camera access is blocked',
      'PepStudio needs permission to use the camera and microphone. On macOS grant it in System Settings → Privacy & Security → Camera / Microphone, then try again.'];
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') {
    return ['No camera found', 'Connect a webcam (or pick a different one below) and try again.'];
  }
  if (n === 'NotReadableError') {
    return ['The camera is in use', 'Another app (Zoom, OBS, Photo Booth…) is holding the camera. Quit it and try again.'];
  }
  return ['Camera unavailable', String((e && e.message) || e)];
}

function showCamError(e) {
  const [title, body] = describeMediaError(e);
  $('#camErrTitle').textContent = title;
  $('#camErrBody').textContent = body;
  $('#camError').classList.remove('hidden');
}

// ---- input level -------------------------------------------------------------------------------
// The single most common way a recording is ruined is a dead or wrong mic, and you cannot hear
// yourself while you talk. The meter makes "am I being heard" answerable at a glance.
function startMeter(stream) {
  stopMeter();
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(node);
    const data = new Uint8Array(node.fftSize);
    state.audio = { ctx, node, data, raf: 0 };
    const fill = $('#meterFill');
    let peak = 0;
    const loop = () => {
      node.getByteTimeDomainData(data);
      let sum = 0;
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
        if (Math.abs(v) > max) max = Math.abs(v);
      }
      const rms = Math.sqrt(sum / data.length);
      // Perceptual-ish: raw RMS crawls along the floor, so map it onto the bar with a root curve.
      peak = Math.max(rms, peak * 0.86);
      fill.style.width = `${Math.min(100, Math.round(Math.pow(peak, 0.45) * 130))}%`;
      fill.classList.toggle('hot', peak > 0.35 && max < 0.985);
      fill.classList.toggle('clip', max >= 0.985);
      state.audio.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* no AudioContext — the meter is informational, recording still works */ }
}
function stopMeter() {
  const a = state.audio;
  if (a.raf) cancelAnimationFrame(a.raf);
  if (a.ctx) a.ctx.close().catch(() => {});
  state.audio = { ctx: null, node: null, raf: 0, data: null };
  const f = $('#meterFill');
  if (f) { f.style.width = '0%'; f.className = ''; }
}

// ---- recording ----------------------------------------------------------------------------------
const pickMime = () => MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';

async function countdown(from = 3) {
  const box = $('#countdown');
  const num = $('#countNum');
  box.classList.remove('hidden');
  for (let i = from; i > 0; i--) {
    num.textContent = String(i);
    num.style.animation = 'none';
    void num.offsetWidth;          // restart the pop animation per digit
    num.style.animation = '';
    await sleep(760);
    if (!state.arming) break;      // cancelled by a second press
  }
  box.classList.add('hidden');
}

// What MediaRecorder actually receives. With a background on, that is the compositor's canvas
// plus the live microphone track — so the key is baked into the file, not re-derived later.
function recordStream() {
  if (!bg.active) return state.stream;
  return bg.stream(state.stream.getAudioTracks()[0], 30);
}

async function startRecording() {
  if (!state.stream || state.recording || state.busy) return;
  const mime = pickMime();
  if (!window.MediaRecorder) return toast('This browser cannot record video (no MediaRecorder).', true);

  state.arming = true;
  setArmedUI(true);
  await countdown(3);
  if (!state.arming) { setArmedUI(false); return; }   // cancelled mid-countdown
  state.arming = false;

  state.chunks = [];
  try {
    state.rec = new MediaRecorder(recordStream(), {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 192_000,
    });
  } catch (e) {
    setArmedUI(false);
    return toast(`Could not start the recorder: ${e.message}`, true);
  }
  state.rec.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
  state.rec.onerror = (e) => toast(`Recorder error: ${(e.error && e.error.message) || 'unknown'}`, true);
  state.rec.onstop = () => finishRecording(state.rec.mimeType || mime);
  state.rec.start(1000);           // 1s slices: a crash costs at most the last second

  state.recording = true;
  state.startedAt = Date.now();
  setRecordingUI(true);
  state.tick = setInterval(() => { $('#recTime').textContent = clock(Date.now() - state.startedAt); }, 250);
}

function stopRecording() {
  if (!state.recording || !state.rec) return;
  state.recording = false;
  clearInterval(state.tick);
  try { state.rec.stop(); } catch { /* already stopping */ }
  setRecordingUI(false);
  setBusy(true, 'Saving…');
}

async function finishRecording(mime) {
  const ms = Date.now() - state.startedAt;
  const blob = new Blob(state.chunks, { type: mime || 'video/webm' });
  state.chunks = [];
  if (!blob.size) { setBusy(false); return toast('Nothing was captured — the take was empty.', true); }
  try {
    const r = await uploadTake(blob, mime, ms);
    state.last = r;
    state.nextTake = (r.take || state.nextTake) + 1;
    paintTakeTag();
    showLastTake(r);
    toast(r.warning ? r.warning : `Saved ${r.name}`, !!r.warning);
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  } finally {
    setBusy(false);
  }
}

// XHR, not fetch: a long take is hundreds of megabytes and fetch gives no upload progress, so the
// button would sit dead with no sign the save is moving.
function uploadTake(blob, mime, ms) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ slug: state.slug, mime: mime || blob.type || '', ms: String(ms) });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/booth/save?${q}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setBusy(true, `Saving… ${Math.round((e.loaded / e.total) * 100)}%`);
    };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && j.ok) resolve(j);
      else reject(new Error(j.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('connection to PepStudio dropped'));
    xhr.send(blob);
  });
}

// ---- UI state ------------------------------------------------------------------------------------
function setArmedUI(on) {
  $('#recBtn').classList.toggle('live', on);
  $('#recHint').textContent = on ? 'Space to cancel' : 'Space to roll';
}
function setRecordingUI(on) {
  $('#recBtn').classList.toggle('live', on);
  $('#recBtn').setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  $('#stage').classList.toggle('live', on);
  $('#recPill').classList.toggle('hidden', !on);
  $('#recTime').textContent = '0:00';
  $('#recHint').textContent = on ? 'Space to stop' : 'Space to roll';
  $('#prompter').classList.toggle('hidden', !(on && state.prompt));
  // Switching device mid-take would tear the recording in half — lock the pickers while hot.
  $('#camSel').disabled = on;
  $('#micSel').disabled = on;
  // Swapping the compositor mid-take would change the recorded stream under MediaRecorder.
  $('#bgSel').disabled = on;
  $('#bgTune').disabled = on;
}
function setBusy(on, label) {
  state.busy = on;
  $('#recBtn').disabled = on;
  if (label) $('#recHint').textContent = label;
  else if (!on) $('#recHint').textContent = 'Space to roll';
}
function paintTakeTag() { $('#takeTag').textContent = `Take ${String(state.nextTake).padStart(2, '0')}`; }

function showLastTake(r) {
  $('#idleNote').classList.add('hidden');
  $('#lastTake').classList.remove('hidden');
  $('#ltName').textContent = r.name;
  $('#ltName').title = r.path;
  $('#ltMeta').textContent = [r.duration ? clock(r.duration * 1000) : null, r.bytes ? mb(r.bytes) : null].filter(Boolean).join(' · ');
}

function applyGuides() {
  const g = $('#guides');
  g.classList.toggle('hidden', state.guides === 0);
  g.classList.toggle('showThirds', state.guides === 1 || state.guides === 3);
  g.classList.toggle('showVert', state.guides === 2 || state.guides === 3);
  $('#guideBtn').classList.toggle('on', state.guides !== 0);
}
function applyMirror() {
  $('#camLayer').classList.toggle('mirror', state.mirror);
  $('#mirrorBtn').classList.toggle('on', state.mirror);
}

// ---- background --------------------------------------------------------------------------------
// Push the whole background state into the compositor and the controls at once, so there is one
// place where "what the user chose" becomes "what is on screen".
function applyBg({ announce = false } = {}) {
  const b = state.bg;
  bg.matte = b.matte;
  bg.key = b.key;
  bg.tol = b.tol / 1000;
  bg.soft = b.soft / 1000;
  bg.spill = b.spill / 100;

  const ok = bg.setMode(b.mode);
  if (!ok && b.mode !== 'off') {
    b.mode = 'off';
    $('#bgSel').value = 'off';
    toast('This machine has no WebGL2, so backgrounds are unavailable here.', true);
  }
  $('#camLayer').classList.toggle('bgOn', bg.active);
  $('#bgSel').value = b.mode;

  // Sheet controls
  $('#keySwatch').style.background = b.key;
  $('#keyHex').textContent = b.key;
  $('#tolRange').value = b.tol; $('#tolVal').textContent = (b.tol / 1000).toFixed(3);
  $('#softRange').value = b.soft; $('#softVal').textContent = (b.soft / 1000).toFixed(3);
  $('#spillRange').value = b.spill; $('#spillVal').textContent = `${b.spill}%`;
  $('#matteChroma').classList.toggle('hidden', b.matte !== 'chroma');
  $('#matteRoom').classList.toggle('hidden', b.matte !== 'room');
  $('#spillRow').classList.toggle('hidden', b.matte !== 'chroma');
  for (const el of document.querySelectorAll('#matteRow .segBtn')) el.classList.toggle('on', el.dataset.matte === b.matte);
  $('#refState').textContent = bg.hasRef ? 'room captured' : 'not captured yet';

  // Honest about the one way this silently does nothing: room matte with no reference frame.
  if (announce && bg.active && b.matte === 'room' && !bg.hasRef) {
    toast('Pick “Learn my empty room” in background settings and capture the room first.', true);
  }
}
function applyPrompt() {
  $('#prompterText').textContent = state.prompt;
  $('#promptBtn').classList.toggle('on', !!state.prompt);
  if (!state.recording) $('#prompter').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- hand-off to the editor ------------------------------------------------------------------------
async function sendToStudio(p) {
  if (!p) return;
  if (window.electron && typeof window.electron.sendToStudio === 'function') {
    try { await window.electron.sendToStudio(p); return toast('Opened in PepStudio'); } catch (e) { return toast(e.message, true); }
  }
  // Plain-browser booth (a tab next to the editor's tab): hand the path over through localStorage.
  // The editor listens for this and imports it the moment it is focused.
  if (window.opener && typeof window.opener.pepResolveNativeFilePath === 'function') {
    try { window.opener.pepResolveNativeFilePath(p); window.opener.focus(); return toast('Opened in PepStudio'); } catch { /* fall through */ }
  }
  try {
    localStorage.setItem(PENDING, JSON.stringify({ path: p, ts: Date.now() }));
    toast('Queued — switch to the PepStudio window to import it.');
  } catch { toast(p); }
}
const reveal = (p) => fetch('/api/reveal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
}).catch(() => {});

// ---- wiring --------------------------------------------------------------------------------------
$('#recBtn').addEventListener('click', () => {
  if (state.busy) return;
  if (state.arming) { state.arming = false; return; }       // cancel the countdown
  if (state.recording) stopRecording(); else startRecording();
});

$('#camSel').addEventListener('change', async () => {
  try { await openStream(); savePrefs(); } catch (e) { toast(describeMediaError(e)[1], true); }
});
$('#micSel').addEventListener('change', async () => {
  try { await openStream(); savePrefs(); } catch (e) { toast(describeMediaError(e)[1], true); }
});

// ---- background controls --------------------------------------------------------------------
$('#bgSel').addEventListener('change', () => {
  const v = $('#bgSel').value;
  // "Image…" always means "pick one" — the dropdown value only sticks once a file is loaded.
  if (v === 'image') { $('#bgSel').value = state.bg.mode; $('#bgFile').click(); return; }
  state.bg.mode = v;
  applyBg({ announce: true });
  savePrefs();
});
$('#bgFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    bg.setImage(img);
    $('#bgImageName').textContent = f.name;
    state.bg.mode = 'image';
    applyBg({ announce: true });
    savePrefs();
  };
  img.onerror = () => toast('That image could not be read.', true);
  img.src = url;
  e.target.value = '';                      // picking the same file twice must still fire
});

$('#bgImageBtn').addEventListener('click', () => $('#bgFile').click());
$('#bgTune').addEventListener('click', (e) => {
  e.preventDefault();
  $('#bgSheet').classList.remove('hidden');
  $('#stage').classList.add('sampling');    // the preview becomes an eyedropper while this is open
  applyBg();
});
$('#bgDone').addEventListener('click', () => {
  $('#bgSheet').classList.add('hidden');
  $('#stage').classList.remove('sampling');
  savePrefs();
});
$('#bgReset').addEventListener('click', () => {
  Object.assign(state.bg, { matte: 'chroma', key: KEY_GREEN, tol: 85, soft: 75, spill: 60 });
  applyBg(); savePrefs();
});
$('#matteRow').addEventListener('click', (e) => {
  const b = e.target.closest('.segBtn');
  if (!b) return;
  state.bg.matte = b.dataset.matte;
  applyBg({ announce: true }); savePrefs();
});
$('#bgCapture').addEventListener('click', () => {
  if (!bg.captureReference()) return toast('No camera frame to capture yet.', true);
  applyBg();
  toast('Room captured — step back into frame.');
});
for (const [id, key, scale] of [['#tolRange', 'tol', 1000], ['#softRange', 'soft', 1000], ['#spillRange', 'spill', 100]]) {
  $(id).addEventListener('input', () => {
    state.bg[key] = Number($(id).value);
    bg[key] = Number($(id).value) / scale;
    $(id === '#tolRange' ? '#tolVal' : id === '#softRange' ? '#softVal' : '#spillVal').textContent =
      key === 'spill' ? `${state.bg.spill}%` : (state.bg[key] / 1000).toFixed(3);
  });
  $(id).addEventListener('change', savePrefs);
}

// Eyedropper: a lit green screen is never the green it claims to be, so sample the real pixel.
$('#stage').addEventListener('click', (e) => {
  if ($('#bgSheet').classList.contains('hidden') || state.bg.matte !== 'chroma') return;
  const v = $('#preview');
  if (!v.videoWidth) return;
  // The preview letterboxes (object-fit: contain) and may be mirrored — undo both before the
  // click position means anything in source pixels.
  const r = $('#stage').getBoundingClientRect();
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const dw = v.videoWidth * scale;
  const dh = v.videoHeight * scale;
  let u = (e.clientX - r.left - (r.width - dw) / 2) / dw;
  const vv = (e.clientY - r.top - (r.height - dh) / 2) / dh;
  if (state.mirror) u = 1 - u;
  if (u < 0 || u > 1 || vv < 0 || vv > 1) return;
  const hex = bg.sampleAt(u, vv);
  if (!hex) return;
  state.bg.key = hex;
  applyBg(); savePrefs();
  toast(`Key colour ${hex}`);
});

$('#mirrorBtn').addEventListener('click', () => { state.mirror = !state.mirror; applyMirror(); savePrefs(); });
$('#guideBtn').addEventListener('click', () => { state.guides = (state.guides + 1) % 4; applyGuides(); savePrefs(); });
$('#folderBtn').addEventListener('click', async () => {
  const r = await fetch('/api/booth/takes').then((x) => x.json()).catch(() => null);
  if (r && r.dir) reveal(r.takes && r.takes[0] ? r.takes[0].path : r.dir);
});
$('#retryBtn').addEventListener('click', () => boot());

$('#promptBtn').addEventListener('click', () => {
  $('#promptInput').value = state.prompt;
  $('#slugInput').value = state.slug === 'confessional' ? '' : state.slug;
  $('#promptSheet').classList.remove('hidden');
  $('#promptInput').focus();
});
$('#promptDone').addEventListener('click', () => {
  state.prompt = $('#promptInput').value.trim();
  const s = $('#slugInput').value.trim();
  state.slug = s || 'confessional';
  $('#promptSheet').classList.add('hidden');
  applyPrompt(); savePrefs(); refreshNextTake();
});

$('#ltStudio').addEventListener('click', () => state.last && sendToStudio(state.last.path));
$('#ltReveal').addEventListener('click', () => state.last && reveal(state.last.path));
$('#ltPlay').addEventListener('click', () => {
  if (!state.last) return;
  $('#reviewName').textContent = state.last.name;
  $('#reviewVid').src = `/api/booth/take?name=${encodeURIComponent(state.last.name)}`;
  $('#reviewSheet').classList.remove('hidden');
});
$('#reviewDone').addEventListener('click', () => {
  const v = $('#reviewVid');
  v.pause(); v.removeAttribute('src'); v.load();
  $('#reviewSheet').classList.add('hidden');
});

// Keyboard: the operator's hands are not on the mouse when they are on camera.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (!$('#promptSheet').classList.contains('hidden')) return $('#promptDone').click();
    if (!$('#reviewSheet').classList.contains('hidden')) return $('#reviewDone').click();
    if (!$('#bgSheet').classList.contains('hidden')) return $('#bgDone').click();
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ' || k === 'r') { e.preventDefault(); $('#recBtn').click(); return; }
  if (state.recording || state.arming) return;              // no device roulette while hot
  if (k === 'c') cycle('#camSel');
  else if (k === 'm') cycle('#micSel');
  else if (k === 'g') $('#guideBtn').click();
  else if (k === 'k') $('#mirrorBtn').click();
  else if (k === 'p') $('#promptBtn').click();
  else if (k === 'b') cycleBg();
});
// Hotkey cycling deliberately skips "Image…" — a keystroke should never pop a file dialog.
function cycleBg() {
  const order = ['off', 'green', 'blue', 'blur'];
  const i = order.indexOf(state.bg.mode);
  state.bg.mode = order[(i + 1) % order.length];
  applyBg({ announce: true });
  savePrefs();
  toast($('#bgSel').selectedOptions[0].text);
}
function cycle(sel) {
  const el = $(sel);
  if (el.options.length < 2) return;
  el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
  el.dispatchEvent(new Event('change'));
  toast(el.options[el.selectedIndex].text);
}

// Webcam plugged in or pulled out while the booth is open.
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (state.recording) return;
  refreshDevices({ cam: $('#camSel').value, mic: $('#micSel').value }).catch(() => {});
});

// Don't let a window close quietly discard a take in progress.
window.addEventListener('beforeunload', (e) => {
  if (!state.recording && !state.busy) return;
  e.preventDefault();
  e.returnValue = '';
});

async function refreshNextTake() {
  try {
    const r = await (await fetch('/api/booth/takes')).json();
    const re = new RegExp(`^${state.slug}-\\d{4}-\\d{2}-\\d{2}-take(\\d+)\\.`);
    let max = 0;
    for (const t of r.takes || []) { const m = re.exec(t.name); if (m) max = Math.max(max, parseInt(m[1], 10) || 0); }
    state.nextTake = max + 1;
    // Say it BEFORE the first take, not in a toast after it: with no ffmpeg the recording is
    // kept but stays a raw WebM — it scrubs badly and drifts once it is on the timeline.
    if (r.canConvert === false) {
      const n = $('#idleNote');
      n.classList.add('warn');
      n.innerHTML = `No ffmpeg found — takes save in the browser's own format instead of an editable MP4, so they will scrub badly on the timeline.<br>Install it with <code>${escapeHtml(r.ffmpegHint || 'ffmpeg')}</code>, then reopen the booth.`;
    }
  } catch { state.nextTake = 1; }
  paintTakeTag();
}

// ---- boot ------------------------------------------------------------------------------------------
async function boot() {
  const p = loadPrefs();
  state.guides = Number.isFinite(p.guides) ? p.guides : 0;
  state.mirror = p.mirror !== false;
  state.prompt = p.prompt || '';
  state.slug = p.slug || 'confessional';
  // An image background can't survive a reload (the file lives on the user's disk, not in the
  // page), so a remembered 'image' mode comes back as off rather than as a black frame.
  const savedBg = p.bg && typeof p.bg === 'object' ? p.bg : {};
  Object.assign(state.bg, savedBg, savedBg.mode === 'image' ? { mode: 'off' } : {});
  applyGuides(); applyMirror(); applyPrompt(); applyBg();
  refreshNextTake();

  if (window.electron?.platform) {
    try { if (await window.electron.platform() === 'darwin') document.documentElement.classList.add('isMac'); } catch {}
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showCamError({ name: 'SecurityError' });
  }
  try {
    // First open uses the remembered devices; if that exact camera is gone, fall back to default
    // rather than failing shut with OverconstrainedError.
    try { await openStream({ cam: p.cam, mic: p.mic }); }
    catch (e) { if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) await openStream({ cam: null, mic: null }); else throw e; }
    await refreshDevices({ cam: p.cam, mic: p.mic });
    // enumerateDevices can hand back a different id than the one in use (e.g. 'default'); re-pin
    // the selects to what the live tracks actually are so the labels never lie.
    const vt = state.stream.getVideoTracks()[0];
    const at = state.stream.getAudioTracks()[0];
    if (vt && vt.getSettings().deviceId) $('#camSel').value = vt.getSettings().deviceId;
    if (at && at.getSettings().deviceId) $('#micSel').value = at.getSettings().deviceId;
    savePrefs();
  } catch (e) {
    showCamError(e);
    try { await refreshDevices(); } catch { /* no labels without permission — expected */ }
  }
}
boot();
