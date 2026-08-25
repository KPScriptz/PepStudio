// PepStudio Pro — Day 1 shell wiring. The ENGINE (server.js + lib/) is untouched; this file
// re-attaches the proven endpoints under the new 3-tab UI. Old app.js stays in the repo as the
// wiring reference until feature parity (Day 4), but nothing loads it.
'use strict';
const $ = (s) => document.querySelector(s);
const state = { proj: null, highlights: [], sel: null, coverT: null, saveTimer: null };
const RECENTS_KEY = 'pep_recents';   // same key as the old shell — recents carry over

// ---------- helpers ----------
const fmt = (t) => {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const tc = (t, fps) => {
  t = Math.max(0, t || 0);
  const fr = Math.floor((t - Math.floor(t)) * (fps || 30));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
};
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${path} failed (${r.status})`);
  return d;
}
function status(el, msg, bad) {
  const n = $(el); if (!n) return;
  n.textContent = msg || '';
  n.style.color = bad ? 'var(--heat)' : '';
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll('.stage').forEach((x) => x.classList.remove('on'));
  t.classList.add('on');
  $('#' + t.dataset.t).classList.add('on');
}));
const gotoTab = (id) => document.querySelector(`.tab[data-t="${id}"]`)?.click();

// ---------- settings modal (⌘,) ----------
const modal = $('#settingsModal');
$('#settingsBtn').addEventListener('click', () => modal.classList.remove('hidden'));
$('#settingsClose').addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); modal.classList.toggle('hidden'); }
  if (e.key === 'Escape') modal.classList.add('hidden');
});
function exportPrefs() {
  const p = {};
  const res = Number($('#expRes').value); if (res !== 1080) p.res = res;
  const fps = Number($('#expFps').value); if (fps !== 30) p.fps = fps;
  const q = $('#expQuality').value; if (q !== 'standard') p.quality = q;
  if ($('#expNorm').checked) p.normalize = true;
  if ($('#expClean').checked) p.voiceclean = true;
  if ($('#expBleep').checked) p.bleep = true;
  return p;
}

// ---------- Tab 1 · ingest ----------
const loadRecents = () => { try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; } };
function pushRecent(id, name) {
  const list = loadRecents().filter((r) => r.id !== id);
  list.unshift({ id, name: name || id, ts: Date.now() });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 12)));
}
function renderRecents() {
  const list = loadRecents();
  $('#recentsGrid').innerHTML = list.slice(0, 6).map((r) => `
    <button class="rec card" data-id="${r.id}">
      <span class="thumb" style="background-image:url('/api/thumb?id=${encodeURIComponent(r.id)}&t=1')"></span>
      <b>${r.name.replace(/[<>&]/g, '')}</b><span class="num">open project</span>
    </button>`).join('');
}
$('#recentsGrid').addEventListener('click', async (e) => {
  const b = e.target.closest('.rec'); if (!b) return;
  status('#ingestStatus', 'Loading project…');
  try { loadProject(await api(`/api/analysis/${b.dataset.id}`)); status('#ingestStatus', ''); }
  catch (err) { status('#ingestStatus', err.message, true); }
});
async function analyzePath(p) {
  status('#ingestStatus', 'Analyzing — audio pass first, video pass continues in the background…');
  try {
    const a = await api('/api/analyze', { path: p });
    loadProject(a);
    status('#ingestStatus', '');
  } catch (err) { status('#ingestStatus', err.message, true); }
}
$('#analyzeBtn').addEventListener('click', () => { const p = $('#pathInput').value.trim(); if (p) analyzePath(p); });
$('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#analyzeBtn').click(); });
$('#urlBtn').addEventListener('click', async () => {
  const url = $('#urlInput').value.trim(); if (!url) return;
  try {
    const { jobId } = await api('/api/import-url', { url });
    status('#ingestStatus', 'Downloading VOD…');
    const poll = setInterval(async () => {
      try {
        const j = await api(`/api/import-url/${jobId}`);
        if (j.status === 'done' && j.project) { clearInterval(poll); loadProject(j.project); status('#ingestStatus', ''); }
        else if (j.status === 'error') { clearInterval(poll); status('#ingestStatus', j.error || 'Import failed.', true); }
        else status('#ingestStatus', `Downloading VOD… ${j.progress != null ? Math.round(j.progress) + '%' : ''}`);
      } catch (err) { clearInterval(poll); status('#ingestStatus', err.message, true); }
    }, 2000);
  } catch (err) { status('#ingestStatus', err.message, true); }
});
const drop = $('#dropZone');
['dragover', 'dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.toggle('hover', ev === 'dragover');
  if (ev === 'drop') {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    const p = f && (window.pepFilePath ? window.pepFilePath(f) : f.path);
    if (p) { $('#pathInput').value = p; analyzePath(p); }
    else status('#ingestStatus', 'Could not read the dropped file path — paste it instead.', true);
  }
}));

// ---------- project load ----------
const player = $('#player');
function loadProject(data) {
  if (state.saveTimer) saveStateNow();
  state.proj = data;
  state.highlights = (data.highlights || []).map((h) => ({ ...h }));
  if (data.edit && Array.isArray(data.edit.clips) && (data.edit.clips.length || data.edit.cleared)) {
    const base = Object.fromEntries(state.highlights.map((h) => [String(h.id), h]));
    state.highlights = data.edit.clips.map((c) => ({ ...(base[c.id] || {}), ...c }));
  }
  state.sel = null; state.coverT = null;
  // The Day-1 shell has no marker/in-out UI yet — echo what the old shell saved so an
  // autosave from here never wipes it.
  state.echo = {
    markers: (data.edit && data.edit.markers) || [],
    inPoint: (data.edit && data.edit.inPoint) ?? null,
    outPoint: (data.edit && data.edit.outPoint) ?? null,
  };
  pushRecent(data.id, data.name);
  state.music = data.music || null; renderMusic();
  $('#musPath').value = '';
  state.undoSnap = null; $('#unpurgeBtn').classList.add('hidden');
  player.src = `/api/video?id=${encodeURIComponent(data.id)}`;
  $('#monEmpty').classList.remove('on');
  renderTimeline(); renderDeadAir(); renderSel(); updateProjStat();
  $('#coverStrip').innerHTML = '';
  if (typeof resetThumbEditor === 'function') resetThumbEditor();
  gotoTab('tabEdit');
}
function updateProjStat() {
  const d = state.proj;
  if (!d) { $('#projStat').textContent = ''; return; }
  const kept = state.highlights.filter((h) => h.keep);
  const keptSec = kept.reduce((n, h) => n + (h.end - h.start) / (Number(h.speed) || 1), 0);
  $('#projStat').textContent = `${d.name} · ${kept.length}/${state.highlights.length} clips kept · ${fmt(keptSec)} of ${fmt(d.duration)}`;
  $('#keptInfo').textContent = kept.length ? `· ${fmt(keptSec)}` : '';
}

// ---------- Tab 2 · timeline ----------
function renderTimeline() {
  const lane = $('#laneV');
  const total = (state.proj && state.proj.duration) || 1;
  lane.querySelectorAll('.clip').forEach((n) => n.remove());
  state.highlights.forEach((h) => {
    const el = document.createElement('div');
    el.className = 'clip' + (h.keep ? '' : ' off') + (state.sel === String(h.id) ? ' sel' : '');
    el.style.left = `${(h.start / total * 100).toFixed(3)}%`;
    el.style.width = `${Math.max(0.4, (h.end - h.start) / total * 100).toFixed(3)}%`;
    el.textContent = h.title || h.id;
    el.dataset.id = h.id;
    if (state.sel === String(h.id)) el.insertAdjacentHTML('beforeend', '<i class="hL"></i><i class="hR"></i>');
    lane.appendChild(el);
  });
}
function renderDeadAir() {
  const total = (state.proj && state.proj.duration) || 1;
  const ghosts = ((state.proj && state.proj.phantasm) || []).filter((s) => s.state === 'ghost');
  $('#heatRail').innerHTML = ghosts.map((g) =>
    `<div class="heatSeg" style="left:${(g.start / total * 100).toFixed(2)}%;width:${Math.max(0.25, (g.end - g.start) / total * 100).toFixed(2)}%" title="dead air · ${fmt(g.start)}"></div>`).join('');
  const st = (state.proj && state.proj.phantasmStats) || {};
  $('#deadAmt').textContent = st.ghostDuration ? fmt(st.ghostDuration) : '—';
}
let _justDragged = false;
$('#laneV').addEventListener('click', (e) => {
  if (_justDragged) return;
  const c = e.target.closest('.clip');
  if (c) {
    state.sel = c.dataset.id;
    const h = state.highlights.find((x) => String(x.id) === c.dataset.id);
    if (h) player.currentTime = h.start;
    renderTimeline(); renderSel();
    return;
  }
  // empty lane = seek there
  const r = $('#laneV').getBoundingClientRect();
  const total = (state.proj && state.proj.duration) || 1;
  player.currentTime = Math.max(0, Math.min(total, (e.clientX - r.left) / r.width * total));
});

// ---------- trim handles (drag the selected clip's gold edges; absolute source seconds) ----------
let _drag = null;
$('#laneV').addEventListener('mousedown', (e) => {
  const hnd = e.target.closest('.hL,.hR'); if (!hnd) return;
  const clipEl = hnd.closest('.clip');
  const h = state.highlights.find((x) => String(x.id) === clipEl.dataset.id);
  if (!h) return;
  e.preventDefault();
  _drag = { h, side: hnd.classList.contains('hL') ? 'L' : 'R', rect: $('#laneV').getBoundingClientRect() };
});
window.addEventListener('mousemove', (e) => {
  if (!_drag) return;
  const total = (state.proj && state.proj.duration) || 1;
  let t = Math.max(0, Math.min(total, (e.clientX - _drag.rect.left) / _drag.rect.width * total));
  if (_drag.side === 'L') _drag.h.start = Math.min(t, _drag.h.end - 0.4);
  else _drag.h.end = Math.max(t, _drag.h.start + 0.4);
  player.currentTime = t;   // live frame feedback while trimming
  renderTimeline(); renderSel();
});
window.addEventListener('mouseup', () => {
  if (!_drag) return;
  _drag = null; _justDragged = true;
  setTimeout(() => { _justDragged = false; }, 60);
  updateProjStat(); scheduleStateSave();
});

// ---------- hover scrub (thumbnail preview riding the cursor; 2s buckets hit the thumb cache) ----------
const _tip = $('#scrubTip');
$('#laneV').addEventListener('mousemove', (e) => {
  if (_drag || !state.proj) { _tip.classList.add('hidden'); return; }
  const r = $('#laneV').getBoundingClientRect();
  const total = state.proj.duration || 1;
  const t = Math.max(0, Math.min(total, (e.clientX - r.left) / r.width * total));
  const bucket = Math.max(1, Math.round(t / 2) * 2);
  const img = _tip.querySelector('img');
  const want = `/api/thumb?id=${encodeURIComponent(state.proj.id)}&t=${bucket}`;
  if (img.dataset.want !== want) { img.dataset.want = want; img.src = want; }
  _tip.querySelector('span').textContent = fmt(t);
  _tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 178, e.clientX - 84))}px`;
  _tip.style.top = `${r.top - 132}px`;
  _tip.classList.remove('hidden');
});
$('#laneV').addEventListener('mouseleave', () => _tip.classList.add('hidden'));

// ---------- dead-air purge (subtract phantasm ghost ranges from every kept clip) ----------
function subtractGhosts(s, e, ghosts) {
  let segs = [[s, e]];
  for (const g of ghosts) {
    const next = [];
    for (const [a, b] of segs) {
      if (g.end <= a || g.start >= b) { next.push([a, b]); continue; }
      if (g.start > a) next.push([a, g.start]);
      if (g.end < b) next.push([g.end, b]);
    }
    segs = next;
  }
  return segs.filter(([a, b]) => b - a >= 0.4);
}
$('#purgeBtn').addEventListener('click', () => {
  if (!state.proj) return;
  const ghosts = ((state.proj.phantasm) || []).filter((x) => x.state === 'ghost')
    .sort((a, b) => a.start - b.start);
  if (!ghosts.length) { status('#renderStatus', 'No dead air mapped for this project.', true); return; }
  state.undoSnap = JSON.stringify(state.highlights);
  let reclaimed = 0;
  const out = [];
  for (const h of state.highlights) {
    if (!h.keep) { out.push(h); continue; }
    const segs = subtractGhosts(h.start, h.end, ghosts);
    reclaimed += (h.end - h.start) - segs.reduce((n, [a, b]) => n + (b - a), 0);
    if (segs.length === 1 && Math.abs(segs[0][0] - h.start) < 0.01 && Math.abs(segs[0][1] - h.end) < 0.01) { out.push(h); continue; }
    segs.forEach(([a, b], k) => out.push({ ...h, id: segs.length === 1 ? h.id : `${h.id}.p${k + 1}`, start: a, end: b }));
  }
  state.highlights = out;
  state.sel = null;
  $('#unpurgeAmt').textContent = `+${fmt(reclaimed)}`;
  $('#unpurgeBtn').classList.remove('hidden');
  status('#renderStatus', `Purged ${fmt(reclaimed)} of dead air from the kept clips.`);
  renderTimeline(); renderSel(); updateProjStat(); scheduleStateSave();
});
$('#unpurgeBtn').addEventListener('click', () => {
  if (!state.undoSnap) return;
  state.highlights = JSON.parse(state.undoSnap);
  state.undoSnap = null; state.sel = null;
  $('#unpurgeBtn').classList.add('hidden');
  status('#renderStatus', 'Purge undone.');
  renderTimeline(); renderSel(); updateProjStat(); scheduleStateSave();
});

// ---------- music (engine contract: /api/music — looped, faded, sidechain-ducked at render) ----------
function renderMusic() {
  const m = state.music;
  $('#musStatus').textContent = m
    ? `${m.name} · ${Math.round(m.volume * 100)}% · duck ${m.duck} — mixes into every render`
    : 'none attached — loops under every render, ducks under speech (gentle ≈ 3–6 dB on gameplay audio)';
  $('#musClear').classList.toggle('hidden', !m);
  if (m) { $('#musVol').value = m.volume; $('#musDuck').value = m.duck; }
}
async function saveMusic(music) {
  if (!state.proj) return;
  try {
    const d = await api('/api/music', { id: state.proj.id, music });
    state.music = d.music; renderMusic();
  } catch (err) { status('#musStatus', err.message, true); }
}
$('#musAttach').addEventListener('click', () => {
  const p = $('#musPath').value.trim();
  if (!p) { status('#musStatus', 'Type the path to an audio file first.', true); return; }
  saveMusic({ path: p, volume: Number($('#musVol').value), duck: $('#musDuck').value });
});
$('#musClear').addEventListener('click', () => { $('#musPath').value = ''; saveMusic(null); });
['musVol', 'musDuck'].forEach((id) => $('#' + id).addEventListener('change', () => {
  if (state.music) saveMusic({ path: state.music.path, volume: Number($('#musVol').value), duck: $('#musDuck').value });
}));
function renderSel() {
  const h = state.highlights.find((x) => String(x.id) === state.sel);
  $('#selBox').innerHTML = h
    ? `<b>${(h.title || h.id)}</b><br>${fmt(h.start)} → ${fmt(h.end)} · ${(h.end - h.start).toFixed(1)}s<br>` +
      `${h.keep ? 'kept — G drops it' : 'dropped — G keeps it'}`
    : 'click a clip to inspect';
}
function toggleKeep() {
  const h = state.highlights.find((x) => String(x.id) === state.sel);
  if (!h) return;
  h.keep = !h.keep;
  renderTimeline(); renderSel(); updateProjStat(); scheduleStateSave();
}

// ---------- transport ----------
const fpsOf = () => (state.proj && state.proj.meta && state.proj.meta.fps) || 30;
$('#playBtn').addEventListener('click', () => { player.paused ? player.play() : player.pause(); });
player.addEventListener('play', () => { $('#playBtn').textContent = '⏸'; });
player.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; });
$('#stepBack').addEventListener('click', () => { player.pause(); player.currentTime -= 1 / fpsOf(); });
$('#stepFwd').addEventListener('click', () => { player.pause(); player.currentTime += 1 / fpsOf(); });
player.addEventListener('timeupdate', () => {
  $('#tcode').innerHTML = `${tc(player.currentTime, fpsOf())} <span>/ ${tc(player.duration || 0, fpsOf())}</span>`;
  const total = (state.proj && state.proj.duration) || player.duration || 1;
  $('#playhead').style.left = `${Math.min(100, player.currentTime / total * 100)}%`;
});
let shuttleRate = 0;
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (!state.proj) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
  else if (k === 'l') { e.preventDefault(); shuttleRate = shuttleRate >= 1 ? Math.min(8, shuttleRate * 2) : 1; player.playbackRate = shuttleRate; player.play(); }
  else if (k === 'j') { e.preventDefault(); player.pause(); player.currentTime -= 2; }
  else if (k === 'k') { e.preventDefault(); shuttleRate = 0; player.playbackRate = 1; player.pause(); }
  else if (k === 'g') { e.preventDefault(); toggleKeep(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); player.pause(); player.currentTime += (1 / fpsOf()) * (e.shiftKey ? 10 : 1); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); player.pause(); player.currentTime -= (1 / fpsOf()) * (e.shiftKey ? 10 : 1); }
});

// ---------- storyboard ----------
$('#sbBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const btn = $('#sbBtn'); btn.disabled = true;
  try {
    const plan = await api('/api/storyboard', {
      highlights: state.highlights, blueprint: 'fast',
      sourceSec: state.proj.duration || 0,
      envelope: state.proj.envelope || [], sceneCuts: state.proj.sceneCuts || [],
    });
    const bodyIds = new Set((plan.body || []).map((h) => h.id));
    state.highlights.forEach((h) => { h.keep = bodyIds.has(h.id); });
    $('#sbInfo').textContent = `${bodyIds.size} kept`;
    renderTimeline(); updateProjStat(); scheduleStateSave();
  } catch (err) { status('#renderStatus', err.message, true); }
  finally { btn.disabled = false; }
});

// ---------- render ----------
async function renderCut(statusSel) {
  const kept = state.highlights.filter((h) => h.keep).sort((a, b) => a.start - b.start);
  if (!state.proj || !kept.length) { status(statusSel, 'Nothing kept — run the storyboard or keep clips with G.', true); return; }
  const vertical = $('#rVert').checked;
  status(statusSel, 'Rendering…');
  $('#busyStat').textContent = 'rendering';
  try {
    const d = await api('/api/export/sequence', {
      ...exportPrefs(), id: state.proj.id, vertical, zoom: false,
      ...(vertical ? { vstyle: 'blur' } : {}),
      clips: kept.map((h) => ({ start: h.start, end: h.end, fadeIn: h.fadeIn || 0, fadeOut: h.fadeOut || 0, speed: h.speed || 1 })),
    });
    const extras = [d.normalized ? `normalized ${d.normalized.measured}→−14 LUFS` : '', d.muted ? `${d.muted} word${d.muted === 1 ? '' : 's'} muted` : ''].filter(Boolean).join(' · ');
    status(statusSel, `Done — ${d.clips} clips rendered${extras ? ' · ' + extras : ''}.`);
    api('/api/reveal', { path: d.file }).catch(() => {});
  } catch (err) { status(statusSel, err.message, true); }
  finally { $('#busyStat').textContent = ''; }
}
$('#renderBtn').addEventListener('click', () => renderCut('#renderStatus'));
$('#pkExportBtn').addEventListener('click', () => renderCut('#pkStatus'));

// ---------- Tab 3 · thumbnails ----------
$('#coversBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const kept = state.highlights.filter((h) => h.keep).sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = kept[0] || state.highlights[0];
  if (!top) return;
  try {
    const d = await api('/api/covers', {
      clip: top, envelope: state.proj.envelope || [], sceneCuts: state.proj.sceneCuts || [], count: 4,
    });
    $('#coverStrip').innerHTML = (d.candidates || []).map((c) =>
      `<img src="/api/cover?id=${encodeURIComponent(state.proj.id)}&t=${c.t}&w=480" data-t="${c.t}" alt="cover at ${fmt(c.t)}" title="${fmt(c.t)}">`).join('');
  } catch (err) { status('#pkStatus', err.message, true); }
});
// ---------- thumbnail canvas editor ----------
// The old server-side builder pasted the facecam TWICE (the burned-in one survives in the
// frame), blurred the whole moment away, and set timid type. This compositor keeps the frame
// SHARP, lets you zoom/reframe to crop burned-in overlays out, draws ONE facecam layer with a
// ring, and sets poster-weight type — all draggable, saved server-side as the finished JPEG.
const TC = $('#thumbC'), tctx = TC.getContext('2d');
const TH = {
  img: null, zoom: 1, bx: 0.5, by: 0.5,
  cam: { on: true, cx: 0.80, cy: 0.26, w: 0.30 },
  text: { x: 0.05, y: 0.90, size: 132, color: '#FFFFFF' },
  hit: {}, drag: null,
};
function resetThumbEditor() {
  TH.img = null; TH.zoom = 1; TH.bx = 0.5; TH.by = 0.5; state.coverT = null;
  $('#tZoom').value = 1;
  $('#thumbEmpty').classList.add('on');
  tctx.clearRect(0, 0, 1280, 720);
}
function drawThumb() {
  if (!TH.img) return;
  const W = 1280, H = 720;
  tctx.clearRect(0, 0, W, H);
  // background — sharp, pan+zoom (cover-fit so no gaps)
  const img = TH.img;
  const s = Math.max(W / img.width, H / img.height) * TH.zoom;
  const dw = img.width * s, dh = img.height * s;
  const dx = Math.max(W - dw, Math.min(0, W / 2 - TH.bx * dw));
  const dy = Math.max(H - dh, Math.min(0, H / 2 - TH.by * dh));
  tctx.drawImage(img, dx, dy, dw, dh);
  // legibility gradient along the bottom third — not a full-frame blur
  const g = tctx.createLinearGradient(0, H * 0.6, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.62)');
  tctx.fillStyle = g; tctx.fillRect(0, H * 0.6, W, H * 0.4);
  // facecam — ONE layer, cropped from the source frame's cam rect, rounded + gold ring
  TH.hit.cam = null;
  const fc = state.proj && state.proj.facecam;
  if (TH.cam.on && fc && fc.w) {
    // facecam rect is stored as FRACTIONS of the frame — scale by the image's own dimensions
    const sx = fc.x * img.width, sy = fc.y * img.height;
    const sw = fc.w * img.width, sh = fc.h * img.height;
    const cw = TH.cam.w * W, ch = cw * (sh / sw);
    const cx = TH.cam.cx * W - cw / 2, cy = TH.cam.cy * H - ch / 2;
    const r = 20;
    tctx.save();
    tctx.shadowColor = 'rgba(0,0,0,.55)'; tctx.shadowBlur = 26; tctx.shadowOffsetY = 8;
    tctx.beginPath(); tctx.roundRect(cx, cy, cw, ch, r); tctx.fillStyle = '#000'; tctx.fill();
    tctx.restore();
    tctx.save();
    tctx.beginPath(); tctx.roundRect(cx, cy, cw, ch, r); tctx.clip();
    tctx.drawImage(img, sx, sy, sw, sh, cx, cy, cw, ch);
    tctx.restore();
    tctx.beginPath(); tctx.roundRect(cx, cy, cw, ch, r);
    tctx.lineWidth = 6; tctx.strokeStyle = '#FFD700'; tctx.stroke();
    TH.hit.cam = { x: cx, y: cy, w: cw, h: ch };
  }
  // text — poster weight, auto-fit, slight tilt, hard shadow + fat stroke
  TH.hit.text = null;
  const raw = ($('#thumbText').value.trim() || '').toUpperCase();
  if (raw) {
    let size = TH.text.size;
    tctx.font = `900 ${size}px Impact, 'Arial Black', sans-serif`;
    while (size > 56 && tctx.measureText(raw).width > W * 0.92) {
      size -= 4; tctx.font = `900 ${size}px Impact, 'Arial Black', sans-serif`;
    }
    const tx = TH.text.x * W, ty = TH.text.y * H;
    tctx.save();
    tctx.translate(tx, ty); tctx.rotate(-0.03);
    tctx.lineJoin = 'round'; tctx.textBaseline = 'alphabetic';
    const off = Math.max(4, size * 0.05);
    tctx.fillStyle = 'rgba(0,0,0,.85)'; tctx.fillText(raw, off, off);
    tctx.lineWidth = Math.max(8, size * 0.14); tctx.strokeStyle = '#000'; tctx.strokeText(raw, 0, 0);
    tctx.fillStyle = TH.text.color; tctx.fillText(raw, 0, 0);
    const m = tctx.measureText(raw);
    tctx.restore();
    TH.hit.text = { x: tx - 10, y: ty - size, w: m.width + 20, h: size * 1.25 };
  }
}
function canvasPt(e) {
  const r = TC.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * 1280, y: (e.clientY - r.top) / r.height * 720 };
}
TC.addEventListener('pointerdown', (e) => {
  if (!TH.img) return;
  const p = canvasPt(e);
  const inside = (b) => b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  TH.drag = inside(TH.hit.text) ? 'text' : inside(TH.hit.cam) ? 'cam' : 'bg';
  TH.last = p;
  TC.setPointerCapture(e.pointerId);
});
TC.addEventListener('pointermove', (e) => {
  if (!TH.drag) return;
  const p = canvasPt(e);
  const mx = (p.x - TH.last.x), my = (p.y - TH.last.y);
  if (TH.drag === 'text') { TH.text.x += mx / 1280; TH.text.y += my / 720; }
  else if (TH.drag === 'cam') { TH.cam.cx += mx / 1280; TH.cam.cy += my / 720; }
  else {
    const s = Math.max(1280 / TH.img.width, 720 / TH.img.height) * TH.zoom;
    TH.bx = Math.max(0, Math.min(1, TH.bx - mx / (TH.img.width * s)));
    TH.by = Math.max(0, Math.min(1, TH.by - my / (TH.img.height * s)));
  }
  TH.last = p; drawThumb();
});
TC.addEventListener('pointerup', () => { TH.drag = null; });
$('#thumbText').addEventListener('input', drawThumb);
$('#tSize').addEventListener('input', () => { TH.text.size = Number($('#tSize').value); drawThumb(); });
$('#tZoom').addEventListener('input', () => { TH.zoom = Number($('#tZoom').value); drawThumb(); });
$('#tCam').addEventListener('change', () => { TH.cam.on = $('#tCam').checked; drawThumb(); });
$('#tColors').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  document.querySelectorAll('#tColors .chip').forEach((x) => x.classList.toggle('sel', x === c));
  TH.text.color = c.dataset.c; drawThumb();
});
$('#coverStrip').addEventListener('click', (e) => {
  const img = e.target.closest('img'); if (!img) return;
  state.coverT = Number(img.dataset.t);
  document.querySelectorAll('#coverStrip img').forEach((i) => i.classList.toggle('sel', i === img));
  const full = new Image();
  full.onload = () => { TH.img = full; $('#thumbEmpty').classList.remove('on'); drawThumb(); };
  full.src = `/api/cover?id=${encodeURIComponent(state.proj.id)}&t=${state.coverT}&w=1920`;
});
$('#thumbSave').addEventListener('click', async () => {
  if (!state.proj) return;
  if (!TH.img) { status('#pkStatus', 'Pick a cover frame first (Suggest covers).', true); return; }
  try {
    const d = await api('/api/thumbsave', { id: state.proj.id, dataUrl: TC.toDataURL('image/jpeg', 0.92) });
    status('#pkStatus', 'Thumbnail saved — revealed in Finder.');
    api('/api/reveal', { path: d.file }).catch(() => {});
  } catch (err) { status('#pkStatus', err.message, true); }
});

// ---------- Tab 3 · titles + chapters ----------
$('#titlesBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const kept = state.highlights.filter((h) => h.keep).sort((a, b) => a.start - b.start);
  if (!kept.length) { status('#pkStatus', 'Keep some clips first — titles come from your cut.', true); return; }
  try {
    const t = await api('/api/autotitles', { clips: kept });
    // Dedupe — neighboring clips often share a snippet, and four identical titles is noise.
    const seen = new Set();
    const uniq = (t.titles || []).filter((x) => !seen.has(x.title) && seen.add(x.title));
    $('#titleList').innerHTML = uniq.slice(0, 4).map((x) => {
      const h = kept.find((k) => String(k.id) === String(x.id)) || {};
      return `<button class="titleRow"><b>${x.title.replace(/[<>&]/g, '')}</b><span class="num">from ${fmt(h.start || 0)}</span></button>`;
    }).join('');
    const pk = await api('/api/publishkit', { clips: kept });
    // buildChapters returns {chapters, text, valid} — text is the YouTube-ready block
    $('#chaptersOut').textContent = (pk.chapters && pk.chapters.text) || '';
    const cp = $('#copyDesc'); cp.classList.remove('hidden');
    cp.onclick = () => { navigator.clipboard.writeText(pk.description || '').then(() => { cp.textContent = 'Copied ✓'; setTimeout(() => { cp.textContent = 'Copy description'; }, 1500); }); };
  } catch (err) { status('#pkStatus', err.message, true); }
});

// ---------- autosave (same contract as the old shell — projects stay compatible) ----------
function saveStateNow() {
  clearTimeout(state.saveTimer); state.saveTimer = null;
  if (!state.proj) return;
  const edit = {
    keeps: state.highlights.filter((h) => h.keep).map((h) => String(h.id)),
    clips: state.highlights.map((h) => {
      const c = { id: String(h.id), start: h.start, end: h.end, title: h.title || '', keep: !!h.keep, score: h.score || 0, fadeIn: h.fadeIn || 0, fadeOut: h.fadeOut || 0, speed: h.speed || 1 };
      if (h.t != null) c.t = h.t;
      return c;
    }),
    cleared: !state.highlights.length,
    markers: (state.echo && state.echo.markers) || [],
    inPoint: state.echo ? state.echo.inPoint : null,
    outPoint: state.echo ? state.echo.outPoint : null,
  };
  fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.proj.id, edit }), keepalive: true }).catch(() => {});
}
function scheduleStateSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveStateNow, 1500); }
window.addEventListener('pagehide', () => { if (state.saveTimer) saveStateNow(); });

// ---------- status bar ----------
setInterval(async () => {
  try {
    const b = await api('/api/busy');
    $('#busyStat').textContent = b.busy ? (b.imports ? 'importing VOD…' : 'rendering…') : $('#busyStat').textContent === 'rendering' ? 'rendering' : '';
  } catch {}
}, 4000);

renderRecents();
