"""Stage 7 - the review deliverables: ``clips.json`` and ``index.html``.

The HTML page is fully self-contained (no CDN, no build step) and references
the rendered MP4s relatively, so the whole output folder can be zipped, moved
or served as-is.
"""

from __future__ import annotations

import html
import json
import logging
import os
from dataclasses import dataclass

from .models import RenderedClip

log = logging.getLogger("cfp.review")


@dataclass
class ReviewMeta:
    source: str
    title: str = ""
    duration: float = 0.0
    picked_by: str = "heuristic"
    gaming: bool = False
    encoder: str = ""
    preset: str = ""
    prompt: str = ""
    model: str = ""
    transcript_words: int = 0


def write_clips_json(
    path: str, clips: list[RenderedClip], meta: ReviewMeta, failed: list[dict]
) -> str:
    payload = {
        "generator": "ClipForge Pro",
        "source": meta.source,
        "source_title": meta.title,
        "source_duration": round(meta.duration, 3),
        "selection": {
            "picked_by": meta.picked_by,
            "prompt": meta.prompt,
            "gaming_mode": meta.gaming,
            "api_model": meta.model,
        },
        "render": {"encoder": meta.encoder, "preset": meta.preset},
        "transcript_words": meta.transcript_words,
        "clip_count": len(clips),
        "clips": [c.to_json() for c in clips],
        "failed": failed,
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, path)
    return path


PAGE_CSS = """
:root{--bg:#09090b;--panel:#151518;--well:#0c0c0e;--line:rgba(255,255,255,.07);
--text:#ededf0;--dim:#9a9aa6;--hot:#ef4444;--warm:#f97316;--cool:#3b82f6;--accent:#ffd600}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{padding:28px 20px 18px;border-bottom:1px solid var(--line)}
h1{margin:0 0 6px;font-size:21px;letter-spacing:-.2px}
.sub{color:var(--dim);font-size:13px}
.sub code{background:var(--well);padding:2px 6px;border-radius:4px}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px}
.grid{display:grid;gap:18px;padding:22px 0;
grid-template-columns:repeat(auto-fill,minmax(282px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
overflow:hidden;display:flex;flex-direction:column}
.card video{width:100%;aspect-ratio:9/16;background:#000;display:block}
.body{padding:13px 14px 15px;display:flex;flex-direction:column;gap:9px;flex:1}
.row{display:flex;align-items:center;gap:9px}
.score{font-weight:700;font-size:13px;padding:3px 9px;border-radius:999px;
background:var(--well);border:1px solid var(--line);white-space:nowrap}
.score.hot{color:var(--hot);border-color:rgba(239,68,68,.4)}
.score.warm{color:var(--warm);border-color:rgba(249,115,22,.4)}
.score.cool{color:var(--cool);border-color:rgba(59,130,246,.4)}
.t{font-weight:650;font-size:15px;line-height:1.35}
.meta{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.hook{font-size:12px;color:var(--accent);letter-spacing:.3px;font-weight:600}
.why{font-size:12.5px;color:var(--dim);border-left:2px solid var(--line);
padding-left:9px;margin:0}
.shots{display:flex;gap:5px;padding:9px 14px 0;overflow-x:auto}
.shot{flex:0 0 auto;border:2px solid transparent;border-radius:6px;padding:0;
background:none;cursor:pointer;line-height:0;position:relative}
.shot img{width:52px;height:92px;object-fit:cover;border-radius:4px;display:block}
.shot.wide img{width:92px;height:52px}
.shot.on{border-color:var(--accent)}
.shot b{position:absolute;bottom:2px;right:3px;font-size:9px;font-weight:700;
color:#fff;text-shadow:0 1px 2px #000;line-height:1}
details{border-top:1px solid var(--line);margin-top:4px}
details summary{cursor:pointer;font-size:12px;color:var(--dim);padding:8px 0 4px;
list-style:none}
details summary::-webkit-details-marker{display:none}
details summary:before{content:"▸ ";font-size:10px}
details[open] summary:before{content:"▾ "}
.alt{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:12.5px}
.alt .n{font-size:10.5px;color:var(--dim);min-width:22px;text-align:right;
font-variant-numeric:tabular-nums}
.alt .x{flex:1}
.alt .fw{font-size:10px;color:var(--dim);opacity:.75}
.plat{display:flex;align-items:baseline;gap:7px;padding:3px 0;font-size:12px}
.plat .p{color:var(--dim);min-width:96px;font-size:11px}
.plat .c{color:var(--dim);font-size:10.5px;font-variant-numeric:tabular-nums}
.plat .c.over{color:var(--hot)}
.tags{display:flex;flex-wrap:wrap;gap:5px}
.tag{font-size:11.5px;background:var(--well);border:1px solid var(--line);
padding:2px 7px;border-radius:5px;color:var(--dim)}
.acts{display:flex;gap:6px;margin-top:auto;padding-top:4px}
button{font:inherit;font-size:12px;cursor:pointer;background:var(--well);
color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button:hover{border-color:rgba(255,255,255,.22)}
button.done{color:#4ade80;border-color:rgba(74,222,128,.4)}
.empty,.fail{margin:22px 0;padding:14px 16px;border-radius:10px;
background:var(--panel);border:1px solid var(--line);font-size:13px}
.fail{border-color:rgba(239,68,68,.35)}
.fail h2{margin:0 0 6px;font-size:14px;color:var(--hot)}
footer{color:var(--dim);font-size:12px;padding:10px 0 34px}
"""

PAGE_JS = """
document.addEventListener('DOMContentLoaded', function(){
  document.querySelectorAll('button.cp').forEach(function(b){
    b.addEventListener('click', function(){ copy(b, b.dataset.copy || ''); });
  });
  // Thumbnail picker: clicking a shot swaps the video's poster.
  document.querySelectorAll('.shots').forEach(function(strip){
    var vid = strip.parentElement.querySelector('video');
    strip.querySelectorAll('.shot').forEach(function(shot){
      shot.addEventListener('click', function(){
        strip.querySelectorAll('.shot').forEach(function(s){ s.classList.remove('on'); });
        shot.classList.add('on');
        if (vid) { vid.setAttribute('poster', shot.dataset.src); vid.load(); }
      });
    });
  });
});
function copy(btn, text){
  const done = () => { const o = btn.textContent; btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = o; btn.classList.remove('done'); }, 1200); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
  } else { fallback(text, done); }
}
function fallback(text, done){
  // file:// pages have no async clipboard, so fall back to a hidden textarea.
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly','');
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); }
  catch (e) { window.prompt('Copy:', text); }
  finally { document.body.removeChild(ta); }
}
"""


def _tier(score: int) -> str:
    if score >= 80:
        return "hot"
    if score >= 60:
        return "warm"
    return "cool"


def _fmt_time(seconds: float) -> str:
    m, s = divmod(max(0.0, seconds), 60)
    return f"{int(m)}:{int(s):02d}"


def render_index_html(
    clips: list[RenderedClip], meta: ReviewMeta, failed: list[dict]
) -> str:
    esc = html.escape
    cards: list[str] = []

    for clip in clips:
        pick = clip.pick
        tags = " ".join(pick.hashtags)
        caption_copy = f"{pick.title}\n\n{tags}".strip()
        poster = (
            f' poster="{esc(os.path.basename(clip.thumbnail))}"'
            if clip.thumbnail else ""
        )
        tag_html = "".join(f'<span class="tag">{esc(t)}</span>' for t in pick.hashtags)
        shots_html = ""
        if clip.thumbnails:
            buttons = []
            for i, shot in enumerate(clip.thumbnails):
                name = esc(os.path.basename(shot.path))
                cls = "shot wide" if shot.aspect == "16:9" else "shot"
                if i == 0:
                    cls += " on"
                buttons.append(
                    f'<button class="{cls}" data-src="{name}" '
                    f'title="{esc(shot.label)} &middot; frame at {shot.frame_time:.1f}s '
                    f'&middot; score {shot.score}">'
                    f'<img src="{name}" alt="{esc(shot.label)}" loading="lazy">'
                    f"<b>{shot.score}</b></button>"
                )
            shots_html = f'<div class="shots">{"".join(buttons)}</div>'

        alts_html = ""
        if len(pick.title_variants) > 1:
            rows = "".join(
                f'<div class="alt"><span class="n">{v.score}</span>'
                f'<span class="x">{esc(v.text)}'
                f'<span class="fw"> &middot; {esc(v.framework)}</span></span>'
                f'<button class="cp" data-copy="{esc(v.text, quote=True)}">Copy</button>'
                "</div>"
                for v in pick.title_variants
            )
            alts_html = (
                f"<details><summary>{len(pick.title_variants)} title options "
                "(ranked by click-through proxy)</summary>" + rows + "</details>"
            )

        plat_html = ""
        if pick.platforms:
            rows = []
            for name, data in pick.platforms.items():
                over = "" if data.get("within_limit", True) else " over"
                rows.append(
                    f'<div class="plat"><span class="p">'
                    f'{esc(name.replace("_", " "))}</span>'
                    f'<span class="x">{esc(str(data.get("text", "")))}</span>'
                    f'<span class="c{over}">{data.get("length", 0)}/'
                    f'{data.get("limit", 0)}</span>'
                    f'<button class="cp" '
                    f'data-copy="{esc(str(data.get("text", "")), quote=True)}">Copy</button>'
                    "</div>"
                )
            plat_html = (
                "<details><summary>Ready-to-paste captions per platform</summary>"
                + "".join(rows) + "</details>"
            )

        cards.append(
            f"""      <article class="card">
        <video src="{esc(os.path.basename(clip.path))}"{poster} controls preload="metadata"></video>
{shots_html}
        <div class="body">
          <div class="row">
            <span class="score {_tier(pick.score)}">{pick.score}/100</span>
            <span class="meta">{_fmt_time(pick.start)}&ndash;{_fmt_time(pick.end)}
              &middot; {pick.duration:.1f}s</span>
          </div>
          <div class="t">{esc(pick.title)}</div>
          {f'<div class="hook">HOOK: {esc(pick.hook)}</div>' if pick.hook else ''}
          {f'<div class="hook">THUMB: {esc(pick.thumbnail_text)}</div>' if pick.thumbnail_text else ''}
          <p class="why">{esc(pick.reason)}</p>
          <div class="tags">{tag_html}</div>
          <div class="acts">
            <button class="cp" data-copy="{esc(pick.title, quote=True)}">Copy title</button>
            <button class="cp" data-copy="{esc(tags, quote=True)}">Copy tags</button>
            <button class="cp" data-copy="{esc(caption_copy, quote=True)}">Copy caption</button>
          </div>
          {alts_html}
          {plat_html}
        </div>
      </article>"""
        )

    body = (
        f'    <div class="grid">\n{chr(10).join(cards)}\n    </div>'
        if cards
        else '    <div class="empty">No clips were rendered.</div>'
    )

    fail_html = ""
    if failed:
        rows = "".join(
            f"<li>clip {esc(str(f.get('clip')))} "
            f"({_fmt_time(float(f.get('start') or 0))}): {esc(str(f.get('error')))}</li>"
            for f in failed
        )
        fail_html = (
            f'    <div class="fail"><h2>{len(failed)} clip(s) failed</h2>'
            f"<ul>{rows}</ul></div>"
        )

    picker = "Claude" if meta.picked_by == "claude" else "built-in heuristic"
    if meta.picked_by == "claude" and meta.model:
        picker += f" ({esc(meta.model)})"
    mode = "gaming / audio-spike ranking" if meta.gaming else "speech-led ranking"
    prompt_line = (
        f'<br>Selection prompt: <code>{esc(meta.prompt)}</code>' if meta.prompt else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClipForge Pro &middot; {esc(meta.title or os.path.basename(meta.source))}</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<header><div class="wrap">
  <h1>{esc(meta.title or os.path.basename(meta.source))}</h1>
  <div class="sub">
    {len(clips)} clip{'' if len(clips) == 1 else 's'} from
    {_fmt_time(meta.duration)} of source &middot; picked by {picker} &middot; {mode}<br>
    Preset <code>{esc(meta.preset)}</code> &middot;
    encoder <code>{esc(meta.encoder)}</code> &middot;
    {meta.transcript_words} transcribed words{prompt_line}
  </div>
</div></header>
<main class="wrap">
{body}
{fail_html}
  <footer>Rendered locally by ClipForge Pro. No watermark, no upload, no credits.</footer>
</main>
<script>{PAGE_JS}</script>
</body>
</html>
"""


def write_review(
    out_dir: str, clips: list[RenderedClip], meta: ReviewMeta, failed: list[dict]
) -> tuple[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    json_path = write_clips_json(os.path.join(out_dir, "clips.json"), clips, meta, failed)
    html_path = os.path.join(out_dir, "index.html")
    tmp = html_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(render_index_html(clips, meta, failed))
    os.replace(tmp, html_path)
    log.info("review page: %s", html_path)
    return json_path, html_path
