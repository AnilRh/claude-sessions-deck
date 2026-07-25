#!/usr/bin/env node
// CLI wrapper around the plugin's shared hook module (single source of truth in
// plugin/hooks.js). Installs the Claude Sessions hooks into ~/.claude/settings.json,
// merge-safe (backup first, only our marker hooks touched, others preserved).
//
// For a second machine feeding the deck over a reverse SSH tunnel, set:
//   CLAUDE_SESSIONS_HOST=127.0.0.1 (the tunnel's local end)
//   CLAUDE_SESSIONS_PORT=<tunnel local port>
//   CLAUDE_SESSIONS_ORIGIN=<short label identifying this machine>
// Defaults reproduce the local single-machine install.

import { installHooks, MARKER } from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/hooks.js';

const host = process.env.CLAUDE_SESSIONS_HOST || '127.0.0.1';
const port = process.env.CLAUDE_SESSIONS_PORT || '9210';
const origin = process.env.CLAUDE_SESSIONS_ORIGIN || '';
if (origin && !/^[\w-]{1,32}$/.test(origin)) {
  console.error(`error: CLAUDE_SESSIONS_ORIGIN '${origin}' must be 1-32 chars of [A-Za-z0-9_-]`);
  process.exit(1);
}

try {
  const r = installHooks({ host, port, origin });
  if (r.backup) console.log(`backup written: ${r.backup}`);
  const q = origin ? `?origin=${origin}` : '';
  console.log(`installed ${r.installed} hooks -> http://${host}:${port}${MARKER}${q}`);
  console.log('note: running Claude Code sessions pick this up on their next session start');
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
