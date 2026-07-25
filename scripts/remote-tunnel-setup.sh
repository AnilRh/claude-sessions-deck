#!/usr/bin/env bash
# Sets up a resilient reverse SSH tunnel (macOS launchd agent) so a second
# machine's Claude Code hooks can reach this laptop's deck plugin, which listens
# only on 127.0.0.1:9210.
#
# The tunnel maps  <server>:localhost:$SERVER_PORT  ->  <laptop>:localhost:$LOCAL_PORT
# so the server's hooks POST to localhost:$SERVER_PORT and it arrives at the
# plugin here. launchd (KeepAlive) restarts ssh whenever it drops — including
# every time you undock and redock — so nothing off-machine is ever exposed.
#
# Run on the LAPTOP (it initiates the outbound SSH). Configure via env vars:
#   SSH_TARGET      required   user@host or an ~/.ssh/config Host alias
#   LABEL           required   short origin label for this server (matches the
#                              CLAUDE_SESSIONS_ORIGIN you install hooks with);
#                              [A-Za-z0-9_-], also names the launch agent
#   SERVER_PORT     default 9210   loopback port opened ON THE SERVER
#   LOCAL_PORT      default 9210   the plugin's port on this laptop
#
# Example:
#   SSH_TARGET=user@host.local LABEL=myserver ./scripts/remote-tunnel-setup.sh
#
# Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.ulanzi.claudesessions.tunnel.<LABEL>.plist
#   rm ~/Library/LaunchAgents/com.ulanzi.claudesessions.tunnel.<LABEL>.plist

set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
: "${LABEL:?set LABEL=<short origin label>}"
SERVER_PORT="${SERVER_PORT:-9210}"
LOCAL_PORT="${LOCAL_PORT:-9210}"

if ! [[ "$LABEL" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
  echo "error: LABEL must be 1-32 chars of [A-Za-z0-9_-]" >&2
  exit 1
fi

SSH_BIN="$(command -v ssh)"
PLIST_LABEL="com.ulanzi.claudesessions.tunnel.$LABEL"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/claude-sessions-tunnel"
mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

# Unload a previous generation before rewriting.
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SSH_BIN</string>
    <string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-R</string><string>${SERVER_PORT}:localhost:${LOCAL_PORT}</string>
    <string>$SSH_TARGET</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$LABEL.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$LABEL.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl load "$PLIST"
echo "tunnel agent installed: $PLIST_LABEL"
echo "  $SSH_TARGET : server localhost:$SERVER_PORT -> laptop localhost:$LOCAL_PORT"
echo "  logs: $LOG_DIR/$LABEL.{out,err}.log"
echo ""
echo "next, ON THE SERVER install hooks pointing at the tunnel:"
echo "  CLAUDE_SESSIONS_HOST=127.0.0.1 CLAUDE_SESSIONS_PORT=$SERVER_PORT CLAUDE_SESSIONS_ORIGIN=$LABEL \\"
echo "    node scripts/hooks-install.js"
echo "then add to this laptop's plugin config.json:"
echo "  \"servers\": { \"$LABEL\": { \"sshTarget\": \"$SSH_TARGET\" } }"