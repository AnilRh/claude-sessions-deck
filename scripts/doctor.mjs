#!/usr/bin/env node
// Health check for the Claude Sessions plugin: walks the whole chain and says
// what's wrong when keys stay empty. Inspects the INSTALLED plugin (what's
// actually running), the Claude Code hooks, the live listener, and each
// configured remote machine. Read-only — it diagnoses, it doesn't change
// anything.  Run:  npm run doctor

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const HOME = os.homedir();
const PLUGIN_DIR = path.join(
  HOME,
  'Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.claudesessions.ulanziPlugin'
);
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const MARKER = '/claude-sessions-event';
const EXPECTED_EVENTS = 9;

let ok = 0;
let warn = 0;
let bad = 0;
function report(status, name, detail, fix) {
  const sym = status === 'ok' ? '✓' : status === 'warn' ? '▲' : '✗';
  if (status === 'ok') ok++;
  else if (status === 'warn') warn++;
  else bad++;
  console.log(`${sym} ${name}${detail ? ` — ${detail}` : ''}`);
  if (fix && status !== 'ok') console.log(`    ↳ ${fix}`);
}
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}
function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

console.log('Claude Sessions — health check\n');

// Ulanzi Studio
const studio = sh('pgrep -x UlanziDeck') || sh("pgrep -f 'Ulanzi Studio.app/Contents/MacOS'");
report(studio ? 'ok' : 'bad', 'Ulanzi Studio running', studio ? `pid ${studio.split('\n')[0]}` : 'not found', 'launch Ulanzi Studio');

// Plugin installed
const manifest = readJSON(path.join(PLUGIN_DIR, 'manifest.json'));
report(
  manifest ? 'ok' : 'bad',
  'Plugin installed',
  manifest ? `v${manifest.Version}` : `not found at ${PLUGIN_DIR}`,
  'install it: npm run install:plugin (or from a release)'
);

// Config
const config = readJSON(path.join(PLUGIN_DIR, 'config.json')) || {};
const port = config.httpPort || 9210;
report('ok', 'Config', `port ${port} · focus ${config.focusApp || 'Ghostty'} · names ${config.nameSource || 'title'}`);

// Plugin process
const procs = (sh(`pgrep -f '${PLUGIN_DIR}/plugin/app.js'`) || '').split('\n').filter(Boolean);
if (procs.length === 1) report('ok', 'Plugin service', '1 instance');
else if (procs.length === 0) report('bad', 'Plugin service', 'not running', 'restart Ulanzi Studio');
else report('warn', 'Plugin service', `${procs.length} instances (orphans)`, `pkill -f '${PLUGIN_DIR}/plugin/app.js', then relaunch Studio`);

// Listener on the port (loopback only)
const lsof = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN`) || '';
if (lsof.includes(`*:${port}`)) report('warn', `Listener on ${port}`, 'bound to * — should be loopback only');
else report(lsof.includes(`127.0.0.1:${port}`) ? 'ok' : 'bad', `Listener on ${port}`, lsof.includes('127.0.0.1') ? '127.0.0.1 (loopback)' : 'nothing listening', `plugin down or port taken (lsof -nP -i :${port})`);

// End-to-end POST (empty body: proves the listener routes, without creating a tile)
const httpCode = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 2 -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:${port}${MARKER}`);
report(httpCode === '200' ? 'ok' : 'bad', 'End-to-end POST', httpCode ? `HTTP ${httpCode}` : 'no response', `listener not reachable on ${port}`);

// Local hooks in ~/.claude/settings.json
const settings = readJSON(SETTINGS);
if (!settings) {
  report('bad', 'Claude Code hooks', '~/.claude/settings.json missing or invalid', 'is Claude Code installed?');
} else {
  const hooks = settings.hooks || {};
  const events = [];
  let hookPort = null;
  for (const ev of Object.keys(hooks)) {
    for (const g of hooks[ev] || []) {
      for (const h of g.hooks || []) {
        if (typeof h.command === 'string' && h.command.includes(MARKER)) {
          events.push(ev);
          const m = h.command.match(/127\.0\.0\.1:(\d+)/);
          if (m) hookPort = m[1];
        }
      }
    }
  }
  if (!events.length) report('bad', 'Claude Code hooks', 'none installed', 'npm run hooks:install');
  else {
    report(
      events.length >= EXPECTED_EVENTS ? 'ok' : 'warn',
      'Claude Code hooks',
      `${events.length}/${EXPECTED_EVENTS} events`,
      events.length < EXPECTED_EVENTS ? 'npm run hooks:uninstall && npm run hooks:install (to add newer events)' : null
    );
    if (hookPort && String(hookPort) !== String(port))
      report('bad', 'Hook port match', `hooks POST to ${hookPort}, plugin listens on ${port}`, `CLAUDE_SESSIONS_PORT=${port} npm run hooks:install`);
  }
}

// claude binary (for resume focus modes)
const claude = sh('command -v claude') || (fs.existsSync(path.join(HOME, '.local/bin/claude')) ? path.join(HOME, '.local/bin/claude') : null);
report(claude ? 'ok' : 'warn', 'claude on PATH', claude || 'not found', 'needed for Terminal(resume)/Claude focus modes');

// Bundled deps
report(fs.existsSync(path.join(PLUGIN_DIR, 'node_modules/ws')) ? 'ok' : 'bad', 'Bundled deps (ws)', '', `cd '${PLUGIN_DIR}' && npm install --omit=dev`);

// Remote machines
const servers = config.servers || {};
for (const [origin, cfg] of Object.entries(servers)) {
  const t = cfg.sshTarget;
  console.log(`\n— remote: ${origin} (${t}) —`);
  const tunnel = sh(`launchctl list 2>/dev/null | grep 'claudesessions.tunnel.${origin}'`);
  report(tunnel ? 'ok' : 'warn', `Tunnel agent (${origin})`, tunnel ? 'loaded' : 'not loaded', `SSH_TARGET=${t} LABEL=${origin} ./scripts/remote-tunnel-setup.sh`);
  const reach = sh(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${t} 'echo ok'`);
  if (reach !== 'ok') {
    report('bad', `SSH (${origin})`, 'unreachable / no key auth', `set up passwordless ssh: ssh-copy-id ${t}`);
    continue;
  }
  report('ok', `SSH (${origin})`, 'reachable');
  const rc = sh(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${t} 'grep -c claude-sessions-event ~/.claude/settings.json 2>/dev/null'`);
  report(rc && Number(rc) > 0 ? 'ok' : 'bad', `Remote hooks (${origin})`, rc ? `${rc} entries` : 'none', `install them: ORIGIN=${origin} npm run remote-hooks`);
  const rclaude = sh(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${t} 'ls ~/.local/bin/claude 2>/dev/null'`);
  report(rclaude ? 'ok' : 'warn', `Remote claude (${origin})`, rclaude || 'not at ~/.local/bin/claude', `set servers.${origin}.claudePath if elsewhere`);
}

console.log(`\n${ok} ok · ${warn} warning(s) · ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
