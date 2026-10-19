// Single source of truth for the Claude Code hooks this plugin relies on.
// Used by the plugin's main service (the Property Inspector's Install/Remove
// buttons) AND by the standalone scripts/hooks-*.js wrappers, so there's one
// event list and one command shape. All edits to ~/.claude/settings.json are
// merge-safe: a timestamped backup is written first, and ONLY hooks tagged with
// our URL marker are ever touched — other tools' hooks are preserved.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const MARKER = '/claude-sessions-event';
export const EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
]);

// OpenAI Codex (CLI, IDE, and the ChatGPT desktop app's Codex mode) has a hooks
// system with the same file shape and nearly the same events/payload as Claude
// Code, so the same installer writes ~/.codex/hooks.json. Codex has no
// Notification/StopFailure; it adds Interrupt (user stopped the turn).
export const CODEX_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
  'SessionEnd',
]);
// Codex caps SessionEnd/Interrupt hook timeouts at 3s; curl gives up after 1s anyway.
export const CODEX_TIMEOUT = 3;

function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function codexHooksPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
}

// stdin (the hook payload JSON) is forwarded as the POST body. --max-time 1 +
// `|| true` + async keeps the agent from ever being slowed or broken when the
// plugin isn't running. `origin` tags a remote machine (omitted = this machine);
// `source` tags the agent (omitted = Claude Code). The URL is single-quoted so
// `?` and `&` are never glob/background characters to the hook's shell.
export function buildCommand({ host = '127.0.0.1', port = 9210, origin = '', source = '' } = {}) {
  const params = [];
  if (origin) params.push(`origin=${origin}`);
  if (source) params.push(`source=${source}`);
  const q = params.length ? `?${params.join('&')}` : '';
  return `curl -s -o /dev/null --max-time 1 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://${host}:${port}${MARKER}${q}' || true`;
}

function hookEntry(command, timeout = 5) {
  return { matcher: '', hooks: [{ type: 'command', command, async: true, timeout }] };
}

function isOurs(h) {
  return h && typeof h.command === 'string' && h.command.includes(MARKER);
}

// Drop our marker hooks from an event's matcher groups, keeping everyone else's
// (and dropping groups we emptied). Never removes another tool's hook.
function stripOurs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => (g.hooks || []).length > 0);
}

function timestampedBackup(settingsPath) {
  return `${settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

// Atomic write (tmp + rename) so a crash mid-write can't truncate the user's
// real ~/.claude/settings.json.
function writeSettingsAtomic(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

/** Read status without modifying anything. */
export function hookStatus(settingsPath = defaultSettingsPath()) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { settingsExists: false, events: [], expected: EVENTS.length, port: null, origins: [] };
  }
  const hooks = settings.hooks || {};
  const events = [];
  const ports = new Set();
  const origins = new Set();
  for (const ev of Object.keys(hooks)) {
    for (const g of hooks[ev] || []) {
      for (const h of g.hooks || []) {
        if (!isOurs(h)) continue;
        if (!events.includes(ev)) events.push(ev);
        const pm = h.command.match(/:(\d+)\//);
        if (pm) ports.add(pm[1]);
        const om = h.command.match(/origin=([\w-]+)/);
        origins.add(om ? om[1] : 'local');
      }
    }
  }
  return {
    settingsExists: true,
    events,
    expected: EVENTS.length,
    port: ports.size === 1 ? [...ports][0] : ports.size ? [...ports] : null,
    origins: [...origins],
  };
}

/**
 * Reconcile our hooks to exactly the current EVENTS at the given host/port/
 * origin: strip any prior marker hooks, then add fresh ones. Idempotent, and
 * safe to re-run after a port or event-list change (unlike a pure append).
 * Creates settings.json (and ~/.claude) if absent.
 */
export function installHooks({
  host,
  port,
  origin,
  source,
  settingsPath = defaultSettingsPath(),
  events = EVENTS,
  timeout = 5,
} = {}) {
  let raw = null;
  let settings = {};
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch {
    settings = {}; // missing/invalid — start fresh (keeps going for a clean setup)
  }
  let backup = null;
  if (raw !== null) {
    backup = timestampedBackup(settingsPath);
    fs.writeFileSync(backup, raw);
  }
  settings.hooks = settings.hooks || {};
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = stripOurs(settings.hooks[ev]);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  const command = buildCommand({ host, port, origin, source });
  for (const ev of events) {
    settings.hooks[ev] = settings.hooks[ev] || [];
    settings.hooks[ev].push(hookEntry(command, timeout));
  }
  writeSettingsAtomic(settingsPath, settings);
  return { installed: events.length, backup, host: host || '127.0.0.1', port: port || 9210, origin: origin || '' };
}

/** Install/reconcile the Codex hooks in ~/.codex/hooks.json (same merge-safety). */
export function installCodexHooks({ port, settingsPath = codexHooksPath() } = {}) {
  return installHooks({ port, source: 'codex', settingsPath, events: CODEX_EVENTS, timeout: CODEX_TIMEOUT });
}

/** hookStatus for ~/.codex/hooks.json, with the Codex event count as the target. */
export function codexHookStatus(settingsPath = codexHooksPath()) {
  return { ...hookStatus(settingsPath), expected: CODEX_EVENTS.length };
}

/** Remove exactly our marker hooks; leave everything else untouched. */
export function uninstallHooks({ settingsPath = defaultSettingsPath() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { removed: 0, backup: null };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return { removed: 0, backup: null }; // corrupt file — leave it alone
  }
  const backup = timestampedBackup(settingsPath);
  fs.writeFileSync(backup, raw);
  let removed = 0;
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    const before = (hooks[ev] || []).reduce((n, g) => n + (g.hooks || []).filter(isOurs).length, 0);
    hooks[ev] = stripOurs(hooks[ev]);
    removed += before;
    if (!hooks[ev].length) delete hooks[ev];
  }
  writeSettingsAtomic(settingsPath, settings);
  return { removed, backup };
}
