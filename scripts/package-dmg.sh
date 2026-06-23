#!/bin/bash
# Build ClipForge.app and package it into build/ClipForge.dmg.
# Installer-style launcher: the 141 MB speech model and Homebrew deps (ffmpeg-full,
# whisper-cpp, yt-dlp) are set up on first run, not bundled.
#
# Gatekeeper note: the app is ad-hoc code-signed and NEVER modifies its own bundle at
# runtime. The launcher is written fresh into ~/Library/Application Support at launch, so
# it carries no "quarantine" flag and never triggers a second Gatekeeper prompt. Without
# Apple notarization (paid Developer ID), the FIRST open of a downloaded copy still needs
# a one-time right-click -> Open.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/ClipForge.app/Contents"
VERSION="${1:-0.2.1}"

rm -rf build/ClipForge.app build/dmg build/AppIcon.iconset
mkdir -p "$APP/MacOS" "$APP/Resources"

cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClipForge</string>
  <key>CFBundleDisplayName</key><string>ClipForge</string>
  <key>CFBundleIdentifier</key><string>com.kpscriptz.clipforge</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>ClipForge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Bundle the JS app (model/renders excluded; node_modules included).
rsync -a ./server.js ./lib ./public ./package.json ./bin "$APP/Resources/app/"
[ -d node_modules ] && rsync -a ./node_modules "$APP/Resources/app/"

# Entry point: sync app to a writable home, materialize the launcher fresh (no quarantine),
# and run it in a visible Terminal. Touches NOTHING inside the signed bundle.
cat > "$APP/MacOS/ClipForge" <<'ENTRY'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA="$HOME/Library/Application Support/ClipForge"
mkdir -p "$DATA"
/usr/bin/rsync -a --exclude 'renders/' "$RES/app/" "$DATA/app/" 2>/dev/null
cat "$RES/launcher.sh" > "$DATA/run.sh"
xattr -d com.apple.quarantine "$DATA/run.sh" 2>/dev/null || true
chmod +x "$DATA/run.sh"
osascript -e 'tell application "Terminal" to activate' \
          -e "tell application \"Terminal\" to do script \"bash '$DATA/run.sh'\""
ENTRY

# The launcher template (run from Application Support, never executed in place).
cat > "$APP/Resources/launcher.sh" <<'LAUNCH'
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DATA="$HOME/Library/Application Support/ClipForge"
APP="$DATA/app"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
printf '\n  \033[1;33m⚡ ClipForge\033[0m — local gameplay editor\n  ────────────────────────────────────\n\n'
NODE=""; for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do [ -n "$c" ] && [ -x "$c" ] && NODE="$c" && break; done
if [ -z "$NODE" ]; then echo "  ✗ Node.js required → opening download page"; open "https://nodejs.org/en/download"; read -r -p "  Install Node, re-open ClipForge. Return to close." _; exit 1; fi
echo "  ✓ Node $($NODE --version)"
BREW="$(command -v brew || true)"
need_brew() { [ -z "$BREW" ] && { echo "  ✗ Homebrew needed → https://brew.sh"; open "https://brew.sh"; read -r -p "  Install brew, re-open ClipForge. Return." _; exit 1; }; }
if [ ! -x /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg ] && ! command -v ffmpeg >/dev/null 2>&1; then need_brew; echo "  • Installing FFmpeg (caption burn-in)…"; "$BREW" install ffmpeg-full; else echo "  ✓ FFmpeg"; fi
if ! command -v whisper-cli >/dev/null 2>&1; then need_brew; echo "  • Installing whisper.cpp…"; "$BREW" install whisper-cpp; else echo "  ✓ whisper.cpp"; fi
if ! command -v yt-dlp >/dev/null 2>&1; then need_brew; echo "  • Installing yt-dlp (VOD downloader)…"; "$BREW" install yt-dlp; else echo "  ✓ yt-dlp"; fi
cd "$APP" || { echo "  ✗ app missing at $APP"; read -r -p "  Return." _; exit 1; }
if [ ! -f "models/ggml-base.en.bin" ]; then echo "  • Downloading speech model (~141 MB, one time)…"; mkdir -p models; curl -L --fail -o "models/ggml-base.en.bin" "$MODEL_URL" || { echo "  ✗ model download failed"; read -r -p "  Return." _; exit 1; }; else echo "  ✓ Speech model"; fi
echo; echo "  ▶ Starting ClipForge at http://localhost:4178"; echo "    (keep this window open; Ctrl-C to quit)"; echo
( for i in $(seq 1 60); do curl -s http://localhost:4178/api/status >/dev/null 2>&1 && break; sleep 0.5; done; open "http://localhost:4178" ) &
exec "$NODE" server.js
LAUNCH
chmod +x "$APP/MacOS/ClipForge"

# Icon (rendered with ffmpeg if available).
FF="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"; [ -x "$FF" ] || FF="$(command -v ffmpeg || true)"
FONT=""; for f in "/System/Library/Fonts/Supplemental/Arial Bold.ttf" "/System/Library/Fonts/Helvetica.ttc"; do [ -f "$f" ] && FONT="$f" && break; done
if [ -n "$FF" ] && [ -n "$FONT" ]; then
  "$FF" -y -f lavfi -i "color=c=0x0b0f17:s=1024x1024" -vf "drawbox=x=64:y=64:w=896:h=896:color=0x161b26:t=fill,drawtext=fontfile='$FONT':text='CF':fontcolor=0xFFC83D:fontsize=520:x=(w-text_w)/2:y=(h-text_h)/2-40,drawtext=fontfile='$FONT':text='ClipForge':fontcolor=0x8aa0b6:fontsize=84:x=(w-text_w)/2:y=h-220" -frames:v 1 build/icon_1024.png >/dev/null 2>&1 || true
  if [ -f build/icon_1024.png ]; then
    mkdir -p build/AppIcon.iconset
    for s in 16 32 64 128 256 512; do sips -z $s $s build/icon_1024.png --out "build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null 2>&1; d=$((s*2)); sips -z $d $d build/icon_1024.png --out "build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1; done
    sips -z 1024 1024 build/icon_1024.png --out "build/AppIcon.iconset/icon_512x512@2x.png" >/dev/null 2>&1
    iconutil -c icns build/AppIcon.iconset -o "$APP/Resources/AppIcon.icns" || true
  fi
fi

# Ad-hoc code-sign LAST (after all bundle contents exist). Keeps the bundle's signature
# valid because nothing inside it changes at runtime.
codesign --force --deep --sign - build/ClipForge.app 2>/dev/null && echo "✓ ad-hoc signed" || echo "(codesign skipped)"

# Stage + build DMG.
STAGE=build/dmg; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R build/ClipForge.app "$STAGE/"; ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
ClipForge — local, free AI gameplay editor

1. Drag ClipForge.app onto the Applications folder.
2. First launch only: RIGHT-CLICK ClipForge -> Open -> Open.
   (It isn't Apple-notarized, so a plain double-click is blocked the first time.)
   If macOS still blocks it, open Terminal and run:
       xattr -dr com.apple.quarantine /Applications/ClipForge.app
   then double-click normally.
3. A Terminal window sets up FFmpeg + whisper + yt-dlp (via Homebrew) and a
   ~141 MB model, then opens http://localhost:4178. Keep it open; Ctrl-C quits.

Requirements: macOS 12+, Node.js (nodejs.org), Homebrew (brew.sh).
Nothing is uploaded — footage is read in place, all processing is local.
TXT
touch build/ClipForge.app
rm -f build/ClipForge.dmg
hdiutil create -volname "ClipForge" -srcfolder "$STAGE" -ov -format UDZO build/ClipForge.dmg >/dev/null
echo "✓ build/ClipForge.dmg ($(ls -lh build/ClipForge.dmg | awk '{print $5}'))"
