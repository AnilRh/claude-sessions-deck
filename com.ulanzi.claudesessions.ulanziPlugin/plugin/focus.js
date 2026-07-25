// App-level focus via AppleScript. Per-window/per-tab focus for terminal
// emulators is deliberately out of scope — resolving which terminal window
// hosts a given Claude Code session is unreliable. Claude Desktop is the
// exception: its claude://resume deep link jumps straight to a session by ID.
//
// The URL built here — claude://resume?session=<id>&cwd=<dir> — is byte-for-
// byte what the CLI's own `/desktop` command fires (verified against the CLI
// bundle: it does `open` on a URL from new URL("claude://resume") with
// `session` and `cwd` search params). We already have both values per session
// from the hook payload.
//
// Duplicate-entry avoidance: Desktop tracks each conversation via a "wrapper"
// JSON in claude-code-sessions/<account>/<org>/local_*.json. A session opened
// natively in Desktop gets a wrapper whose id is `local_<random-uuid>` (with
// the CLI uuid stored in a `cliSessionId` field); a session first reached via
// the resume deep link gets a wrapper keyed `local_<cli-uuid>`. The deep link,
// given a param X, only ever looks up the key `local_<X>` — so passing the CLI
// uuid never matches a native wrapper and imports the transcript as a SECOND,
// generically-titled entry ("General coding session"). But because the lookup
// is purely `local_<param>`, passing the NATIVE wrapper's own id (its random
// uuid, sans `local_`) makes Desktop hit the existing native entry and just
// focus it — no import, no duplicate, landing on the good entry that carries
// the user's title/star/pin/model.
//
// So we keep an index of cliSessionId -> native wrapper id, built by scanning
// the store (reading only each file's ~16KB head, where both id fields live —
// the bulky remoteMcpServersConfig sits past 21KB). The scan runs in the
// background at load and on a timer, so the press-time lookup is an instant
// in-memory Map.get. On a hit we fire the native id (clean focus); on a miss
// (session never opened natively, or indexed <refresh-interval ago) we fall
// back to the raw CLI uuid — which hits an already-imported wrapper if present,
// or imports once otherwise (the one-time cost we already accept).

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Focus targets offered in the Property Inspector dropdown:
//  - Ghostty / iTerm2 / Terminal : bring that app to the front (app-level).
//  - Terminal (resume)           : open Terminal.app running `claude --resume`
//                                  in the session's dir — for local terminal
//                                  Claude Code users who want a real jump.
//  - Claude                      : Claude Desktop deep-link resume.
export const FOCUS_APPS = ['Ghostty', 'iTerm2', 'Terminal', 'Terminal (resume)', 'Claude'];

const APP_NAMES = {
  Ghostty: 'Ghostty',
  iTerm2: 'iTerm',
  Terminal: 'Terminal',
  Claude: 'Claude',
};

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_STORE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions'
);
const HEAD_BYTES = 16384; // sessionId/cliSessionId live in the first ~60 bytes
const REFRESH_MS = 60000; // background safety-net rescan; misses refresh on demand
const MISS_REBUILD_MIN_MS = 5000;

/** cliSessionId -> native wrapper's bare id (its random uuid, sans `local_`). */
let nativeIndex = new Map();
let refreshInFlight = false;
let lastRefreshAt = 0;

async function readHead(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function collectWrapperFiles(dir, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectWrapperFiles(p, out);
    else if (e.isFile() && /^local_.*\.json$/.test(e.name)) out.push(p);
  }
  return out;
}

async function refreshNativeIndex() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  lastRefreshAt = Date.now();
  try {
    const files = await collectWrapperFiles(SESSION_STORE, []);
    const next = new Map();
    for (const file of files) {
      let head;
      try {
        head = await readHead(file);
      } catch {
        continue;
      }
      const sid = head.match(/"sessionId"\s*:\s*"([^"]+)"/);
      const cli = head.match(/"cliSessionId"\s*:\s*"([^"]+)"/);
      if (!sid || !cli) continue;
      const sessionId = sid[1];
      const cliId = cli[1];
      // Skip imported wrappers (keyed local_<cliId>) — the raw-uuid fallback
      // already hits those; we only want native wrappers here.
      if (sessionId === `local_${cliId}`) continue;
      const bareId = sessionId.replace(/^local_/, '');
      if (SESSION_ID_RE.test(bareId)) next.set(cliId, bareId);
    }
    nativeIndex = next; // atomic swap
  } catch {
    // leave the previous index in place on failure
  } finally {
    refreshInFlight = false;
  }
}

let refreshTimer = null;

// Enable/disable the background Desktop-store scan. Only Claude-Desktop focus
// mode needs it (to resolve native wrapper ids); terminal focus modes never
// touch the Desktop store, so a terminal-only user pays no scan cost. Called by
// app.js at startup and whenever focusApp changes.
export function setDesktopMode(enabled) {
  if (enabled) {
    if (refreshTimer) return;
    refreshNativeIndex(); // warm now
    refreshTimer = setInterval(refreshNativeIndex, REFRESH_MS);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  } else if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    nativeIndex = new Map();
  }
}

function fireResume(jumpId, cwd, log) {
  const url = new URL('claude://resume');
  url.searchParams.set('session', jumpId);
  if (typeof cwd === 'string' && cwd) url.searchParams.set('cwd', cwd);
  execFile('open', [url.toString()], { timeout: 5000 }, (err) => {
    if (err) log(`resume session ${jumpId} failed: ${err.message}`);
  });
}

const DEFAULT_CLAUDE_PATH = '~/.local/bin/claude';

// Resume a session that lives on another machine: open Terminal running an SSH
// resume. Desktop can't open a transcript that isn't on this machine, so this
// is the remote equivalent of the local claude://resume jump.
//
// `claude` is invoked by absolute path (default ~/.local/bin/claude, the native
// install location; override per-server with `claudePath`). A bare
// `ssh host claude ...` runs in a non-login, non-interactive shell whose PATH
// doesn't include ~/.local/bin — and sourcing the login/interactive rc over SSH
// proved unreliable — so the explicit path is the robust route. The remote
// command is double-quoted as one argument; the leading ~ is left for the
// remote shell to expand (not the local one). sshTarget, sessionId, and
// claudePath are all validated, so nothing unsafe reaches the quotes.
function resumeRemote(sshTarget, sessionId, cwd, claudePath, log) {
  const bin = claudePath || DEFAULT_CLAUDE_PATH;
  if (
    !/^[\w.@-]{1,128}$/.test(sshTarget) ||
    !SESSION_ID_RE.test(sessionId) ||
    !/^[\w./~-]{1,256}$/.test(bin)
  ) {
    log(`invalid remote resume (target='${sshTarget}')`);
    return;
  }
  // `claude --resume <id>` only finds a session within its own project dir, so
  // cd into the session's cwd first (SSH lands in the home dir otherwise). cwd
  // is single-quoted for the remote shell; only whitelisted path chars are
  // allowed through, so the quoting can't be broken out of. If cwd is missing
  // or odd, resume without cd (may not resolve, but better than nothing).
  let remote = `${bin} --resume ${sessionId}`;
  if (typeof cwd === 'string' && /^[\w /.@:+-]{1,512}$/.test(cwd)) {
    remote = `cd '${cwd}' && ${remote}`;
  }
  const cmd = `ssh -t ${sshTarget} "${remote}"`;
  execFile(
    'osascript',
    [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(cmd)}`,
      '-e',
      'tell application "Terminal" to activate',
    ],
    { timeout: 5000 },
    (err) => {
      if (err) log(`remote resume failed: ${err.message}`);
    }
  );
}

// Resume a LOCAL session in Terminal.app. Unlike a bare SSH command, Terminal's
// `do script` opens a login+interactive shell, so `claude` is already on PATH
// (no absolute path needed). cd into the session's project dir first, since
// `claude --resume <id>` is project-scoped. Terminal.app specifically, for its
// reliable scripting; opens a new window and forks if the session is already
// live elsewhere.
function resumeLocalTerminal(cwd, sessionId, log) {
  if (!SESSION_ID_RE.test(sessionId)) {
    log(`invalid local resume (session='${sessionId}')`);
    return;
  }
  let inner = `claude --resume ${sessionId}`;
  if (typeof cwd === 'string' && /^[\w /.@:+-]{1,512}$/.test(cwd)) {
    inner = `cd '${cwd}' && ${inner}`;
  }
  execFile(
    'osascript',
    [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(inner)}`,
      '-e',
      'tell application "Terminal" to activate',
    ],
    { timeout: 5000 },
    (err) => {
      if (err) log(`local resume failed: ${err.message}`);
    }
  );
}

/**
 * Bring a session's host into view on key press.
 * @param {string} app configured focus app (terminal name, 'Terminal (resume)', or 'Claude')
 * @param {{sessionId:string, cwd?:string, origin?:string}} session
 * @param {Record<string,{sshTarget:string, claudePath?:string}>} servers origin -> ssh target
 * @param {(msg:string)=>void} [log]
 */
export function focusApp(app, session, servers = {}, log = () => {}) {
  const sessionId = session && session.sessionId;
  const cwd = session && session.cwd;
  const origin = (session && session.origin) || 'local';

  // Remote session -> SSH resume in Terminal (Desktop can't open a remote transcript).
  if (origin !== 'local') {
    const srv = servers && servers[origin];
    if (srv && srv.sshTarget) resumeRemote(srv.sshTarget, sessionId, cwd, srv.claudePath, log);
    else log(`no SSH target for '${origin}' — add it under Remote machines in a key's settings`);
    return;
  }

  // Claude Desktop -> deep-link resume (native wrapper id if known, else raw uuid).
  if (app === 'Claude') {
    if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
      const nativeId = nativeIndex.get(sessionId);
      if (!nativeId && Date.now() - lastRefreshAt > MISS_REBUILD_MIN_MS) {
        // A native wrapper may have appeared since the last scan; refresh for
        // next time (fire-and-forget, never blocks this press).
        refreshNativeIndex();
      }
      fireResume(nativeId || sessionId, cwd, log);
    }
    return;
  }

  // Local terminal, resume mode -> open Terminal.app running `claude --resume`.
  if (app === 'Terminal (resume)') {
    resumeLocalTerminal(cwd, sessionId, log);
    return;
  }

  // Any other configured app (terminal emulator) -> just bring it to the front.
  const name = APP_NAMES[app] || app;
  if (!name || !/^[\w .-]+$/.test(name)) return;
  execFile('osascript', ['-e', `tell application "${name}" to activate`], { timeout: 5000 }, (err) => {
    if (err) log(`focus ${name} failed: ${err.message}`);
  });
}
