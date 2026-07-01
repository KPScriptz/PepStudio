// PepAI — PepStudio's OPTIONAL local AI layer. Talks to a local Ollama instance to write
// punchier titles/tags than the zero-dep heuristic. It is strictly opt-in and fully
// graceful: if Ollama isn't running (or no model is pulled), every export returns null and
// the caller falls back to lib/titles.js. Nothing here is ever on the funny hot path.
//
// Config via env: OLLAMA_HOST (default http://localhost:11434), PEPAI_MODEL (default = first
// installed model). Zero npm deps — uses global fetch (Node 18+).

const BASE = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const PREFERRED = process.env.PEPAI_MODEL || '';

// fetch with an AbortController timeout so a hung daemon never stalls the request.
async function fetchT(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// Is Ollama up + a usable model present? Cheap (short timeout); used by /api/status and to
// pick the model. Connection-refused (Ollama not installed) resolves fast to {ready:false}.
export async function pepaiReady() {
  try {
    const r = await fetchT(`${BASE}/api/tags`, {}, 800);
    if (!r.ok) return { ready: false };
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    if (!models.length) return { ready: false };
    const model = (PREFERRED && models.includes(PREFERRED)) ? PREFERRED : models[0];
    return { ready: true, model, models };
  } catch {
    return { ready: false };
  }
}

// One structured call → { title, tags, titleSource:'pepai' }. Returns null on ANY failure
// (no model, bad JSON, timeout) so the caller can fall back to the heuristic.
export async function generateClipMeta(transcript, { model } = {}) {
  const text = (transcript || '').trim();
  if (!text) return null;

  let mdl = model;
  if (!mdl) {
    const s = await pepaiReady();
    if (!s.ready) return null;
    mdl = s.model;
  }

  const system = 'You title short-form gaming/comedy clips for YouTube Shorts and TikTok. '
    + 'Reply with ONLY compact JSON of the form {"title": string, "tags": string[]}. '
    + 'title: punchy, retention-hooky, <=6 words, ALL CAPS, no quotes/emojis/punctuation. '
    + 'tags: exactly 3 lowercase niche tags, no # symbol.';
  const user = `Clip transcript: "${text.slice(0, 600)}"`;

  try {
    const r = await fetchT(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: mdl,
        system,
        prompt: user,
        stream: false,
        format: 'json',                       // Ollama constrains output to valid JSON
        options: { temperature: 0.6, num_predict: 120 },
      }),
    }, 20000);
    if (!r.ok) return null;

    const data = await r.json();
    const parsed = JSON.parse(data.response || '{}');
    const title = String(parsed.title || '').replace(/["']/g, '').trim().toUpperCase().slice(0, 60);
    let tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    tags = tags.map((t) => String(t).toLowerCase().replace(/[^\w]/g, '')).filter(Boolean).slice(0, 3);
    if (!title) return null;
    return { title, tags: tags.length ? tags : ['clip'], titleSource: 'pepai' };
  } catch {
    return null;
  }
}
