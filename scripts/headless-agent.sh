#!/usr/bin/env bash
# Install (or remove) a launchd agent that runs the plugin HEADLESS at login —
# for people using the web board without a deck / without Ulanzi Studio.
#
#   npm run headless:agent                     # install / update + start
#   ACTION=uninstall npm run headless:agent    # stop + remove
#
# The agent runs plugin/app.js --headless from THIS checkout, so config.json /
# sessions.json live in the repo's plugin folder (gitignored). Logs go to
# ~/Library/Logs/claude-sessions-headless.log. Don't install this if you use
# Ulanzi Studio — the Studio-spawned plugin and the agent would fight over the
# hook port.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/com.ulanzi.claudesessions.ulanziPlugin"
APP="$PLUGIN_DIR/plugin/app.js"
LABEL="com.claudesessions.headless"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-sessions-headless.log"
ACTION="${ACTION:-install}"

if [ "$ACTION" = "uninstall" ]; then
  # Boot out by label (not plist path) so it works even if the plist was
  # already deleted while the service is still loaded.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL (plist deleted; process stopped)"
  exit 0
fi

[ -f "$APP" ] || { echo "error: $APP not found"; exit 1; }
NODE_BIN="$(command -v node)" || { echo "error: node not found on PATH"; exit 1; }

# Warn (don't block) if Ulanzi Studio is around — mixed setups fight over the port.
if pgrep -x "UlanziDeck" >/dev/null 2>&1 || pgrep -x "Ulanzi Studio" >/dev/null 2>&1; then
  echo "warning: Ulanzi Studio appears to be running. Headless mode is meant for"
  echo "         setups WITHOUT Studio — both would contend for the hook port."
fi

# Deps must exist before launchd runs the app (no npm in the agent).
if [ ! -d "$PLUGIN_DIR/node_modules/ws" ]; then
  (cd "$PLUGIN_DIR" && npm install --omit=dev --silent)
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Paths are interpolated into XML — escape the XML metacharacters so a
# checkout path containing & or < can't produce an invalid plist.
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
NODE_BIN="$(xml_escape "$NODE_BIN")"
APP_X="$(xml_escape "$APP")"
LOG_X="$(xml_escape "$LOG")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_X</string>
    <string>--headless</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_X</string>
  <key>StandardErrorPath</key><string>$LOG_X</string>
</dict>
</plist>
PLIST

# Reload cleanly whether or not a previous version was running. bootstrap right
# after bootout can race in launchd; retry briefly before giving up.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in 1 2 3; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [ "$i" = 3 ] && { echo "error: launchctl bootstrap failed"; exit 1; }
  sleep 1
done
echo "installed + started $LABEL"
echo "  logs:  $LOG"
PORT="$(node -e 'try{console.log(require(process.argv[1]).httpPort||9210)}catch{console.log(9210)}' "$PLUGIN_DIR/config.json" 2>/dev/null || echo 9210)"
echo "  board: http://127.0.0.1:$PORT/board"
