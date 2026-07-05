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
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const showProgress = (txt) => { $('#progressText').textContent = txt; $('#progress').classList.remove('hidden'); };
const hideProgress = () => $('#progress').classList.add('hidden');

const state = { proj: null, highlights: [], selected: null, drag: null };
const player = $('#player');
const canvas = $('#timeline');
const ctx = canvas.getContext('2d');
const IC_PLAY = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2l10 6-10 6V2z"/></svg>';

// ---- Theme (Liquid Glass light/dark) ----
(() => {
  const saved = localStorage.getItem('pepstudio-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  $('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pepstudio-theme', next);
    if (state.proj) draw();   // canvas stays dark, but redraw to be safe
  });
})();

// ---- Project picker (launch overlay) + recents ----
const RECENTS_KEY = 'pep_recents';
function loadRecents() { try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; } }
function pushRecent(id, name) {
  if (!id) return;
  const list = loadRecents().filter((r) => r.id !== id);
  list.unshift({ id, name: name || id, ts: Date.now() });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 12)));
}
function renderRecents() {
  const list = loadRecents();
  $('#recentsGrid').innerHTML = list.length
    ? list.map((r) => `<div class="recent-card" data-id="${r.id}">
         <div class="recent-thumb" style="background-image:url('/api/thumb?id=${encodeURIComponent(r.id)}&t=1')">
           <div class="recent-acts">
             <button class="recent-rename" title="Rename">Rename</button>
             <button class="recent-del" title="Remove from recents">Remove</button>
           </div>
         </div>
         <div class="recent-name">${escapeHtml(r.name)}</div>
         <div class="recent-date">${new Date(r.ts).toLocaleDateString()}</div>
       </div>`).join('')
    : '<div class="recents-empty">No recent projects yet — hit “+ New Project” to start.</div>';
}
// One delegated handler: rename / delete (recents-only) / open.
$('#recentsGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.recent-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.recent-rename')) {
    const list = loadRecents(); const i = list.findIndex((r) => r.id === id);
    if (i < 0) return;
    const name = prompt('Rename project:', list[i].name);
    if (name && name.trim()) { list[i].name = name.trim(); localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); renderRecents(); }
    return;
  }
  if (e.target.closest('.recent-del')) {
    if (confirm('Remove this project from recents? (the rendered files are kept)')) {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(loadRecents().filter((r) => r.id !== id)));
      renderRecents();
    }
    return;
  }
  openRecent(id);
});
const showPicker = () => { renderRecents(); $('#view-project-picker').classList.remove('hidden'); };
const hidePicker = () => $('#view-project-picker').classList.add('hidden');
async function openRecent(id) {
  try {
    showProgress('Opening project…');
    const r = await fetch(`/api/analysis/${id}`);
    if (!r.ok) throw new Error('Project not found (it may have been cleared).');
    loadProject(await r.json());
    hidePicker();
  } catch (e) { toast(e.message, true); } finally { hideProgress(); }
}
// New Project → reveal the (empty) workspace shell: monitor placeholder + empty sequence,
// ready for ingest. Source state is cleared, but no project is loaded yet.
function newProject() {
  hidePicker();
  state.proj = null; state.highlights = []; state.segments = []; state.selected = null;
  try { player.removeAttribute('src'); player.load(); } catch {}
  $('#editor').classList.remove('hidden');
  $('#monitorPlaceholder')?.classList.remove('hidden');
  $('#metaName').textContent = 'Untitled Project *';
  $('#metaInfo').textContent = '';
  { const t = $('#activeProjectTitle'); if (t) t.textContent = 'Untitled Sequence *'; }
  renderMediaAsset();   // clears the bin's asset card (no project)
  renderHighlights();
  $('#pathInput').focus();
}
$('#btnNewProject')?.addEventListener('click', newProject);
$('#backToProjects')?.addEventListener('click', showPicker);
// Native file dialog (Step 2) routes the chosen absolute path here, same as drag-drop.
window.pepResolveNativeFilePath = (p) => { hidePicker(); window.pepHandleDroppedPath(p); };
renderRecents();

// ---- Status ----
state.canBurn = false;
state.pepaiReady = false;
fetch('/api/status').then((r) => r.json()).then((s) => {
  state.canBurn = !!s.canBurn;
  state.pepaiReady = !!(s.pepai && s.pepai.ready);
  // PepAI is an optional upgrade — only reveal the button when a local model is detected.
  const pb = $('#pepaiBtn');
  if (pb) {
    pb.classList.toggle('hidden', !state.pepaiReady);
    if (state.pepaiReady) pb.title = `Upgrade titles/tags with local PepAI (${s.pepai.model})`;
  }
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

// "Choose file…" → native OS dialog: Electron IPC in the Electron build, the Swift
// pepChooseFile bridge (NSOpenPanel) in the native macOS app, prompt in a plain browser.
$('#btn-import-file')?.addEventListener('click', async () => {
  if (window.electron && typeof window.electron.showOpenDialog === 'function') {
    try {
      const p = await window.electron.showOpenDialog();
      if (p) window.pepResolveNativeFilePath(p);
    } catch (e) { toast(`File dialog failed: ${e.message}`, true); }
  } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pepChooseFile) {
    // Native macOS shell: real NSOpenPanel; the selection comes back via pepResolveNativeFilePath.
    window.webkit.messageHandlers.pepChooseFile.postMessage(null);
  } else {
    const p = prompt('Enter the absolute path to a video file:');
    if (p && p.trim()) window.pepResolveNativeFilePath(p.trim());
  }
});

// ---- Drag & drop a local video onto the import card ----
// Single entry point for a resolved absolute path. Electron exposes file.path on the drop;
// the native WKWebView host can call this directly via a Swift drag bridge. Plain browsers
// can't read local paths, so they fall back to the graceful hint below.
window.pepHandleDroppedPath = (p) => {
  if (!p) return;
  $('#pathInput').value = p;
  analyze();
};
// Stop the browser from navigating to a file dropped anywhere in the window.
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
(() => {
  const zone = $('#importBar');
  if (!zone) return;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { stop(e); zone.classList.add('dropping'); }));
  ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, (e) => { stop(e); zone.classList.remove('dropping'); }));
  zone.addEventListener('drop', (e) => {
    stop(e); zone.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (f.path) window.pepHandleDroppedPath(f.path);   // Electron / native bridge expose the path
    else toast('Drag-drop needs the PepStudio desktop app — paste the file path here instead.', true);
  });
})();

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
  // NLE: keep the 4-pane workspace visible during import (progress shows in the media bin).
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
  // NLE: keep the workspace persistent during analyze (the spinner overlay handles feedback).
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
  pushRecent(data.id, data.name);   // remember for the project picker
  state.highlights = (data.highlights || []).map((h) => ({ ...h }));
  state.segments = (data.phantasm || []).map((s) => ({ ...s }));
  state.selSeg = null;
  state.selected = state.highlights[0] ? state.highlights[0].id : null;
  player.src = `/api/video?id=${data.id}`;
  $('#monitorPlaceholder')?.classList.add('hidden');
  $('#metaName').textContent = data.name;
  { const t = $('#activeProjectTitle'); if (t) t.textContent = data.name; }
  $('#editor').classList.remove('hidden');
  $('#outputs').innerHTML = '';
  renderMeta();
  renderHighlights();
  renderGhosts();
  updatePhantasmSummary();
  resizeCanvas();
  draw();
  if (data.videoReady) {
    const st = data.phantasmStats || {};
    toast(`Phantasm: ${st.ghostCount || 0} ghosts (${fmt(st.ghostDuration || 0)} dead air) → cut ≈ ${fmt(st.cutDuration || 0)}.`);
  } else {
    toast('Audio ready — curate now. Scanning video for dead air in the background…');
    pollVideoPass();
  }
}

function renderMeta() {
  const d = state.proj; if (!d) return;
  const m = d.meta || {};
  const tail = d.videoReady
    ? `${(d.sceneCuts || []).length} scene cuts · ${(d.freezes || []).length} static screens`
    : 'analyzing video…';
  $('#metaInfo').textContent =
    `${m.width}×${m.height} · ${m.fps}fps · ${fmt(d.duration)} · ${tail} · ${state.highlights.length} highlights`;
  renderMediaAsset();
}

// Media Bin asset card: the loaded source rendered as a solid block (Premiere-style),
// replacing the dashed empty-drop-zone look once a file is mounted.
function renderMediaAsset() {
  const bar = $('#importBar'); if (!bar) return;
  let card = $('#mediaAsset');
  if (!state.proj) { if (card) card.remove(); bar.classList.remove('has-asset'); return; }
  const m = state.proj.meta || {};
  const html = `<div class="assetName">${escapeHtml(state.proj.name || 'source')}</div>
      <div class="assetMeta">${m.width || '?'}×${m.height || '?'} · ${m.fps || '?'}fps · ${fmt(state.proj.duration)}</div>`;
  if (!card) {
    card = document.createElement('div');
    card.id = 'mediaAsset'; card.className = 'mediaAsset';
    bar.prepend(card);
  }
  card.innerHTML = html;
  bar.classList.add('has-asset');
}

// Poll the persisted analysis until the background video pass (Phantasm / scene cuts) lands.
function pollVideoPass() {
  const id = state.proj && state.proj.id;
  if (!id || state.proj.videoReady) return;
  clearTimeout(state._vpTimer);
  const tick = async () => {
    if (!state.proj || state.proj.id !== id || state.proj.videoReady) return;
    try {
      const r = await fetch(`/api/analysis/${id}`);
      if (r.ok) {
        const d = await r.json();
        if (d.videoReady) return applyVideoPass(d);
        if (d.videoFailed) { renderMeta(); return toast('Video analysis failed — audio curation still works.', true); }
      }
    } catch {}
    state._vpTimer = setTimeout(tick, 1500);
  };
  state._vpTimer = setTimeout(tick, 1500);
}

// Patch phase-2 results into the live project. We deliberately do NOT overwrite
// state.highlights — the user may have already hit "Rank funny moments" — only the
// Phantasm band / scene cuts / freezes get added. Ghost curation can't have started yet
// (phantasm was empty at phase 1), so adopting the fresh segments is safe.
function applyVideoPass(d) {
  if (!state.proj || state.proj.id !== d.id) return;
  Object.assign(state.proj, {
    sceneCuts: d.sceneCuts || [],
    freezes: d.freezes || [],
    phantasm: d.phantasm || [],
    phantasmStats: d.phantasmStats || state.proj.phantasmStats,
    videoReady: true,
  });
  state.segments = (d.phantasm || []).map((s) => ({ ...s }));
  renderMeta();
  renderGhosts();
  updatePhantasmSummary();
  draw();
  const st = d.phantasmStats || {};
  toast(`Phantasm ready: ${st.ghostCount || 0} ghosts (${fmt(st.ghostDuration || 0)} dead air) → cut ≈ ${fmt(st.cutDuration || 0)}.`);
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
    (risky ? ` · <span style="color:var(--hl)">${risky} to check</span>` : '');
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
    const chip = s.risky ? '<span class="chip risky">check</span>'
      : `<span class="chip ${s.reason}">${reasonLabel[s.reason] || s.reason}</span>`;
    row.innerHTML = `
      ${chip}
      <div class="meta">
        <div>${fmt(s.start)}–${fmt(s.end)} <span class="muted">(${Math.round(s.end - s.start)}s)</span></div>
        <div class="muted">${s.state === 'keep' ? 'kept ✓' : 'will be cut'}</div>
      </div>
      <div class="acts">
        <button data-act="verify" title="Play 2s">${IC_PLAY}</button>
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
  if (!state.highlights.length) {
    $('#hlCount').textContent = '0 / 0';
    $('#hlList').innerHTML = '<div class="hlEmpty">Sequence empty — analyze a file, then press Rank funny moments to begin.</div>';
    renderTracks();
    return;
  }
  $('#hlCount').textContent = `${state.highlights.filter((h) => h.keep).length} kept / ${state.highlights.length}`;
  const list = $('#hlList');
  list.innerHTML = '';
  state.highlights.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'hlRow' + (h.keep ? '' : ' dropped');
    row.dataset.id = h.id;
    const reactBadge = (h.reactionScore != null)
      ? `<span class="react" title="reaction score">${h.reactionScore}</span>`
      : '';
    const hitTags = (h.hits && h.hits.length)
      ? `<span class="hitTags">${h.hits.map((t) => `<span class="tag ${t}">${t}</span>`).join('')}</span>`
      : '';
    const snip = h.snippet ? `<div class="snip">“${escapeHtml(h.snippet)}”</div>` : '';
    const titleLine = h.title
      ? `<div class="clipTitle">${escapeHtml(h.title)}${h.titleSource === 'pepai' ? '<span class="pepBadge">PepAI</span>' : ''}</div>`
      : '';
    const tagLine = (h.tags && h.tags.length)
      ? `<div class="ctags">${h.tags.map((t) => `<span class="ctag">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const trimmed = (h.snapped && h.originalStart != null)
      ? Math.max(0, (h.originalEnd - h.originalStart) - (h.end - h.start)) : 0;
    const snapChip = trimmed >= 1
      ? `<span class="snapChip" title="snapped to the reaction — trimmed ${trimmed.toFixed(1)}s of dead air">snapped</span>` : '';
    // Overlay drawer: text overlays in the server's shape {type,content,startTime,endTime}.
    const overlays = h.overlays || (h.overlays = []);
    const ovItems = overlays.map((ov, oi) => `
      <div class="ovItem" data-oi="${oi}">
        <select class="ovType" title="overlay type">
          <option value="text" ${ov.type === 'broll' ? '' : 'selected'}>Text</option>
          <option value="broll" ${ov.type === 'broll' ? 'selected' : ''}>B-roll</option>
        </select>
        <input type="text" class="ovText" value="${escapeHtml(ov.content || '')}" placeholder="${ov.type === 'broll' ? '/path/to/image.png' : 'on-screen text…'}">
        <input type="number" step="0.1" class="ovStart" value="${ov.startTime ?? 0}" title="start (s into clip)">
        <input type="number" step="0.1" class="ovEnd" value="${ov.endTime ?? 2}" title="end (s into clip)">
        <button class="ovDel" title="remove">✕</button>
      </div>`).join('');
    const ovDrawer = `<div class="ovDrawer" data-id="${h.id}">${ovItems}<button class="ovAdd" data-id="${h.id}">＋ Text overlay</button></div>`;
    row.innerHTML = `
      <div class="meta">
        <div class="seqLine"><span class="dragHandle" title="Drag to reorder the sequence">⠿</span><span class="seqNum">#${i + 1}</span></div>
        ${titleLine}
        <div>${h.id.toUpperCase()} · <span class="score">score ${h.score}</span> ${reactBadge} ${hitTags}</div>
        <div class="muted">${fmt(h.start)}–${fmt(h.end)} (${Math.round(h.end - h.start)}s) ${snapChip}</div>
        ${snip}
        ${tagLine}
      </div>
      <div class="trim">
        start <input type="number" step="0.5" value="${h.start.toFixed(1)}" data-k="start">
        end <input type="number" step="0.5" value="${h.end.toFixed(1)}" data-k="end">
      </div>
      <div class="acts">
        <button data-act="preview">${IC_PLAY}</button>
        <button data-act="keep">${h.keep ? 'Drop' : 'Keep'}</button>
      </div>
      ${ovDrawer}`;
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
    row.querySelector('.dragHandle').addEventListener('mousedown', (e) => {
      e.preventDefault(); startReorder(h.id);
    });
    list.appendChild(row);
  });
  renderTracks();
}

// ---- Premiere-style multi-track sequence timeline (output-time view of the real layers) ----
function renderTracks() {
  const lanes = $('#trackLanes');
  if (!lanes) return;
  const kept = (state.proj ? state.highlights : []).filter((h) => h.keep);
  if (!kept.length) { lanes.innerHTML = ''; $('#seqDur').textContent = '0:00'; return; }
  // Lay kept clips back-to-back in OUTPUT order (sequence time), tracking each clip's span.
  let acc = 0;
  const seq = kept.map((h) => { const d = Math.max(0.01, h.end - h.start); const s = acc; acc += d; return { h, s, d }; });
  const total = acc || 1;
  state.seqMap = { items: seq, total };   // source-time → sequence-position map for the playhead
  const maxScore = Math.max(0.0001, ...seq.map(({ h }) => h.score || 0));
  $('#seqDur').textContent = fmt(total);
  const pct = (t) => (t / total) * 100;
  const blk = (cls, left, width, label, title) =>
    `<div class="tblk ${cls}" style="left:${left}%;width:${Math.max(0.6, width)}%"${title ? ` title="${title}"` : ''}>${label ? `<span>${label}</span>` : ''}</div>`;

  const vOv = [], vClip = [], aSpeech = [], aMusic = [], aSfx = [];
  for (const { h, s, d } of seq) {
    const sc = h.score || 0;
    const tier = sc >= maxScore * 0.8 ? 'hot' : sc >= maxScore * 0.5 ? 'warm' : 'cool';
    vClip.push(blk('clip ' + tier, pct(s), pct(d), escapeHtml((h.title || h.id || '').slice(0, 24))));
    aSpeech.push(blk('speech', pct(s), pct(d), ''));
    const auto = h.automation || {};
    if (auto.bgMusic && auto.bgMusic.path) aMusic.push(blk('music', pct(s), pct(d), 'music'));
    (auto.sfxTrack || []).forEach((sfx) => aSfx.push(blk('sfx', pct(s + (sfx.time || 0)), 1.2, '◆', `SFX @ ${(sfx.time || 0)}s`)));
    (h.overlays || []).forEach((ov) => {
      const os = s + (ov.startTime ?? 0); const oe = s + (ov.endTime ?? d);
      vOv.push(blk(ov.type === 'broll' ? 'broll' : 'text', pct(os), pct(oe - os),
        ov.type === 'broll' ? 'b-roll' : escapeHtml((ov.content || 'text').slice(0, 16))));
    });
  }
  lanes.innerHTML = [vOv, vClip, aSpeech, aMusic, aSfx].map((a) => `<div class="lane">${a.join('')}</div>`).join('')
    + '<div class="seqPlayhead" id="seqPlayhead" style="display:none"></div>';
  updateSeqPlayhead();
}

// ---- Sequence reorder: drag a card's handle to change OUTPUT order (array order). This
// changes which order clips concat in exports — it NEVER touches a clip's source start/end.
let _reorderId = null;
function startReorder(id) { _reorderId = id; document.body.classList.add('reordering'); }
function reorderMove(clientY) {
  if (_reorderId == null) return;
  const rows = [...document.querySelectorAll('#hlList .hlRow')];
  let target = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return clientY < b.top + b.height / 2; });
  if (target === -1) target = rows.length;                 // past the last row → end
  const from = state.highlights.findIndex((h) => h.id === _reorderId);
  if (from === -1) return;
  const to = target > from ? target - 1 : target;          // adjust for the pending removal
  if (to === from || to < 0 || to >= state.highlights.length) return;
  const [m] = state.highlights.splice(from, 1);
  state.highlights.splice(to, 0, m);
  renderHighlights(); draw();
}
document.addEventListener('mousemove', (e) => { if (_reorderId != null) reorderMove(e.clientY); });
document.addEventListener('mouseup', () => {
  if (_reorderId == null) return;
  _reorderId = null; document.body.classList.remove('reordering');
});

// Transcribe candidate windows and re-rank by reaction (laughter / hype / big moments).
async function rankFunny() {
  if (!state.proj) return toast('Analyze a video first.', true);
  const btn = $('#funnyBtn');
  btn.disabled = true;
  showProgress('Listening for your reactions — laughter, hype, big moments…');
  try {
    const res = await fetch('/api/highlights/funny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not rank funny moments.');
    if (!data.highlights || !data.highlights.length) return toast('No standout reactions found in the candidates.', true);
    state.highlights = data.highlights.map((h) => ({ ...h }));
    state.selected = state.highlights[0].id;
    renderHighlights();
    draw();
    toast(`Ranked ${data.highlights.length} moments by reaction (from ${data.scoredCount} candidates).`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    hideProgress();
  }
}
$('#funnyBtn')?.addEventListener('click', rankFunny);

// Optional: upgrade the kept clips' titles/tags via local PepAI (Ollama). On-demand,
// off the funny hot path; patches titles in place and leaves heuristics on failed ones.
async function rankPepAI() {
  if (!state.proj) return;
  const kept = state.highlights.filter((h) => h.keep && h.snippet);
  if (!kept.length) return toast('Keep at least one clip with speech to upgrade.', true);
  const btn = $('#pepaiBtn');
  btn.disabled = true;
  showProgress(`PepAI is writing titles for ${kept.length} clip${kept.length > 1 ? 's' : ''}…`);
  try {
    const res = await fetch('/api/pepai/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: kept.map((h) => ({ id: h.id, transcript: h.snippet })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PepAI upgrade failed.');
    let upgraded = 0;
    for (const r of data.results || []) {
      if (!r.ok || !r.title) continue;
      const h = state.highlights.find((x) => x.id === r.id);
      if (h) { h.title = r.title; h.tags = r.tags || h.tags; h.titleSource = 'pepai'; upgraded++; }
    }
    renderHighlights();
    toast(upgraded ? `PepAI upgraded ${upgraded} title${upgraded > 1 ? 's' : ''} (${data.model}).` : 'PepAI returned nothing usable — heuristics kept.', !upgraded);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    hideProgress();
  }
}
$('#pepaiBtn')?.addEventListener('click', rankPepAI);

// ---- Overlay drawer: author per-clip text overlays (→ multi-track sequence export) ----
// Delegated on #hlList so it survives card re-renders. Edits update state without a
// re-render (no focus loss); add/remove re-render. Overlays stay in the server's shape.
$('#hlList').addEventListener('click', (e) => {
  const add = e.target.closest('.ovAdd');
  if (add) {
    const h = state.highlights.find((c) => c.id === add.dataset.id);
    if (!h) return;
    (h.overlays || (h.overlays = [])).push({
      type: 'text', content: 'NEW TEXT',
      startTime: 0, endTime: Math.min(2, +(h.end - h.start).toFixed(1)),
    });
    renderHighlights();
    return;
  }
  const del = e.target.closest('.ovDel');
  if (del) {
    const h = state.highlights.find((c) => c.id === del.closest('.ovDrawer').dataset.id);
    if (h && h.overlays) { h.overlays.splice(+del.closest('.ovItem').dataset.oi, 1); renderHighlights(); }
  }
});
$('#hlList').addEventListener('input', (e) => {
  const item = e.target.closest('.ovItem');
  if (!item) return;
  const h = state.highlights.find((c) => c.id === e.target.closest('.ovDrawer').dataset.id);
  const ov = h && h.overlays && h.overlays[+item.dataset.oi];
  if (!ov) return;
  if (e.target.classList.contains('ovText')) ov.content = e.target.value;
  else if (e.target.classList.contains('ovStart')) ov.startTime = +parseFloat(e.target.value || 0).toFixed(1);
  else if (e.target.classList.contains('ovEnd')) ov.endTime = +parseFloat(e.target.value || 0).toFixed(1);
  else if (e.target.classList.contains('ovType')) { ov.type = e.target.value; renderHighlights(); } // re-render → updated placeholder
});

// Export the kept clips (in sequence order) with their text overlays burned in.
$('#seqExportBtn')?.addEventListener('click', async () => {
  if (!state.proj) return;
  const clips = state.highlights.filter((h) => h.keep).map((h) => ({
    start: h.start, end: h.end,
    overlays: (h.overlays || []).filter((o) => o.content && o.content.trim()),
  }));
  if (!clips.length) return toast('Keep at least one clip to export the sequence.', true);
  $('#seqExportBtn').disabled = true;
  showProgress('Rendering sequence — clips in order, text overlays burned…');
  try {
    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, vertical: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addOutput('Sequence', data, 'sequence');
    toast(`Sequence rendered (${data.clips} clip${data.clips > 1 ? 's' : ''}) ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); $('#seqExportBtn').disabled = false; }
});

// stop preview/verify playback at the marked end time (highlight or ghost segment)
player.addEventListener('timeupdate', () => {
  const stoppers = [...state.highlights, ...(state.segments || [])];
  const m = stoppers.find((x) => x._stopAt && player.currentTime >= x._stopAt);
  if (m) { player.pause(); m._stopAt = null; }
  draw();
  $('#tlTime').textContent = `${fmt(player.currentTime)} / ${fmt(state.proj?.duration || 0)}`;
  updateTransport();
  updateSeqPlayhead();
});

// ---- Transport bar (custom controls under the monitor) + sequence playhead ----
function updateTransport() {
  const scrub = $('#tpScrub'); const tEl = $('#tpTime'); const pEl = $('#tpPlay');
  const dur = state.proj?.duration || player.duration || 0;
  if (scrub) { scrub.max = dur || 100; if (document.activeElement !== scrub) scrub.value = player.currentTime || 0; }
  if (tEl) tEl.textContent = `${fmt(player.currentTime || 0)} / ${fmt(dur)}`;
  if (pEl) pEl.classList.toggle('playing', !player.paused);
}
// Sequence time ≠ source time: find which kept clip the source playhead is inside, then
// place the sequence playhead at that clip's back-to-back position on the track lanes.
function updateSeqPlayhead() {
  const ph = $('#seqPlayhead'); if (!ph) return;
  const map = state.seqMap; const cur = player.currentTime || 0;
  if (!map || !map.items || !map.items.length) { ph.style.display = 'none'; return; }
  const hit = map.items.find(({ h }) => cur >= h.start - 0.05 && cur <= h.end + 0.05);
  if (!hit) { ph.style.display = 'none'; return; }
  ph.style.left = `${((hit.s + (cur - hit.h.start)) / map.total) * 100}%`;
  ph.style.display = 'block';
}
function setupTransport() {
  const play = $('#tpPlay'); const back = $('#tpBack'); const fwd = $('#tpFwd'); const scrub = $('#tpScrub');
  if (play) play.addEventListener('click', () => { if (player.paused) player.play(); else player.pause(); });
  // Premiere-style frame stepping: click = 1 frame (from the source fps), Shift+click = 5s jump.
  const frameStep = () => 1 / ((state.proj && state.proj.meta && state.proj.meta.fps) || 30);
  if (back) back.addEventListener('click', (e) => { player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 5 : frameStep())); });
  if (fwd) fwd.addEventListener('click', (e) => { player.currentTime = Math.min(player.duration || 1e9, player.currentTime + (e.shiftKey ? 5 : frameStep())); });
  if (scrub) scrub.addEventListener('input', () => { player.currentTime = parseFloat(scrub.value) || 0; });
  ['play', 'pause', 'loadedmetadata', 'seeked'].forEach((ev) => player.addEventListener(ev, updateTransport));
  updateTransport();
}
setupTransport();

// ---- Timeline canvas (Phantasm green/red band) ----
const TOP = 26;       // clip lane height (scene-cut ticks + draggable highlight blocks)
const EDGE_PX = 6;    // grab tolerance for a clip's trim edges
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

  // clip lane: scene-cut ticks + draggable highlight blocks with trim handles
  ctx.fillStyle = '#0a0c11'; ctx.fillRect(0, 0, W, TOP);
  ctx.strokeStyle = 'rgba(167,139,250,0.5)'; ctx.lineWidth = 1;
  for (const c of (state.proj.sceneCuts || [])) { ctx.beginPath(); ctx.moveTo(X(c), 0); ctx.lineTo(X(c), TOP); ctx.stroke(); }
  for (const h of state.highlights) {
    if (!h.keep) continue;
    const x = X(h.start), w = Math.max(3, X(h.end) - X(h.start));
    const sel = h.id === state.selected;
    ctx.fillStyle = sel ? 'rgba(251,191,36,0.85)' : 'rgba(251,191,36,0.5)';
    ctx.fillRect(x, 2, w, TOP - 4);
    // trim handles (left/right edges)
    ctx.fillStyle = sel ? '#fde68a' : '#fbbf24';
    ctx.fillRect(x, 2, 2, TOP - 4);
    ctx.fillRect(x + w - 2, 2, 2, TOP - 4);
    if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, 2.5, w - 1, TOP - 5); }
  }

  // playhead
  const px = X(player.currentTime || 0);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
}

// ---- Interactive clip lane: drag an edge to trim, drag the body to shift, else seek ----
// Hit-test the clip lane (y < TOP). Returns the clip + which zone (left/right edge or body).
function clipLaneAt(x, y) {
  if (y >= TOP) return null;                 // below the lane = Phantasm band (seek/select)
  for (const h of state.highlights) {
    if (!h.keep) continue;
    const sx = X(h.start), ex = X(h.end);
    if (x < sx - EDGE_PX || x > ex + EDGE_PX) continue;
    if (Math.abs(x - sx) <= EDGE_PX) return { clip: h, zone: 'left' };
    if (Math.abs(x - ex) <= EDGE_PX) return { clip: h, zone: 'right' };
    if (x > sx && x < ex) return { clip: h, zone: 'body' };
  }
  return null;
}

// Live-update one clip row's trim inputs mid-drag (no full re-render → no input focus loss).
function syncRowInputs(h) {
  const row = document.querySelector(`#hlList .hlRow[data-id="${h.id}"]`);
  if (!row) return;
  const si = row.querySelector('input[data-k=start]'); if (si) si.value = h.start.toFixed(1);
  const ei = row.querySelector('input[data-k=end]'); if (ei) ei.value = h.end.toFixed(1);
}

canvas.addEventListener('mousedown', (e) => {
  if (!state.proj) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;

  // On a clip in the lane? Start a trim/shift drag instead of seeking.
  const hit = clipLaneAt(x, y);
  if (hit) {
    e.preventDefault();
    state.selected = hit.clip.id;
    state.drag = {
      id: hit.clip.id, zone: hit.zone, anchorT: T(x),
      startStart: hit.clip.start, startEnd: hit.clip.end,
    };
    canvas.style.cursor = hit.zone === 'body' ? 'grabbing' : 'ew-resize';
    renderHighlights(); draw();
    return;
  }

  // Otherwise: seek + select the Phantasm segment under the cursor (original behavior).
  const t = Math.max(0, Math.min(state.proj.duration, T(x)));
  player.currentTime = t;
  const seg = (state.segments || []).find((s) => t >= s.start && t <= s.end);
  state.selSeg = seg ? seg.id : null;
  renderGhosts(); draw();
});

// Move/up on window so a fast drag keeps working even if the cursor leaves the canvas.
window.addEventListener('mousemove', (e) => {
  if (!state.proj) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;

  if (state.drag) {
    if (!canvas.clientWidth) return;   // guard: a 0-width canvas would make T(x) NaN
    const d = state.drag;
    const h = state.highlights.find((c) => c.id === d.id);
    if (!h) return;
    const dt = T(x) - d.anchorT;
    const dur = state.proj.duration, MIN = 0.3;
    if (d.zone === 'left') {
      h.start = +Math.max(0, Math.min(d.startStart + dt, h.end - MIN)).toFixed(3);
    } else if (d.zone === 'right') {
      h.end = +Math.min(dur, Math.max(d.startEnd + dt, h.start + MIN)).toFixed(3);
    } else { // body: shift, preserving length
      const len = d.startEnd - d.startStart;
      const ns = Math.max(0, Math.min(d.startStart + dt, dur - len));
      h.start = +ns.toFixed(3); h.end = +(ns + len).toFixed(3);
    }
    h.snapped = false;                  // manual edit → no longer an auto-snap
    syncRowInputs(h);
    requestAnimationFrame(draw);
    return;
  }

  // Hover feedback, only while over the canvas.
  if (x < 0 || x > canvas.clientWidth || y < 0 || y > 160) return;
  const hit = clipLaneAt(x, y);
  canvas.style.cursor = hit ? (hit.zone === 'body' ? 'grab' : 'ew-resize') : 'default';
});

window.addEventListener('mouseup', () => {
  if (!state.drag) return;
  const h = state.highlights.find((c) => c.id === state.drag.id);
  state.drag = null;
  canvas.style.cursor = 'default';
  if (h) { renderHighlights(); draw(); }   // commit: refresh duration line + snap chip + inputs
});

// Razor: double-click a clip to split it in two — at the playhead if it's inside the clip,
// otherwise at the click point. Both halves inherit the parent's title/tags and stay kept.
let _splitSeq = 0;
canvas.addEventListener('dblclick', (e) => {
  if (!state.proj) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (y >= TOP) return;
  const t = T(x);
  const clip = state.highlights.find((h) => h.keep && t > h.start && t < h.end);
  if (!clip) return;
  e.preventDefault();
  const MIN = 0.4;
  const pt = player.currentTime;
  let cut = +(pt > clip.start && pt < clip.end ? pt : t).toFixed(3);
  if (cut - clip.start < MIN || clip.end - cut < MIN) return toast('Too close to an edge to split.', true);
  const idx = state.highlights.indexOf(clip);
  const right = { ...clip, id: `m${++_splitSeq}`, start: cut, snapped: false };
  clip.end = cut; clip.snapped = false;
  state.highlights.splice(idx + 1, 0, right);
  state.selected = right.id;
  renderHighlights(); draw();
  toast(`Split into 2 clips at ${fmt(cut)}.`);
});

// keyboard: G toggle keep/ghost, V verify (play 2s), B banish-export
window.addEventListener('keydown', (e) => {
  if (!state.proj || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const seg = (state.segments || []).find((s) => s.id === state.selSeg);
  if (e.key === 'g' || e.key === 'G') { if (seg) { e.preventDefault(); toggleSeg(seg); } }
  else if (e.key === 'v' || e.key === 'V') { if (seg) { e.preventDefault(); verifySeg(seg); } }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); $('#banishBtn').click(); }
  // Spacebar = transport play/pause (industry standard; inputs already guarded above).
  else if (e.code === 'Space') { e.preventDefault(); if (player.paused) player.play(); else player.pause(); }
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
  if (risky) msg += `\n\n${risky} are silent-but-moving (possible stealth plays). Keep them first if they matter.`;
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

// Hand the Phantasm cut to Premiere/Resolve/FCP as an EDL + FCP7 XML.
$('#premiereBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  const segments = keepSegments();
  if (!segments.length) return toast('Nothing to hand off — all segments are red.', true);
  const markers = (state.highlights || []).map((h) => ({ t: h.t, name: `Highlight ${String(h.id || '').toUpperCase()}` }));
  $('#premiereBtn').disabled = true;
  showProgress('Building Premiere handoff (EDL + FCP7 XML)…');
  try {
    const res = await fetch('/api/export/premiere', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, segments, markers }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const el = document.createElement('div');
    el.className = 'outItem';
    el.innerHTML = `<span class="tag">premiere</span><strong>Premiere handoff</strong>
      <a href="${data.xmlUrl}" download>XML (auto-relink)</a>
      <a href="${data.edlUrl}" download>EDL</a>
      ${data.srtUrl ? `<a href="${data.srtUrl}" download>captions.srt</a>` : ''}`;
    $('#outputs').prepend(el);
    toast(`Premiere handoff ready: ${data.segments} segments @ ${data.fps}fps. In Premiere: File → Import the XML.`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); $('#premiereBtn').disabled = false; }
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

// ---- PepAI interactive console: chat with the local model; whitelisted tuning
// mutations are applied server-side to data/gaming_heuristics.json (hot-reloaded by
// the ranker). Rendered via textContent — no HTML injection from model output.
const aiHistory = [];
function aiAppend(who, text) {
  const log = $('#pepaiChatLog'); if (!log) return;
  const d = document.createElement('div');
  d.className = 'aiMsg ' + (who === 'you' ? 'you' : 'ai');
  const w = document.createElement('span'); w.className = 'aiWho';
  w.textContent = who === 'you' ? 'You' : 'PepAI';
  d.appendChild(w);
  d.appendChild(document.createTextNode(text));
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
async function aiSend() {
  const inp = $('#pepaiChatInput'); const btn = $('#pepaiChatSend');
  const q = (inp && inp.value || '').trim(); if (!q) return;
  inp.value = '';
  aiAppend('you', q);
  aiHistory.push({ role: 'user', content: q });
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/pepai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiHistory.slice(-12) }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'chat failed');
    aiHistory.push({ role: 'assistant', content: data.reply });
    aiAppend('ai', data.reply);
    if (data.applied) {
      aiAppend('ai', 'Tuning applied: ' + Object.entries(data.applied)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' · ')
        + ' — the next "Rank funny moments" uses these weights.');
    }
  } catch (e) {
    aiAppend('ai', `Offline — ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}
$('#pepaiChatSend')?.addEventListener('click', aiSend);
$('#pepaiChatInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') aiSend(); });

// ---- Sequence lanes: click a clip block or drag anywhere across the lanes to scrub.
// Maps lane-x% -> sequence time -> SOURCE time via state.seqMap (read-only: never
// mutates clip.start/end — guardrail).
(() => {
  const lanes = $('#trackLanes'); if (!lanes) return;
  const seek = (clientX) => {
    const map = state.seqMap;
    if (!map || !map.items || !map.items.length) return;
    const r = lanes.getBoundingClientRect(); if (!r.width) return;
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * map.total;
    let acc = 0;
    for (const { h, d } of map.items) {
      if (acc + d >= t) { player.currentTime = h.start + (t - acc); return; }
      acc += d;
    }
    player.currentTime = map.items[map.items.length - 1].h.end;
  };
  lanes.addEventListener('mousedown', (e) => {
    e.preventDefault();
    seek(e.clientX);
    const mv = (ev) => seek(ev.clientX);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
})();
