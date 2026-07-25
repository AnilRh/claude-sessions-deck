#!/usr/bin/env bash
# Installs (or updates) the plugin into Ulanzi Studio on macOS and restarts
# the app. Preserves an existing config.json (user settings) and sessions.json
# (runtime session snapshot, so the deck repaints instead of blanking after the
# reinstall's restart) across reinstalls.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="com.ulanzi.claudesessions.ulanziPlugin"
SRC="$REPO_DIR/$PLUGIN_NAME"
PLUGINS_DIR="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins"
DEST="$PLUGINS_DIR/$PLUGIN_NAME"
# Backups live OUTSIDE the scanned Plugins/ dir. A .bak copy left inside
# Plugins/ is a second folder with the SAME plugin UUID, and enough of them
# accumulating wedges Studio (it once stopped driving the device entirely).
BACKUP_DIR="$HOME/Library/Application Support/Ulanzi/UlanziDeck/_claude-sessions-backups"
BACKUP_KEEP=3
APP="/Applications/Ulanzi Studio.app"

[ -d "$SRC" ] || { echo "error: $SRC not found"; exit 1; }
[ -d "$APP" ] || { echo "error: Ulanzi Studio not found at $APP"; exit 1; }
mkdir -p "$PLUGINS_DIR"

# keep user config + runtime session snapshot across reinstalls
declare -a PRESERVE=(config.json sessions.json)
declare -a PRESERVE_TMP=()
for f in "${PRESERVE[@]}"; do
  if [ -f "$DEST/$f" ]; then
    tmp="$(mktemp)"
    cp "$DEST/$f" "$tmp"
    PRESERVE_TMP+=("$tmp:$f")
  fi
done

if [ -d "$DEST" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/$PLUGIN_NAME.bak.$(date +%Y%m%d%H%M%S)"
  echo "existing install moved to: $BACKUP"
  mv "$DEST" "$BACKUP"
  # Keep only the most recent few; never let backups pile up.
  ls -dt "$BACKUP_DIR/$PLUGIN_NAME.bak."* 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
    rm -rf "$old"
  done
fi

cp -R "$SRC" "$DEST"
for entry in "${PRESERVE_TMP[@]}"; do
  mv "${entry%%:*}" "$DEST/${entry##*:}"
done

# Ulanzi Studio bundles its own Node; deps must be installed inside the plugin
cd "$DEST"
if [ ! -d node_modules/ws ]; then
  npm install --omit=dev --silent
fi

echo "restarting Ulanzi Studio..."
pkill -x "UlanziDeck" 2>/dev/null || pkill -x "Ulanzi Studio" 2>/dev/null || true
sleep 2
# Killing the Studio app does not reliably kill its already-spawned plugin
# child processes (they become orphans, not part of a process group Studio
# cleans up) - observed multiple stale generations accumulating across
# reinstalls, all holding a WS connection to whichever Studio instance is
# current. $DEST is a fixed path across reinstalls, so this matches every
# generation regardless of when it was spawned.
pkill -f "$DEST/plugin/app.js" 2>/dev/null || true
sleep 1
if pgrep -f "$DEST/plugin/app.js" >/dev/null 2>&1; then
  pkill -9 -f "$DEST/plugin/app.js" 2>/dev/null || true
  sleep 1
fi
open "$APP"

# Poll for the plugin to come up — Studio can take well over 5s to spawn it,
# so a single early check gives false negatives. `|| true` on the substitution
# keeps `set -e`/`pipefail` from aborting when pgrep finds nothing (exit 1);
# wc still emits 0 in that case.
COUNT=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do  # up to ~12s
  sleep 1
  COUNT=$(pgrep -f "$DEST/plugin/app.js" 2>/dev/null | wc -l | tr -d ' ' || true)
  [ "$COUNT" = "1" ] && break
done
if [ "$COUNT" = "1" ]; then
  echo "plugin service running (1 instance)"
elif [ "$COUNT" = "0" ]; then
  echo "warning: plugin service did not start within ~12s - check Ulanzi Studio (--log for details)"
else
  echo "warning: $COUNT plugin instances running - expected 1 (run: pkill -f '$DEST/plugin/app.js' then relaunch Studio)"
fi

echo "installed: $DEST"
echo "next: drag 'Claude Sessions > Session Slot' onto 5-8 keys, then run: npm run hooks:install"
