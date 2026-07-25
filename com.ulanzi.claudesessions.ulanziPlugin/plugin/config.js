// Plugin-wide config, persisted to config.json next to the plugin (not via
// the Studio settings API, whose persistence is per-key-instance and skips
// saves while an action is inactive).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config.json');

// Runtime-persisted session snapshot (see SessionManager persistence). Lives in
// the plugin root next to config.json; regenerated at runtime, safe to delete.
export const SESSIONS_PATH = path.join(PLUGIN_ROOT, 'sessions.json');

export const DEFAULTS = Object.freeze({
  httpPort: 9210,
  staleTimeoutMin: 30,
  focusApp: 'Ghostty',
  animateThinking: true,
  // Button label source: 'title' shows the session title (a [bracketed] hint in
  // the title wins as a short label; otherwise the full title wraps to two
  // lines), falling back to the folder name; 'folder' always uses the folder.
  nameSource: 'title',
  // How sessions map to keys: 'fixed' keeps each session on its key (gaps appear
  // when one is cleared — best muscle memory); 'compact' fills gaps, sliding up
  // in arrival order; 'grouped' is compact with local sessions first, then
  // remote grouped by machine. compact/grouped move a session's key as others
  // are added/removed.
  slotOrder: 'fixed',
  // Remote machines whose sessions reach this plugin (via a reverse SSH tunnel,
  // tagged with ?origin=<label>). Maps that origin label -> { sshTarget }.
  // sshTarget is "user@host" (or an ~/.ssh/config Host alias); pressing a
  // remote session's key opens Terminal running
  // `ssh -t <sshTarget> "<claudePath> --resume <id>"`. claudePath is optional
  // (default ~/.local/bin/claude — the native install location). Empty on
  // single-machine setups. Example:
  //   "servers": { "myserver": { "sshTarget": "user@host.local" } }
  servers: {},
});

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return sanitize({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config, log = () => {}) {
  try {
    // Atomic (tmp + rename) so a crash mid-write can't corrupt config.json.
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sanitize(config), null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    log(`config save failed: ${e?.message}`);
  }
}

export function sanitize(config) {
  const c = { ...DEFAULTS, ...config };
  c.httpPort = Math.min(65535, Math.max(1024, parseInt(c.httpPort, 10) || DEFAULTS.httpPort));
  c.staleTimeoutMin = Math.min(24 * 60, Math.max(1, parseInt(c.staleTimeoutMin, 10) || DEFAULTS.staleTimeoutMin));
  c.focusApp = String(c.focusApp || DEFAULTS.focusApp);
  c.animateThinking = c.animateThinking !== false && c.animateThinking !== 'false';
  c.nameSource = c.nameSource === 'folder' ? 'folder' : 'title';
  c.slotOrder = ['fixed', 'compact', 'grouped'].includes(c.slotOrder) ? c.slotOrder : 'fixed';
  c.servers = sanitizeServers(c.servers);
  return c;
}

// Keep only well-formed { origin: { sshTarget } } entries with a safe origin
// label (matches hook-server's validation) and a shell-safe ssh target.
function sanitizeServers(servers) {
  const out = {};
  if (!servers || typeof servers !== 'object') return out;
  for (const [origin, entry] of Object.entries(servers)) {
    if (!/^[\w-]{1,32}$/.test(origin) || origin === 'local') continue;
    const sshTarget = entry && typeof entry.sshTarget === 'string' ? entry.sshTarget : '';
    if (!/^[\w.@-]{1,128}$/.test(sshTarget)) continue;
    const clean = { sshTarget };
    // Optional absolute path to `claude` on that machine (default
    // ~/.local/bin/claude). Only kept if it looks like a plain path.
    if (typeof entry.claudePath === 'string' && /^[\w./~-]{1,256}$/.test(entry.claudePath)) {
      clean.claudePath = entry.claudePath;
    }
    out[origin] = clean;
  }
  return out;
}
