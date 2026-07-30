// ESM view of the platform helpers.
//
// The IMPLEMENTATION lives in ./platform.cjs, not here. electron/main.cjs is CommonJS and needs
// these same decisions at module scope (its `which()` runs before anything async), while the
// server and lib/ are ESM — so the logic is written once in CJS and re-exported here rather than
// maintained twice. Two copies of "which delimiter does PATH use" is exactly the kind of drift
// that produces a Windows-only bug nobody can reproduce on a Mac.
//
// See platform.cjs for the documented implementations, and test/platform.test.js for the
// win32-branch assertions that run on any host.
import mod from './platform.cjs';

export const {
  isWin, binName, pathDelim, homeDir, expandTilde, toolDirs, buildPath,
  ytdlpAsset, revealCmd, whichCmd, binCandidates, whisperModelDirs, installHint,
  filterPath, concatLine, hwDecodeArgs, fontCandidates,
} = mod;
