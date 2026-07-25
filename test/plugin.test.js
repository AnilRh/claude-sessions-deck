// Focused safety net for the two behaviors that would actually burn a user:
//   1. the hook installer editing ~/.claude/settings.json (must never clobber
//      another tool's hooks, e.g. a beep.sh or rubocop hook);
//   2. the session state machine's self-correcting transitions (the amber->
//      thinking recovery, and not re-alerting an acknowledged session).
// No framework, no CI required: `npm test` runs it with the bundled Node.
//
//   node --test        (or: npm test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVENTS,
  MARKER,
  installHooks,
  uninstallHooks,
  hookStatus,
} from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/hooks.js';
import SessionManager from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/session-manager.js';

// --- helpers ---------------------------------------------------------------

// A hook that belongs to some OTHER tool, which we must never touch.
const FOREIGN = {
  matcher: 'Edit|Write',
  hooks: [{ type: 'command', command: '~/.claude/rubocop-autofix.sh' }],
};

function tmpSettings(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hooks-'));
  const p = path.join(dir, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(p, initial);
  return p;
}

function read(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// count our marker hooks across every event/group
function ourHookCount(settings) {
  let n = 0;
  for (const ev of Object.keys(settings.hooks || {})) {
    for (const g of settings.hooks[ev] || []) {
      for (const h of g.hooks || []) if (h.command && h.command.includes(MARKER)) n++;
    }
  }
  return n;
}

function foreignStillPresent(settings) {
  return (settings.hooks?.PostToolUse || []).some((g) =>
    (g.hooks || []).some((h) => h.command === FOREIGN.hooks[0].command),
  );
}

// --- hook installer --------------------------------------------------------

test('installHooks preserves a foreign hook and installs all EVENTS', () => {
  const p = tmpSettings(JSON.stringify({ hooks: { PostToolUse: [FOREIGN] } }));
  installHooks({ port: 9210, settingsPath: p });
  const s = read(p);
  assert.ok(foreignStillPresent(s), 'foreign rubocop hook must survive install');
  for (const ev of EVENTS) {
    assert.ok(s.hooks[ev]?.length, `event ${ev} should have a hook group`);
  }
  assert.equal(ourHookCount(s), EVENTS.length, 'exactly one of our hooks per event');
});

test('installHooks is idempotent (reconcile, not append) when re-run', () => {
  const p = tmpSettings(JSON.stringify({ hooks: { PostToolUse: [FOREIGN] } }));
  installHooks({ port: 9210, settingsPath: p });
  installHooks({ port: 9210, settingsPath: p });
  installHooks({ port: 9210, settingsPath: p });
  const s = read(p);
  assert.equal(ourHookCount(s), EVENTS.length, 'no duplicate marker hooks after re-runs');
  assert.ok(foreignStillPresent(s), 'foreign hook still preserved across re-runs');
});

test('installHooks reconciles a port change (no stale old-port hooks)', () => {
  const p = tmpSettings(JSON.stringify({ hooks: {} }));
  installHooks({ port: 9210, settingsPath: p });
  installHooks({ port: 9999, settingsPath: p });
  const s = read(p);
  assert.equal(ourHookCount(s), EVENTS.length, 'still one hook per event after port change');
  const status = hookStatus(p);
  assert.equal(status.port, '9999', 'only the new port should remain');
});

test('uninstallHooks removes only our hooks and leaves foreign ones', () => {
  const p = tmpSettings(JSON.stringify({ hooks: { PostToolUse: [FOREIGN] } }));
  installHooks({ port: 9210, settingsPath: p });
  const res = uninstallHooks({ settingsPath: p });
  assert.equal(res.removed, EVENTS.length, 'removed count matches installed count');
  const s = read(p);
  assert.equal(ourHookCount(s), 0, 'none of our hooks remain');
  assert.ok(foreignStillPresent(s), 'foreign hook must survive uninstall');
});

test('uninstallHooks leaves a corrupt settings file untouched', () => {
  const p = tmpSettings('{ this is not valid json');
  const res = uninstallHooks({ settingsPath: p });
  assert.equal(res.removed, 0);
  assert.equal(res.backup, null);
  assert.equal(fs.readFileSync(p, 'utf8'), '{ this is not valid json', 'file byte-for-byte unchanged');
});

test('hookStatus reports installed events and port', () => {
  const p = tmpSettings(JSON.stringify({ hooks: {} }));
  installHooks({ port: 9210, settingsPath: p });
  const status = hookStatus(p);
  assert.equal(status.events.length, EVENTS.length);
  assert.equal(status.expected, EVENTS.length);
  assert.equal(status.port, '9210');
  assert.deepEqual(status.origins, ['local']);
});

// --- session state machine -------------------------------------------------

function makeManager() {
  let t = 1000;
  const mgr = new SessionManager({
    now: () => t,
    persistPath: null,
    staleTimeoutMs: 30 * 60 * 1000,
  });
  return { mgr, advance: (ms) => (t += ms) };
}

const SID = 'sess-1';
function ev(name, extra = {}) {
  return { hook_event_name: name, session_id: SID, cwd: '/home/u/dev/app', ...extra };
}

test('UserPromptSubmit creates a session in thinking', () => {
  const { mgr } = makeManager();
  const s = mgr.ingest(ev('UserPromptSubmit'));
  assert.equal(s.state, 'thinking');
  assert.equal(s.projectName, 'app');
});

test('permission gap recovers: PermissionRequest -> waiting -> heartbeat -> thinking', () => {
  const { mgr } = makeManager();
  mgr.ingest(ev('UserPromptSubmit'));
  assert.equal(mgr.ingest(ev('PermissionRequest')).state, 'waiting');
  // No event fires when work resumes after approval; the next tool event is the
  // heartbeat that must pull the tile back out of waiting.
  assert.equal(mgr.ingest(ev('PostToolUse')).state, 'thinking');
});

test('Stop -> done_unread; SessionEnd on a done tile does not re-alert', () => {
  const { mgr } = makeManager();
  mgr.ingest(ev('UserPromptSubmit'));
  assert.equal(mgr.ingest(ev('Stop')).state, 'done_unread');
  // Ending an already-finished session shouldn't bump it again.
  assert.equal(mgr.ingest(ev('SessionEnd', { reason: 'clear' })).state, 'done_unread');
});

test('acknowledge -> idle; a later SessionEnd must not re-green it', () => {
  const { mgr } = makeManager();
  mgr.ingest(ev('UserPromptSubmit'));
  mgr.ingest(ev('Stop'));
  assert.equal(mgr.acknowledge(SID), true);
  assert.equal(mgr.sessions.get(SID).state, 'idle');
  // Resuming over SSH then quitting fires SessionEnd; the just-read tile stays dark.
  assert.equal(mgr.ingest(ev('SessionEnd', { reason: 'other' })).state, 'idle');
});

test('StopFailure -> error, and acknowledge clears it to idle', () => {
  const { mgr } = makeManager();
  mgr.ingest(ev('UserPromptSubmit'));
  assert.equal(mgr.ingest(ev('StopFailure')).state, 'error');
  assert.equal(mgr.acknowledge(SID), true);
  assert.equal(mgr.sessions.get(SID).state, 'idle');
});

test('idle_prompt notification does not flip a finished session to waiting', () => {
  const { mgr } = makeManager();
  mgr.ingest(ev('UserPromptSubmit'));
  mgr.ingest(ev('Stop'));
  // The event carries no state signal for a finished session, so ingest ignores
  // it (returns null); the tile must stay green rather than flip to amber.
  assert.equal(mgr.ingest(ev('Notification', { notification_type: 'idle_prompt' })), null);
  assert.equal(mgr.sessions.get(SID).state, 'done_unread', 'idle_prompt after a turn ends must not re-alert');
});

test('SessionEnd for a never-seen session creates no phantom tile', () => {
  const { mgr } = makeManager();
  assert.equal(mgr.ingest(ev('SessionEnd', { reason: 'clear' })), null);
  assert.equal(mgr.sessions.size, 0);
});
