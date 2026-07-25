#!/usr/bin/env bash
# Install / update (or remove) the Claude Sessions hooks on a REMOTE machine
# that feeds the deck over the reverse SSH tunnel. Run on the LAPTOP.
#
#   ORIGIN=mini ./scripts/remote-hooks.sh                    # install / update
#   ORIGIN=mini ACTION=uninstall ./scripts/remote-hooks.sh   # remove
#
# SSH_TARGET defaults to the sshTarget configured for ORIGIN in the installed
# plugin's config.json. SERVER_PORT is the tunnel's local port on that machine
# (default 9210 — must match the tunnel's SERVER_PORT). Uses the same shared
# hook module as everywhere else (bundled into a single self-contained file for
# the push), so the remote gets exactly the same event list and behavior.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_JS="$REPO_DIR/com.ulanzi.claudesessions.ulanziPlugin/plugin/hooks.js"
CONFIG="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.claudesessions.ulanziPlugin/config.json"

: "${ORIGIN:?set ORIGIN=<label> (matches the tunnel LABEL and the config server key)}"
[[ "$ORIGIN" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "error: ORIGIN must be 1-32 chars of [A-Za-z0-9_-]"; exit 1; }
[ -f "$HOOKS_JS" ] || { echo "error: $HOOKS_JS not found"; exit 1; }
ACTION="${ACTION:-install}"
SERVER_PORT="${SERVER_PORT:-9210}"
[[ "$SERVER_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "error: SERVER_PORT must be numeric"; exit 1; }

# Resolve the SSH target from the plugin config if not given explicitly.
SSH_TARGET="${SSH_TARGET:-}"
if [ -z "$SSH_TARGET" ] && [ -f "$CONFIG" ]; then
  SSH_TARGET="$(CONFIG="$CONFIG" ORIGIN="$ORIGIN" node -e 'try{const c=require(process.env.CONFIG);process.stdout.write((c.servers&&c.servers[process.env.ORIGIN]&&c.servers[process.env.ORIGIN].sshTarget)||"")}catch{}' 2>/dev/null || true)"
fi
[ -n "$SSH_TARGET" ] || { echo "error: no SSH_TARGET given and none configured for origin '$ORIGIN'"; exit 1; }

echo "target=$SSH_TARGET  origin=$ORIGIN  port=$SERVER_PORT  action=$ACTION"

# 1. Reachable over SSH (non-interactive)?
ssh -o BatchMode=yes -o ConnectTimeout=6 "$SSH_TARGET" true 2>/dev/null \
  || { echo "error: cannot SSH to $SSH_TARGET non-interactively — need key auth (try: ssh-copy-id $SSH_TARGET)"; exit 1; }

# 2. Find node on the remote's login-shell PATH and use its ABSOLUTE path, so
#    the non-interactive run doesn't depend on PATH (the gotcha that bites bare
#    `ssh host node …`).
REMOTE_NODE="$(ssh "$SSH_TARGET" 'zsh -lic "command -v node" 2>/dev/null || bash -lc "command -v node" 2>/dev/null || command -v node' | tail -1 | tr -d '\r')"
[ -n "$REMOTE_NODE" ] || { echo "error: node not found on $SSH_TARGET — install Node or put it on your login-shell PATH"; exit 1; }
echo "remote node: $REMOTE_NODE"

# 3. Bundle the shared module + a tiny CLI epilogue into one self-contained file.
TMP="$(mktemp -t cs-hooks).mjs"
trap 'rm -f "$TMP"' EXIT
cat "$HOOKS_JS" > "$TMP"
cat >> "$TMP" <<'EPILOGUE'

// --- CLI epilogue (appended by remote-hooks.sh) ---
const _a = process.env.CS_ACTION || 'install';
const _h = process.env.CLAUDE_SESSIONS_HOST || '127.0.0.1';
const _p = process.env.CLAUDE_SESSIONS_PORT || '9210';
const _o = process.env.CLAUDE_SESSIONS_ORIGIN || '';
if (_a === 'uninstall') {
  const r = uninstallHooks();
  console.log(`removed ${r.removed} hook(s)`);
} else {
  const r = installHooks({ host: _h, port: _p, origin: _o });
  console.log(`installed ${r.installed} hooks -> http://${_h}:${_p}/claude-sessions-event` + (_o ? `?origin=${_o}` : ''));
}
EPILOGUE

# 4. Push, run with the absolute node path (env vars set for that command), clean up.
REMOTE_TMP="/tmp/claude-sessions-hooks-install.mjs"
scp -q "$TMP" "$SSH_TARGET:$REMOTE_TMP"
ssh "$SSH_TARGET" "CS_ACTION='$ACTION' CLAUDE_SESSIONS_HOST=127.0.0.1 CLAUDE_SESSIONS_PORT='$SERVER_PORT' CLAUDE_SESSIONS_ORIGIN='$ORIGIN' '$REMOTE_NODE' '$REMOTE_TMP'"
ssh "$SSH_TARGET" "rm -f '$REMOTE_TMP'"

# 5. Verify.
CNT="$(ssh "$SSH_TARGET" 'grep -c claude-sessions-event ~/.claude/settings.json 2>/dev/null' | tr -d '\r' || true)"
echo "remote now has ${CNT:-0} claude-sessions hook entr(y/ies)"
echo "start a new Claude Code session on '$ORIGIN' for it to take effect."
