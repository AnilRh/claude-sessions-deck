#!/usr/bin/env bash
# Simulates Claude Code hook traffic against the plugin's local HTTP server so
# the whole state machine + rendering pipeline can be exercised with zero real
# Claude Code sessions. Watch the deck (or mock Studio log) while it runs.
#
# Usage:
#   scripts/fake-events.sh [scenario] [port]
#   scenarios: lifecycle | permission | multi | restart | end | all (default)

set -u
PORT="${2:-${CLAUDE_SESSIONS_PORT:-9210}}"
URL="http://127.0.0.1:${PORT}/claude-sessions-event"
SCENARIO="${1:-all}"

emit() { # emit <event> <session_id> <cwd> [extra-json]
  local event="$1" session="$2" cwd="$3" extra="${4:-}"
  local body="{\"hook_event_name\":\"${event}\",\"session_id\":\"${session}\",\"cwd\":\"${cwd}\",\"transcript_path\":\"/tmp/fake.jsonl\"${extra:+,${extra}}}"
  curl -s -o /dev/null --max-time 2 -X POST -H 'Content-Type: application/json' -d "$body" "$URL" \
    || echo "  !! server not reachable on port ${PORT}"
  echo "  -> ${event} ${session} (${cwd##*/}) ${extra}"
}

pause() { sleep "${FAKE_EVENTS_DELAY:-2}"; }

lifecycle() {
  echo "== scenario: full lifecycle (prompt -> tools -> stop -> [press green key to ack])"
  emit UserPromptSubmit sess-life $HOME/dev/web-app '"prompt":"do the thing"'
  pause
  emit PreToolUse sess-life $HOME/dev/web-app '"tool_name":"Read"'
  pause
  emit PostToolUse sess-life $HOME/dev/web-app '"tool_name":"Read"'
  pause
  emit PreToolUse sess-life $HOME/dev/web-app '"tool_name":"Edit"'
  pause
  emit PostToolUse sess-life $HOME/dev/web-app '"tool_name":"Edit"'
  pause
  emit Stop sess-life $HOME/dev/web-app '"stop_hook_active":false'
  echo "  key should now be GREEN. Press it on the deck to acknowledge -> idle."
}

permission() {
  echo "== scenario: permission flow incl. the resume gap (gotcha #1)"
  emit UserPromptSubmit sess-perm $HOME/dev/api-server '"prompt":"risky change"'
  pause
  emit PreToolUse sess-perm $HOME/dev/api-server '"tool_name":"Bash"'
  pause
  emit PermissionRequest sess-perm $HOME/dev/api-server '"tool_name":"Bash"'
  echo "  key should be AMBER (waiting)"
  pause
  emit Notification sess-perm $HOME/dev/api-server '"message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"'
  pause
  pause
  echo "  simulating approval: next tool event must snap it back to TERRACOTTA"
  emit PostToolUse sess-perm $HOME/dev/api-server '"tool_name":"Bash"'
  pause
  emit Stop sess-perm $HOME/dev/api-server '"stop_hook_active":false'
  echo "  key should now be GREEN"
}

multi() {
  echo "== scenario: three concurrent sessions on three keys"
  emit UserPromptSubmit sess-a $HOME/dev/web-app
  emit UserPromptSubmit sess-b $HOME/dev/worker
  emit UserPromptSubmit sess-c $HOME/dev/home-automation
  pause
  emit PermissionRequest sess-b $HOME/dev/worker '"tool_name":"Bash"'
  pause
  emit Stop sess-c $HOME/dev/home-automation '"stop_hook_active":false'
  echo "  expect: key1 terracotta (web-app), key2 amber (worker), key3 green (home-automation)"
}

restart() {
  echo "== scenario: unknown session mid-stream (plugin-restart resilience)"
  echo "  (kill/relaunch the plugin service first if testing for real)"
  emit PostToolUse sess-orphan $HOME/dev/tickets-mcp '"tool_name":"Grep"'
  echo "  expect: a key lights up TERRACOTTA immediately - state inferred from event type"
  pause
  emit PermissionRequest sess-orphan2 $HOME/dev/db-mcp '"tool_name":"Write"'
  echo "  expect: second key lights AMBER for a session never seen before"
}

end() {
  echo "== scenario: SessionEnd keeps the tile (done), doesn't free the slot"
  emit UserPromptSubmit sess-end $HOME/dev/scratch
  pause
  emit Stop sess-end $HOME/dev/scratch '"stop_hook_active":false'
  pause
  emit SessionEnd sess-end $HOME/dev/scratch '"reason":"clear"'
  echo "  expect: the key goes GREEN/done and STAYS (SessionEnd no longer clears"
  echo "          the slot; long-press to remove, or it prunes after stale timeout)"
  echo "  stale-prune test: set 'Stale session timeout' to 1 min in the PI,"
  echo "  run 'multi', wait ~90s, and watch all three keys empty out."
}

case "$SCENARIO" in
  lifecycle) lifecycle ;;
  permission) permission ;;
  multi) multi ;;
  restart) restart ;;
  end) end ;;
  all)
    lifecycle; echo; sleep 3
    permission; echo; sleep 3
    multi; echo; sleep 3
    restart; echo; sleep 3
    end
    ;;
  *) echo "unknown scenario: $SCENARIO (use lifecycle|permission|multi|restart|end|all)"; exit 1 ;;
esac
