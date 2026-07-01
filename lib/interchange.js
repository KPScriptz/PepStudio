// NLE handoff: turn the Phantasm keep-cut into formats Premiere (and Resolve/FCP) import.
//  - CMX3600 EDL: a simple, rock-solid cut list (relink to the source clip on import).
//  - Final Cut Pro 7 XML (xmeml v4): rebuilds the trimmed sequence referencing the
//    original media by path (auto-relink) with highlight markers. Premiere imports this.

const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// frames -> HH:MM:SS:FF (non-drop) at an integer timebase
function tc(frames, tb) {
  const f = frames % tb;
  let s = Math.floor(frames / tb);
  const ss = s % 60; s = Math.floor(s / 60);
  const mm = s % 60; const hh = Math.floor(s / 60);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(f)}`;
}

export function buildEDL(segments, fps, { title = 'PepStudio Cut', reel = 'AX', clipName = '' } = {}) {
  const tb = Math.max(1, Math.round(fps));
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  segments.forEach((seg, i) => {
    const sIn = Math.round(seg.start * fps);
    const sOut = Math.round(seg.end * fps);
    const dur = Math.max(1, sOut - sIn);
    const recIn = rec; const recOut = rec + dur; rec = recOut;
    const ev = String(i + 1).padStart(3, '0');
    lines.push(`${ev}  ${reel.padEnd(8)} AA/V  C        ${tc(sIn, tb)} ${tc(sOut, tb)} ${tc(recIn, tb)} ${tc(recOut, tb)}`);
    if (clipName) lines.push(`* FROM CLIP NAME: ${clipName}`);
  });
  return lines.join('\n') + '\n';
}

// Map a SOURCE-time marker to its position on the cut TIMELINE (skips markers that
// fall inside removed regions).
function mapMarkersToTimeline(markers, segments, fps) {
  const out = [];
  for (const m of (markers || [])) {
    let acc = 0;
    for (const seg of segments) {
      if (m.t >= seg.start && m.t <= seg.end) { out.push({ name: m.name, frame: Math.round((acc + (m.t - seg.start)) * fps) }); break; }
      acc += (seg.end - seg.start);
    }
  }
  return out;
}

export function buildFcp7Xml(absPath, meta, segments, markers = [], { title = 'PepStudio Cut' } = {}) {
  const fps = meta.fps || 30;
  const tb = Math.max(1, Math.round(fps));
  const ntsc = Math.abs(fps - tb) > 0.01 ? 'TRUE' : 'FALSE';
  const w = meta.width || 1920; const h = meta.height || 1080;
  const hasAudio = meta.hasAudio !== false;
  const name = absPath.split('/').pop();
  const url = 'file://localhost' + encodeURI(absPath);
  const srcDurF = Math.round((meta.duration || 0) * fps);
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  let total = 0;
  const segF = segments.map((seg) => {
    const inF = Math.round(seg.start * fps); const outF = Math.round(seg.end * fps);
    const dur = Math.max(1, outF - inF); const start = total; const end = total + dur; total = end;
    return { inF, outF, start, end };
  });

  let fileEmitted = false;
  const fileDef = () => {
    if (fileEmitted) return '<file id="file-1"/>';
    fileEmitted = true;
    return `<file id="file-1"><name>${xe(name)}</name><pathurl>${xe(url)}</pathurl>${rate}<duration>${srcDurF}</duration>`
      + `<media><video><samplecharacteristics><width>${w}</width><height>${h}</height></samplecharacteristics></video>`
      + (hasAudio ? '<audio><channelcount>2</channelcount></audio>' : '') + '</media></file>';
  };

  const vClips = segF.map((s, i) => `<clipitem id="v-${i + 1}"><name>${xe(name)}</name><duration>${srcDurF}</duration>${rate}`
    + `<start>${s.start}</start><end>${s.end}</end><in>${s.inF}</in><out>${s.outF}</out>${fileDef()}</clipitem>`).join('');

  const aClips = hasAudio ? segF.map((s, i) => `<clipitem id="a-${i + 1}"><name>${xe(name)}</name><duration>${srcDurF}</duration>${rate}`
    + `<start>${s.start}</start><end>${s.end}</end><in>${s.inF}</in><out>${s.outF}</out><file id="file-1"/>`
    + '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>').join('') : '';

  const markerXml = mapMarkersToTimeline(markers, segments, fps)
    .map((m) => `<marker><name>${xe(m.name)}</name><in>${m.frame}</in><out>-1</out></marker>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="seq-1">
    <name>${xe(title)}</name>
    <duration>${total}</duration>
    ${rate}
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${w}</width><height>${h}</height></samplecharacteristics></format>
        <track>${vClips}</track>
      </video>
      ${hasAudio ? `<audio><track>${aClips}</track></audio>` : ''}
    </media>
    ${markerXml}
  </sequence>
</xmeml>
`;
}
