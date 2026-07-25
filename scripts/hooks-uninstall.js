#!/usr/bin/env node
// CLI wrapper around the plugin's shared hook module (plugin/hooks.js). Removes
// ONLY the Claude Sessions hook entries (identified by the marker path) from
// ~/.claude/settings.json; everything else — including other hooks on the same
// events — is preserved. Writes a timestamped backup first.

import { uninstallHooks } from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/hooks.js';

const r = uninstallHooks();
if (r.backup) console.log(`backup written: ${r.backup}`);
console.log(`removed ${r.removed} Claude Sessions hook(s)`);
