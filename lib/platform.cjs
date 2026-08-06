// Platform decisions, isolated and PURE so the Windows branch is testable from a Mac.
//
// Every function here takes `platform` (and `env` where relevant) as an argument instead of
// reading process.platform directly. That is the whole point: this app is developed on macOS
// and shells out to four external binaries, so the Windows paths would otherwise be unrunnable
// and therefore unverifiable. Parameterising them means test/platform.test.js can assert the
// win32 behaviour on any host.
//
// Nothing in here touches the filesystem or spawns anything — callers do that.

const path = require('node:path');


const isWin = (platform = process.platform) => platform === 'win32';

// Path semantics of the TARGET platform, not the host. Using the host's path.join meant a
// Windows path computed on a Mac came out with mixed separators (C:\\Users\\kp/scoop/shims), and
// the mac-branch unit tests failed when run on a Windows CI runner. pathFor() makes every helper
// deterministic regardless of where it executes.
const pathFor = (platform) => (isWin(platform) ? path.win32 : path.posix);

// Executable filename for a tool. Windows needs the .exe suffix for existsSync checks; bare
// names still work when spawning through PATH (PATHEXT resolves them), but we cannot rely on
// that when probing the filesystem.
function binName(base, platform = process.platform) {
  return isWin(platform) ? `${base}.exe` : base;
}

// PATH list separator. Getting this wrong turns the whole PATH into one nonsense entry, which
// is how "spawn ffprobe ENOENT" happens even when the tool is installed.
function pathDelim(platform = process.platform) {
  return isWin(platform) ? ';' : ':';
}

// Home directory. Windows sets USERPROFILE, not HOME.
function homeDir(env = process.env, platform = process.platform) {
  return (isWin(platform) ? env.USERPROFILE : env.HOME) || '';
}

// Expand a leading ~ using the platform's own home variable.
function expandTilde(p, env = process.env, platform = process.platform) {
  if (!p || typeof p !== 'string' || !p.startsWith('~')) return p;
  const home = homeDir(env, platform);
  return home ? pathFor(platform).join(home, p.slice(1)) : p;
}

// Directories to PREPEND to PATH so a GUI-launched app can find user-installed tools. A
// double-clicked app inherits a bare PATH (this bit us on macOS — see CLAUDE.md), and on
// Windows an installed app inherits the system PATH without any per-user tool dirs.
// `appBinDir` is the app's own managed bin folder under userData, where we drop downloads.
function toolDirs(appBinDir, env = process.env, platform = process.platform) {
  const home = homeDir(env, platform);
  const dirs = [];
  if (appBinDir) dirs.push(appBinDir);
  if (isWin(platform)) {
    // Common spots a user's ffmpeg/whisper end up: winget/scoop/chocolatey shims.
    if (home) {
      dirs.push(pathFor(platform).join(home, 'scoop', 'shims'));
      dirs.push(pathFor(platform).join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'));
    }
    if (env.ProgramData) dirs.push(pathFor(platform).join(env.ProgramData, 'chocolatey', 'bin'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    if (home) dirs.push(pathFor(platform).join(home, '.local', 'bin'));
  }
  return dirs;
}

// Build the final PATH value: our tool dirs first, then whatever was already there.
function buildPath(appBinDir, env = process.env, platform = process.platform) {
  return [...toolDirs(appBinDir, env, platform), env.PATH || '']
    .filter(Boolean).join(pathDelim(platform));
}

// The yt-dlp release asset for this platform. yt-dlp publishes one standalone binary per OS,
// which is why it needs no package manager on any of them.
function ytdlpAsset(platform = process.platform) {
  if (isWin(platform)) return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

// Reveal a file in the OS file manager.
// NOTE: Windows explorer.exe exits with code 1 even when it succeeds — callers must not treat
// a non-zero exit as failure here.
function revealCmd(filePath, platform = process.platform) {
  if (isWin(platform)) return { cmd: 'explorer.exe', args: [`/select,${filePath}`], ignoreExit: true };
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath], ignoreExit: false };
  return { cmd: 'xdg-open', args: [pathFor(platform).dirname(filePath)], ignoreExit: false };
}

// Locate an executable on PATH without a shell. `command -v` is POSIX-only; Windows has `where`.
// Returned as argv (never a shell string) so a odd path can't inject.
function whichCmd(bin, platform = process.platform) {
  return isWin(platform)
    ? { cmd: 'where', args: [bin] }
    : { cmd: '/usr/bin/which', args: [bin] };
}

// Candidate absolute locations for a tool, tried before falling back to a bare PATH lookup.
function binCandidates(base, env = process.env, platform = process.platform) {
  const name = binName(base, platform);
  const home = homeDir(env, platform);
  const out = [];
  if (isWin(platform)) {
    if (home) {
      out.push(pathFor(platform).join(home, 'scoop', 'shims', name));
      out.push(pathFor(platform).join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', name));
    }
    if (env.ProgramData) out.push(pathFor(platform).join(env.ProgramData, 'chocolatey', 'bin', name));
    if (env.ProgramFiles) out.push(pathFor(platform).join(env.ProgramFiles, base, 'bin', name));
  } else {
    out.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
    if (home) out.push(pathFor(platform).join(home, '.local', 'bin', name));
  }
  return out;
}

// Where to look for the whisper.cpp GGML model, in priority order.
function whisperModelDirs(env = process.env, platform = process.platform) {
  const home = homeDir(env, platform);
  const out = [];
  if (env.CLIPFORGE_MODELS) out.push(env.CLIPFORGE_MODELS);
  if (isWin(platform)) {
    if (env.LOCALAPPDATA) out.push(pathFor(platform).join(env.LOCALAPPDATA, 'PepStudio', 'models'));
    if (home) out.push(pathFor(platform).join(home, 'whisper.cpp', 'models'));
  } else {
    if (home) out.push(pathFor(platform).join(home, 'whisper.cpp', 'models'), pathFor(platform).join(home, '.local', 'share', 'whisper', 'models'));
    out.push('/opt/homebrew/share/whisper-cpp/models', '/usr/local/share/whisper-cpp/models');
  }
  return out;
}

// How the user installs the external tools, for error messages that actually help.
function installHint(tool, platform = process.platform) {
  const win = {
    ffmpeg: 'winget install Gyan.FFmpeg  (or: scoop install ffmpeg)',
    'whisper-cli': 'Download whisper.cpp for Windows and put whisper-cli.exe on your PATH',
    'yt-dlp': 'winget install yt-dlp  (or: scoop install yt-dlp)',
  };
  const mac = {
    ffmpeg: 'brew install ffmpeg',
    'whisper-cli': 'brew install whisper-cpp',
    'yt-dlp': 'brew install yt-dlp',
  };
  return (isWin(platform) ? win : mac)[tool] || tool;
}

// ---- ffmpeg path handling ---------------------------------------------------------------------
// ffmpeg hands paths to two separate, differently-broken parsers, and BOTH treat a Windows
// backslash as an escape character. Getting these wrong is a SILENT failure: the render runs and
// then reports "No such file", or the subtitle track simply never appears.

// Path for use INSIDE a filtergraph value (subtitles=..., fontfile=...).
// On Windows the drive colon must be escaped AND separators must become forward slashes, because
// a backslash inside a filter argument is consumed as an escape: C:\a\b.ass -> C\:/a/b.ass
function filterPath(p, platform = process.platform) {
  if (!p) return p;
  if (isWin(platform)) return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// One line of a concat-demuxer list file. The demuxer unescapes backslashes inside the quotes, so
// a Windows temp path silently resolves to garbage. Forward slashes are accepted on Windows and
// sidestep it entirely. Single quotes are escaped the way the demuxer expects.
function concatLine(p, platform = process.platform) {
  const norm = isWin(platform) ? String(p).replace(/\\/g, '/') : String(p);
  return `file '${norm.replace(/'/g, "'\\''")}'`;
}

// Hardware DECODE flags. VideoToolbox is Apple-only; passing it on Windows makes ffmpeg fail or
// warn on every render call.
function hwDecodeArgs(platform = process.platform, env = process.env) {
  if (env.PEP_HWDECODE === 'off') return [];
  if (platform === 'darwin') return ['-hwaccel', 'videotoolbox'];
  if (isWin(platform)) return ['-hwaccel', 'd3d11va'];
  return [];
}

// Candidate drawtext fonts, in preference order. drawtext needs an explicit fontfile on builds
// without fontconfig — which is every common Windows ffmpeg build, so without this every text
// overlay render fails.
function fontCandidates(platform = process.platform, env = process.env) {
  if (isWin(platform)) {
    const win = env.WINDIR || 'C:\\Windows';
    return [
      pathFor(platform).join(win, 'Fonts', 'arialbd.ttf'),
      pathFor(platform).join(win, 'Fonts', 'arial.ttf'),
      pathFor(platform).join(win, 'Fonts', 'segoeuib.ttf'),
      pathFor(platform).join(win, 'Fonts', 'segoeui.ttf'),
    ];
  }
  return [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/HelveticaNeue.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
}

module.exports = { isWin, binName, pathDelim, homeDir, expandTilde, toolDirs, buildPath, ytdlpAsset, revealCmd, whichCmd, binCandidates, whisperModelDirs, installHint, filterPath, concatLine, hwDecodeArgs, fontCandidates };
