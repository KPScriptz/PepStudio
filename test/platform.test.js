// test/platform.test.js — vanilla Node assertions. Run: node test/platform.test.js
//
// The point of this file: PepStudio is developed on macOS but has to run on Windows, and the
// Windows branches can't be exercised here. lib/platform.js takes `platform`/`env` as
// arguments precisely so those branches ARE assertable from a Mac. If this suite passes, the
// platform decisions are right even though the host can't run the Windows build.
import assert from 'assert';
import path from 'node:path';
import {
  isWin, binName, pathDelim, homeDir, expandTilde, toolDirs, buildPath,
  ytdlpAsset, revealCmd, whichCmd, binCandidates, whisperModelDirs, installHint,
  filterPath, concatLine, hwDecodeArgs, fontCandidates,
} from '../lib/platform.js';

const WIN = 'win32', MAC = 'darwin', LIN = 'linux';
const winEnv = { USERPROFILE: 'C:\\Users\\kp', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\kp\\AppData\\Local', PATH: 'C:\\Windows\\system32' };
const macEnv = { HOME: '/Users/kp', PATH: '/usr/bin:/bin' };

function run() {
  console.log('🧪 PepStudio cross-platform unit tests…');

  // --- executable naming ---
  assert.strictEqual(binName('ffmpeg', WIN), 'ffmpeg.exe', 'windows needs .exe');
  assert.strictEqual(binName('ffmpeg', MAC), 'ffmpeg', 'mac stays bare');
  assert.strictEqual(binName('whisper-cli', WIN), 'whisper-cli.exe');
  console.log('✅ binName adds .exe on win32 only.');

  // --- PATH separator: the classic "spawn ENOENT even though it is installed" bug ---
  assert.strictEqual(pathDelim(WIN), ';');
  assert.strictEqual(pathDelim(MAC), ':');
  assert.strictEqual(pathDelim(WIN), path.win32.delimiter, 'matches node path.win32');
  assert.strictEqual(pathDelim(MAC), path.posix.delimiter, 'matches node path.posix');
  console.log('✅ pathDelim matches node’s own delimiters for both platforms.');

  // --- home directory: Windows has no HOME ---
  assert.strictEqual(homeDir(winEnv, WIN), 'C:\\Users\\kp', 'win uses USERPROFILE');
  assert.strictEqual(homeDir(macEnv, MAC), '/Users/kp', 'mac uses HOME');
  assert.strictEqual(homeDir({}, WIN), '', 'missing env is empty, never undefined');
  assert.strictEqual(homeDir({ HOME: '/Users/kp' }, WIN), '', 'win must NOT fall back to HOME');
  console.log('✅ homeDir reads USERPROFILE on win, HOME on mac, never crashes when unset.');

  // --- tilde expansion uses the right home per platform ---
  assert.ok(expandTilde('~/whisper.cpp', macEnv, MAC).startsWith('/Users/kp'), 'mac tilde');
  assert.ok(expandTilde('~/models', winEnv, WIN).includes('C:\\Users\\kp'), 'win tilde');
  assert.strictEqual(expandTilde('/abs/path', macEnv, MAC), '/abs/path', 'non-tilde untouched');
  assert.strictEqual(expandTilde(null, macEnv, MAC), null, 'null is safe');
  console.log('✅ expandTilde resolves against the platform’s own home var.');

  // --- PATH assembly ---
  const wp = buildPath('C:\\app\\bin', winEnv, WIN);
  assert.ok(wp.includes(';'), 'win PATH uses ;');
  assert.ok(!wp.split(';')[0].includes(':\\Windows'), 'app bin dir comes FIRST');
  assert.strictEqual(wp.split(';')[0], 'C:\\app\\bin', 'managed bin dir wins');
  assert.ok(wp.endsWith('C:\\Windows\\system32'), 'existing PATH preserved at the end');
  assert.ok(!wp.includes('/opt/homebrew'), 'no homebrew on windows');

  const mp = buildPath('/app/bin', macEnv, MAC);
  assert.ok(mp.includes('/opt/homebrew/bin') && mp.includes('/Users/kp/.local/bin'), 'mac keeps the known tool dirs');
  assert.strictEqual(mp.split(':')[0], '/app/bin');
  assert.ok(mp.endsWith('/usr/bin:/bin'), 'existing PATH preserved');
  console.log('✅ buildPath: correct delimiter, app bin first, existing PATH kept, no cross-contamination.');

  // an empty inherited PATH must not leave a trailing separator (an empty PATH entry means
  // "current directory" on Windows — a real security footgun)
  const wpEmpty = buildPath('C:\\app\\bin', { USERPROFILE: 'C:\\Users\\kp' }, WIN);
  assert.ok(!wpEmpty.endsWith(';'), 'no trailing delimiter → no implicit CWD on PATH');
  assert.ok(!wpEmpty.includes(';;'), 'no empty PATH entries');
  console.log('✅ buildPath never emits an empty PATH entry (implicit-CWD footgun).');

  // --- yt-dlp asset per platform ---
  assert.strictEqual(ytdlpAsset(WIN), 'yt-dlp.exe');
  assert.strictEqual(ytdlpAsset(MAC), 'yt-dlp_macos');
  assert.strictEqual(ytdlpAsset(LIN), 'yt-dlp');
  console.log('✅ ytdlpAsset picks the right release binary per OS.');

  // --- reveal in file manager ---
  const rw = revealCmd('C:\\vids\\a.mp4', WIN);
  assert.strictEqual(rw.cmd, 'explorer.exe');
  assert.deepStrictEqual(rw.args, ['/select,C:\\vids\\a.mp4'], 'explorer takes /select,<path> as ONE arg');
  assert.strictEqual(rw.ignoreExit, true, 'explorer exits 1 on success — must be ignored');
  const rm = revealCmd('/Users/kp/a.mp4', MAC);
  assert.strictEqual(rm.cmd, 'open');
  assert.deepStrictEqual(rm.args, ['-R', '/Users/kp/a.mp4']);
  assert.strictEqual(revealCmd('/x/a.mp4', LIN).cmd, 'xdg-open');
  console.log('✅ revealCmd is argv-only (no shell) and flags explorer’s bogus exit code.');

  // --- which/where, argv form so a weird path can't inject ---
  assert.strictEqual(whichCmd('ffmpeg', WIN).cmd, 'where');
  assert.deepStrictEqual(whichCmd('ffmpeg', WIN).args, ['ffmpeg']);
  assert.strictEqual(whichCmd('ffmpeg', MAC).cmd, '/usr/bin/which');
  for (const p of [WIN, MAC]) {
    const c = whichCmd('a; rm -rf /', p);
    assert.ok(Array.isArray(c.args) && c.args.length === 1, 'argv, never a shell string');
  }
  console.log('✅ whichCmd replaces POSIX `command -v` and stays shell-free.');

  // --- binary candidate locations ---
  const wc = binCandidates('ffmpeg', winEnv, WIN);
  assert.ok(wc.every((c) => c.endsWith('.exe')), 'every windows candidate is a .exe');
  assert.ok(wc.some((c) => c.includes('scoop')) && wc.some((c) => c.includes('chocolatey')), 'covers scoop + chocolatey');
  assert.ok(!wc.some((c) => c.startsWith('/opt')), 'no posix paths leak into the windows list');
  const mc = binCandidates('ffmpeg', macEnv, MAC);
  assert.ok(mc.some((c) => c === '/opt/homebrew/bin/ffmpeg'), 'keeps the documented homebrew path');
  assert.ok(!mc.some((c) => c.endsWith('.exe')), 'no .exe on mac');
  assert.strictEqual(binCandidates('ffmpeg', {}, WIN).length >= 0, true, 'empty env does not throw');
  console.log('✅ binCandidates: per-platform install locations, no cross-contamination.');

  // --- whisper model search dirs ---
  const wm = whisperModelDirs(winEnv, WIN);
  assert.ok(!wm.some((d) => d.startsWith('/opt')), 'no homebrew dirs on windows');
  assert.ok(wm.some((d) => d.includes('AppData')), 'uses LOCALAPPDATA');
  const mm = whisperModelDirs(macEnv, MAC);
  assert.ok(mm.some((d) => d.includes('whisper.cpp/models') || d.includes(path.join('whisper.cpp', 'models'))), 'keeps the known mac model dir');
  // an explicit override always wins, on both platforms
  for (const [env, p] of [[{ ...winEnv, CLIPFORGE_MODELS: 'X' }, WIN], [{ ...macEnv, CLIPFORGE_MODELS: 'X' }, MAC]]) {
    assert.strictEqual(whisperModelDirs(env, p)[0], 'X', 'CLIPFORGE_MODELS takes priority');
  }
  console.log('✅ whisperModelDirs: per-platform dirs, explicit override wins.');

  // --- install hints must not tell a Windows user to run brew ---
  assert.ok(!installHint('ffmpeg', WIN).includes('brew'), 'never suggest brew on windows');
  assert.ok(installHint('ffmpeg', WIN).match(/winget|scoop/i), 'suggests a real windows installer');
  assert.ok(installHint('ffmpeg', MAC).includes('brew'), 'mac still says brew');
  console.log('✅ installHint gives platform-appropriate instructions.');

  // --- ffmpeg filtergraph paths (subtitles=/fontfile=) ---
  // These are the SILENT failures: the render succeeds but the subtitles never appear.
  const wf = filterPath('C:\\Users\\kp\\AppData\\Local\\Temp\\caps.ass', WIN);
  assert.ok(!wf.includes('\\U'), 'no raw backslash-letter left for ffmpeg to eat as an escape');
  assert.ok(wf.includes('C\\:'), 'drive colon escaped');
  assert.ok(wf.includes('/Users/kp/'), 'separators converted to forward slashes');
  assert.strictEqual(wf, 'C\\:/Users/kp/AppData/Local/Temp/caps.ass');
  const mf = filterPath('/Users/kp/a:b/caps.ass', MAC);
  assert.ok(mf.includes('\\:'), 'mac still escapes colons');
  assert.ok(!mf.includes('C\\:'), 'mac unaffected by the windows rule');
  assert.strictEqual(filterPath(null, WIN), null, 'null-safe');
  assert.ok(!filterPath("/a/o'brien.ass", MAC).includes("o'b"), 'single quote escaped');
  console.log('✅ filterPath: windows drive-colon + forward slashes, mac behaviour unchanged.');

  // --- concat demuxer list lines ---
  const wl = concatLine('C:\\Users\\kp\\Temp\\clip000.mp4', WIN);
  assert.ok(!wl.includes('\\'), 'NO backslashes survive — the demuxer would eat them as escapes');
  assert.strictEqual(wl, "file 'C:/Users/kp/Temp/clip000.mp4'");
  const ml = concatLine('/tmp/cf-seq/clip000.mp4', MAC);
  assert.strictEqual(ml, "file '/tmp/cf-seq/clip000.mp4'", 'mac line unchanged');
  assert.ok(concatLine("/tmp/o'brien.mp4", MAC).includes("'\\''"), 'single quote escaped for the demuxer');
  // a user folder with a space is extremely common on Windows and must survive quoting
  assert.strictEqual(concatLine('C:\\Users\\Kyle P\\v.mp4', WIN), "file 'C:/Users/Kyle P/v.mp4'");
  console.log('✅ concatLine: no backslashes reach the demuxer; spaces and quotes survive.');

  // --- hardware decode flags ---
  assert.deepStrictEqual(hwDecodeArgs(MAC, {}), ['-hwaccel', 'videotoolbox']);
  assert.ok(!hwDecodeArgs(WIN, {}).includes('videotoolbox'), 'never videotoolbox on windows');
  assert.deepStrictEqual(hwDecodeArgs(WIN, {}), ['-hwaccel', 'd3d11va']);
  assert.deepStrictEqual(hwDecodeArgs(MAC, { PEP_HWDECODE: 'off' }), [], 'kill switch still works');
  assert.deepStrictEqual(hwDecodeArgs(WIN, { PEP_HWDECODE: 'off' }), [], 'kill switch works on windows too');
  console.log('✅ hwDecodeArgs: per-platform accel, PEP_HWDECODE=off still disables.');

  // --- drawtext fonts ---
  const wfonts = fontCandidates(WIN, { WINDIR: 'C:\\Windows' });
  assert.ok(wfonts.length && wfonts.every((f) => f.includes('Windows')), 'windows fonts only');
  assert.ok(!wfonts.some((f) => f.startsWith('/System')), 'no macOS font paths on windows');
  assert.ok(wfonts.some((f) => /arialbd/i.test(f)), 'prefers a bold face first');
  const mfonts = fontCandidates(MAC, {});
  assert.ok(mfonts.some((f) => f.startsWith('/System/Library/Fonts')), 'keeps the macOS list');
  assert.ok(!mfonts.some((f) => f.includes('Windows')), 'no windows paths on mac');
  console.log('✅ fontCandidates: real font files per platform (drawtext needs an explicit one).');

  // --- HOST INDEPENDENCE ---
  // These must hold whether this suite runs on macOS, Linux or a Windows CI runner. Using the
  // host's path.join produced mixed separators (C:\Users\kp/scoop/shims) and made the mac-branch
  // assertions fail on windows-latest — a green Mac and a red CI for the same correct code.
  for (const d of toolDirs('C:\\app\\bin', winEnv, WIN)) {
    assert.ok(!d.includes('/'), `windows tool dir must have no forward slashes: ${d}`);
  }
  for (const d of toolDirs('/app/bin', macEnv, MAC)) {
    assert.ok(!d.includes('\\'), `posix tool dir must have no backslashes: ${d}`);
  }
  for (const c of binCandidates('ffmpeg', winEnv, WIN)) {
    assert.ok(!c.includes('/'), `windows candidate must be pure win32: ${c}`);
  }
  for (const c of binCandidates('ffmpeg', macEnv, MAC)) {
    assert.ok(!c.includes('\\'), `posix candidate must be pure posix: ${c}`);
  }
  assert.ok(!whisperModelDirs(winEnv, WIN).some((d) => d.includes('/')), 'win model dirs are pure win32');
  assert.ok(!whisperModelDirs(macEnv, MAC).some((d) => d.includes('\\')), 'posix model dirs are pure posix');
  assert.strictEqual(expandTilde('~/models', winEnv, WIN), 'C:\\Users\\kp\\models', 'win tilde uses backslashes');
  assert.strictEqual(expandTilde('~/models', macEnv, MAC), '/Users/kp/models', 'posix tilde uses forward slashes');
  console.log('✅ path output depends on the TARGET platform, never on the host running the tests.');

  // --- isWin ---
  assert.ok(isWin(WIN) && !isWin(MAC) && !isWin(LIN));

  console.log('🚀 ALL CROSS-PLATFORM TESTS PASSED.');
}

run();
