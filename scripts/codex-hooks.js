#!/usr/bin/env node
// Install / remove the Claude Sessions hooks for OpenAI Codex (CLI, IDE
// extension, and the ChatGPT desktop app's Codex mode). Writes
// ~/.codex/hooks.json (or $CODEX_HOME/hooks.json) using the same merge-safe
// installer as the Claude Code hooks: backup first, only our marker hooks
// touched, anything else in the file preserved.
//
//   npm run codex-hooks:install     # install / update
//   npm run codex-hooks:uninstall   # remove
//
// Codex won't run new or changed hooks until you trust them: open Codex and run
// /hooks to review and trust them (once per install/update).

import {
  installCodexHooks,
  uninstallHooks,
  codexHooksPath,
  MARKER,
} from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/hooks.js';

const action = process.argv[2] === 'uninstall' ? 'uninstall' : 'install';
const port = process.env.CLAUDE_SESSIONS_PORT || '9210';
const file = codexHooksPath();

try {
  if (action === 'uninstall') {
    const r = uninstallHooks({ settingsPath: file });
    if (r.backup) console.log(`backup written: ${r.backup}`);
    console.log(`removed ${r.removed} Codex hook(s) from ${file}`);
  } else {
    const r = installCodexHooks({ port });
    if (r.backup) console.log(`backup written: ${r.backup}`);
    console.log(`installed ${r.installed} Codex hooks in ${file} -> http://127.0.0.1:${port}${MARKER}?source=codex`);
    console.log('next: open Codex and run /hooks to trust them (Codex skips untrusted hooks)');
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
