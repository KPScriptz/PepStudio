// ClipForge editor — analyze, curate highlights on a timeline, export.
const $ = (s) => document.querySelector(s);
const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
// FCP-style timecode HH:MM:SS:FF (frames from the source fps).
const tc = (t, fps) => {
  t = Math.max(0, t || 0); fps = Math.round(fps || 30) || 30;
  const p = (n) => String(n).padStart(2, '0');
  const f = Math.min(fps - 1, Math.floor((t - Math.floor(t)) * fps));
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(Math.floor(t) % 60)}:${p(f)}`;
};
const toast = (msg, isErr) => {
  const el = $('#toast');
  el.textContent = msg; el.classList.toggle('err', !!isErr); el.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), isErr ? 6000 : 3500);
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Progress also drives the OS: a Dock progress bar on macOS and a taskbar-button bar on Windows,
// so a long render stays visible when the app is behind something else. Same Electron call for
// both. Every native hook is optional-chained — in a plain browser tab there is no
// window.electron and these are simply inert.
const showProgress = (txt) => {
  $('#progressText').textContent = txt; $('#progress').classList.remove('hidden');
  try { window.electron?.setProgress?.(2); } catch {}    // 2 = indeterminate
};
const hideProgress = () => {
  $('#progress').classList.add('hidden');
  try { window.electron?.setProgress?.(-1); } catch {}   // -1 = clear
};

const state = { proj: null, highlights: [], selected: null, selClip: null, drag: null };
const player = $('#player');
// player.play() returns a promise that REJECTS if a pause()/seek interrupts it — which the J-K-L
// shuttle, clip verify and In→Out loop all do routinely. Unhandled it surfaced as a console
// AbortError on every fast transport tap, noise that would mask a real error. Swallow only that.
const safePlay = () => { const p = player.play(); if (p && p.catch) p.catch(() => {}); return p; };
const canvas = $('#timeline');
const ctx = canvas.getContext('2d');
const IC_PLAY = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2l10 6-10 6V2z"/></svg>';

// ---- Theme (Liquid Glass light/dark) ----
// No saved choice → follow the macOS system appearance (and keep following it live).
// The moment the user hits the toggle, their choice is persisted and wins from then on.
(() => {
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const systemTheme = () => (mq && mq.matches ? 'light' : 'dark');
  const apply = (t) => { document.documentElement.setAttribute('data-theme', t); if (state.proj) draw(); };
  const saved = localStorage.getItem('pepstudio-theme');
  apply(saved || systemTheme());   // instant paint from the fast local cache (no flash)
  let chosen = !!saved;            // has the user explicitly picked (locally)?

  // Server-side prefs are AUTHORITATIVE across relaunches: the packaged app binds a new random
  // port each launch (PORT=0), which wipes localStorage (origin:port-keyed) — so the durable
  // choice lives in /api/prefs. Adopt it once it arrives; keep localStorage as the fast cache.
  fetch('/api/prefs').then((r) => r.json()).then((p) => {
    if (p && (p.theme === 'light' || p.theme === 'dark')) {
      chosen = true;
      localStorage.setItem('pepstudio-theme', p.theme);
      apply(p.theme);
    }
  }).catch(() => {});

  if (mq) {
    mq.addEventListener('change', () => {
      if (chosen || localStorage.getItem('pepstudio-theme')) return;   // user has chosen; stop following
      apply(systemTheme());
    });
  }
  $('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    chosen = true;
    apply(next);
    localStorage.setItem('pepstudio-theme', next);   // fast local cache
    // Durable: survives the packaged app's per-launch port change (localStorage would not).
    fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }) }).catch(() => {});
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
  if (typeof renderHookLab === 'function') renderHookLab({});   // clear any stale cold-open health
  $('#pathInput').focus();
}
$('#btnNewProject')?.addEventListener('click', newProject);
$('#backToProjects')?.addEventListener('click', showPicker);
// Native file dialog (Step 2) routes the chosen absolute path here, same as drag-drop.
window.pepResolveNativeFilePath = (p) => { hidePicker(); window.pepHandleDroppedPath(p); };
renderRecents();

// ---- Native desktop chrome, gated on the real platform ----------------------------------------
// On macOS the window uses hiddenInset, so the traffic lights float OVER the top-left of the page.
// Without a matching inset they'd sit on top of the "‹ Projects" button. The class is applied only
// when the MAIN PROCESS confirms darwin — never from a user-agent guess — so Windows and a plain
// browser tab are untouched.
//
// The accent colour comes from macOS System Settings, so the app picks up the user's chosen colour
// the way a native app does. Off macOS it resolves to null and the stylesheet's accent stands.
(async () => {
  try {
    const el = window.electron; if (!el) return;
    const plat = await (el.platform?.() ?? null);
    if (plat) document.documentElement.classList.add(`os-${plat}`);
    if (plat === 'darwin') document.documentElement.classList.add('isMac');
    const accent = await (el.accentColor?.() ?? null);
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      document.documentElement.style.setProperty('--px-accent', accent);
      document.documentElement.style.setProperty('--premiere-blue', accent);
    }
  } catch { /* native chrome is a nicety — never block the UI on it */ }
})();
// Crash recovery: the server flags an unclean shutdown (.running sentinel survived); the
// curation autosaves on every edit, so recovery is just reopening the last project.
(async () => {
  try {
    const s = await (await fetch('/api/session')).json();
    const last = loadRecents()[0];
    const bar = $('#crashBanner');
    if (!s.crashed || !last || !bar) return;
    bar.innerHTML =
      `<span>PepStudio didn't shut down cleanly. Your edits are autosaved — pick up where you left off?</span>
       <button id="crashRestoreBtn">Restore “${escapeHtml(last.name)}”</button>
       <button id="crashDismissBtn" class="ghostBtn">Dismiss</button>`;
    bar.classList.remove('hidden');
    $('#crashRestoreBtn').addEventListener('click', () => { bar.classList.add('hidden'); openRecent(last.id); });
    $('#crashDismissBtn').addEventListener('click', () => bar.classList.add('hidden'));
  } catch { /* session check is best-effort — never block the picker */ }
})();

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
  // Restore autosaved curation (crash/relaunch-safe): saved clip windows/titles/keeps replace the
  // base set (they may include razor splits the base never had), re-merged with the base clips'
  // rich fields (snippet/hits/story) by id so ranking context survives.
  if (data.edit && Array.isArray(data.edit.clips) && data.edit.clips.length) {
    const base = Object.fromEntries(state.highlights.map((h) => [String(h.id), h]));
    state.highlights = data.edit.clips.map((c) => ({ ...(base[c.id] || {}), ...c }));
    state.markers = (data.edit.markers || []).map((m) => ({ t: m.t, label: m.label || '' }));
    state.inPoint = Number.isFinite(data.edit.inPoint) ? data.edit.inPoint : null;
    state.outPoint = Number.isFinite(data.edit.outPoint) ? data.edit.outPoint : null;
  } else { state.markers = []; state.inPoint = null; state.outPoint = null; }
  if (typeof renderRail === 'function') setTimeout(renderRail, 0);   // rail exists after this script block
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
  if (typeof renderHookLab === 'function') renderHookLab({});   // reset cold-open health for the new project
  state.facecam = data.facecam || null;                          // per-project facecam box (persisted in analysis)
  if (typeof renderFcStatus === 'function') renderFcStatus();
  if (typeof resetUndoBaseline === 'function') setTimeout(resetUndoBaseline, 0);   // undo history starts at the loaded state
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
  // Premiere-style media tile: thumbnail with a duration badge (bottom-right) + blue
  // selection ring. Reuses the same /api/thumb frame grabs the timeline filmstrip uses.
  const html = `<div class="assetThumb" style="background-image:url('/api/thumb?id=${encodeURIComponent(state.proj.id)}&t=1')">
        <span class="assetDur">${fmt(state.proj.duration)}</span>
      </div>
      <div class="assetName">${escapeHtml(state.proj.name || 'source')}</div>
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
  if (typeof renderAIAssistant === 'function') renderAIAssistant();   // dead-air count lands with phase-2 segments
  if (typeof scheduleRunPlan === 'function') scheduleRunPlan();   // re-cost the planned cut
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
function verifySeg(s) { state.selSeg = s.id; player.currentTime = s.start; safePlay(); s._stopAt = Math.min(s.end, s.start + 2); draw(); }
function toggleSeg(s) {
  s._wasGhost = true;
  s.state = s.state === 'ghost' ? 'keep' : 'ghost';
  logEdit(s.state === 'ghost' ? 'segment_cut' : 'segment_restored', { start: s.start, end: s.end, reason: s.reason });
  promptCorrection(s.state === 'ghost' ? 'segment_cut' : 'segment_restore', { start: s.start, end: s.end, segReason: s.reason, label: `segment ${s.state === 'ghost' ? 'cut' : 'restored'}` });
  renderGhosts(); updatePhantasmSummary(); draw();
}

// ---- Highlights list ----
function renderHighlights() {
  // Re-cost the planned cut whenever the moment set changes (ranking, keeps, trims, cuts).
  if (typeof scheduleRunPlan === 'function') scheduleRunPlan();
  // Re-audit too. Hooked HERE and not in renderTracks on purpose: refreshCritic() repaints the
  // lanes via renderTracks, so auditing from there would recurse.
  if (typeof scheduleCritic === 'function') scheduleCritic();
  if (!state.highlights.length) {
    $('#hlCount').textContent = '0 / 0';
    $('#hlList').innerHTML = '<div class="hlEmpty">Sequence empty — analyze a file, then press Rank funny moments to begin.</div>';
    renderTracks();
    return;
  }
  $('#hlCount').textContent = `${state.highlights.filter((h) => h.keep).length} kept / ${state.highlights.length}`;
  const list = $('#hlList');
  list.innerHTML = '';
  buildStory(state.highlights);   // v0.1 story graph → per-clip "why kept"
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
        ${h.story && h.story.why ? `<div class="storyWhy">${STORY_ICON}${escapeHtml(h.story.why)}</div>` : ''}
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
        logEdit('trim', { id: h.id, edge: inp.dataset.k, start: +h.start.toFixed(1), end: +h.end.toFixed(1) });
        promptCorrection('trim', { clipId: h.id, edge: inp.dataset.k, start: +h.start.toFixed(1), end: +h.end.toFixed(1), story: (h.story || {}).intent || null, label: `trimmed ${h.id.toUpperCase()}` });
        renderHighlights(); draw();
      });
    });
    row.querySelector('[data-act=preview]').addEventListener('click', () => {
      state.selected = h.id; player.currentTime = h.start; safePlay();
      h._stopAt = h.end; draw();
    });
    row.querySelector('[data-act=keep]').addEventListener('click', () => {
      h.keep = !h.keep;
      logEdit(h.keep ? 'clip_kept' : 'clip_dropped', { id: h.id, start: h.start, end: h.end, score: h.score,
        story: h.story ? { role: h.story.label, intent: h.story.intent, confidence: h.story.confidence, setupAt: h.story.setupAt, payoffAt: h.story.payoffAt, callbackOf: h.story.callbackOf } : null,
        scores: h.scores || null });
      promptCorrection(h.keep ? 'restore' : 'drop', { clipId: h.id, kept: h.keep, story: (h.story || {}).intent || null, label: `${h.keep ? 'restored' : 'dropped'} ${h.id.toUpperCase()}` });
      renderHighlights(); draw();
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
  if (typeof renderAIAssistant === 'function') renderAIAssistant();   // keep the copilot live
  const lanes = $('#trackLanes');
  if (!lanes) return;
  let kept = (state.proj ? state.highlights : []).filter((h) => h.keep);
  // Full-source view: with no curated clips kept, mount the UNCUT VOD on the lanes (filmstrip +
  // waveform + scrub all work) instead of an empty timeline. Display/seek only — every export
  // reads the real kept set, so nothing accidentally renders the whole VOD as a "short".
  const sourceView = !kept.length && !!(state.proj && state.proj.duration);
  if (!kept.length && !sourceView) { lanes.innerHTML = ''; $('#seqDur').textContent = '0:00'; updateSeqViewBtn(false); return; }
  if (sourceView) kept = [{ id: '__source', start: 0, end: state.proj.duration, title: state.proj.name || 'Full source', score: 0, keep: true }];
  updateSeqViewBtn(sourceView);
  // Lay kept clips back-to-back in OUTPUT order (sequence time), tracking each clip's span.
  let acc = 0;
  const seq = kept.map((h) => { const d = Math.max(0.01, h.end - h.start); const s = acc; acc += d; return { h, s, d }; });
  const total = acc || 1;
  state.seqMap = { items: seq, total };   // source-time → sequence-position map for the playhead
  const maxScore = Math.max(0.0001, ...seq.map(({ h }) => h.score || 0));
  $('#seqDur').textContent = fmt(total);
  const pct = (t) => (t / total) * 100;
  const blk = (cls, left, width, label, title, extra) =>
    `<div class="tblk ${cls}" style="left:${left}%;width:${Math.max(0.6, width)}%;${extra || ''}"${title ? ` title="${title}"` : ''}>${label ? `<span>${label}</span>` : ''}</div>`;

  // FCP-style filmstrip: 3 real frames (start/mid/end of the clip's SOURCE range) under a
  // cobalt tint so the label stays legible. Frames come from GET /api/thumb (real ffmpeg
  // grabs) — only when a project id is loaded; otherwise clips fall back to the flat fill.
  const filmstrip = (h) => {
    if (!state.proj || !state.proj.id) return '';
    const id = encodeURIComponent(state.proj.id);
    const dur = Math.max(0.1, h.end - h.start);
    const ts = [0.1, 0.5, 0.9].map((f) => Math.max(0, h.start + dur * f).toFixed(1));
    const imgs = ts.map((t) => `url('/api/thumb?id=${id}&t=${t}')`).join(',');
    return `background-image:linear-gradient(rgba(20,40,90,.40),rgba(20,40,90,.68)),${imgs};`
      + 'background-position:center,0% center,50% center,100% center;'
      + 'background-size:cover,33.34% 100%,33.34% 100%,33.34% 100%;'
      + 'background-repeat:no-repeat;';
  };

  // FCP-style audio waveform inside A1 speech clips, drawn from the REAL loudness envelope
  // (state.proj.envelope, the same data the Phantasm canvas uses) — no extra decode. Rendered
  // as an inline SVG (single-quoted so it survives the double-quoted style attr) over green.
  const envAll = (state.proj && state.proj.envelope) || [];
  const envMax = envAll.reduce((m, e) => Math.max(m, e.v || 0), 0) || 1;   // client field is .v (0–1)
  const waveform = (h) => {
    const pts = envAll.filter((e) => e.t >= h.start && e.t <= h.end);
    if (pts.length < 2) return '';
    const N = pts.length, top = [], bot = [];
    pts.forEach((e, i) => {
      const x = ((i / (N - 1)) * 100).toFixed(1);
      const a = Math.min(1, (e.v || 0) / envMax) * 17;
      top.push(`${x},${(20 - a).toFixed(1)}`);
      bot.push(`${x},${(20 + a).toFixed(1)}`);
    });
    const poly = top.concat(bot.reverse()).join(' ');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 40' preserveAspectRatio='none'><polygon points='${poly}' fill='rgba(200,255,244,0.55)'/></svg>`;
    const uri = encodeURIComponent(svg).replace(/'/g, '%27');
    return `background-image:url('data:image/svg+xml,${uri}'),linear-gradient(180deg,#1c6d61,#165c52);`
      + 'background-size:100% 100%,cover;background-repeat:no-repeat;';
  };

  const vOv = [], vClip = [], aSpeech = [], aMusic = [], aSfx = [];
  for (const { h, s, d } of seq) {
    const sc = h.score || 0;
    const tier = sc >= maxScore * 0.8 ? 'hot' : sc >= maxScore * 0.5 ? 'warm' : 'cool';
    const _sel = state.selClip === h.id ? ' sel' : '';
    vClip.push(`<div class="tblk clip ${tier}${_sel}" data-hid="${escapeHtml(String(h.id))}" style="left:${pct(s)}%;width:${Math.max(0.6, pct(d))}%;${filmstrip(h)}" title="${escapeHtml(h.title || h.id || '')}"><span>${escapeHtml((h.title || h.id || '').slice(0, 24))}</span></div>`);
    aSpeech.push(blk('speech', pct(s), pct(d), '', null, waveform(h)));
    const auto = h.automation || {};
    if (auto.bgMusic && auto.bgMusic.path) aMusic.push(blk('music', pct(s), pct(d), 'music'));
    (auto.sfxTrack || []).forEach((sfx) => aSfx.push(blk('sfx', pct(s + (sfx.time || 0)), 1.2, '◆', `SFX @ ${(sfx.time || 0)}s`)));
    (h.overlays || []).forEach((ov) => {
      const os = s + (ov.startTime ?? 0); const oe = s + (ov.endTime ?? d);
      vOv.push(blk(ov.type === 'broll' ? 'broll' : 'text', pct(os), pct(oe - os),
        ov.type === 'broll' ? 'b-roll' : escapeHtml((ov.content || 'text').slice(0, 16))));
    });
  }
  // Dead-air heatmap: the critic's findings painted straight onto the sequence, in the SAME
  // output-time percentages the lanes use, so a defect sits visually over the clip that causes it.
  // This is what would have made the 54s-of-dead-air bug obvious on screen instead of only in a
  // rendered file. Only drawn for the real sequence — the full-source view has no cut to audit.
  const heat = (!sourceView ? (state.criticIssues || []) : [])
    .filter((i) => HEAT_TYPES[i.type])
    .map((i) => {
      const a = Math.max(0, Number(i.atSec) || 0);
      const b = Math.max(a + 0.15, Number(i.endSec ?? i.atSec) || a + 0.15);   // always visible
      const t = HEAT_TYPES[i.type];
      return `<div class="heatBlk ${t.cls}" style="left:${pct(a)};width:${pct(Math.min(b, total) - a)}"`
        + ` title="${escapeHtml(t.label)} · ${escapeHtml(i.detail || '')}"></div>`;
    }).join('');

  lanes.innerHTML = [vOv, vClip, aSpeech, aMusic, aSfx].map((a) => `<div class="lane">${a.join('')}</div>`).join('')
    + (heat ? `<div class="heatLane" aria-hidden="true">${heat}</div>` : '')
    + '<div class="seqPlayhead" id="seqPlayhead" style="display:none"></div>';
  updateSeqPlayhead();
}
// Which critic findings get painted, and how they read at a glance.
const HEAT_TYPES = {
  dead_air: { cls: 'heatDead', label: 'Dead air' },
  low_speech_density: { cls: 'heatQuiet', label: 'Low speech density' },
  no_pattern_interrupt: { cls: 'heatFlat', label: 'No pattern interrupt' },
};

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
  logEdit('reorder', { id: m.id, from, to });
  renderHighlights(); draw();
}
document.addEventListener('mousemove', (e) => { if (_reorderId != null) reorderMove(e.clientY); });
document.addEventListener('mouseup', () => {
  if (_reorderId == null) return;
  const id = _reorderId;
  _reorderId = null; document.body.classList.remove('reordering');
  promptCorrection('reorder', { clipId: id, story: ((state.highlights.find((h) => h.id === id) || {}).story || {}).intent || null, label: `reordered ${String(id).toUpperCase()}` });
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
      body: JSON.stringify({ ...exportPrefs(), id: state.proj.id, clips, vertical: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addOutput('Sequence', data, 'sequence');
    toast(`Sequence rendered (${data.clips} clip${data.clips > 1 ? 's' : ''}) ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); $('#seqExportBtn').disabled = false; }
});

// ---- Publish Kit: turn the kept cut into upload-ready copy (YouTube chapters + hashtags +
// description). Nothing is posted — it fills a textarea the creator copies. ----
async function generatePublishKit() {
  const btn = $('#pkGenBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const clips = (state.highlights || []).filter((h) => h.keep).sort((a, b) => a.start - b.start)
    .map((h) => ({ start: h.start, end: h.end, title: h.title || '', snippet: h.snippet || '',
      reactionScore: h.reactionScore || 0, tag: (h.hits && h.hits[0] && h.hits[0].tag) || '' }));
  if (!clips.length) { toast('Keep some clips (Rank or Story Cut) first, then generate the kit.', true); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Building…';
  try {
    const res = await fetch('/api/publishkit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips, game: state.proj.name || '', title: state.proj.name || '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Kit failed.');
    const ta = $('#pkText'); if (ta) ta.value = data.description || '';
    $('#pkBody')?.classList.remove('hidden');
    const nCh = (data.chapters && data.chapters.chapters || []).length;
    logEdit('publish_kit', { clips: clips.length, chapters: nCh, tags: (data.hashtags || []).length });
    toast(`Upload kit ready — ${nCh} chapter${nCh === 1 ? '' : 's'}, ${(data.hashtags || []).length} hashtags.`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = orig; }
}
// Auto-title clips: punchy Title-Cased names from each kept clip's snippet (offline). Updates the
// highlight list AND sharpens the Publish Kit chapters. Titles from clips that lack a transcript
// snippet fall back to editorial labels; clips with a snippet get a real phrase.
async function autoTitleClips() {
  const btn = $('#pkTitleBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const kept = (state.highlights || []).filter((h) => h.keep);
  if (!kept.length) { toast('Keep some clips first, then auto-title.', true); return; }
  if (!kept.some((h) => h.snippet)) { toast('Rank funny moments first — titles come from the transcript.', true); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Titling…';
  try {
    const clips = kept.map((h) => ({ id: h.id, snippet: h.snippet || '', title: h.title || '',
      reactionScore: h.reactionScore || 0, tag: (h.hits && h.hits[0] && h.hits[0].tag) || '' }));
    const res = await fetch('/api/autotitles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Auto-title failed.');
    const byId = Object.fromEntries((data.titles || []).map((t) => [t.id, t.title]));
    let n = 0;
    state.highlights.forEach((h) => { if (byId[h.id]) { h.title = byId[h.id]; n++; } });
    renderHighlights(); draw();
    logEdit('auto_titles', { titled: n });
    toast(`Auto-titled ${n} clip${n === 1 ? '' : 's'}.`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = orig; }
}
// Picking a Storyboard blueprint pre-sets the Micro-Cut level to the pace that matches its style
// (e.g. Fast-Cut → Relentless) — a suggestion the user can still override in the Publish pane.
$('#blueprintSel')?.addEventListener('change', (e) => {
  const pace = e.target.selectedOptions[0] && e.target.selectedOptions[0].dataset.pace;
  const paceSel = $('#paceLevel');
  if (pace && paceSel) paceSel.value = pace;
});
$('#pkTitleBtn')?.addEventListener('click', autoTitleClips);
$('#pkGenBtn')?.addEventListener('click', generatePublishKit);

// ---- Thumbnail Cover Selector: peak-frame candidates for the top moment. The picker asks the
// backend for candidate timestamps (reaction peak / loudest / scene change) then renders each as a
// preview still; clicking opens the full-res JPG (right-click → Save, or it downloads). ----
async function suggestCovers() {
  const btn = $('#cpBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const clip = activeClip();
  if (!clip) { toast('No moments yet — analyze / rank first.', true); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Grabbing…';
  try {
    const res = await fetch('/api/covers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clip: { start: clip.start, end: clip.end, t: clip.t },
        envelope: (state.proj.envelope) || [], sceneCuts: (state.proj.sceneCuts) || [],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Covers failed.');
    const id = encodeURIComponent(state.proj.id);
    const grid = $('#cpGrid');
    grid.innerHTML = (data.candidates || []).map((c) =>
      `<a class="cpCard" href="/api/cover?id=${id}&t=${c.t}&w=1280" download="cover-${c.t}.jpg" title="Open / save full-res">`
      + `<img src="/api/cover?id=${id}&t=${c.t}&w=480" alt="${escapeHtml(c.label)}"/>`
      + `<span class="cpLabel">${escapeHtml(c.label)} · ${fmt(c.t)}</span></a>`).join('');
    grid.classList.toggle('hidden', !(data.candidates || []).length);
    logEdit('cover_suggest', { clip: clip.id, candidates: (data.candidates || []).length });
    toast(`${(data.candidates || []).length} cover frame${(data.candidates || []).length === 1 ? '' : 's'} for your top moment.`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = orig; }
}
$('#cpBtn')?.addEventListener('click', suggestCovers);

// ---- Thumbnail Studio: one-click creator thumbnail — peak frame background (saturated + blurred),
// the facecam box as the face layer with a cyan rim-glow, bold stroke text, optional badge pill.
// Text defaults to the active clip's title (real transcript-derived words, never canned clickbait).
async function buildThumbnail() {
  const btn = $('#vtBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const clip = activeClip();
  const t = clip ? (Number.isFinite(clip.t) ? clip.t : (clip.start + clip.end) / 2) : (player.currentTime || 1);
  const suggested = ((clip && clip.title) || '').split(' ').slice(0, 3).join(' ').toUpperCase();
  const text = prompt('Thumbnail text (1–3 words):', suggested || 'CLIPPED');
  if (text == null) return;
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Composing…';
  try {
    const res = await fetch('/api/thumbstudio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, t, text, facecam: state.facecam || undefined, badge: 'STREAM HIGHLIGHTS' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Thumbnail failed.');
    addOutput('Thumbnail', data, 'thumb');
    logEdit('thumb_studio', { t: +t.toFixed(1), usedFacecam: !!data.usedFacecam });
    toast(`Thumbnail composed${data.usedFacecam ? ' with facecam layer' : ' (no facecam box set — background + text only)'} ✓`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = o; }
}
$('#vtBtn')?.addEventListener('click', buildThumbnail);

// ---- Export presets (resolution / fps / quality) — spread into every sequence-export request.
// Defaults return {} so behavior is byte-identical until the user changes a setting. Quality is a
// CRF preset, NOT a bitrate slider: the pipeline is CRF-based by benchmarked policy.
function exportPrefs() {
  const p = {};
  const res = Number($('#expRes')?.value); if (res && res !== 1080) p.res = res;
  const fps = Number($('#expFps')?.value); if (fps && fps !== 30) p.fps = fps;
  const q = $('#expQuality')?.value; if (q && q !== 'standard') p.quality = q;
  return p;
}
// Live "≈ size" estimate for the current kept cut — an honest heuristic from measured renders
// (1080p30 standard ≈ 5.5 Mbps on this pipeline), scaled by the preset factors.
function updateSizeEst() {
  const el = $('#sizeEst'); if (!el) return;
  const dur = (state.seqMap && state.seqMap.total) || 0;
  if (!dur) { el.textContent = ''; return; }
  const res = Number($('#expRes')?.value) || 1080;
  const fps = Number($('#expFps')?.value) || 30;
  const q = $('#expQuality')?.value || 'standard';
  const mbps = 5.5 * ({ 720: 0.5, 1080: 1, 1440: 1.7 }[res] || 1)
    * ({ 24: 0.85, 30: 1, 60: 1.55 }[fps] || 1)
    * ({ high: 1.35, standard: 1, compact: 0.7 }[q] || 1);
  el.textContent = `≈ ${(dur * mbps / 8 / 1024).toFixed(dur * mbps / 8 / 1024 < 1 ? 2 : 1)} GB estimated for the current ${fmt(dur)} cut`;
}
['expRes', 'expFps', 'expQuality'].forEach((id) => $(`#${id}`)?.addEventListener('change', updateSizeEst));
$('#exportSettings')?.addEventListener('toggle', updateSizeEst);

// ---- Monitor guides (thirds / safe margins / crosshair) — composition overlays sized to the
// DISPLAYED video rect (object-fit-contain math, same as the facecam drawer) so lines align to
// the frame, not the letterbox. Cycled by the guides button; pure overlay, pointer-events none.
const GUIDE_MODES = ['off', 'thirds', 'safe', 'cross'];
let _guideMode = 0;
function renderGuides() {
  let ov = document.getElementById('monGuides');
  const mon = document.querySelector('.nle-center .monitor');
  const mode = GUIDE_MODES[_guideMode];
  if (!mon) return;
  if (mode === 'off' || !player.videoWidth) { ov?.remove(); return; }
  const mr = mon.getBoundingClientRect();
  const pr = player.getBoundingClientRect();
  const scale = Math.min(pr.width / player.videoWidth, pr.height / player.videoHeight);
  const dw = player.videoWidth * scale, dh = player.videoHeight * scale;
  const ox = pr.left - mr.left + (pr.width - dw) / 2, oy = pr.top - mr.top + (pr.height - dh) / 2;
  if (!ov) { ov = document.createElement('div'); ov.id = 'monGuides'; ov.className = 'monGuides'; mon.appendChild(ov); }
  ov.style.cssText = `left:${ox}px;top:${oy}px;width:${dw}px;height:${dh}px`;
  const L = (x1, y1, x2, y2) => `<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/>`;
  let svg = '';
  if (mode === 'thirds') svg = L(33.33, 0, 33.33, 100) + L(66.66, 0, 66.66, 100) + L(0, 33.33, 100, 33.33) + L(0, 66.66, 100, 66.66);
  else if (mode === 'safe') svg = '<rect x="5%" y="5%" width="90%" height="90%"/><rect x="10%" y="10%" width="80%" height="80%"/>';
  else if (mode === 'cross') svg = L(50, 44, 50, 56) + L(44, 50, 56, 50) + '<circle cx="50%" cy="50%" r="1.2%"/>';
  ov.innerHTML = `<svg width="100%" height="100%">${svg}</svg>`;
}
$('#guidesBtn')?.addEventListener('click', () => {
  _guideMode = (_guideMode + 1) % GUIDE_MODES.length;
  renderGuides();
  toast(`Guides: ${GUIDE_MODES[_guideMode]}`);
});
window.addEventListener('resize', () => renderGuides());
player.addEventListener('loadedmetadata', () => renderGuides());

// ---- Scrub-rail hover timecode: a floating frame-exact readout following the cursor. ----
(() => {
  const wrap = document.querySelector('.scrubWrap'); const tip = $('#railTip');
  if (!wrap || !tip) return;
  wrap.addEventListener('mousemove', (e) => {
    const dur = (state.proj && state.proj.duration) || player.duration || 0;
    if (!dur) return;
    const r = wrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const fps = (state.proj && state.proj.meta && state.proj.meta.fps) || 30;
    tip.textContent = tc(frac * dur, fps);
    tip.style.left = `${Math.max(28, Math.min(r.width - 28, e.clientX - r.left))}px`;
    tip.classList.remove('hidden');
  });
  wrap.addEventListener('mouseleave', () => tip.classList.add('hidden'));
})();

// ---- Micro-cut Pacing: jump-cut internal dead air out of the top moment. Preview shows the gain
// per level; export renders the tightened sub-segments through the existing sequence pipeline. ----
// The clip the context tools (Covers, Micro-Cut) act on: the clip explicitly SELECTED on the
// timeline (even if it isn't "kept" — that's what the user is pointing at), else the top-scoring
// kept clip, else the top moment overall. Shared so Covers + Pacing target the same clip.
function activeClip() {
  const hs = state.highlights || [];
  const sel = hs.find((h) => h.id === state.selected && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  if (sel) return sel;
  const kept = hs.filter((h) => h.keep);
  const pool = kept.length ? kept : hs;
  return pool.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
}
function pacingIsSequence() { return !!($('#paceSeq') && $('#paceSeq').checked); }
// The two knobs that actually drive a cut: how long a pause has to be, and how quiet counts as
// silence. Selecting a named preset snaps the sliders back to that preset's numbers, so the
// dropdown stays a meaningful starting point rather than being silently overridden.
function pacingKnobs() {
  const ms = $('#paceMinSil'), db = $('#paceDb');
  return { minSilence: ms ? +ms.value : undefined, db: db ? +db.value : undefined };
}
function renderPacingKnobs() {
  const ms = $('#paceMinSil'), db = $('#paceDb');
  if (ms && $('#paceMinSilVal')) $('#paceMinSilVal').textContent = `${(+ms.value).toFixed(2)}s`;
  if (db && $('#paceDbVal')) $('#paceDbVal').textContent = `${(+db.value < 0 ? '−' : '')}${Math.abs(+db.value)} dB`;
}
const PACE_PRESETS = { natural: [1.2, -32], tight: [0.7, -32], relentless: [0.4, -30] };
$('#paceMinSil')?.addEventListener('input', renderPacingKnobs);
$('#paceDb')?.addEventListener('input', renderPacingKnobs);
$('#paceLevel')?.addEventListener('change', () => {
  const p = PACE_PRESETS[$('#paceLevel').value]; if (!p) return;
  if ($('#paceMinSil')) $('#paceMinSil').value = p[0];
  if ($('#paceDb')) $('#paceDb').value = p[1];
  renderPacingKnobs();
});
renderPacingKnobs();
// One shared pacing fetch for both scopes → { label, origSec, tightSec, removedSec, cuts, segments, scopeLabel }.
async function fetchPacing(level) {
  if (pacingIsSequence()) {
    const clips = (state.highlights || []).filter((h) => h.keep).sort((a, b) => a.start - b.start)
      .map((h) => ({ start: h.start, end: h.end }));
    if (!clips.length) throw new Error('Keep some clips (Rank or Story Cut) first.');
    const d = await (await fetch('/api/pacing/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, level, ...pacingKnobs() }),
    })).json();
    if (d.error) throw new Error(d.error);
    return { ...d, scopeLabel: `${d.clips} clips` };
  }
  const clip = activeClip(); if (!clip) throw new Error('No moments yet — analyze / rank first.');
  const d = await (await fetch('/api/pacing/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: state.proj.id, clip: { start: clip.start, end: clip.end }, level, ...pacingKnobs() }),
  })).json();
  if (d.error) throw new Error(d.error);
  return { ...d, scopeLabel: clip.title || `Clip ${fmt(clip.start)}` };
}
async function previewPacing() {
  const btn = $('#pacePreviewBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const level = ($('#paceLevel') && $('#paceLevel').value) || 'tight';
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    const d = await fetchPacing(level);
    const st = $('#paceStat');
    if (st) {
      st.innerHTML = `<b>${escapeHtml(d.scopeLabel)}</b> · ${d.origSec}s → <b>${d.tightSec}s</b>`
        + ` · ${d.cuts} jump-cut${d.cuts === 1 ? '' : 's'} · <span class="paceCut">−${d.removedSec}s dead air</span>`;
      st.classList.remove('hidden');
    }
    toast(`${d.label}: ${d.origSec}s → ${d.tightSec}s (${d.cuts} cuts).`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = o; }
}
// Throws on failure and returns a summary on success, so the batch queue can report the real
// outcome per row instead of marking every job "done".
async function runTightPacing() {
  const level = ($('#paceLevel') && $('#paceLevel').value) || 'tight';
  const seq = pacingIsSequence();
  showProgress(seq ? 'Tightening every clip into one master cut…' : 'Rendering the tightened short…');
  try {
    const pr = await fetchPacing(level);
    if (!pr.segments || !pr.segments.length) throw new Error('No dead air to cut at this level.');

    // APPLY TO THE TIMELINE, not just the render. The route returns one flat list of surviving
    // spans, so group them back under the clip that contains each span — every span came from
    // inside exactly one kept clip, so containment is an exact regrouping, not a heuristic.
    // Without this the file was tight but the lanes still showed the original wide clips and
    // #seqDur still reported the uncut runtime.
    const targets = seq
      ? state.highlights.filter((h) => h.keep)
      : [activeClip()].filter(Boolean);
    const perClip = targets.map((h) => ({
      id: h.id,
      segments: pr.segments
        .filter((g) => g.start >= h.start - 0.01 && g.start < h.end + 0.01)
        .map((g) => ({ start: Math.max(g.start, h.start), end: Math.min(g.end, h.end) }))
        .filter((g) => g.end > g.start),
    })).filter((r) => r.segments.length);
    const applied = applyCutSegments(perClip);

    const clips = pr.segments.map((g) => ({ start: g.start, end: g.end, overlays: [] }));
    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...exportPrefs(), id: state.proj.id, vertical: !seq, zoom: false, clips }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    addOutput(seq ? 'Tight sequence' : 'Tight short', data, 'sequence');
    logEdit('micro_cut', { scope: seq ? 'sequence' : 'clip', level, cuts: pr.cuts, removedSec: pr.removedSec, applied });
    renderHighlights(); draw();      // lanes + #seqDur now reflect the real, tightened runtime
    return `${seq ? 'Tight master cut' : 'Tight short'} ready — ${pr.origSec}s → ${pr.tightSec}s`
      + (applied ? ` · timeline updated (${applied} clip${applied === 1 ? '' : 's'})` : '');
  } finally { hideProgress(); }
}
async function exportTightPacing() {
  const btn = $('#paceExportBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Tightening…';
  try { toast(`${await runTightPacing()} ✓`); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = o; }
}
$('#pacePreviewBtn')?.addEventListener('click', previewPacing);
$('#paceExportBtn')?.addEventListener('click', exportTightPacing);

// ---- Filler-Word Purge: transcribe the kept clips, cut the "um / uh / you know" beats, render
// the survivors through the same sequence pipeline pacing uses. Scan caches its result so the
// export doesn't pay for a second whisper pass when nothing changed. ----
let _fillerScan = null;   // { key, data } — key ties the cache to the clip set + aggressive flag
function fillerClips() {
  return (state.highlights || []).filter((h) => h.keep).sort((a, b) => a.start - b.start)
    .map((h) => ({ start: h.start, end: h.end }));
}
async function scanFillers() {
  const clips = fillerClips();
  if (!clips.length) throw new Error('Keep some clips (Rank or Story Cut) first.');
  const aggressive = !!($('#fillerAggressive') && $('#fillerAggressive').checked);
  const key = JSON.stringify([clips, aggressive]);
  if (_fillerScan && _fillerScan.key === key) return _fillerScan.data;
  const res = await fetch('/api/fillers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: state.proj.id, clips, aggressive }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'Filler scan failed.');
  _fillerScan = { key, data: d };
  return d;
}
function renderFillerStat(d) {
  const st = $('#fillerStat'); if (!st) return;
  if (!d.cuts) {
    st.innerHTML = `<b>No filler words found</b> across ${d.clips} clip${d.clips === 1 ? '' : 's'}.`;
  } else {
    // Show what it actually found — a filler purge you can't inspect is a filler purge you can't trust.
    const words = [...new Set(d.hits.map((h) => h.w))].slice(0, 8).map((w) => `“${escapeHtml(w)}”`).join(', ');
    st.innerHTML = `<b>${d.cuts} filler${d.cuts === 1 ? '' : 's'}</b> in ${d.clips} clip${d.clips === 1 ? '' : 's'}`
      + ` · ${d.origSec}s → <b>${d.tightSec}s</b> · <span class="paceCut">−${d.removedSec}s</span><br>${words}`;
  }
  st.classList.remove('hidden');
}
async function findFillers() {
  const btn = $('#fillerScanBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Transcribing…';
  try {
    const d = await scanFillers();
    renderFillerStat(d);
    toast(d.cuts ? `${d.cuts} filler word${d.cuts === 1 ? '' : 's'} found (−${d.removedSec}s).` : 'No filler words found.');
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = o; }
}
async function runCleanCut() {
  showProgress('Cutting the filler words out of every kept clip…');
  try {
    const d = await scanFillers();
    renderFillerStat(d);
    if (!d.cuts) throw new Error('No filler words to cut.');

    // Apply to the timeline too — same regrouping-by-containment as the pacing pass, so the lanes
    // and #seqDur show the filler-free runtime instead of the original clip windows.
    const perClip = state.highlights.filter((h) => h.keep).map((h) => ({
      id: h.id,
      segments: d.segments
        .filter((g) => g.start >= h.start - 0.01 && g.start < h.end + 0.01)
        .map((g) => ({ start: Math.max(g.start, h.start), end: Math.min(g.end, h.end) }))
        .filter((g) => g.end > g.start),
    })).filter((r) => r.segments.length);
    const applied = applyCutSegments(perClip);

    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...exportPrefs(),
        id: state.proj.id, vertical: false, zoom: false,
        clips: d.segments.map((g) => ({ start: g.start, end: g.end, overlays: [] })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    addOutput('Filler-free cut', data, 'sequence');
    logEdit('filler_purge', { cuts: d.cuts, removedSec: d.removedSec, aggressive: d.aggressive, applied });
    renderHighlights(); draw();
    return `Clean cut ready — ${d.cuts} filler${d.cuts === 1 ? '' : 's'} removed (−${d.removedSec}s)`
      + (applied ? ` · timeline updated` : '');
  } finally { hideProgress(); }
}
async function exportCleanCut() {
  const btn = $('#fillerExportBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Purging…';
  try { toast(`${await runCleanCut()} ✓`); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = o; }
}
// ---- Transcript-driven editing. Whisper gives every word an absolute [t0,t1]; this turns that
// into an editable text surface: click a word to seek, strike a run of words to cut exactly
// those frames. The cut math is the SAME stripFillers complement the filler purge is tested on
// (server-side /api/transcript/cut), so text-cutting and filler-cutting can't drift apart.
// Cutting rebuilds each affected clip into sub-clips that are still absolute source ranges —
// never relative offsets (see CLAUDE.md) — so extraction stays frame-accurate. ----
// ---- Apply a cut to the TIMELINE, not just to an exported file --------------------------------
// Every tightening pass (micro-cut pacing, filler purge, transcript strike) produces the same
// shape: per-clip surviving spans. They used to be piped straight into /api/export/sequence, so
// the rendered file was tight but the timeline still showed the ORIGINAL wide clips and the
// original duration — you couldn't see what had been cut, and #seqDur lied about the runtime.
//
// This rebuilds each affected clip into its surviving spans as real sub-clips. Every span stays an
// ABSOLUTE source range (never a relative offset — see CLAUDE.md), sub-clips inherit the parent's
// title/tags, and the whole thing routes through logEdit so Cmd+Z puts it back.
//
// @param perClip [{ id, segments:[{start,end}], cuts? }]
// @returns number of clips actually replaced
function applyCutSegments(perClip) {
  let replaced = 0;
  for (const r of (perClip || [])) {
    if (!r || !Array.isArray(r.segments) || !r.segments.length) continue;
    const idx = state.highlights.findIndex((h) => String(h.id) === String(r.id));
    if (idx < 0) continue;
    const parent = state.highlights[idx];
    // Nothing was removed from this clip — leave it alone rather than churning its id.
    const same = r.segments.length === 1
      && Math.abs(r.segments[0].start - parent.start) < 0.01
      && Math.abs(r.segments[0].end - parent.end) < 0.01;
    if (same) continue;
    const subs = r.segments
      .filter((g) => Number.isFinite(g.start) && Number.isFinite(g.end) && g.end > g.start)
      .map((g, k) => ({
        ...parent,
        id: k === 0 ? parent.id : `t${++_splitSeq}`,
        start: g.start, end: g.end, keep: true, snapped: false,
      }));
    if (!subs.length) continue;
    state.highlights.splice(idx, 1, ...subs);
    replaced++;
  }
  return replaced;
}

let _tr = null;            // { clips: [{id,start,end,words}] } as returned by the server
const _trStruck = new Set();  // "clipId:wordIndex" of struck words
const trKey = (cid, i) => `${cid}:${i}`;
function renderTranscript() {
  const box = $('#trWords'), stat = $('#trStat');
  if (!box) return;
  if (!_tr) { box.classList.add('hidden'); stat?.classList.add('hidden'); return; }
  box.innerHTML = _tr.clips.map((c) => {
    if (!c.words.length) return `<div class="trClip"><span class="trClipId">${escapeHtml(String(c.id || '').toUpperCase())}</span><span class="trEmpty">no speech detected</span></div>`;
    const words = c.words.map((w, i) =>
      `<span class="trW${_trStruck.has(trKey(c.id, i)) ? ' struck' : ''}" data-cid="${escapeHtml(String(c.id))}" data-i="${i}" data-t0="${w.t0}" title="${fmt(w.t0)}">${escapeHtml(w.w)}</span>`).join(' ');
    return `<div class="trClip"><span class="trClipId">${escapeHtml(String(c.id || '').toUpperCase())}</span>${words}</div>`;
  }).join('');
  box.classList.remove('hidden');
  if (stat) {
    stat.textContent = _trStruck.size ? `${_trStruck.size} struck` : `${_tr.clips.reduce((n, c) => n + c.words.length, 0)} words`;
    stat.classList.remove('hidden');
  }
}
// Click seeks; click-drag or Shift-click strikes a run. Strike state is per word index, so
// re-rendering never loses it.
let _trAnchor = null, _trPainting = false, _trPaintTo = null;
$('#trWords')?.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.trW'); if (!el) return;
  const cid = el.dataset.cid, i = +el.dataset.i;
  if (e.shiftKey && _trAnchor && _trAnchor.cid === cid) {
    e.preventDefault();
    strikeRange(cid, Math.min(_trAnchor.i, i), Math.max(_trAnchor.i, i));
    return;
  }
  _trAnchor = { cid, i };
  _trPainting = true; _trPaintTo = null;
  player.currentTime = +el.dataset.t0;      // click = seek to the exact word
});
$('#trWords')?.addEventListener('mousemove', (e) => {
  if (!_trPainting) return;
  const el = e.target.closest('.trW'); if (!el) return;
  const cid = el.dataset.cid, i = +el.dataset.i;
  if (cid !== _trAnchor.cid || i === _trPaintTo) return;
  _trPaintTo = i;
  strikeRange(cid, Math.min(_trAnchor.i, i), Math.max(_trAnchor.i, i));
});
window.addEventListener('mouseup', () => { _trPainting = false; });
function strikeRange(cid, a, b) {
  for (let i = a; i <= b; i++) _trStruck.add(trKey(cid, i));
  renderTranscript();
}
// Click a single already-struck word to un-strike it (the escape hatch for a mis-drag).
$('#trWords')?.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.trW'); if (!el) return;
  e.preventDefault();
  _trStruck.delete(trKey(el.dataset.cid, +el.dataset.i));
  renderTranscript();
});
async function loadTranscript() {
  const btn = $('#trLoadBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  const clips = (state.highlights || []).filter((h) => h.keep).sort((a, b) => a.start - b.start)
    .map((h) => ({ id: h.id, start: h.start, end: h.end }));
  if (!clips.length) { toast('Keep some clips (Rank or Story Cut) first.', true); return; }
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Transcribing…';
  try {
    const res = await fetch('/api/transcript', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Transcription failed.');
    _tr = d; _trStruck.clear(); renderTranscript();
    // The critic can only score speech density once words exist, so re-audit now that they do.
    if (typeof scheduleCritic === 'function') scheduleCritic();
    toast(d.words ? `Transcript ready — ${d.words} words.` : 'No speech found in the kept clips.', !d.words);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = o; }
}
async function cutStruckWords() {
  const btn = $('#trCutBtn'); if (!btn) return;
  if (!_tr) { toast('Load the transcript first.', true); return; }
  if (!_trStruck.size) { toast('Strike some words first — click-drag across them.', true); return; }
  const cuts = [];
  for (const c of _tr.clips) {
    c.words.forEach((w, i) => { if (_trStruck.has(trKey(c.id, i))) cuts.push({ t0: w.t0, t1: w.t1, w: w.w }); });
  }
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'Cutting…';
  try {
    const res = await fetch('/api/transcript/cut', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: _tr.clips.map((c) => ({ id: c.id, start: c.start, end: c.end })), cuts }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Cut failed.');
    if (!d.cuts) { toast('Those words are too short to cut cleanly.', true); return; }
    const replaced = applyCutSegments(d.clips);
    _trStruck.clear();
    _tr = null; renderTranscript();
    logEdit('transcript_cut', { cuts: d.cuts, removedSec: d.removedSec, clips: replaced });
    renderHighlights(); draw();
    toast(`Cut ${d.cuts} word span${d.cuts === 1 ? '' : 's'} (−${d.removedSec}s) from ${replaced} clip${replaced === 1 ? '' : 's'} ✓`);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = o; }
}
$('#trLoadBtn')?.addEventListener('click', loadTranscript);
$('#trCutBtn')?.addEventListener('click', cutStruckWords);

$('#fillerScanBtn')?.addEventListener('click', findFillers);
$('#fillerExportBtn')?.addEventListener('click', exportCleanCut);

// ---- One-Shot Publish: run the whole publishing handoff in one pass — Auto-Titles → Upload Kit
// → Cover frames. Each sub-step handles its own errors/toasts (never throws), so the chain always
// completes; the button label narrates progress. ----
async function publishEverything() {
  const btn = $('#publishAllBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  if (!(state.highlights || []).some((h) => h.keep)) { toast('Rank or Story Cut first, then Publish Everything.', true); return; }
  const o = btn.innerHTML; btn.disabled = true;
  try {
    btn.textContent = 'Auto-titling…'; await autoTitleClips();
    btn.textContent = 'Building upload kit…'; await generatePublishKit();
    btn.textContent = 'Grabbing covers…'; await suggestCovers();
    toast('Publish kit ready — titles, chapters, hashtags + cover frames ✓');
  } finally { btn.disabled = false; btn.innerHTML = o; }
}
$('#publishAllBtn')?.addEventListener('click', publishEverything);

// ---- Facecam box: draw once over the monitor → every vertical short renders facecam-on-top /
// gameplay-below (the creator split layout). Stored normalized (0..1 of the SOURCE frame) and
// persisted into the project's analysis via /api/facecam, so it survives relaunches. ----
function renderFcStatus() {
  const st = $('#fcStatus'); const clr = $('#fcClearBtn');
  if (!st) return;
  const f = state.facecam;
  st.textContent = f ? `set — ${Math.round(f.w * 100)}×${Math.round(f.h * 100)}% @ ${Math.round(f.x * 100)},${Math.round(f.y * 100)}` : 'not set — shorts use center-crop';
  clr?.classList.toggle('hidden', !f);
}
async function saveFacecam(rect) {
  state.facecam = rect;
  renderFcStatus();
  if (!state.proj) return;
  try {
    await fetch('/api/facecam', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, facecam: rect }) });
  } catch {}
}
$('#fcClearBtn')?.addEventListener('click', () => { saveFacecam(null); toast('Facecam box cleared — shorts use center-crop.'); });
$('#fcSetBtn')?.addEventListener('click', () => {
  if (!state.proj) { toast('Load a project first.', true); return; }
  if (!player.videoWidth || !player.videoHeight) { toast('Wait for the video to load, then try again.', true); return; }
  // The video renders object-fit:contain inside #player — compute the DISPLAYED rect so the drawn
  // box maps to true source pixels (drawing on letterbox bars would skew the crop).
  const pr = player.getBoundingClientRect();
  if (pr.width < 120 || pr.height < 70) { toast('Monitor too small to draw on — widen the window first.', true); return; }
  const scale = Math.min(pr.width / player.videoWidth, pr.height / player.videoHeight);
  const dw = player.videoWidth * scale, dh = player.videoHeight * scale;
  const ox = pr.left + (pr.width - dw) / 2, oy = pr.top + (pr.height - dh) / 2;
  const ov = document.createElement('div');
  ov.className = 'fcOverlay';
  ov.style.cssText = `left:${ox}px;top:${oy}px;width:${dw}px;height:${dh}px`;
  ov.innerHTML = '<div class="fcHint">Drag a box around your facecam · Esc to cancel</div><div class="fcBox hidden"></div>';
  document.body.appendChild(ov);
  const box = ov.querySelector('.fcBox');
  let sx = 0, sy = 0, drawing = false;
  const cancel = () => { ov.remove(); window.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
  window.addEventListener('keydown', esc, true);
  ov.addEventListener('mousedown', (e) => {
    e.preventDefault();
    drawing = true; sx = e.clientX - ox; sy = e.clientY - oy;
    box.classList.remove('hidden');
    box.style.cssText = `left:${sx}px;top:${sy}px;width:0;height:0`;
  });
  ov.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    const x = Math.max(0, Math.min(dw, e.clientX - ox)), y = Math.max(0, Math.min(dh, e.clientY - oy));
    box.style.left = `${Math.min(sx, x)}px`; box.style.top = `${Math.min(sy, y)}px`;
    box.style.width = `${Math.abs(x - sx)}px`; box.style.height = `${Math.abs(y - sy)}px`;
  });
  ov.addEventListener('mouseup', (e) => {
    if (!drawing) return; drawing = false;
    const x = Math.max(0, Math.min(dw, e.clientX - ox)), y = Math.max(0, Math.min(dh, e.clientY - oy));
    const rx = Math.min(sx, x) / dw, ry = Math.min(sy, y) / dh;
    const rw = Math.abs(x - sx) / dw, rh = Math.abs(y - sy) / dh;
    cancel();
    if (rw < 0.03 || rh < 0.03) { toast('Box too small — drag a rectangle around the facecam.', true); return; }
    saveFacecam({ x: +rx.toFixed(4), y: +ry.toFixed(4), w: +rw.toFixed(4), h: +rh.toFixed(4) });
    toast('Facecam box saved — vertical shorts now use the split layout.');
  });
});
$('#pkCopyBtn')?.addEventListener('click', async () => {
  const ta = $('#pkText'); if (!ta || !ta.value) return;
  try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
  toast('Description copied ✓');
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
  if (scrub) {
    scrub.max = dur || 100;
    if (document.activeElement !== scrub) scrub.value = player.currentTime || 0;
    // drive the played-progress fill on the custom scrub rail (pure-CSS gradient reads --val)
    scrub.style.setProperty('--val', `${scrub.max > 0 ? (scrub.value / scrub.max) * 100 : 0}%`);
  }
  const fps = (state.proj && state.proj.meta && state.proj.meta.fps) || 30;
  if (tEl) tEl.textContent = `${tc(player.currentTime || 0, fps)} / ${tc(dur, fps)}`;
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
  if (play) play.addEventListener('click', () => { if (player.paused) safePlay(); else player.pause(); });
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
const NARROW_PX = 20; // below this rendered width a clip splits into thirds so the body stays grabbable
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  // Height follows the canvas's actual flexed display height (it shrinks to whatever the panel
  // leaves after the header + phantasm bar + tip) — falls back to 240 before the flex settles.
  const h = canvas.clientHeight || 240;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
// Coalesce a burst of resize events (dragging the window fires dozens/sec) into ONE redraw on the
// next animation frame — the Phantasm canvas redraw is heavy, so redrawing per-event janks the
// resize itself. Trailing frame = final size, drawn once.
let _resizeRaf = 0;
window.addEventListener('resize', () => {
  if (_resizeRaf) return;
  _resizeRaf = requestAnimationFrame(() => { _resizeRaf = 0; resizeCanvas(); draw(); });
});

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
  const W = canvas.clientWidth, H = canvas.clientHeight || 240;
  ctx.clearRect(0, 0, W, H);

  // Phantasm band: contiguous keep/ghost blocks
  for (const s of (state.segments || [])) {
    const x = X(s.start), w = Math.max(1, X(s.end) - X(s.start));
    ctx.fillStyle = s.state === 'keep' ? SEG_FILL.keep : (SEG_FILL[s.reason] || SEG_FILL.silence);
    ctx.fillRect(x, TOP, w, H - TOP);
    // Segment divider — only when the segment is wide enough to resolve. On a long VOD the
    // segments are a few px each, so per-segment dividers were turning the band into a
    // barcode of black lines; skip them below ~6px and let the colour fills read cleanly.
    if (w >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, H); ctx.stroke();
    }
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

  // Snap guide: amber dashed line at the time the dragged edge locked onto, so the magnet is
  // visible rather than a mysterious jump. Only drawn mid-drag.
  if (state.snapAt != null) {
    const sx = X(state.snapAt);
    ctx.save();
    ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    ctx.restore();
  }
}

// ---- Interactive clip lane: drag an edge to trim, drag the body to shift, else seek ----
// Hit-test the clip lane (y < TOP). Returns the clip + which zone (left/right edge or body).
function clipLaneAt(x, y) {
  if (y >= TOP) return null;                 // below the lane = Phantasm band (seek/select)
  for (const h of state.highlights) {
    if (!h.keep) continue;
    const sx = X(h.start), ex = X(h.end);
    if (x < sx - EDGE_PX || x > ex + EDGE_PX) continue;
    // Narrow clips: at full zoom on a long VOD a 15s clip is ~5px wide, so both edge zones
    // cover the whole block and the body becomes unreachable — you could only trim, never move.
    // Below NARROW_PX the middle belongs to the body and the edges shrink to a third each, so a
    // clip stays draggable without having to zoom in first.
    const w = ex - sx;
    if (w < NARROW_PX) {
      const edge = Math.max(2, w / 3);
      if (x <= sx + edge) return { clip: h, zone: 'left' };
      if (x >= ex - edge) return { clip: h, zone: 'right' };
      return { clip: h, zone: 'body' };
    }
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

// ---- Magnetic snapping (toggle with S). While dragging or trimming, a clip edge within
// SNAP_PX of a meaningful time locks onto it exactly. Targets are everything an editor lines
// up against: the playhead, markers, the In/Out region, every OTHER kept clip's edges, and the
// sequence bounds. The snap is applied to the edge being moved, so a body-drag preserves length
// by construction (both edges shift by the same delta). state.snapAt drives the on-canvas guide.
const SNAP_PX = 10;
state.snapOn = true;
state.snapAt = null;
function snapTargets(excludeId) {
  const out = [0, state.proj.duration];
  if (Number.isFinite(player.currentTime)) out.push(player.currentTime);
  for (const m of (state.markers || [])) out.push(m.t);
  if (state.inPoint != null) out.push(state.inPoint);
  if (state.outPoint != null) out.push(state.outPoint);
  for (const c of (state.highlights || [])) {
    if (!c.keep || c.id === excludeId) continue;
    out.push(c.start, c.end);
  }
  return out.filter(Number.isFinite);
}
// Returns the snapped time for `t`, or null when nothing is in range. tolSec is SNAP_PX
// converted through the CURRENT zoom, so snapping feels like a constant 10px at any zoom level.
function snapTime(t, targets, tolSec) {
  let best = null, bestD = tolSec;
  for (const g of targets) {
    const d = Math.abs(g - t);
    if (d <= bestD) { bestD = d; best = g; }
  }
  return best;
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
    // Hold Alt to suspend snapping for one drag (the standard NLE escape hatch).
    const snapping = state.snapOn && !e.altKey;
    const tol = canvas.clientWidth ? (SNAP_PX / canvas.clientWidth) * dur : 0;
    const targets = snapping ? snapTargets(h.id) : [];
    state.snapAt = null;
    if (d.zone === 'left') {
      let ns = d.startStart + dt;
      const s = snapping ? snapTime(ns, targets, tol) : null;
      if (s != null) { ns = s; state.snapAt = s; }
      h.start = +Math.max(0, Math.min(ns, h.end - MIN)).toFixed(3);
    } else if (d.zone === 'right') {
      let ne = d.startEnd + dt;
      const s = snapping ? snapTime(ne, targets, tol) : null;
      if (s != null) { ne = s; state.snapAt = s; }
      h.end = +Math.min(dur, Math.max(ne, h.start + MIN)).toFixed(3);
    } else { // body: shift, preserving length
      const len = d.startEnd - d.startStart;
      let ns = d.startStart + dt;
      if (snapping) {
        // Try BOTH edges and take whichever lands closer, so a clip snaps by its head or its
        // tail — whichever the editor pushed against. Length is preserved either way.
        const sS = snapTime(ns, targets, tol);
        const sE = snapTime(ns + len, targets, tol);
        const dS = sS == null ? Infinity : Math.abs(sS - ns);
        const dE = sE == null ? Infinity : Math.abs(sE - (ns + len));
        if (dS <= dE && sS != null) { ns = sS; state.snapAt = sS; }
        else if (sE != null) { ns = sE - len; state.snapAt = sE; }
      }
      ns = Math.max(0, Math.min(ns, dur - len));
      h.start = +ns.toFixed(3); h.end = +(ns + len).toFixed(3);
    }
    h.snapped = false;                  // manual edit → no longer an auto-snap
    syncRowInputs(h);
    requestAnimationFrame(draw);
    return;
  }

  // Hover feedback, only while over the canvas.
  if (x < 0 || x > canvas.clientWidth || y < 0 || y > 240) return;
  const hit = clipLaneAt(x, y);
  canvas.style.cursor = hit ? (hit.zone === 'body' ? 'grab' : 'ew-resize') : 'default';
});

window.addEventListener('mouseup', () => {
  if (!state.drag) return;
  const h = state.highlights.find((c) => c.id === state.drag.id);
  const moved = h && (h.start !== state.drag.startStart || h.end !== state.drag.startEnd);
  state.drag = null;
  state.snapAt = null;                     // clear the guide line once the drag lands
  canvas.style.cursor = 'default';
  if (h) {
    renderHighlights(); draw();            // commit: refresh duration line + snap chip + inputs
    if (moved) logEdit('trim', { id: h.id, start: +h.start.toFixed(3), end: +h.end.toFixed(3) });
  }
});

// Razor: double-click a clip to split it in two — at the playhead if it's inside the clip,
// otherwise at the click point. Both halves inherit the parent's title/tags and stay kept.
let _splitSeq = 0;
// Shared razor: split `clip` at source-time `cut`. Both halves inherit title/tags and stay
// kept. Used by the phantasm-canvas double-click AND the timeline Razor tool (single click).
function splitClipAt(clip, cut) {
  const MIN = 0.4;
  cut = +cut.toFixed(3);
  if (cut - clip.start < MIN || clip.end - cut < MIN) { toast('Too close to an edge to split.', true); return false; }
  const idx = state.highlights.indexOf(clip);
  const right = { ...clip, id: `m${++_splitSeq}`, start: cut, snapped: false };
  clip.end = cut; clip.snapped = false;
  state.highlights.splice(idx + 1, 0, right);
  logEdit('split', { id: clip.id, at: cut });
  state.selected = right.id;
  renderHighlights(); draw();
  toast(`Split into 2 clips at ${fmt(cut)}.`);
  return true;
}
canvas.addEventListener('dblclick', (e) => {
  if (!state.proj) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (y >= TOP) return;
  const t = T(x);
  const clip = state.highlights.find((h) => h.keep && t > h.start && t < h.end);
  if (!clip) return;
  e.preventDefault();
  const pt = player.currentTime;
  splitClipAt(clip, pt > clip.start && pt < clip.end ? pt : t);
});

// keyboard: G toggle keep/ghost, V verify (play 2s), B banish-export
window.addEventListener('keydown', (e) => {
  if (!state.proj || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const seg = (state.segments || []).find((s) => s.id === state.selSeg);
  if (e.key === 'g' || e.key === 'G') { if (seg) { e.preventDefault(); toggleSeg(seg); } }
  else if (e.key === 'v' || e.key === 'V') { if (seg) { e.preventDefault(); verifySeg(seg); } }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); $('#banishBtn').click(); }
  // Spacebar = transport play/pause (industry standard; inputs already guarded above).
  // Blur any focused button first so Space can't ALSO trigger it on keyup (transport lock);
  // Alt+Space is the play-In→Out shortcut, handled elsewhere.
  else if (e.code === 'Space' && !e.altKey) {
    e.preventDefault();
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    if (player.paused) safePlay(); else player.pause();
  }
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
  logEdit('banish_all', { ghosts: ghosts.length, deadAir: +dur.toFixed(1) });
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

// The TikTok pack render, split out from its button so the batch queue can run the exact same
// path (one implementation, no drift). Reads its options at CALL time — a queued job therefore
// renders with the settings in effect when it runs, matching what the direct button does.
async function runTikTokPack() {
  const n = parseInt($('#tiktokCount').value, 10) || 5;
  const clips = topClips(n);
  if (!clips.length) throw new Error('No highlights to clip — keep at least one.');
  const caps = $('#capPublish').checked;
  showProgress(`Rendering ${clips.length} TikTok clips — vertical${caps ? ' + transcribing captions' : ''}…`);
  try {
    const res = await fetch('/api/export/tiktok', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, captions: caps, kinetic: !!($('#capKinetic') && $('#capKinetic').checked), capStyle: ($('#capStyleSel') && $('#capStyleSel').value) || 'pop', facecam: state.facecam || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.clips.forEach((c, i) => addOutput(`TikTok ${i + 1}`, c, 'tiktok'));
    return `${data.clips.length} TikTok clips ready${data.captionsBurned ? ' with burned captions' : ''}`;
  } finally { hideProgress(); }
}
$('#tiktokBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  $('#tiktokBtn').disabled = true;
  try { toast(`${await runTikTokPack()} ✓`); }
  catch (e) { toast(e.message, true); }
  finally { $('#tiktokBtn').disabled = false; }
});

async function runYouTubeCut() {
  const segments = keepSegments();
  if (!segments.length) throw new Error('Nothing to cut — all segments are red.');
  const hook = hookRange();
  const caps = $('#capPublish').checked;
  showProgress(`Building YouTube cut — cold-open hook + tight edit${caps ? ' + captions' : ''}…`);
  try {
    const res = await fetch('/api/export/youtube', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, segments, hook, captions: caps }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    addOutput('YouTube cut', data, 'youtube');
    return `YouTube cut ready${data.hook ? ' (hooked)' : ''}${data.captionsBurned ? ' + captions' : ''}`;
  } finally { hideProgress(); }
}
$('#youtubeBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  $('#youtubeBtn').disabled = true;
  try { toast(`${await runYouTubeCut()} ✓`); }
  catch (e) { toast(e.message, true); }
  finally { $('#youtubeBtn').disabled = false; }
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

async function runShorts() {
  const clips = keptHighlightClips();
  if (!clips.length) throw new Error('Keep at least one highlight to export shorts.');
  showProgress(`Rendering ${clips.length} vertical shorts…`);
  try {
    const res = await fetch('/api/export/shorts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, clips, captions: $('#capShort').checked, facecam: state.facecam || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.shorts.forEach((s, i) => addOutput(`Short ${i + 1}`, s, 'short'));
    return `${data.shorts.length} shorts exported`;
  } finally { hideProgress(); }
}
$('#shortsBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  try { toast(`${await runShorts()} ✓`); } catch (e) { toast(e.message, true); }
});

async function runThumbs() {
  const times = state.highlights.filter((h) => h.keep).map((h) => h.t);
  if (!times.length) throw new Error('Keep at least one highlight to grab thumbnails.');
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
    return `${data.thumbs.length} thumbnails saved (1280px). Drop into Canva to finish.`;
  } finally { hideProgress(); }
}
$('#thumbsBtn').addEventListener('click', async () => {
  if (!state.proj) return;
  try { toast(await runThumbs()); } catch (e) { toast(e.message, true); }
});

// ---- Export Queue: line up several renders and run them back-to-back. Each entry calls the
// SAME run* function its button does, so queued output is identical to clicking it by hand.
// Serial by design — the server already saturates the CPU inside a single pack (PACK_CONCURRENCY),
// so running two packs at once would only make both slower.
const QUEUE_JOBS = {
  tiktok: { label: 'TikTok pack', run: () => runTikTokPack() },
  youtube: { label: 'YouTube cut', run: () => runYouTubeCut() },
  shorts: { label: 'Vertical shorts', run: () => runShorts() },
  thumbs: { label: 'Thumbnails', run: () => runThumbs() },
  pacing: { label: 'Tight cut', run: () => runTightPacing() },
  fillers: { label: 'Clean cut', run: () => runCleanCut() },
};
let _queue = [];        // [{ id, key, label, status: queued|running|done|error, note }]
let _queueRunning = false;
let _queueSeq = 0;
function renderQueue() {
  const list = $('#queueList'), count = $('#queueCount');
  if (!list) return;
  const icon = { queued: '·', running: '⟳', done: '✓', error: '✕' };
  list.innerHTML = _queue.map((j) =>
    `<div class="qItem ${j.status}">
       <span class="qIcon">${icon[j.status]}</span>
       <span class="qLabel">${escapeHtml(j.label)}</span>
       <span class="qNote">${escapeHtml(j.note || '')}</span>
       ${j.status === 'queued' ? `<button class="qDel" data-qid="${j.id}" title="Remove">×</button>` : ''}
     </div>`).join('');
  list.classList.toggle('hidden', !_queue.length);
  const pending = _queue.filter((j) => j.status === 'queued' || j.status === 'running').length;
  if (count) {
    count.textContent = pending ? `${pending} pending` : `${_queue.length} done`;
    count.classList.toggle('hidden', !_queue.length);
  }
  const run = $('#queueRunBtn');
  if (run) { run.disabled = _queueRunning || !pending; run.textContent = _queueRunning ? 'Running…' : 'Run queue'; }
}
function queueAdd(key) {
  const job = QUEUE_JOBS[key]; if (!job) return;
  _queue.push({ id: ++_queueSeq, key, label: job.label, status: 'queued', note: '' });
  renderQueue();
  toast(`${job.label} queued (${_queue.filter((j) => j.status === 'queued').length} waiting).`);
}
async function runQueue() {
  if (_queueRunning) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  _queueRunning = true; renderQueue();
  let ok = 0, failed = 0;
  try {
    // Re-scan each pass: the user can queue MORE work while the queue is draining.
    for (let j = _queue.find((x) => x.status === 'queued'); j; j = _queue.find((x) => x.status === 'queued')) {
      j.status = 'running'; j.note = ''; renderQueue();
      try {
        const note = await QUEUE_JOBS[j.key].run();
        j.status = 'done'; j.note = typeof note === 'string' ? note : ''; ok++;
      } catch (e) {
        // One bad job never stops the rest — the failure is recorded on its own row.
        j.status = 'error'; j.note = String(e.message || e); failed++;
      }
      renderQueue();
    }
  } finally { _queueRunning = false; renderQueue(); }
  toast(failed ? `Queue finished — ${ok} done, ${failed} failed.` : `Queue finished — ${ok} export${ok === 1 ? '' : 's'} ✓`, !!failed);
}
$('#queueAddBtn')?.addEventListener('click', () => queueAdd($('#queueJob').value));
$('#queueRunBtn')?.addEventListener('click', runQueue);
$('#queueClearBtn')?.addEventListener('click', () => {
  // Clearing drops the waiting work and the finished log; anything mid-render keeps going.
  _queue = _queue.filter((j) => j.status === 'running');
  renderQueue(); toast('Queue cleared.');
});
$('#queueList')?.addEventListener('click', (e) => {
  const b = e.target.closest('.qDel'); if (!b) return;
  _queue = _queue.filter((j) => String(j.id) !== b.dataset.qid);
  renderQueue();
});
renderQueue();   // start with Run disabled until something is queued

function addOutput(label, data, kind) {
  // Every finished render lands here, so it's the one honest place to fire an OS notification —
  // Notification Center on macOS, a toast on Windows. The main process suppresses it when the
  // window is focused, so it only ever reaches you when you've switched away during a long export.
  try { window.electron?.notify?.('PepStudio', `${label} is ready.`); } catch {}
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
    // Hand tool (H): drag pans the zoomed timeline horizontally. No select, no scrub.
    if (state.tool === 'hand') {
      const body = document.querySelector('.trackBody'); if (!body) return;
      lanes.classList.add('panning');
      const startX = e.clientX; const startScroll = body.scrollLeft;
      const mv = (ev) => { body.scrollLeft = startScroll - (ev.clientX - startX); };
      const up = () => { lanes.classList.remove('panning'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
      return;
    }
    const clip = e.target.closest('.tblk.clip');
    // Razor tool (C): single-click a clip → split at the click point (Premiere behavior).
    // No select, no scrub — the razor only cuts.
    if (clip && clip.dataset.hid && state.tool === 'razor') {
      const h = state.highlights.find((x) => String(x.id) === clip.dataset.hid);
      if (h) {
        const r = clip.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
        splitClipAt(h, h.start + frac * (h.end - h.start));
      }
      return;
    }
    // Click a clip → select it (FCP-blue outline); drag still scrubs.
    if (clip && clip.dataset.hid) {
      state.selClip = clip.dataset.hid;
      lanes.querySelectorAll('.tblk.clip.sel').forEach((c) => c.classList.remove('sel'));
      clip.classList.add('sel');
      renderClipInsight();
    }
    seek(e.clientX);
    const mv = (ev) => seek(ev.clientX);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
})();

// ---- Sequence view toggle: Full source <-> AI highlights cut. The full-source view is what
// renderTracks shows when nothing is kept; this button stashes/restores the kept set so you can
// flip between the uncut VOD and the curated cut without re-analyzing (or triggers the first
// rank when no highlights exist yet). ----
function updateSeqViewBtn(sourceView) {
  const b = $('#seqViewBtn'); if (!b) return;
  if (!state.proj) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const hasHl = (state.highlights || []).length > 0;
  b.textContent = sourceView ? (hasHl ? 'AI highlights cut' : 'Generate AI highlights') : 'View full source';
  b.title = sourceView
    ? (hasHl ? 'Swap the timeline to the curated highlight clips' : 'Run the funny-moments rank, then mount the highlight cut')
    : 'Show the uncut source VOD on the timeline (exports keep using your highlight cut)';
}
$('#seqViewBtn')?.addEventListener('click', () => {
  if (!state.proj) return;
  const keptReal = (state.highlights || []).filter((h) => h.keep);
  if (keptReal.length) {                       // highlights → full source (stash the keeps)
    state._keepStash = keptReal.map((h) => h.id);
    state.highlights.forEach((h) => { h.keep = false; });
    renderHighlights(); draw();
    toast('Full source mounted — exports still use your highlight cut when you restore it.');
  } else if ((state.highlights || []).length) { // full source → restore the stashed (or all-ranked) cut
    const stash = state._keepStash;
    state.highlights.forEach((h) => { h.keep = stash ? stash.includes(h.id) : true; });
    renderHighlights(); draw();
    toast('AI highlights cut mounted.');
  } else {
    $('#funnyBtn')?.click();                    // nothing ranked yet → run the rank
  }
});

// ---- Timeline tool strip: Selection / Razor (C) / Hand (H). Only tools with REAL behavior
// ship — Selection = click-to-select; Razor = single-click split; Hand = drag-pan the zoomed
// timeline. C/H each toggle their tool <-> selection (V stays bound to the verify shortcut).
state.tool = 'select';
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('#toolStrip button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const lanes = $('#trackLanes');
  lanes?.classList.toggle('razorMode', tool === 'razor');
  lanes?.classList.toggle('handMode', tool === 'hand');
}
$('#toolStrip')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]');
  if (b) setTool(b.dataset.tool);
});
window.addEventListener('keydown', (e) => {
  if (!state.proj || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'c' || e.key === 'C') setTool(state.tool === 'razor' ? 'select' : 'razor');
  if (e.key === 'h' || e.key === 'H') setTool(state.tool === 'hand' ? 'select' : 'hand');
  // S toggles magnetic snapping globally; Alt suspends it for a single drag.
  if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.shiftKey && !e.altKey) {
    state.snapOn = !state.snapOn;
    toast(state.snapOn ? 'Snapping on' : 'Snapping off');
  }
  // Delete vs Ripple Delete on the selected clip.
  //
  // A note on what "ripple" means HERE: clips are absolute SOURCE ranges and the export
  // concatenates the kept ones in order, so the output has no gaps to close — dropping a clip
  // already pulls everything downstream up. Rewriting start/end into relative timeline offsets
  // to "close a gap" would break frame-accurate extraction (see CLAUDE.md). So:
  //   Delete/Backspace  → ghost the clip: keep=false, still on the timeline, fully reversible.
  //   Shift+Backspace   → ripple delete: drop it from the sequence entirely.
  // Both route through logEdit, so both are Cmd+Z-able.
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const id = state.selClip || state.selected;
    const i = (state.highlights || []).findIndex((x) => String(x.id) === String(id));
    if (i < 0) { toast('Select a clip on the timeline first.', true); return; }
    e.preventDefault();
    const h = state.highlights[i];
    if (e.shiftKey) {
      state.highlights.splice(i, 1);
      if (state.selected === h.id) state.selected = null;
      if (state.selClip === h.id) state.selClip = null;
      logEdit('ripple_delete', { id: h.id });
      toast(`Ripple-deleted ${String(h.id).toUpperCase()} — sequence closed up.`);
    } else {
      h.keep = false;
      logEdit('drop', { id: h.id });
      toast(`${String(h.id).toUpperCase()} dropped to a ghost (Shift+Delete removes it).`);
    }
    renderHighlights(); draw();
  }
});

// ---- Markers (M) + In/Out region (I/O) on the source scrub rail. Markers are session-scoped
// pins in SOURCE time; Shift+N / Shift+P jump between them. I/O set an export region rendered
// as a Premiere-blue band, cleared with Option+X — and "Export I/O" renders JUST that region
// through the existing verified sequence pipeline (no new endpoint). ----
state.markers = []; state.inPoint = null; state.outPoint = null;
function renderRail() {
  const rail = $('#tpRail'); if (!rail) return;
  const dur = (state.proj && state.proj.duration) || player.duration || 0;
  if (!dur) { rail.innerHTML = ''; return; }
  const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100)).toFixed(3)}%`;
  let html = '';
  if (state.inPoint != null && state.outPoint != null && state.outPoint > state.inPoint) {
    html += `<div class="ioRange" style="left:${pct(state.inPoint)};width:${pct(state.outPoint - state.inPoint)}"></div>`;
  } else if (state.inPoint != null) {
    html += `<div class="ioTick" style="left:${pct(state.inPoint)}" title="In ${fmt(state.inPoint)}"></div>`;
  } else if (state.outPoint != null) {
    html += `<div class="ioTick out" style="left:${pct(state.outPoint)}" title="Out ${fmt(state.outPoint)}"></div>`;
  }
  html += state.markers.map((m, i) =>
    `<div class="tpMark${m.label ? ' named' : ''}" data-t="${m.t}" style="left:${pct(m.t)}" title="${escapeHtml(m.label || `Marker ${i + 1}`)} · ${fmt(m.t)} (double-click to label)"></div>`).join('');
  rail.innerHTML = html;
  $('#ioExportBtn')?.classList.toggle('hidden', !(state.inPoint != null && state.outPoint != null && state.outPoint > state.inPoint));
}
$('#tpRail')?.addEventListener('mousedown', (e) => {
  const m = e.target.closest('.tpMark'); if (!m) return;
  e.preventDefault(); e.stopPropagation();
  player.currentTime = +m.dataset.t;
});
// Double-click a marker pin → name it (same prompt UX as project rename). The label shows in
// the pin tooltip and the jump toasts.
$('#tpRail')?.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.tpMark'); if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const mk = state.markers.find((m) => m.t === +el.dataset.t); if (!mk) return;
  const label = prompt('Marker label:', mk.label || '');
  if (label != null) { mk.label = label.trim(); renderRail(); scheduleStateSave(); pushUndo(); }
});
$('#ioExportBtn')?.addEventListener('click', async () => {
  const a = state.inPoint, b = state.outPoint;
  if (!state.proj || a == null || b == null || b <= a) return;
  const btn = $('#ioExportBtn'); const o = btn.textContent; btn.disabled = true; btn.textContent = 'Exporting…';
  showProgress(`Rendering the In→Out region (${fmt(b - a)})…`);
  try {
    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...exportPrefs(), id: state.proj.id, vertical: false, zoom: false, clips: [{ start: a, end: b, overlays: [] }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    addOutput('In/Out region', data, 'sequence');
    logEdit('io_export', { in: +a.toFixed(2), out: +b.toFixed(2) });
    toast(`In→Out region exported (${fmt(b - a)}) ✓`);
  } catch (e) { toast(e.message, true); } finally { hideProgress(); btn.disabled = false; btn.textContent = o; }
});
// Nudge/slip the selected clip's SOURCE window by ±1 frame (Shift: ±5). Length is preserved;
// this slips WHICH content plays (clips are absolute source windows — guardrail-safe edit).
function nudgeSelectedClip(dir, frames) {
  const id = state.selClip || state.selected;
  const h = (state.highlights || []).find((x) => String(x.id) === String(id));
  if (!h) { toast('Select a clip on the timeline first.', true); return; }
  const fps = (state.proj && state.proj.meta && state.proj.meta.fps) || 30;
  const d = dir * frames / fps;
  const dur = (state.proj && state.proj.duration) || Infinity;
  if (h.start + d < 0 || h.end + d > dur) { toast('At the source boundary.', true); return; }
  h.start = +(h.start + d).toFixed(4); h.end = +(h.end + d).toFixed(4); h.snapped = false;
  renderHighlights(); draw();
  logEdit('nudge', { id: h.id, frames: dir * frames });
  toast(`Slipped ${h.id.toUpperCase()} ${dir > 0 ? '+' : '−'}${frames}f → ${fmt(h.start)}`);
}
// ---- Pro transport: J-K-L shuttle, frame stepping, cut navigation, In/Out loop. ----
// J skims backward (HTML5 video can't reverse-play, so J seeks in steps at the shuttle rate —
// honest behavior, not fake smooth reverse); L plays forward at 1/2/4/8x; K stops both.
let _shuttle = { dir: 0, rate: 1, timer: null };
function stopShuttle() { clearInterval(_shuttle.timer); _shuttle = { dir: 0, rate: 1, timer: null }; player.playbackRate = 1; }
function shuttle(dir) {
  if (_shuttle.dir === dir) _shuttle.rate = Math.min(8, _shuttle.rate * 2);   // repeat press → 2x/4x/8x
  else { clearInterval(_shuttle.timer); _shuttle.dir = dir; _shuttle.rate = 1; }
  if (dir > 0) { clearInterval(_shuttle.timer); _shuttle.timer = null; player.playbackRate = _shuttle.rate; safePlay(); }
  else {
    player.pause(); player.playbackRate = 1;
    clearInterval(_shuttle.timer);
    _shuttle.timer = setInterval(() => {
      player.currentTime = Math.max(0, player.currentTime - 0.1 * _shuttle.rate);
      if (player.currentTime <= 0) stopShuttle();
    }, 100);
  }
  toast(`${dir > 0 ? '▶' : '◀'} ${_shuttle.rate}×`);
}
// Loop In→Out (Ctrl+L) — wraps playback inside the region; Option+Space plays it once.
let _loopIO = false, _playToOut = false;
player.addEventListener('timeupdate', () => {
  if (state.outPoint == null) return;
  if (_loopIO && player.currentTime >= state.outPoint) player.currentTime = state.inPoint ?? 0;
  else if (_playToOut && player.currentTime >= state.outPoint) { player.pause(); _playToOut = false; }
});
window.addEventListener('keydown', (e) => {
  if (!state.proj || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const t = player.currentTime || 0;
  const frame = 1 / ((state.proj.meta && state.proj.meta.fps) || 30);
  // Undo/Redo
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault(); if (e.shiftKey) redoEdit(); else undoEdit(); return;
  }
  // J-K-L shuttle
  if (!e.metaKey && !e.altKey && (e.key === 'l' || e.key === 'L') && !e.ctrlKey) { e.preventDefault(); shuttle(1); return; }
  if (!e.metaKey && !e.altKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); shuttle(-1); return; }
  if (!e.metaKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); stopShuttle(); player.pause(); return; }
  // frame stepping (plain arrows; Shift = 10 frames; Option+arrows stay bound to clip nudge)
  if (!e.altKey && !e.metaKey && e.code === 'ArrowRight') { e.preventDefault(); stopShuttle(); player.currentTime = Math.min(player.duration || 1e9, t + frame * (e.shiftKey ? 10 : 1)); return; }
  if (!e.altKey && !e.metaKey && e.code === 'ArrowLeft') { e.preventDefault(); stopShuttle(); player.currentTime = Math.max(0, t - frame * (e.shiftKey ? 10 : 1)); return; }
  // jump to next / previous cut (kept-clip boundaries in source time)
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    const cuts = [...new Set((state.highlights || []).filter((h) => h.keep).flatMap((h) => [h.start, h.end]))].sort((a, b) => a - b);
    if (cuts.length) {
      e.preventDefault();
      const next = e.code === 'ArrowUp' ? cuts.find((c) => c > t + 0.05) : [...cuts].reverse().find((c) => c < t - 0.05);
      if (next != null) { player.currentTime = next; toast(`Cut · ${fmt(next)}`); }
    }
    return;
  }
  // In→Out playback: Ctrl+L loop toggle, Option+Space play-once
  if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault(); _loopIO = !_loopIO;
    if (_loopIO && state.inPoint != null) { player.currentTime = state.inPoint; safePlay(); }
    toast(_loopIO ? 'Looping In→Out' : 'Loop off'); return;
  }
  if (e.altKey && e.code === 'Space') {
    e.preventDefault();
    if (state.inPoint != null && state.outPoint != null) { _playToOut = true; player.currentTime = state.inPoint; safePlay(); }
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault(); player.currentTime = 0;
  } else if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    state.markers.push({ t: +t.toFixed(3) }); state.markers.sort((a, b) => a.t - b.t);
    renderRail(); scheduleStateSave(); pushUndo(); toast(`Marker at ${fmt(t)} (${state.markers.length} total)`);
  } else if (e.shiftKey && (e.key === 'N' || e.key === 'n')) {
    const next = state.markers.find((m) => m.t > t + 0.05);
    if (next) { e.preventDefault(); player.currentTime = next.t; toast(`${next.label || 'Marker'} · ${fmt(next.t)}`); }
  } else if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    const prev = [...state.markers].reverse().find((m) => m.t < t - 0.05);
    if (prev) { e.preventDefault(); player.currentTime = prev.t; toast(`${prev.label || 'Marker'} · ${fmt(prev.t)}`); }
  } else if ((e.key === 'i' || e.key === 'I') && !e.metaKey && !e.altKey) {
    e.preventDefault(); state.inPoint = +t.toFixed(3);
    if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null;
    renderRail(); scheduleStateSave(); pushUndo(); toast(`In point ${fmt(t)}`);
  } else if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.altKey) {
    e.preventDefault(); state.outPoint = +t.toFixed(3);
    if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null;
    renderRail(); scheduleStateSave(); pushUndo(); toast(`Out point ${fmt(t)}`);
  } else if (e.altKey && e.code === 'KeyX') {
    e.preventDefault(); state.inPoint = null; state.outPoint = null; renderRail(); scheduleStateSave(); pushUndo(); toast('In/Out cleared');
  } else if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    e.preventDefault(); nudgeSelectedClip(e.code === 'ArrowRight' ? 1 : -1, e.shiftKey ? 5 : 1);
  }
});

// ---- Timeline zoom engine: scale the lanes' laid-out width (all blocks are %-positioned, so
// they scale for free) and let .trackBody scroll horizontally; track headers stay sticky-left.
// The time under the anchor point (cursor for Cmd+wheel, viewport center for the slider) stays
// stationary across zooms. seek()/playhead need no changes — both read getBoundingClientRect().
state.tlZoom = 1;
function applyTlZoom(z, anchorClientX) {
  const lanes = $('#trackLanes'); const body = document.querySelector('.trackBody');
  const headers = document.querySelector('.trackHeaders');
  if (!lanes || !body) return;
  z = Math.min(8, Math.max(1, z));
  const headersW = headers ? headers.offsetWidth : 0;
  const viewW = Math.max(1, body.clientWidth - headersW);
  const oldW = lanes.getBoundingClientRect().width || viewW;
  const laneStartX = body.getBoundingClientRect().left + headersW;
  const ax = anchorClientX != null ? (anchorClientX - laneStartX) : viewW / 2;   // px into the visible lanes
  const frac = (body.scrollLeft + ax) / oldW;                                    // time-fraction under the anchor
  state.tlZoom = z;
  if (z <= 1.001) { lanes.style.width = ''; lanes.style.flex = ''; body.scrollLeft = 0; }
  else {
    lanes.style.flex = '0 0 auto';
    lanes.style.width = `${Math.round(viewW * z)}px`;
    body.scrollLeft = Math.max(0, frac * viewW * z - ax);
  }
  const s = $('#tlZoomSlider'); if (s && +s.value !== z) s.value = z;
}
$('#tlZoomSlider')?.addEventListener('input', (e) => applyTlZoom(+e.target.value));
$('#tlZoomOut')?.addEventListener('click', () => applyTlZoom(state.tlZoom / 1.5));
$('#tlZoomIn')?.addEventListener('click', () => applyTlZoom(state.tlZoom * 1.5));
$('#tlZoomFit')?.addEventListener('click', () => applyTlZoom(1));
// Cmd/Ctrl + scroll = zoom centered on the cursor (the Premiere gesture).
document.querySelector('.trackBody')?.addEventListener('wheel', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  applyTlZoom(state.tlZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
}, { passive: false });

// ---- Right-column tabs (Curate / Publish): pure show/hide by data-rtab. Cards stay in
// the DOM (display:none), so every listener/value in the hidden tab still works — this is
// only a density view, never a teardown. All guardrail IDs untouched.
(() => {
  const strip = document.querySelector('.nle-right .paneTabs');
  if (!strip) return;
  const panes = [...document.querySelectorAll('.nle-right .rtabPane')];
  const show = (name) => {
    strip.querySelectorAll('.rtab').forEach((t) => t.classList.toggle('active', t.dataset.rtab === name));
    // Toggle a DEDICATED tab-visibility class — NOT `hidden` — so switching tabs never clobbers the
    // panes that gate their OWN visibility with `hidden` (#hookLab / #clipInsight / #correctionShelf,
    // shown only once their render code fills them). Overloading `hidden` here was force-showing
    // those as empty boxes / a premature correction shelf whenever the Curate tab was active.
    panes.forEach((p) => p.classList.toggle('paneOff', p.dataset.rtab !== name));
  };
  strip.addEventListener('click', (e) => {
    const t = e.target.closest('.rtab');
    if (t) show(t.dataset.rtab);
  });
  show('curate');
})();

// ==========================================================================
// AI ASSISTANT — action-first copilot. Every action drives an EXISTING pipeline
// by triggering the real control; nothing here is fake. Status + suggestions are
// derived from real analysis state; the action set is context-aware (no project
// vs analyzed). The natural-language chat is kept, demoted to "Advanced prompt".
// ==========================================================================
const SVG_CHK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4l3 3 6-7"/></svg>';
const SVG_ARR = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M6 3.5L10.5 8 6 12.5z"/></svg>';
const SVG_LINK = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.6 9.4a3 3 0 0 0 4.2 0l1.7-1.7a3 3 0 1 0-4.2-4.2l-1 1"/><path d="M9.4 6.6a3 3 0 0 0-4.2 0L3.5 8.3a3 3 0 1 0 4.2 4.2l1-1"/></svg>';

function aiSilences() {
  return (state.segments || []).filter((s) => s.reason === 'silence' || s.reason === 'static' || s.state === 'ghost');
}
// Each action → the REAL control it clicks (honest: no new backend).
const AI_TRIGGER = {
  choose:   () => $('#btn-import-file') && $('#btn-import-file').click(),
  url:      () => { const u = $('#urlInput'); if (u) { u.focus(); u.scrollIntoView({ block: 'nearest' }); } },
  analyze:  () => $('#analyzeBtn') && $('#analyzeBtn').click(),
  deadair:  () => $('#banishBtn') && $('#banishBtn').click(),
  rank:     () => $('#funnyBtn') && $('#funnyBtn').click(),
  captions: () => $('#captionsBtn') && $('#captionsBtn').click(),
  shorts:   () => $('#tiktokBtn') && $('#tiktokBtn').click(),
};
function aiActionSet() {
  if (!state.proj) {
    return [
      { act: 'choose', label: 'Choose a video file', meta: 'MP4 · MOV · MKV' },
      { act: 'url', label: 'Paste a Twitch / YouTube link', meta: 'processed locally' },
      { act: 'analyze', label: 'Analyze footage', meta: 'silence · scenes · loudness' },
    ];
  }
  const sil = aiSilences();
  const dead = sil.reduce((a, s) => a + (s.end - s.start), 0);
  const kept = (state.highlights || []).filter((h) => h.keep).length;
  const n = ($('#tiktokCount') && $('#tiktokCount').value) || '5';
  return [
    { act: 'deadair', label: 'Remove Dead Air', meta: sil.length ? `${sil.length} sections · ${fmt(dead)}` : 'none detected', dim: !sil.length },
    { act: 'rank', label: 'Rank Highlights', meta: kept ? `${kept} kept` : 'ready to rank' },
    { act: 'captions', label: 'Generate Captions', meta: state.canBurn ? 'burn-in ready' : 'SRT sidecar' },
    { act: 'shorts', label: 'Create Shorts', meta: `${n} vertical clip${n === '1' ? '' : 's'}` },
  ];
}
function aiSuggestions() {
  if (!state.proj) return [];
  const out = [];
  const hs = [...(state.highlights || [])].filter((h) => (h.score || 0) > 0).sort((a, b) => (b.score || 0) - (a.score || 0));
  if (hs[0]) out.push({ t: hs[0].start, label: `Top moment at ${fmt(hs[0].start)}` });
  const sil = [...aiSilences()].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  if (sil[0]) out.push({ t: sil[0].start, label: `Long pause at ${fmt(sil[0].start)} · ${fmt(sil[0].end - sil[0].start)}` });
  const env = state.proj.envelope || [];
  if (env.length) { const loud = env.reduce((m, e) => ((e.v || 0) > (m.v || 0) ? e : m), env[0]); out.push({ t: loud.t, label: `Loud reaction at ${fmt(loud.t)}` }); }
  return out.slice(0, 3);
}
// Callback suggestions: mine the story graph for setup↔payoff arcs + shared-topic callbacks
// (already tracked by buildStory) and offer to build a tight back-to-back edit of the pair.
// Reads existing h.story; lazily builds it once if snippets exist but the graph isn't computed yet.
function aiCallbacks() {
  const hs = state.highlights || [];
  if (hs.length < 2) return [];
  if (typeof buildStory === 'function' && hs.some((h) => (h.snippet || h.title)) && !hs.some((h) => h.story)) buildStory(hs);
  const find = (t) => hs.find((x) => Number.isFinite(x.start) && Math.abs(x.start - t) < 0.5);
  const out = [];
  const seen = new Set();
  for (const h of hs) {
    const s = h.story || {};
    // shared-topic callback: h calls back to an earlier moment.
    if (s.callbackOf != null) {
      const setup = find(s.callbackOf);
      const key = setup && `${setup.id}>${h.id}`;
      if (setup && setup.id !== h.id && !seen.has(key)) { seen.add(key);
        out.push({ kind: 'callback', setupId: setup.id, payoffId: h.id, setupT: setup.start, payoffT: h.start, topic: s.callbackTopic || '' }); }
    }
    // setup → payoff arc.
    if (s.intent === 'setup' && s.payoffAt != null) {
      const payoff = find(s.payoffAt);
      const key = payoff && `${h.id}>${payoff.id}`;
      if (payoff && payoff.id !== h.id && !seen.has(key)) { seen.add(key);
        out.push({ kind: 'payoff', setupId: h.id, payoffId: payoff.id, setupT: h.start, payoffT: payoff.start, topic: '' }); }
    }
  }
  return out.slice(0, 3);
}
// Build the callback edit: keep JUST the setup + payoff so they play back-to-back (chronological,
// setup first). Uses the sanctioned keep→renderHighlights path (renderTracks rebuilds seqMap — no
// overwrite). Reversible: re-rank or Story Cut restores the full set.
function buildCallbackEdit(aId, bId) {
  const a = (state.highlights || []).find((h) => h.id === aId);
  const b = (state.highlights || []).find((h) => h.id === bId);
  if (!a || !b) { toast('That callback pair is no longer available.', true); return; }
  state.highlights.forEach((h) => { h.keep = (h.id === aId || h.id === bId); });
  renderHighlights(); draw();   // renderTracks rebuilds seqMap from the two kept clips
  logEdit('callback_edit', { setup: aId, payoff: bId, gap: +(b.start - a.end).toFixed(1) });
  if (player && Number.isFinite(a.start)) { try { player.currentTime = a.start; } catch (_) {} }
  toast(`Callback edit — setup + payoff kept back-to-back (${fmt((a.end - a.start) + (b.end - b.start))}). Re-rank to restore the full set.`);
}

function renderAIAssistant() {
  const box = $('#aiActions'); if (!box) return;
  box.innerHTML = aiActionSet().map((a) =>
    `<button class="aiAction${a.dim ? ' dim' : ''}" data-act="${a.act}">`
    + `<span class="aiActIcon">${SVG_CHK}</span>`
    + `<span class="aiActBody"><span class="aiActLabel">${escapeHtml(a.label)}</span>`
    + `<span class="aiActMeta">${escapeHtml(a.meta)}</span></span></button>`).join('');
  const sbox = $('#aiSuggest');
  if (sbox) {
    const sug = aiSuggestions();
    sbox.innerHTML = sug.length
      ? '<div class="aiSuggestHead">Suggestions</div>' + sug.map((s) =>
          `<button class="aiSuggestRow" data-seek="${s.t}">${SVG_ARR}<span>${escapeHtml(s.label)}</span></button>`).join('')
      : '';
  }
  const cbox = $('#aiCallbacks');
  if (cbox) {
    const cbs = aiCallbacks();
    cbox.innerHTML = cbs.length
      ? '<div class="aiSuggestHead">Callbacks</div>' + cbs.map((c) =>
          `<button class="aiCallback" data-a="${c.setupId}" data-b="${c.payoffId}" title="Keep just these two, back-to-back">`
          + `<span class="aiCbIcon">${SVG_LINK}</span>`
          + `<span class="aiCbBody"><span class="aiCbLabel">${c.kind === 'callback' ? 'Callback' : 'Setup → payoff'}${c.topic ? `: “${escapeHtml(c.topic)}”` : ''}</span>`
          + `<span class="aiCbMeta">${fmt(c.setupT)} → ${fmt(c.payoffT)} · build back-to-back</span></span></button>`).join('')
      : '';
    cbox.classList.toggle('hidden', !cbs.length);
  }
  const st = $('#aiStatus');
  if (st) st.textContent = state.pepaiReady ? 'local model ✓' : '';
}
$('#aiActions')?.addEventListener('click', (e) => {
  const b = e.target.closest('.aiAction'); if (!b) return;
  const fn = AI_TRIGGER[b.dataset.act]; if (fn) { logEdit('ai_action_accepted', { act: b.dataset.act }); fn(); }
});
$('#aiSuggest')?.addEventListener('click', (e) => {
  const b = e.target.closest('.aiSuggestRow'); if (!b) return;
  const t = parseFloat(b.dataset.seek); if (!Number.isNaN(t)) { logEdit('suggestion_followed', { t }); player.currentTime = t; }
});
$('#aiCallbacks')?.addEventListener('click', (e) => {
  const b = e.target.closest('.aiCallback'); if (!b) return;
  buildCallbackEdit(b.dataset.a, b.dataset.b);
});
renderAIAssistant();

// ---- Icon rail: collapse the 250px left column to a 48px rail; each icon flies out ONE
// panel (Media or Inspector — the two real left sections). Reclaims the width for preview.
(() => {
  const rail = $('#railNav'); const left = document.querySelector('.nle-left');
  if (!rail || !left) return;
  const fx = left.querySelector('.fxPane'); const media = left.querySelector('.nle-pane.grow');
  let cur = 'media';   // open on Media by default so import is reachable
  const apply = () => {
    left.classList.toggle('railCollapsed', !cur);
    if (fx) fx.classList.toggle('hidden', cur !== 'inspector');
    if (media) media.classList.toggle('hidden', cur !== 'media');
    rail.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.panel === cur));
  };
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-panel]'); if (!b) return;
    cur = (cur === b.dataset.panel) ? null : b.dataset.panel;   // click active → collapse
    apply();
  });
  apply();
})();

// ---- Unified timeline: one full-width zone, toggle between Timeline (edit) and
// Phantasm (analysis). Both are different time-bases, so it's a swap not an overlay.
// The Phantasm canvas is re-fit on show (a hidden canvas has 0 width).
(() => {
  const bottom = document.querySelector('.nle-bottom'); const toggle = $('#tlToggle');
  if (!bottom || !toggle) return;
  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]'); if (!b) return;
    const phantasm = b.dataset.view === 'phantasm';
    bottom.classList.toggle('view-phantasm', phantasm);
    toggle.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    if (phantasm) {
      // The canvas has 0 width until the display:block reflow settles; re-fit on a
      // short delay (rAF alone fires too early here) and draw.
      const refit = () => {
        if (typeof resizeCanvas === 'function') resizeCanvas();
        if (typeof draw === 'function' && state.proj) draw();
      };
      requestAnimationFrame(refit);
      setTimeout(refit, 60);
    }
  });
})();

// ---- Editorial feedback recorder: every real human edit decision → /api/feedback, a
// local JSONL corpus (the substrate for future supervised learning from real edits).
function logEdit(action, detail) {
  try {
    fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, projectId: state.proj && state.proj.id, detail: detail || {} }), keepalive: true,
    }).then(() => refreshEditCount()).catch(() => {});
  } catch {}
  scheduleStateSave();   // every edit action also autosaves the curation (debounced)
  pushUndo();            // and records an undo snapshot (deduped)
}
// ---- Undo/Redo (Cmd+Z / Cmd+Shift+Z): post-state history of the curation (clips + markers +
// in/out), capped at 100. logEdit is the chokepoint every mutation already flows through; the
// baseline state is pushed on project load. Restoring re-renders and autosaves. ----
let _undoStack = [], _undoPtr = -1;
function _snapState() {
  return JSON.stringify({
    h: (state.highlights || []).map((x) => ({ ...x })),
    m: (state.markers || []).map((x) => ({ ...x })),
    i: state.inPoint, o: state.outPoint,
  });
}
function pushUndo() {
  if (!state.proj) return;
  const snap = _snapState();
  if (_undoStack[_undoPtr] === snap) return;          // non-mutating action (e.g. an export) — skip
  _undoStack = _undoStack.slice(0, _undoPtr + 1);     // a new edit clears the redo branch
  _undoStack.push(snap);
  if (_undoStack.length > 100) _undoStack.shift();
  _undoPtr = _undoStack.length - 1;
}
function _applyUndoState(snap) {
  const s = JSON.parse(snap);
  state.highlights = s.h; state.markers = s.m; state.inPoint = s.i; state.outPoint = s.o;
  renderHighlights(); draw();
  if (typeof renderRail === 'function') renderRail();
  scheduleStateSave();
}
function undoEdit() {
  if (_undoPtr <= 0) { toast('Nothing to undo.', true); return; }
  _undoPtr--; _applyUndoState(_undoStack[_undoPtr]); toast(`Undo (${_undoPtr}/${_undoStack.length - 1})`);
}
function redoEdit() {
  if (_undoPtr >= _undoStack.length - 1) { toast('Nothing to redo.', true); return; }
  _undoPtr++; _applyUndoState(_undoStack[_undoPtr]); toast(`Redo (${_undoPtr}/${_undoStack.length - 1})`);
}
function resetUndoBaseline() { _undoStack = []; _undoPtr = -1; pushUndo(); }
// Autosave the curation (keeps + clip windows/titles + markers + in/out) into the analysis,
// debounced so bursts of edits coalesce into one small write. Crash/relaunch-safe: loadProject
// restores it. logEdit is the chokepoint every edit action already flows through.
let _stateSaveTimer = null;
function scheduleStateSave() {
  if (!state.proj) return;
  clearTimeout(_stateSaveTimer);
  _stateSaveTimer = setTimeout(() => {
    const edit = {
      keeps: (state.highlights || []).filter((h) => h.keep).map((h) => String(h.id)),
      clips: (state.highlights || []).map((h) => ({ id: String(h.id), start: h.start, end: h.end, title: h.title || '', keep: !!h.keep, score: h.score || 0 })),
      markers: (state.markers || []).map((m) => ({ t: m.t, label: m.label || '' })),
      inPoint: state.inPoint, outPoint: state.outPoint,
    };
    fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, edit }), keepalive: true }).catch(() => {});
  }, 1500);
}
function refreshEditCount() {
  const el = $('#editCount'); if (!el) return;
  fetch('/api/feedback/count').then((r) => r.json()).then((d) => {
    el.textContent = d.count ? `${d.count} edit decision${d.count === 1 ? '' : 's'} recorded` : '';
  }).catch(() => {});
}
refreshEditCount();

// ==========================================================================
// STORY GRAPH v0.1 — heuristic (rule-based, not a trained model). Classifies each
// clip's transcript intent, links setups→payoffs, and detects callbacks, from the
// real whisper snippet + reaction score. Powers the "why this clip is kept" line and
// enriches the feedback corpus with the story context of every human decision.
// ==========================================================================
const STORY_RX = {
  setup: /\b(i bet|i can|i'?ll|i'?m gonna|gonna|going to|watch (this|me)|it'?s easy|no way i|let me|check this|guarantee|bet you|about to|i promise|trust me)\b/i,
  payoff: /\b(oh no|nope|no way|what happened|i failed|i died|wasted|i missed|dammit|are you kidding|so bad|oh my|told you|called it|that was awful|why)\b/i,
};
const STORY_STOP = new Set('the and are was were you your this that with have has had they them will would gonna going just like get got out here there what when this been about really very much more some they mine your okay guys yeah nah'.split(' '));
function storyKeywords(text) {
  return [...new Set((text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STORY_STOP.has(w)))];
}
function buildStory(hs) {
  if (!hs || !hs.length) return;
  const maxScore = Math.max(0.001, ...hs.map((h) => h.score || 0));
  const items = hs.map((h) => ({ h, kw: storyKeywords(h.snippet || h.title || '') }));
  // v0.2 — intent with confidence + competing interpretations (heuristic, not learned).
  items.forEach(({ h }) => {
    const t = (h.snippet || h.title || '').toLowerCase();
    const cues = (rx) => (t.match(rx) || []).length;
    const reactive = (h.reactionScore || 0) + (((h.hits && h.hits.length) || 0));
    const raw = {
      SETUP: cues(STORY_RX.setup) * 1.4,
      PAYOFF: cues(STORY_RX.payoff) * 1.2 + reactive,
      TRASH_TALK: cues(/\b(destroy|beat you|trash|noob|owned|rekt|clap|garbage|you'?re (bad|trash))\b/g) * 1.3,
      NEUTRAL: 0.6,
    };
    const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const ranked = Object.entries(raw).map(([type, v]) => ({ type, confidence: +(v / total).toFixed(2) }))
      .sort((a, b) => b.confidence - a.confidence);
    const primary = ranked[0];
    const bucket = (primary.type === 'SETUP' || primary.type === 'TRASH_TALK') ? 'setup'
      : primary.type === 'PAYOFF' ? 'payoff' : 'neutral';
    h.story = { intent: bucket, label: primary.type, confidence: primary.confidence,
      alternatives: ranked.slice(1).filter((r) => r.confidence >= 0.05),
      why: '', setupAt: null, payoffAt: null, callbackOf: null, callbackTopic: null, debt: null };
  });
  const byTime = [...items].sort((a, b) => a.h.start - b.h.start);
  byTime.forEach((s, i) => {
    if (s.h.story.intent !== 'setup') return;
    for (let j = i + 1; j < byTime.length; j++) {
      if (byTime[j].h.start - s.h.end > 45) break;
      if (byTime[j].h.story.intent === 'payoff') { s.h.story.payoffAt = byTime[j].h.start; byTime[j].h.story.setupAt = s.h.start; break; }
    }
    // story debt: a setup opens an unfinished question; resolved when a payoff is found.
    s.h.story.debt = { question: (s.h.snippet || s.h.title || 'setup').slice(0, 60),
      created: s.h.start, resolved: s.h.story.payoffAt, resolution: s.h.story.payoffAt != null ? 'resolved' : 'open' };
  });
  for (let i = 0; i < byTime.length; i++) for (let j = i + 1; j < byTime.length; j++) {
    if (byTime[j].h.start - byTime[i].h.start < 60) continue;
    const shared = byTime[j].kw.find((w) => byTime[i].kw.includes(w));
    if (shared && byTime[j].h.story.callbackOf == null) { byTime[j].h.story.callbackOf = byTime[i].h.start; byTime[j].h.story.callbackTopic = shared; }
  }
  // multi-dimensional scores (0-1) from real signals.
  hs.forEach((h) => {
    const s = h.story;
    const reactive = (h.reactionScore || 0) + (((h.hits && h.hits.length) || 0));
    const callback = s.callbackOf != null ? 0.8 : 0;
    const chain = (s.intent === 'setup' && s.payoffAt != null) || s.setupAt != null;
    h.scores = {
      story: +Math.min(1, (chain ? 0.65 : 0) + (s.intent === 'payoff' ? 0.25 : 0) + callback * 0.3 + (s.intent === 'setup' ? 0.2 : 0.1)).toFixed(2),
      humor: +Math.min(1, reactive / 3).toFixed(2),
      context: +(s.intent === 'setup' ? 0.9 : (s.setupAt != null ? 0.8 : 0.4)).toFixed(2),
      callback: +callback.toFixed(2),
      retention: +Math.min(1, (h.score || 0) / maxScore).toFixed(2),
    };
    const p = [];
    if (s.intent === 'setup' && s.payoffAt != null) p.push(`sets up the payoff at ${fmt(s.payoffAt)}`);
    else if (s.intent === 'setup') p.push('opens a setup (payoff not found yet)');
    if (s.setupAt != null) p.push(`pays off the setup at ${fmt(s.setupAt)}`);
    if (s.callbackOf != null) p.push(`callback to ${fmt(s.callbackOf)}${s.callbackTopic ? ` (“${s.callbackTopic}”)` : ''}`);
    if (!p.length && s.intent === 'payoff') p.push('strong reaction moment');
    s.why = p.join(' · ');
  });
}
const STORY_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M2 3h12v2H2zM2 7h8v2H2zM2 11h11v2H2z"/></svg>';

// ---- Visual Story Inspector: click a sequence clip → see its story chain, confidence,
// competing interpretations, and multi-dimensional scores. Makes the AI's reasoning
// visible so creators can trust (and later correct) it.
function renderClipInsight() {
  const box = $('#clipInsight'); if (!box) return;
  const h = (state.highlights || []).find((x) => x.id === state.selClip);
  if (!h || !h.story) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const s = h.story; const sc = h.scores || {};
  const pct = (v) => Math.round((v || 0) * 100);
  const bar = (label, v) => `<div class="ciBar"><span>${label}</span><i style="width:${pct(v)}%"></i><b>${pct(v)}</b></div>`;
  const chain = [];
  if (s.setupAt != null) chain.push(`<div class="ciNode setup">Setup · ${fmt(s.setupAt)}</div><div class="ciArrow">↓</div>`);
  chain.push(`<div class="ciNode this">${escapeHtml((s.label || s.intent).toLowerCase())} · ${fmt(h.start)}<span class="ciConf">${pct(s.confidence)}%</span></div>`);
  if (s.payoffAt != null) chain.push(`<div class="ciArrow">↓</div><div class="ciNode payoff">Payoff · ${fmt(s.payoffAt)}</div>`);
  if (s.callbackOf != null) chain.push(`<div class="ciArrow">↺</div><div class="ciNode cb">Callback of ${fmt(s.callbackOf)}</div>`);
  const alts = (s.alternatives || []).length
    ? `<div class="ciAlts">Could also be: ${s.alternatives.map((a) => `${a.type.toLowerCase().replace('_', ' ')} ${pct(a.confidence)}%`).join(' · ')}</div>` : '';
  const debt = (s.debt && s.debt.resolution === 'open')
    ? `<div class="ciDebt">⚠ open story debt — keep this setup; its payoff isn't in the cut yet</div>` : '';
  box.innerHTML = `<div class="ciHead">Clip Insight<span class="ciClose" title="close">×</span></div>`
    + `<div class="ciChain">${chain.join('')}</div>${alts}`
    + `<div class="ciScores">${bar('Story', sc.story)}${bar('Humor', sc.humor)}${bar('Context', sc.context)}${bar('Callback', sc.callback)}${bar('Retention', sc.retention)}</div>`
    + `${s.why ? `<div class="ciWhy">${s.why}</div>` : ''}${debt}`;
  box.querySelector('.ciClose')?.addEventListener('click', () => { state.selClip = null; box.classList.add('hidden'); renderTracks(); });
}

// ---- "Edit for Me": the one-click auto-pilot. Assembles the best moments (the Story Cut
// brain) and RENDERS them into a tight highlight cut via the existing sequence pipeline
// (/api/export/sequence). On a real long VOD this yields a few-minute watchable reel — NOT
// a 45-minute de-silenced dump (what the old silence-strip longcut produced, which hung at
// "Editing…" for many minutes and felt broken). No fake endpoint, no hardcoded ids.
async function autoEdit() {
  const btn = $('#autoEditBtn'); if (!btn) return;
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  if (!(state.highlights && state.highlights.length)) {
    toast('Rank funny moments first, then hit Edit for Me.', true); return;
  }
  const { kept, total } = assembleStoryCut();   // pick + order the best moments
  const clips = state.highlights.filter((h) => h.keep).sort((a, b) => a.start - b.start).map((h) => ({
    start: h.start, end: h.end,
    overlays: (h.overlays || []).filter((o) => o.content && o.content.trim()),
  }));
  if (!clips.length) { toast('No strong moments found to edit — try Rank funny moments first.', true); return; }
  logEdit('auto_edit', { keptClips: kept, cutLength: +total.toFixed(1) });
  btn.disabled = true; const orig = btn.innerHTML; btn.innerHTML = 'Editing…';
  showProgress(`Editing for you — ${kept} best moments (${fmt(total)})…`);
  try {
    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // zoom:false = skip the batched whisper pass + per-frame emphasis-zoom rescale
      // (that eval=frame lanczos caps encode at ~14fps). The one-click stays fast + clean;
      // the manual "Render sequence" keeps the polished punch-ins.
      body: JSON.stringify({ ...exportPrefs(), id: state.proj.id, clips, vertical: true, zoom: false }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    addOutput('Edit for Me', data, 'sequence');
    toast(`Your cut is ready — ${kept} moments, ${fmt(total)} ✓`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    hideProgress(); btn.disabled = false; btn.innerHTML = orig;
  }
}
$('#autoEditBtn')?.addEventListener('click', autoEdit);

// ---- Storyboard Cut: a HOOK-LED narrative package (vs autoEdit's short reel), sized to the
// footage by the adaptive planner rather than a fixed clock. Ranks a
// WIDE candidate pool (storyboard:true → keep≈40, bigger audio budget) so there's enough to fill
// the cut, asks the backend /api/storyboard to compile the plan, sets keep on the chosen body
// clips (native seqMap rebuild — NO overwrite), then exports with the cold-open hook PREPENDED as
// the first clip (hard smash-cut into the chronological body). Reuses autoEdit's export path.
async function storyboardCut() {
  const btn = $('#storyCutBtn');
  if (!state.proj) { toast('Load and analyze a video first.', true); return; }
  try {
    if (btn) btn.disabled = true;
    // 1. Rank with the wide pool so the storyboard doesn't starve.
    showProgress('Ranking a wide candidate pool — the cut length is sized to your footage…');
    const rank = await fetch('/api/highlights/funny', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.proj.id, storyboard: true }),
    });
    const rankData = await rank.json();
    if (!rank.ok) throw new Error(rankData.error || 'Ranking failed.');
    if (!rankData.highlights || !rankData.highlights.length) { toast('No standout moments found.', true); return; }
    state.highlights = rankData.highlights.map((h) => ({ ...h }));

    // 2. Compile the hook-driven plan on the backend (the frontend can't import lib/).
    // Blueprint reweights which moments lead + the cold-open length (default 'balanced').
    // Send envelope + sceneCuts so the backend can score the cold-open's health + candidates.
    const blueprint = ($('#blueprintSel') && $('#blueprintSel').value) || 'balanced';
    showProgress(`Compiling the ${blueprint} storyboard…`);
    const sbRes = await fetch('/api/storyboard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        highlights: state.highlights, blueprint,
        sourceSec: (state.proj && state.proj.duration) || 0,   // lets the planner size the cut to the footage
        pickyFloor: state.pickyFloor,                          // the quality bar that governs length
        envelope: (state.proj && state.proj.envelope) || [],
        sceneCuts: (state.proj && state.proj.sceneCuts) || [],
      }),
    });
    const plan = await sbRes.json();
    if (!sbRes.ok) throw new Error(plan.error || 'Storyboard compile failed.');
    renderHookLab(plan);   // Hook Health Score + audition candidates

    // 3. Keep only the body clips — set keep flags, let renderHighlights/draw rebuild seqMap NATIVELY.
    const bodyIds = new Set((plan.body || []).map((h) => h.id));
    state.highlights.forEach((h) => { h.keep = bodyIds.has(h.id); });
    renderHighlights(); draw();

    // 3b. TIGHTEN the selected moments before exporting. The ranker picks wide contextual windows,
    // so shipping them raw meant the "story cut" carried all their internal dead air — measured at
    // 22% of the runtime on a real VOD, with a 74s opening at 0.53 words/sec. Running the same
    // micro-cut pass the Tight Cut button uses, and APPLYING it to the timeline, is the difference
    // between a selection of moments and an actual edit. Best-effort: a tightening failure must
    // never lose the storyboard the user just waited for.
    try {
      showProgress('Tightening the selected moments (removing internal dead air)…');
      const kept = state.highlights.filter((h) => h.keep);
      const pace = await (await fetch('/api/pacing/sequence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: state.proj.id, level: ($('#paceLevel') && $('#paceLevel').value) || 'tight',
          clips: kept.map((h) => ({ start: h.start, end: h.end })), ...pacingKnobs(),
        }),
      })).json();
      if (pace && Array.isArray(pace.segments) && pace.segments.length) {
        const perClip = kept.map((h) => ({
          id: h.id,
          segments: pace.segments
            .filter((g) => g.start >= h.start - 0.01 && g.start < h.end + 0.01)
            .map((g) => ({ start: Math.max(g.start, h.start), end: Math.min(g.end, h.end) }))
            .filter((g) => g.end > g.start),
        })).filter((r) => r.segments.length);
        const tightened = applyCutSegments(perClip);
        if (tightened) {
          renderHighlights(); draw();
          toast(`Tightened ${tightened} moment${tightened === 1 ? '' : 's'} — cut ${pace.removedSec}s of dead air.`);
        }
      }
    } catch { /* tightening is an improvement, not a gate — keep the storyboard either way */ }

    // 4. Export clip list = cold-open HOOK first, then the chronological body (hard-cut concat).
    const body = state.highlights.filter((h) => h.keep).sort((a, b) => a.start - b.start)
      .map((h) => ({ start: h.start, end: h.end, overlays: (h.overlays || []).filter((o) => o.content && o.content.trim()) }));
    const clips = [];
    if (plan.hook) clips.push({ start: plan.hook.start, end: plan.hook.end });   // cold-open teaser
    clips.push(...body);
    if (!clips.length) { toast('Not enough moments to build a storyboard.', true); return; }

    // Report the REAL runtime, not plan.totalSec — that figure predates the tightening pass, so
    // it over-reported the length of what actually shipped (4:11 claimed vs 3:07 delivered).
    const finalSec = clips.reduce((n, c) => n + Math.max(0, c.end - c.start), 0);
    showProgress(`Editing your ${fmt(finalSec)} story package…`);
    const res = await fetch('/api/export/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...exportPrefs(), id: state.proj.id, clips, vertical: false, zoom: false }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    addOutput('Storyboard Cut', data, 'sequence');
    logEdit('storyboard_cut', { body: body.length, totalSec: +finalSec.toFixed(1), plannedSec: +(+plan.totalSec).toFixed(1), blueprint, hookScore: plan.hookScore ?? null });
    toast(`Story package ready — hook + ${body.length} moments, ${fmt(finalSec)} ✓`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false; hideProgress();
  }
}

// ---- Hook Toolkit: rate the cold open (1–10) + audition the alternatives in the monitor.
// Heuristic health (audio peak/rise + scene-cut motion + reaction intrigue) — an honest pre-export
// estimate, NOT a retention prediction (nothing's uploaded to learn from). ----
function hookScoreClass(s) { return s >= 8 ? 'good' : s >= 5 ? 'ok' : 'weak'; }
function renderHookLab(plan) {
  const lab = $('#hookLab'); if (!lab) return;
  const score = plan && plan.hookScore;
  const cands = (plan && plan.hookCandidates) || [];
  if (!Number.isFinite(score) && !cands.length) { lab.classList.add('hidden'); lab.innerHTML = ''; return; }
  const chosen = plan.hook ? plan.hook.source : null;
  const play = '<svg viewBox="0 0 10 10" width="9" height="9" fill="currentColor" aria-hidden="true"><path d="M2 1l6 4-6 4z"/></svg>';
  lab.innerHTML =
    `<div class="hookLabHead">Cold-open health<span class="hookScore ${hookScoreClass(score || 0)}">${Number.isFinite(score) ? score : '–'}<i>/10</i></span></div>` +
    '<div class="hookCands">' +
    cands.map((c) => `<button class="hookCand${c.source === chosen ? ' pick' : ''}" data-start="${c.start}" data-end="${c.end}" title="Audition this cold open in the monitor">` +
      `<span class="hookCandScore ${hookScoreClass(c.score)}">${c.score}</span>` +
      `<span class="hookCandMeta">${c.source === chosen ? 'in your cut · ' : ''}${fmt(c.end - c.start)} teaser</span>` +
      `<span class="hookCandPlay">${play}Audition</span></button>`).join('') +
    '</div>';
  lab.classList.remove('hidden');
}
// Audition = seek the monitor to the candidate and play just its window (cheap, no re-export).
let _hookStopTimer = null;
$('#hookLab')?.addEventListener('click', (e) => {
  const b = e.target.closest('.hookCand'); if (!b || !player) return;
  const start = +b.dataset.start; const end = +b.dataset.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  clearTimeout(_hookStopTimer);
  try {
    player.currentTime = start;
    safePlay();
    _hookStopTimer = setTimeout(() => { try { player.pause(); } catch (_) {} }, (end - start) * 1000);
  } catch (_) {}
});

// ---- One-Button Story Cut: auto-assemble the sequence from the ranked highlights.
// Selects story clips (setup/payoff/callback) + strong reactions, drops filler, holds
// payoffs 1.2s for the reaction, orders chronologically (setups precede payoffs), then
// lets renderHighlights/renderTracks rebuild state.seqMap and DRAW the finished timeline.
// Works WITH the architecture — no seqMap overwrite (that would break playhead/scrub).
// Shared assembly brain: pick the best moments (story beats + strong reactions; fill to a
// floor of 3 with the top remaining by score), set keep + chronological order on
// state.highlights, and rebuild the sequence. Returns { kept, total }. Used by Story Cut
// (assemble only) and Edit for Me (assemble → export).
function assembleStoryCut() {
  buildStory(state.highlights);   // maps setups → payoffs → callbacks + scores
  let kept = 0;
  state.highlights.forEach((h) => {
    const s = h.story || {};
    const isStory = s.intent === 'setup' || s.intent === 'payoff' || s.setupAt != null || s.payoffAt != null || s.callbackOf != null;
    const isStrong = (h.reactionScore || 0) > 1.8 || (h.scores && h.scores.retention >= 0.6);
    h.keep = !!(isStory || isStrong);
    // pacing: hold the reaction on payoffs (extend end 1.2s, clamped to the source)
    if (h.keep && s.intent === 'payoff' && state.proj.duration) h.end = Math.min(state.proj.duration, h.end + 1.2);
    if (h.keep) kept++;
  });
  if (kept < 3) {   // too few matched → relax: fill up to 3 with the top remaining by score
    [...state.highlights].filter((h) => !h.keep).sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3 - kept).forEach((h) => { h.keep = true; kept++; });
  }
  // order: kept first, chronological by source time (setups naturally precede their payoffs)
  state.highlights.sort((a, b) => (a.keep === b.keep ? a.start - b.start : (a.keep ? -1 : 1)));
  renderHighlights(); draw();   // renderTracks rebuilds seqMap from kept clips → draws the cut
  return { kept, total: (state.seqMap && state.seqMap.total) || 0 };
}

function oneButtonStoryCut() {
  const btn = $('#storyCutBtn');
  if (!state.proj || !(state.highlights && state.highlights.length)) {
    toast('Analyze (and ideally Rank funny moments) first, then hit Story Cut.', true); return;
  }
  const { kept, total } = assembleStoryCut();
  logEdit('one_button_story_cut', { kept, dropped: state.highlights.length - kept });
  if (btn) { btn.disabled = true; const o = btn.innerHTML; btn.innerHTML = 'Assembling…'; setTimeout(() => { btn.disabled = false; btn.innerHTML = o; }, 400); }
  toast(`Story cut assembled — ${kept} clips (${fmt(total)}), filler dropped.`);
}
// The single primary auto-edit control now runs the Storyboard Cut (the old One-Button
// Story Cut / Edit for Me buttons were redundant and confusing). oneButtonStoryCut/autoEdit remain
// defined for reuse but are no longer wired to a button.
$('#storyCutBtn')?.addEventListener('click', storyboardCut);

// ---- Live run-time plan ----------------------------------------------------------------------
// The cut length is no longer a fixed 8-10 minutes: it's computed from how much genuinely strong
// material the ranking actually found, with the source length only supplying a sanity ceiling.
// Surfacing it BEFORE the export is the point — you see what it intends to build, and changing the
// blueprint re-costs it instantly (the planner is pure, so this is a cheap round-trip, no ffmpeg).
// How picky the filter is, 0-1 — the ONLY length control. A moment must score at least this
// fraction of the VOD's best moment to make the cut. Persisted so it survives a reload.
state.pickyFloor = (() => {
  const v = parseFloat(localStorage.getItem('pep_picky'));
  return Number.isFinite(v) ? v : 0.35;
})();
function renderRunPlan(p) {
  const el = $('#runPlan'); if (!el) return;
  if (!p || !p.targetSec) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const flat = p.degenerate ? ' <span class="rpCap" title="The ranking found no spread — rank the VOD for a sharper cut">unranked</span>' : '';
  const pct = Math.round((state.pickyFloor || 0.35) * 100);
  el.innerHTML =
    `<div class="pkHead"><span>Planned cut</span><span class="rpTier">${escapeHtml(p.tier)}</span></div>
     <div class="rpBig">${fmt(p.targetSec)}${flat}</div>
     <div class="rpWhy">${escapeHtml(p.reason)}</div>
     <div class="rpMeta">${p.strongCount}${p.totalCount ? ` of ${p.totalCount}` : ''} moments kept · ${fmt(p.availSec)} available · ${p.hookSec}s cold open</div>
     <div class="knobRow rpKnob">
       <label for="pickySlider">How picky <span id="pickyVal" class="knobVal">${pct}%</span></label>
       <input type="range" id="pickySlider" min="0.05" max="0.9" step="0.05" value="${state.pickyFloor}" />
     </div>`;
  el.classList.remove('hidden');
  // Re-bound on every render because innerHTML replaces the node — hence binding here, not once.
  $('#pickySlider')?.addEventListener('input', (e) => {
    state.pickyFloor = +e.target.value;
    localStorage.setItem('pep_picky', String(state.pickyFloor));
    const lbl = $('#pickyVal'); if (lbl) lbl.textContent = `${Math.round(state.pickyFloor * 100)}%`;
    scheduleRunPlan();
  });
}
// Cost the current highlights without exporting anything.
// Dragging the picky slider fires overlapping requests, and responses can come back OUT OF ORDER —
// a slower reply for an older bar would otherwise land last and leave the card showing a number
// that doesn't match the slider. The sequence guard drops any response that isn't the newest.
let _planTimer = null, _planSeq = 0;
async function refreshRunPlan() {
  const el = $('#runPlan'); if (!el) return;
  const hs = (state.highlights || []).filter((h) => Number.isFinite(h.start) && Number.isFinite(h.end));
  if (!state.proj || !hs.length) { renderRunPlan(null); return; }
  const seq = ++_planSeq;
  try {
    const res = await fetch('/api/storyboard/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        highlights: hs,
        sourceSec: state.proj.duration || 0,
        blueprint: ($('#blueprintSel') && $('#blueprintSel').value) || 'balanced',
        pickyFloor: state.pickyFloor,
      }),
    });
    const p = await res.json();
    if (seq !== _planSeq) return;                     // a newer request already answered
    if (res.ok) renderRunPlan({ ...p, availCount: hs.length });
  } catch { /* advisory only — never block the UI on it */ }
}
const scheduleRunPlan = () => { clearTimeout(_planTimer); _planTimer = setTimeout(refreshRunPlan, 250); };
$('#blueprintSel')?.addEventListener('change', scheduleRunPlan);

// ---- Retention critic panel -------------------------------------------------------------------
// Objective numbers for the cut you're about to render, so a bad edit is a measurement rather than
// a judgement call. Pure server-side maths (no ffmpeg, no tokens), so it re-costs live.
//
// IMPORTANT: speech density is only meaningful when a transcript is loaded. Without words the
// critic sees zero words and would paint the ENTIRE cut as low-density — confidently wrong. So the
// density findings are suppressed (and the panel says why) until the transcript exists.
state.criticIssues = [];
function renderCriticCard(r, hasWords) {
  const el = $('#criticBox'); if (!el) return;
  if (!r || !r.stats || !r.stats.clipCount) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const s = r.stats;
  const verdict = r.pass ? 'pass' : (s.fails > 2 ? 'bad' : 'warn');
  const chip = (ok, label, val, title) =>
    `<div class="cMetric ${ok ? 'ok' : 'bad'}" title="${escapeHtml(title)}"><span>${escapeHtml(label)}</span><b>${escapeHtml(val)}</b></div>`;
  const top = (r.issues || []).slice(0, 4).map((i) =>
    `<li class="cIssue ${i.severity}"><b>${escapeHtml((i.type || '').replace(/_/g, ' '))}</b>
       <span class="cAt">@${fmt(i.atSec)}</span><br><span class="cFix">${escapeHtml(i.detail || '')}</span></li>`).join('');
  el.innerHTML =
    `<div class="pkHead"><span>Retention critic</span><span class="cScore ${verdict}">${r.score}</span></div>
     <div class="cMetrics">
       ${chip(s.deadAirSec <= 2, 'Dead air', `${s.deadAirSec}s`, 'Silence that survived into a kept clip')}
       ${chip(s.interruptsPerMin >= 8, 'Interrupts', `${s.interruptsPerMin}/min`, 'Cuts, zooms, overlays and SFX hits per minute')}
       ${hasWords ? chip(s.wordsPerSec >= 2.5, 'Speech', `${s.wordsPerSec}/s`, 'Sustained speech density') : ''}
       ${chip(true, 'Runtime', fmt(s.outputSec), `${s.clipCount} clips`)}
     </div>
     ${top ? `<ul class="cIssues">${top}</ul>` : '<div class="cClean">No retention defects found.</div>'}
     ${hasWords ? '' : '<div class="hint">Load the transcript to also score speech density.</div>'}`;
  el.classList.remove('hidden');
}
let _criticTimer = null, _criticSeq = 0;
async function refreshCritic() {
  const el = $('#criticBox'); if (!el) return;
  const clips = (state.highlights || []).filter((h) => h.keep)
    .map((h) => ({ id: h.id, start: h.start, end: h.end }));
  if (!state.proj || !clips.length) { state.criticIssues = []; renderCriticCard(null); return; }
  // Words only exist once the transcript has been loaded in this session.
  const words = _tr ? _tr.clips.flatMap((c) => c.words || []) : [];
  const seq = ++_criticSeq;
  try {
    const res = await fetch('/api/critic', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips, words,
        silences: ((state.proj && state.proj.silences) || []).map((s) => (Array.isArray(s) ? s : [s.start, s.end])),
      }),
    });
    const r = await res.json();
    if (seq !== _criticSeq || !res.ok) return;             // a newer audit already answered
    // Drop density findings when we have no transcript, so the heatmap can't lie.
    r.issues = (r.issues || []).filter((i) => words.length || i.type !== 'low_speech_density');
    state.criticIssues = r.issues;
    renderCriticCard(r, words.length > 0);
    renderTracks();                                        // repaint the heatmap
  } catch { /* advisory only */ }
}
const scheduleCritic = () => { clearTimeout(_criticTimer); _criticTimer = setTimeout(refreshCritic, 400); };

// ---- Step 5: Correction Capture. After a MANUAL override (trim/keep/reorder/segment),
// surface a one-tap "why?" popover. The base action already logged; tapping a reason
// appends a labeled human_correction token (with story context) to the feedback corpus.
// Optional + non-blocking: it auto-fades if ignored (low friction — even 10% labels help).
let _corrCtx = null, _corrTimer = null;
function promptCorrection(action, ctx) {
  const shelf = $('#correctionShelf'); if (!shelf) return;
  _corrCtx = { action, ...ctx };
  const what = $('#corrWhat'); if (what) what.textContent = (ctx && ctx.label) || action;
  shelf.classList.remove('hidden');
  clearTimeout(_corrTimer);
  _corrTimer = setTimeout(() => { shelf.classList.add('hidden'); _corrCtx = null; }, 9000);
}
$('#correctionShelf')?.addEventListener('click', (e) => {
  const shelf = $('#correctionShelf');
  if (e.target.closest('#corrClose')) { shelf.classList.add('hidden'); clearTimeout(_corrTimer); _corrCtx = null; return; }
  const b = e.target.closest('.corrTag'); if (!b || !_corrCtx) return;
  logEdit('human_correction', { ..._corrCtx, reason: b.dataset.reason });
  toast('Thanks — logged as training feedback.');
  shelf.classList.add('hidden'); clearTimeout(_corrTimer); _corrCtx = null;
});
