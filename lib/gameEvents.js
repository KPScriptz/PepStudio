// Fold game-adapter OCR event tokens (NBA scoreboard, Palworld notifications, future Minecraft/GTA)
// into highlight ranking. Pure (no I/O), matching lib/reactions.js / lib/retention.js: it adds ONE
// more additive term to the existing score model (server.js funny route:
//   total = audioScore + 1.5*reactionScore + hook + boost)
// so an OCR-confirmed moment (a buzzer-beater, a rare Pal catch) rises to the top without
// disturbing anything else. Caller re-sorts by score afterward, exactly as it already does.
//
// A highlight is boosted when an event's timestamp falls within its window (± pad seconds). The
// boost scales with the summed event weights so a clutch buzzer-beater (w=1.0) outranks a routine
// bucket (w=0.4). Highlights with no nearby event are returned untouched.
export function applyGameEvents(highlights, events, { boost = 2.5, pad = 3 } = {}) {
  if (!Array.isArray(highlights) || !Array.isArray(events) || !events.length) return highlights;
  return highlights.map((h) => {
    const near = events.filter((e) => e.t >= h.start - pad && e.t <= h.end + pad);
    if (!near.length) return h;
    const add = +(boost * near.reduce((a, e) => a + (e.weight ?? 0.5), 0)).toFixed(2);
    const types = [...new Set(near.map((e) => e.type))];
    return {
      ...h,
      score: +((Number(h.score) || 0) + add).toFixed(2),
      gameBoost: add,
      gameEvents: types,
      tags: [...new Set([...(h.tags || []), ...types])],
    };
  });
}
