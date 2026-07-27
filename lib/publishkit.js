// Publish Kit — turn a finished cut's kept clips into the copy a creator pastes when uploading:
// timestamped YouTube chapters, a description, and hashtags. Pure (no I/O), heuristic (no model
// required — PepAI titles slot in upstream when present). Grounded in data the app already has:
// each clip's { start, end, title?, snippet? } plus the OUTPUT order.
import { smartTitle } from './titles.js';

// Format seconds as a YouTube timestamp: 0:00, 1:23, 1:02:03.
function ts(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(ss).padStart(2, '0')}`;
}

// A short, punchy chapter title. Prefers a pre-set clip title, else derives one from the transcript
// snippet via smartTitle (Title-Cased, filler-trimmed). Numbered fallback keeps chapters distinct
// when there's no text at all.
function clipTitle(clip, i) {
  const t = smartTitle(clip.title || clip.snippet || '', { tag: clip.tag || '', reactionScore: clip.reactionScore || 0 });
  return (!t || t === 'Highlight') ? `Moment ${i + 1}` : t;
}

// YouTube chapters on the OUTPUT timeline (cumulative clip durations). YouTube's rules are enforced
// so the chapters actually WORK: first marker at 0:00, at least 3 markers, each >=10s after the
// previous (closer markers merge into the earlier chapter). `hookSec` accounts for a prepended
// cold-open teaser. Returns { chapters:[{tOut,title}], text, valid }.
export function buildChapters(clips, { hookSec = 0 } = {}) {
  const cl = (clips || []).filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  const chapters = [];
  const push = (tOut, title) => {
    const prev = chapters[chapters.length - 1];
    if (!prev || tOut - prev.tOut >= 10) chapters.push({ tOut: +Math.max(0, tOut).toFixed(1), title });
  };
  let out = hookSec > 0 ? hookSec : 0;
  if (hookSec > 0) chapters.push({ tOut: 0, title: 'Cold open' });
  cl.forEach((c, i) => {
    push(i === 0 && hookSec <= 0 ? 0 : out, clipTitle(c, i));
    out += c.end - c.start;
  });
  if (chapters.length) chapters[0].tOut = 0;   // YouTube requires the first chapter at 0:00
  const valid = chapters.length >= 3;          // YouTube needs >=3 markers to show chapters at all
  const text = chapters.map((c) => `${ts(c.tOut)} ${c.title}`).join('\n');
  return { chapters, text, valid };
}

const STOP = new Set(('the a an and or but to of in on at is it this that i you we he she they them me my your our so ' +
  'just like get got go going gonna yeah ok okay right now here there what when how why who all out up down for with ' +
  'was were are be been being do does did no yes not too very really from into over under about into then than').split(' '));

// Hashtags from clip-text keyword frequency + an optional game name. Lowercased, deduped, capped.
export function suggestHashtags(clips, { game = '', max = 12 } = {}) {
  const freq = new Map();
  for (const c of (clips || [])) {
    for (const w of String(c.title || c.snippet || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const tags = [];
  const g = String(game).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (g) tags.push(g);                                   // e.g. "NBA 2K26 GOAT" → nba2k26goat
  for (const t of ['gaming', 'gameplay', 'clips', 'shorts']) tags.push(t);
  for (const [w] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (tags.length >= max) break;
    if (!tags.includes(w)) tags.push(w);
  }
  return [...new Set(tags)].slice(0, max).map((t) => `#${t}`);
}

// Assemble the full description block a creator can paste into YouTube.
export function buildDescription({ title = '', chapters = null, hashtags = [] } = {}) {
  const lines = [];
  if (title) { lines.push(title, ''); }
  if (chapters && chapters.valid) { lines.push('Chapters:', chapters.text, ''); }
  if (hashtags.length) lines.push(hashtags.join(' '));
  return lines.join('\n').trim();
}
