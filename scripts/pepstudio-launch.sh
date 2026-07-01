#!/bin/sh
# PepStudio launcher for Xcode (External Build System target).
# Pressing Build (⌘B) in Xcode runs this script, which boots the real Node/Express +
# Electron app from source — DETACHED, so Xcode's build returns immediately while
# PepStudio keeps running. This is a launcher wrapper, NOT a native Swift port: all the
# existing Electron/vanilla-JS architecture is launched as-is.
set -e

# Xcode's build shell has a minimal PATH. Add where node/npm live (/usr/local/bin) and
# where the media binaries live (Homebrew), so spawned ffmpeg/whisper/yt-dlp resolve too.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Project root = one level up from this script, regardless of the caller's cwd.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG="${TMPDIR:-/tmp}/pepstudio-launch.log"

# First launch: install Electron + deps if missing.
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/electron ]; then
  echo "PepStudio: installing dependencies (first launch)…"
  npm install
fi

# Dry run (set PEPSTUDIO_DRYRUN=1) verifies wiring without actually launching the GUI.
if [ -n "$PEPSTUDIO_DRYRUN" ]; then
  echo "PepStudio DRYRUN ok: would run 'npm run electron' in $ROOT (node=$(command -v node))"
  exit 0
fi

# Launch detached (nohup + &) so the Xcode build finishes immediately and the app survives.
nohup npm run electron >"$LOG" 2>&1 &
echo "PepStudio launching (pid $!). Logs: $LOG"
exit 0
