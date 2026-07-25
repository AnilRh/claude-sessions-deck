#!/usr/bin/env bash
# Builds a distributable plugin archive (deps bundled, machine-specific runtime
# files excluded) for sharing with others or marketplace submission.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="com.ulanzi.claudesessions.ulanziPlugin"
SRC="$REPO_DIR/$PLUGIN"
DIST="$REPO_DIR/dist"

[ -d "$SRC" ] || { echo "error: $SRC not found"; exit 1; }

# Ulanzi Studio bundles its own Node but not the plugin's deps — make sure they
# are present in the folder so the archive is self-contained.
if [ ! -d "$SRC/node_modules/ws" ]; then
  echo "installing runtime deps into the plugin folder…"
  ( cd "$SRC" && npm install --omit=dev --silent )
fi

mkdir -p "$DIST"
OUT="$DIST/$PLUGIN.zip"
PKG="$DIST/claude-sessions.ulanziPlugin"
rm -f "$OUT" "$PKG"

# Exclude runtime/local files a recipient must not inherit.
( cd "$REPO_DIR" && zip -r -q "$OUT" "$PLUGIN" \
    -x "$PLUGIN/config.json" \
    -x "$PLUGIN/sessions.json" \
    -x "*/.DS_Store" \
    -x "*.bak" -x "*.bak.*" )

# Same archive under the .ulanziPlugin extension, for Studio's double-click
# import if the installed version supports it (it's a zip of the plugin folder,
# the Stream-Deck-style convention). The .zip is the always-works fallback.
cp "$OUT" "$PKG"

echo "packaged:"
echo "  $PKG   ($(du -h "$PKG" | cut -f1))  — try double-clicking to install"
echo "  $OUT   — fallback: unzip into the plugins folder"
echo ""
echo "Install (macOS), whichever works in your Studio build:"
echo "  A) double-click claude-sessions.ulanziPlugin, or"
echo "  B) unzip the .zip into"
echo "     ~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/"
echo "  then restart Ulanzi Studio."
echo "Recipients also need the Claude Code hooks (see README → Install)."
