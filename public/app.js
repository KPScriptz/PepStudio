// ClipForge editor — analyze, curate highlights on a timeline, export.
const $ = (s) => document.querySelector(s);
const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const toast = (msg, isErr) => {
  const el = $('#toast');
  el.textContent = msg; el.classList.toggle('err', !!isErr); el.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), isErr ? 6000 : 3500);
};
const showProgress = (txt) => { $('#progressText').textContent = txt; $('#progress').classList.remove('hidden'); };
const hideProgress = () => $('#progress').classList.add('hidden');

const state = { proj: null, highlights: [], selected: null, drag: null };
const player = $('#player');
const canvas = $('#timeline');
const ctx = canvas.getContext('2d');

// ---- Status ----
state.canBurn = false;
fetch('/api/status').then((r) => r.json()).then((s) => {
  state.canBurn = !!s.canBurn;
  const b = $('#capStatus');
  if (!s.captions.ready) {
    b.textContent = 'captions: not set up'; b.className = 'badge muted';
    b.title = 'Install whisper.cpp + a model to enable captions';
  } else if (s.canBurn) {
    b.textContent = 'captions: ready ✓ (burn-in)'; b.className = 'badge ok';
  } else {
    b.textContent = 'captions: transcribe + .srt'; b.className = 'badge muted';
    b.title = 'Transcription works; this ffmpeg cannot burn text into pixels (no libass). Exports a .srt sidecar instead.';
    // Burn-in unavailable: relabel the checkboxes so expectations are honest.
    document.querySelectorAll('#capLong, #capShort').forEach((c) => { c.checked = false; });
    const hint = $('#exportHint');
    hint.innerHTML = 'ℹ︎ This ffmpeg has no <code>libass</code>, so captions export as a <b>.srt file</b> you drop into YouTube/CapCut. To burn text directly into the video, install a libass-enabled ffmpeg.';
  }
}).catch(() => {});

// ---- Analyze ----
$('#analyzeBtn').addEventListener('click', analyze);
$('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

// ---- Import a VOD from a YouTube/Twitch URL ----
$('#importBtn').addEventListener('click', importUrl);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') importUrl(); });

async function importUrl() {
  const url = $('#urlInput').value.trim();
  if (!url) return toast('Paste a YouTube or Twitch link first.', true);
  const fill = $('#urlBarFill'); const txt = $('#urlProgressText');
  $('#importBtn').disabled = true;
  $('#urlProgress').classList.remove('hidden');
  fill.style.width = '0%'; txt.textContent = 'Starting…';
  $('#editor').classList.add('hidden');
  try {
    const res = await fetch('/api/import-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'import failed');
    const jobId = data.jobId;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      const jr = await fetch(`/api/import-url/${jobId}`);
      const j = await jr.json();
      if (!jr.ok) throw new Error(j.error || 'job failed');
      if (j.status === 'downloading') {
        fill.style.width = `${j.progress || 0}%`;
        txt.textContent = `Downloading ${j.title ? `“${j.title}” ` : ''}${j.progress || 0}%`;
      } else if (j.status === 'analyzing') {
        fill.style.width = '100%';
        txt.textContent = 'Analyzing — silence, static screens, highlights…';
      } else if (j.status === 'done') {
        txt.textContent = 'Done ✓'; loadProject(j.project); break;
      } else if (j.status === 'error') { throw new Error(j.error); }
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#importBtn').disabled = false;
    setTimeout(() => $('#urlProgress').classList.add('hidden'), 1500);
  }
}

async function analyze() {
  const path = $('#pathInput').value.trim();
  if (!path) return toast('Paste a path to a video file first.', true);
  showProgress('Analyzing — audio silence + video freeze (Phantasm), scene cuts & highlights…');
  $('#editor').classList.add('hidden');
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'analyze failed');
    loadProject(data);
  } catch (e) {
    toast(e.message, true);
  } finally {
    hideProgress();
  }
}

function loadProject(data) {
  state.proj = data;
  state.highlights = (data.highlights || []).map((h) => ({ ...h }));
  state.segments = (data.phantasm || []).map((s) => ({ ...s }));
  state.selSeg = null;
  state.selected = state.highlights[0] ? state.highlights[0].id : null;
  player.src = `/api/video?id=${data.id}`;
  $('#metaName').textContent = data.name;
  const m = data.meta || {};
  $('#metaInfo').textContent = `${m.width}×${m.height} · ${m.fps}fps · ${fmt(data.duration)} · ${data.sceneCuts.length} scene cuts · ${(data.freezes || []).length} static screens · ${state.highlights.length} highlights`;
  $('#editor').classList.remove('hidden');
  $('#outputs').innerHTML = '';
  renderHighlights();
  renderGhosts();
  updatePhantasmSummary();
  resizeCanvas();
  draw();
  const st = data.phantasmStats || {};
  toast(`Phantasm: ${st.ghostCount || 0} ghosts (${fmt(st.ghostDuration || 0)} dead air) → cut ≈ ${fmt(st.cutDuration || 0)}.`);
}

// ---- Phantasm: ghost clips ----
const ghostKeep = (s) => s.state === 'keep';
function keepSegments() { return (state.segments || []).filter(ghostKeep).map((s) => ({ start: s.start, end: s.end })); }

function updatePhantasmSummary() {
  const segs = state.segments || [];
  const ghosts = segs.filter((s) => s.state === 'ghost');
  const ghostDur = ghosts.reduce((a, s) => a + (s.end - s.start), 0);
  const keepDur = (state.proj.duration || 0) - ghostDur;
  const risky = ghosts.filter((s) => s.risky).length;
  $('#phantasmSummary').innerHTML =
    `<b style="color:var(--danger)">${ghosts.length}</b> red ghosts · ${fmt(ghostDur)} dead air ` +
    `→ cut ≈ <b style="color:var(--green)">${fmt(keepDur)}</b>` +
    (risky ? ` · <span style="color:var(--hl)">⚠ ${risky} to check</span>` : '');
}

const reasonLabel = { silence: 'silence', static: 'static', dead: 'dead air' };
function renderGhosts() {
  // Show every segment that began as a ghost (re-kept ones stay listed, dimmed).
  const list = (state.segments || []).filter((s) => s.reason !== 'active');
  $('#ghostCount').textContent = `${list.filter((s) => s.state === 'ghost').length} red / ${list.length}`;
  const el = $('#ghostList');
  el.innerHTML = '';
  list.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'ghostRow' + (s.state === 'keep' ? ' kept' : '') + (s.id === state.selSeg ? ' sel' : '');
    const chip = s.risky ? '<span class="chip risky">⚠ check</span>'
      : `<span class="chip ${s.reason}">${reasonLabel[s.reason] || s.reason}</span>`;
    row.innerHTML = `
      ${chip}
      <div class="meta">
        <div>${fmt(s.start)}–${fmt(s.end)} <span class="muted">(${Math.round(s.end - s.start)}s)</span></div>
        <div class="muted">${s.state === 'keep' ? 'kept ✓' : 'will be cut'}</div>
      </div>
      <div class="acts">
        <button data-act="verify" title="Play 2s">▶</button>
        <button data-act="toggle">${s.state === 'ghost' ? 'Keep' : 'Ghost'}</button>
      </div>`;
    row.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') selectSeg(s); });
    row.querySelector('[data-act=verify]').addEventListener('click', () => verifySeg(s));
    row.querySelector('[data-act=toggle]').addEventListener('click', () => toggleSeg(s));
    el.appendChild(row);
  });
}

function selectSeg(s) { state.selSeg = s.id; player.currentTime = s.start; renderGhosts(); draw(); }
function verifySeg(s) { state.selSeg = s.id; player.currentTime = s.start; player.play(); s._stopAt = Math.min(s.end, s.start + 2); draw(); }
function toggleSeg(s) {
  s._wasGhost = true;
  s.state = s.state === 'ghost' ? 'keep' : 'ghost';
  renderGhosts(); updatePhantasmSummary(); draw();
}

// ---- Highlights list ----
function renderHighlights() {
  $('#hlCount').textContent = `${state.highlights.filter((h) => h.keep).length} kept / ${state.highlights.length}`;
  const list = $('#hlList');
  list.innerHTML = '';
  state.highlights.forEach((h) => {
    const row = document.createElement('div');
    row.className = 'hlRow' + (h.keep ? '' : ' dropped');
    row.innerHTML = `
      <div class="meta">
        <div>${h.id.toUpperCase()} · <span class="score">score ${h.score}</span></div>
        <div class="muted">${fmt(h.start)}–${fmt(h.end)} (${Math.round(h.end - h.start)}s)</div>
      </div>
      <div class="trim">
        start <input type="number" step="0.5" value="${h.start.toFixed(1)}" data-k="start">
        end <input type="number" step="0.5" value="${h.end.toFixed(1)}" data-k="end">
      </div>
      <div class="acts">
        <button data-act="preview">▶</button>
        <button data-act="keep">${h.keep ? 'Drop' : 'Keep'}</button>
      </div>`;
    row.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        h[inp.dataset.k] = Math.max(0, Math.min(state.proj.duration, v));
        if (h.end - h.start < 1) h.end = h.start + 1;
        renderHighlights(); draw();
      });
    });
    row.querySelector('[data-act=preview]').addEventListener('click', () => {
      state.selected = h.id; player.currentTime = h.start; player.play();
      h._stopAt = h.end; draw();
    });
    row.querySelector('[data-act=keep]').addEventListener('click', () => {
      h.keep = !h.keep; renderHighlights(); draw();
    });
    list.appendChild(row);
  });
}

// stop preview/verify playback at the marked end time (highlight or ghost segment)
player.addEventListener('timeupdate', () => {
  const stoppers = [...state.highlights, ...(state.segments || [])];
  const m = stoppers.find((x) => x._stopAt && player.currentTime >= x._stopAt);
  if (m) { player.pause(); m._stopAt = null; }
  draw();
  $('#tlTime').textContent = `${fmt(player.currentTime)} / ${fmt(state.proj?.duration || 0)}`;
});

// ---- Timeline canvas (Phantasm green/red band) ----
const TOP = 15; // top strip height (scene cuts + highlight markers)
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  canvas.width = w * dpr; canvas.height = 160 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

const X = (t) => (t / state.proj.duration) * canvas.clientWidth;
const T = (x) => (x / canvas.clientWidth) * state.proj.duration;

const SEG_FILL = {
  keep: 'rgba(52,211,153,0.22)',
  silence: 'rgba(212,86,75,0.42)',
  static: 'rgba(127,29,29,0.62)',
  dead: 'rgba(150,45,45,0.55)',
};

function draw() {
  if (!state.proj) return;
  const W = canvas.clientWidth, H = 160;
  ctx.clearRect(0, 0, W, H);

  // Phantasm band: contiguous keep/ghost blocks
  for (const s of (state.segments || [])) {
    const x = X(s.start), w = Math.max(1, X(s.end) - X(s.start));
    ctx.fillStyle = s.state === 'keep' ? SEG_FILL.keep : (SEG_FILL[s.reason] || SEG_FILL.silence);
    ctx.fillRect(x, TOP, w, H - TOP);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, H); ctx.stroke();
    if (s.state === 'ghost' && s.risky) { // amber outline = silent-but-moving (check it)
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, TOP + 1, w - 2, H - TOP - 2);
    }
    if (s.id === state.selSeg) {
      ctx.strokeStyle = '#6ee7ff'; ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, TOP + 1, w - 2, H - TOP - 2);
    }
  }

  // loudness envelope inside the band
  const env = state.proj.envelope;
  if (env.length) {
    ctx.beginPath(); ctx.moveTo(0, H);
    for (const p of env) ctx.lineTo(X(p.t), H - p.v * (H - TOP - 6));
    ctx.lineTo(W, H); ctx.closePath();
    ctx.fillStyle = 'rgba(110,231,255,0.12)'; ctx.fill();
    ctx.strokeStyle = 'rgba(110,231,255,0.45)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // top strip: scene cuts + highlight markers (used for shorts)
  ctx.fillStyle = '#0a0c11'; ctx.fillRect(0, 0, W, TOP);
  ctx.strokeStyle = 'rgba(167,139,250,0.7)'; ctx.lineWidth = 1;
  for (const c of state.proj.sceneCuts) { ctx.beginPath(); ctx.moveTo(X(c), 0); ctx.lineTo(X(c), TOP); ctx.stroke(); }
  for (const h of state.highlights) {
    if (!h.keep) continue;
    const x = X(h.start), w = Math.max(2, X(h.end) - X(h.start));
    ctx.fillStyle = h.id === state.selected ? '#fbbf24' : 'rgba(251,191,36,0.7)';
    ctx.fillRect(x, 2, w, TOP - 4);
  }

  // playhead
  const px = X(player.currentTime || 0);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
}

// click: seek to point, select the phantasm segment under it (and highlight if in top strip)
canvas.addEventListener('mousedown', (e) => {
  if (!state.proj) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const t = Math.max(0, Math.min(state.proj.duration, T(x)));
  player.currentTime = t;
  const seg = (state.segments || []).find((s) => t >= s.start && t <= s.end);
  state.selSeg = seg ? seg.id : null;
  if (y < TOP) {
    const h = state.highlights.find((hh) => hh.keep && t >= hh.start && t <= hh.end);
    if (h) state.selected = h.id;
  }
  renderGhosts(); draw();
});

// keyboard: G toggle keep/ghost, V verify (play 2s), B banish-export
window.addEventListener('keydown', (e) => {
  if (!state.proj || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const seg = (state.segments || []).find((s) => s.id === state.selSeg);
  if (e.key === 'g' || e.key === 'G') { if (seg) { e.preventDefault(); toggleSeg(seg); } }
  else if (e.key === 'v' || e.key === 'V') { if (seg) { e.preventDefault(); verifySeg(seg); } }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); $('#banishBtn').click(); }
});

// ---- Captions ----
$('#captionsBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  showProgress('Transcribing with Whisper (local)… first run downloads nothing extra.');
  try {
    const res = await fetch('/api/captions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.proj.hasCaptions = true;
    if (data.canBurn) {
      toast(`Captions ready: ${data.count} chunks. They'll burn in on export.`);
    } else {
      toast(`Captions ready: ${data.count} chunks. Saved as .srt for YouTube/CapCut import.`);
      const el = document.createElement('div');
      el.className = 'outItem';
      el.innerHTML = `<span class="tag">srt</span><strong>captions.srt</strong>
        <a href="${data.srtUrl}" target="_blank" download>download</a>`;
      $('#outputs').prepend(el);
    }
  } catch (e) { toast(e.message, true); } finally { hideProgress(); }
});

// ---- Exports ----
function keptHighlightClips() {
  return state.highlights.filter((h) => h.keep).map((h) => ({ start: h.start, end: h.end }));
}
function longSegments() {
  if ($('#longMode').value === 'highlights') return keptHighlightClips();
  return keepSegments(); // Phantasm: everything still green
}

async function renderLongCut(label) {
  const segments = longSegments();
  if (!segments.length) return toast('Nothing left to export — all segments are red.', true);
  showProgress(`Rendering ${label} from ${segments.length} green segments…`);
  try {
    const res = await fetch('/api/export/longcut', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, segments, captions: $('#capLong').checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addOutput(label, data, 'longcut');
    toast(`${label} exported ✓${data.captionsBurned ? ' (captions burned in)' : ''}`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); }
}

$('#longBtn').addEventListener('click', () => { if (state.proj) renderLongCut('Long cut'); });

// "Banish all red" = commit the Phantasm cut from the current green set.
$('#banishBtn').addEventListener('click', () => {
  if (!state.proj) return;
  const ghosts = (state.segments || []).filter((s) => s.state === 'ghost');
  const risky = ghosts.filter((s) => s.risky).length;
  const dur = ghosts.reduce((a, s) => a + (s.end - s.start), 0);
  let msg = `Banish ${ghosts.length} red ghosts (${fmt(dur)} of dead air) and export the cut?`;
  if (risky) msg += `\n\n⚠ ${risky} are silent-but-moving (possible stealth plays). Keep them first if they matter.`;
  if (!window.confirm(msg)) return;
  $('#longMode').value = 'phantasm';
  renderLongCut('Phantasm cut');
});

// ---- Publish: TikTok pack + YouTube cut ----
function topClips(n) {
  return [...state.highlights]
    .filter((h) => h.keep)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.start - b.start)
    .map((h) => ({ start: h.start, end: h.end }));
}
// Cold-open hook = ~5s around the single highest-scoring moment.
function hookRange() {
  const top = [...state.highlights].sort((a, b) => b.score - a.score)[0];
  if (!top) return null;
  const d = state.proj.duration;
  return [Math.max(0, +(top.t - 2).toFixed(2)), Math.min(d, +(top.t + 3).toFixed(2))];
}

$('#tiktokBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const n = parseInt($('#tiktokCount').value, 10) || 5;
  const clips = topClips(n);
  if (!clips.length) return toast('No highlights to clip — keep at least one.', true);
  const caps = $('#capPublish').checked;
  $('#tiktokBtn').disabled = true;
  showProgress(`Rendering ${clips.length} TikTok clips — vertical${caps ? ' + transcribing captions' : ''}…`);
  try {
    const res = await fetch('/api/export/tiktok', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, captions: caps }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.clips.forEach((c, i) => addOutput(`TikTok ${i + 1}`, c, 'tiktok'));
    toast(`${data.clips.length} TikTok clips ready${data.captionsBurned ? ' with burned captions' : ''} ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); $('#tiktokBtn').disabled = false; }
});

$('#youtubeBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const segments = keepSegments();
  if (!segments.length) return toast('Nothing to cut — all segments are red.', true);
  const hook = hookRange();
  const caps = $('#capPublish').checked;
  $('#youtubeBtn').disabled = true;
  showProgress(`Building YouTube cut — cold-open hook + tight edit${caps ? ' + captions' : ''}…`);
  try {
    const res = await fetch('/api/export/youtube', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, segments, hook, captions: caps }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addOutput('YouTube cut', data, 'youtube');
    toast(`YouTube cut ready${data.hook ? ' (hooked)' : ''}${data.captionsBurned ? ' + captions' : ''} ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); $('#youtubeBtn').disabled = false; }
});

$('#shortsBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const clips = keptHighlightClips();
  if (!clips.length) return toast('Keep at least one highlight to export shorts.', true);
  showProgress(`Rendering ${clips.length} vertical shorts…`);
  try {
    const res = await fetch('/api/export/shorts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, captions: $('#capShort').checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.shorts.forEach((s, i) => addOutput(`Short ${i + 1}`, s, 'short'));
    toast(`${data.shorts.length} shorts exported ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); }
});

$('#thumbsBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const times = state.highlights.filter((h) => h.keep).map((h) => h.t);
  if (!times.length) return toast('Keep at least one highlight to grab thumbnails.', true);
  showProgress(`Grabbing ${times.length} thumbnail frames…`);
  try {
    const res = await fetch('/api/export/thumbs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, times }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.thumbs.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'outItem';
      el.innerHTML = `<span class="tag">thumb</span><strong>Thumbnail ${i + 1}</strong>
        <a href="${t.url}" target="_blank">view</a>
        <button data-reveal style="padding:5px 10px;font-size:12px">Reveal</button>`;
      el.querySelector('[data-reveal]').addEventListener('click', () =>
        fetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: t.file }) }));
      $('#outputs').prepend(el);
    });
    toast(`${data.thumbs.length} thumbnails saved (1280px). Drop into Canva to finish.`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); }
});

function addOutput(label, data, kind) {
  const el = document.createElement('div');
  el.className = 'outItem';
  el.innerHTML = `<span class="tag">${kind}</span>
    <strong>${label}</strong>
    <a href="${data.url}" target="_blank">open</a>
    <button data-reveal style="padding:5px 10px;font-size:12px">Reveal in Finder</button>`;
  el.querySelector('[data-reveal]').addEventListener('click', () => {
    fetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: data.file }) });
  });
  $('#outputs').prepend(el);
}
