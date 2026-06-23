// Download a VOD from a URL (YouTube, Twitch, etc.) with yt-dlp. Local + free.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function ytdlpBin() {
  if (process.env.YTDLP_BIN && fs.existsSync(process.env.YTDLP_BIN)) return process.env.YTDLP_BIN;
  for (const c of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp']) {
    try {
      const p = c.includes('/') ? (fs.existsSync(c) ? c : '') : execSync(`command -v ${c} 2>/dev/null`).toString().trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

export const SUPPORTED_URL = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com|twitch\.tv|clips\.twitch\.tv)\//i;

// Probe a URL's title/duration without downloading (quick metadata fetch).
export function probeUrl(url) {
  return new Promise((resolve) => {
    const bin = ytdlpBin();
    if (!bin) return resolve(null);
    const child = spawn(bin, ['--no-playlist', '--no-warnings', '--print', '%(title)s\n%(duration)s', url]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const [title, duration] = out.trim().split('\n');
      resolve(title ? { title, duration: parseFloat(duration) || null } : null);
    });
  });
}

// Download to destDir/<base>.mp4, reporting integer % via onProgress. Resolves to the file path.
export function downloadUrl(url, destDir, { base = 'vod', onProgress, onStage } = {}) {
  return new Promise((resolve, reject) => {
    const bin = ytdlpBin();
    if (!bin) return reject(new Error('yt-dlp not found. Install with: brew install yt-dlp'));
    fs.mkdirSync(destDir, { recursive: true });
    // Clear any stale files for this base.
    for (const f of fs.readdirSync(destDir)) if (f.startsWith(base + '.')) { try { fs.unlinkSync(path.join(destDir, f)); } catch {} }

    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--no-part',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '-o', path.join(destDir, `${base}.%(ext)s`),
      url,
    ];
    const child = spawn(bin, args);
    let err = '';
    let lastStage = '';
    const handle = (s) => {
      // yt-dlp emits e.g. "[download]  37.4% of ~512.0MiB at 8.0MiB/s"
      const m = /\[download\]\s+([\d.]+)%/.exec(s);
      if (m && onProgress) onProgress(Math.round(parseFloat(m[1])));
      if (/\[Merger\]/.test(s) && lastStage !== 'merge') { lastStage = 'merge'; onStage && onStage('merging'); }
      else if (/\[download\] Destination/.test(s) && lastStage !== 'dl') { lastStage = 'dl'; onStage && onStage('downloading'); }
    };
    child.stdout.on('data', (d) => handle(d.toString()));
    child.stderr.on('data', (d) => { const s = d.toString(); err += s; handle(s); });
    child.on('error', reject);
    child.on('close', (code) => {
      const made = fs.readdirSync(destDir).filter((f) => f.startsWith(base + '.')).map((f) => path.join(destDir, f));
      const mp4 = made.find((f) => f.endsWith('.mp4')) || made.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      if (code !== 0 && !mp4) return reject(new Error('Download failed:\n' + err.slice(-1500)));
      if (!mp4) return reject(new Error('yt-dlp produced no file.\n' + err.slice(-800)));
      resolve(mp4);
    });
  });
}
