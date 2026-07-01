// Punch-in "pattern interrupt" zooms for live video, done the way that actually renders.
// NOT zoompan (image Ken-Burns; stutters/dup-frames on video). NOT a time-varying `crop`
// size either — `crop` evaluates w/h ONCE at init, so a t-dependent crop never zooms, and
// its inline commas get read as filtergraph separators ("Filter not found"). The correct
// technique: SCALE the frame up per-frame (`eval=frame`) by a zoom factor during emphasis
// windows, then CROP back to a constant W×H center → a real punch-in, constant output size.
//
// Returns { hasZoom, factor, filter }:
//   factor — readable zoom expression, e.g. "if(between(t,2.5,3.2),1.15,1)" (1 = native).
//   filter — ready chain "scale=...:eval=frame,crop=W:H" (null when nothing to zoom).
// `blocks` carry ABSOLUTE caption times; only emphasis blocks zoom, remapped clip-relative.

export function buildTimelineZoomExpression(blocks = [], clipStart = 0, { zoom = 1.15, w = 1080, h = 1920 } = {}) {
  const hits = (blocks || [])
    .filter((b) => b && b.emphasis)
    .map((b) => ({ relStart: +(b.start - clipStart).toFixed(3), relEnd: +(b.end - clipStart).toFixed(3) }))
    .filter((b) => b.relEnd > 0 && b.relStart >= 0)
    .sort((a, b) => a.relStart - b.relStart);

  if (!hits.length) return { hasZoom: false, factor: '1', filter: null };

  // Build inside-out so parentheses always balance: if(win1, Z, if(win2, Z, 1)).
  let factor = '1';
  for (let i = hits.length - 1; i >= 0; i--) {
    factor = `if(between(t,${hits[i].relStart},${hits[i].relEnd}),${zoom},${factor})`;
  }

  // Single-quote the w/h values so the commas inside the expression aren't parsed as
  // filtergraph separators (safe: the graph is handed to ffmpeg as one arg, no shell).
  // ceil(...→/2)*2 keeps dimensions even for libx264.
  const filter = `scale=w='ceil(${w}*(${factor})/2)*2':h='ceil(${h}*(${factor})/2)*2':eval=frame,crop=${w}:${h}`;
  return { hasZoom: true, factor, filter };
}
