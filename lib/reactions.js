// Reaction scoring — mine a transcribed window for the "funny" signal:
// laughter, hype/disbelief exclamations, swears, and excited fast talking.
// Pure (no I/O): takes word tokens [{ t0, t1, w }] and returns a reaction score
// plus the line that was actually said, so the UI can surface candidates with context.

// Weighted lexicon, matched case-insensitively against the joined window text.
// whisper.cpp (-ml 1) emits near-word tokens with little punctuation, so we lean
// on words/phrases rather than '!' density.
const LEXICON = [
  // Laughter — the strongest tell that something was funny.
  // Catches "haha", "hahaha", "hehe", "lol", "lmao", "rofl".
  { re: /\b(?:(?:ha|hah|heh|hee|ho|ah){2,}|lo+l|lma+o+|lmf+ao+|rofl)\b/gi, w: 3.0, tag: 'laugh' },
  { re: /\b(?:hilarious|dying|crying|cant breathe|can'?t breathe|so funny|bruh|bro+|dude+)\b/gi, w: 1.6, tag: 'laugh' },
  // Hype / disbelief reactions.
  { re: /\b(?:oh my god|oh my gosh|oh my|what the|no way|no shot|let'?s go+|lets go+|are you (?:kidding|serious)|what just happened|wait what|how did|holy|insane|unreal|no chance|you'?re kidding)\b/gi, w: 1.4, tag: 'hype' },
  // Swears — strong reaction markers in gaming / comedy VODs.
  { re: /\b(?:wtf|omfg|omg|holy (?:shit|crap)|oh shit|what the (?:hell|heck|f))\b/gi, w: 1.5, tag: 'swear' },
];

// One-line snippet of what was said (clamped), for the candidate card.
function snippet(words, max = 180) {
  const text = words.map((x) => x.w).join(' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

// Score a window of word tokens. Returns { reactionScore, rate, hits, snippet }.
// reactionScore = weighted lexicon hits + a bonus for excited fast talking.
export function scoreWindow(words) {
  if (!words || !words.length) return { reactionScore: 0, rate: 0, hits: [], snippet: '' };
  const text = words.map((x) => x.w).join(' ');
  const span = Math.max(1, words[words.length - 1].t1 - words[0].t0);
  const rate = words.length / span; // words per second

  let kw = 0;
  const hits = [];
  for (const { re, w, tag } of LEXICON) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) { kw += w; hits.push({ tag, word: m[0] }); }
  }

  // Excited, rapid-fire talking (laughing-while-talking, hype) reads as funny.
  // Baseline conversational rate ~2.2 w/s; reward the excess.
  const rateBonus = Math.max(0, rate - 2.2) * 0.8;

  return {
    reactionScore: +(kw + rateBonus).toFixed(2),
    rate: +rate.toFixed(2),
    hits,
    snippet: snippet(words),
  };
}

// Time spans of every lexicon match within a word window, using the SAME regexes as
// scoreWindow — so multiword phrases ("oh my god") and laughter ("hahaha") are captured,
// which a flat word-Set can't do. Returns [{t0, t1}] sorted by start. Used by the snap
// engine (lib/trim.js) to anchor tight clip bounds on where the reaction actually lands.
export function reactionSpans(words) {
  if (!words || !words.length) return [];
  // Reconstruct the joined text while tracking each word's char range → its timestamps.
  let text = '';
  const ranges = words.map((wd) => {
    const start = text.length;
    text += (wd.w || '');
    const end = text.length;
    text += ' ';
    return { start, end, t0: wd.t0, t1: wd.t1 };
  });

  const spans = [];
  for (const { re } of LEXICON) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const a = m.index;
      const b = m.index + m[0].length;
      const hit = ranges.filter((r) => r.end > a && r.start < b); // tokens overlapping the match
      if (hit.length) spans.push({ t0: hit[0].t0, t1: hit[hit.length - 1].t1 });
    }
  }
  return spans.sort((x, y) => x.t0 - y.t0);
}
