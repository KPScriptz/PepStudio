// Zero-dependency heuristic titler/tagger — the always-on baseline for clip metadata.
// Builds a punchy title + tags from data we already have (the transcribed words + the
// reaction-lexicon hits), so titles work instantly, offline, with nothing installed.
// PepAI (lib/pepai.js) optionally upgrades these when a local Ollama model is present.

const FILLER = new Set([
  'um', 'uh', 'like', 'so', 'and', 'the', 'a', 'an', 'to', 'of', 'it', 'that', 'this',
  'i', 'you', 'we', 'is', 'are', 'was', 'okay', 'ok', 'just', 'really', 'gonna', 'wanna', 'yeah',
]);

// Fallback titles keyed by the dominant reaction tag.
const TAG_TITLE = { laugh: 'FUNNY MOMENT', hype: 'INSANE MOMENT', swear: 'WHAT JUST HAPPENED' };
// Lexicon tag → social tag.
const TAG_MAP = { laugh: 'funny', hype: 'hype', swear: 'wild' };

const norm = (s) => String(s || '').replace(/[^\w']/g, '').toLowerCase();

// Title: anchor on the strongest reaction word (where the funny actually happens), then
// take up to 6 content words from there, skipping leading filler. Uppercased for punch.
function heuristicTitle(words, hits) {
  const toks = (words || []).map((w) => (w.w || '').trim()).filter(Boolean);
  const fallback = TAG_TITLE[hits?.[0]?.tag] || 'BIG MOMENT';
  if (!toks.length) return fallback;

  const hitWords = new Set((hits || []).map((h) => norm(h.word)).filter(Boolean));
  let anchor = 0;
  if (hitWords.size) {
    const idx = toks.findIndex((t) => hitWords.has(norm(t)));
    if (idx >= 0) anchor = idx;
  }

  let start = Math.max(0, anchor - 1);
  while (start < toks.length && FILLER.has(norm(toks[start]))) start++;

  const picked = [];
  for (let i = start; i < toks.length && picked.length < 6; i++) {
    const clean = toks[i].replace(/[^\w'!?]/g, '');
    if (clean) picked.push(clean);
  }
  const title = picked.join(' ').replace(/\s+/g, ' ').trim();
  return (title || fallback).toUpperCase().slice(0, 60);
}

// Tags: reaction tags first, padded to 3 with generic content tags.
function heuristicTags(hits) {
  const tags = [];
  for (const h of hits || []) {
    const t = TAG_MAP[h.tag];
    if (t && !tags.includes(t)) tags.push(t);
  }
  for (const g of ['clip', 'gaming', 'shorts']) {
    if (tags.length >= 3) break;
    if (!tags.includes(g)) tags.push(g);
  }
  return tags.slice(0, 3);
}

// words: [{t0,t1,w}] ; hits: [{tag, word}] (full hits from reactions.scoreWindow).
export function heuristicMeta(words, hits = []) {
  return {
    title: heuristicTitle(words, hits),
    tags: heuristicTags(hits),
    titleSource: 'heuristic',
  };
}

// Editorial fallbacks when a clip's transcript is too thin to yield a real phrase.
const TITLE_TEMPLATE = { laugh: 'Funny Moment', hype: 'Insane Play', swear: 'What Just Happened' };
// Small words that stay lowercase inside a Title-Cased phrase (never the first word).
const SMALLWORD = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'vs', 'my', 'it', 'is', 'so']);

function titleCase(words) {
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (i > 0 && SMALLWORD.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

// smartTitle — a punchy, Title-Cased 3–6 word clip title from a transcript SNIPPET STRING (what the
// stored highlights carry, vs the word tokens heuristicTitle needs). Strips whisper parentheticals
// and filler from the edges, keeps a coherent middle phrase, and Title-Cases it (reads far better as
// a YouTube chapter than the ALL-CAPS transcript fragment). Falls back to an editorial template by
// reaction tag when there aren't enough real words. Pure + deterministic.
export function smartTitle(text, { tag = '', reactionScore = 0 } = {}) {
  const clean = String(text || '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')     // drop (laughing) / [applause] annotations
    .replace(/[^\w'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let toks = clean.split(' ').filter(Boolean);
  while (toks.length && FILLER.has(norm(toks[0]))) toks.shift();          // trim leading filler
  while (toks.length && FILLER.has(norm(toks[toks.length - 1]))) toks.pop(); // and trailing
  if (toks.length < 3) return TITLE_TEMPLATE[tag] || (reactionScore >= 3 ? 'Big Reaction' : 'Highlight');
  return titleCase(toks.slice(0, 6)).slice(0, 60);
}
