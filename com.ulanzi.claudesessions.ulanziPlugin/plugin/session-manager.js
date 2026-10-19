// Event-driven session state machine. Deliberately self-correcting: any hook
// event can move a session to the state implied by that event, so a missed or
// out-of-order event is repaired by the next one (there is no hook that fires
// when work resumes after a permission approval — tool events are the
// heartbeat that recovers from `waiting`).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { STATES } from './renderer.js';

const HEARTBEAT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SAVE_DEBOUNCE_MS = 400;
const MAX_SSH_TITLE_READS = 3; // cap concurrent ssh title reads across sessions
const TITLE_RETRY_MS = 10 * 1000; // re-read this often (on events) while no title yet
const TITLE_RECHECK_MS = 90 * 1000; // re-read this often (on events) once a title is known
// grep pattern for the transcript records that carry a title. A title can sit
// ANYWHERE in the file (a rename done early is buried mid-file as the chat grows),
// so we grep for just these lines rather than sampling head+tail.
const TITLE_GREP = '"(custom-title|ai-title|summary)"';

export default class SessionManager {
  /**
   * @param {object} opts
   * @param {() => number} [opts.now] clock override for tests
   * @param {(session) => void} [opts.onChange] called when a session's state changes
   * @param {number} [opts.staleTimeoutMs]
   * @param {number} [opts.maxSlots]
   * @param {string|null} [opts.persistPath] JSON file to persist sessions to; on
   *   construction sessions are reloaded from it (stale ones pruned) so the deck
   *   repaints immediately after a plugin restart (redock, Studio relaunch,
   *   crash, reboot) instead of blanking until the next hook event.
   */
  constructor({
    now = Date.now,
    onChange = () => {},
    staleTimeoutMs = 30 * 60 * 1000,
    maxSlots = 64,
    persistPath = null,
    nameSource = 'title',
    servers = {},
    slotOrder = 'fixed',
  } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.staleTimeoutMs = staleTimeoutMs;
    this.maxSlots = maxSlots;
    this.persistPath = persistPath;
    this.nameSource = nameSource; // 'title' (session title, bracket-aware) | 'folder'
    this.servers = servers || {}; // origin -> { sshTarget } for remote title reads
    this.slotOrder = slotOrder; // 'fixed' | 'compact' | 'grouped'
    this.seqCounter = 0; // monotonic arrival order (stable tiebreak for ordering)
    this.sshReadsInFlight = 0; // concurrency gate for remote title reads
    this.saveTimer = null;
    /** @type {Map<string, object>} session_id -> session */
    this.sessions = new Map();
    if (persistPath) this.load();
  }

  setNameSource(src) {
    this.nameSource = src === 'folder' ? 'folder' : 'title';
  }

  setServers(servers) {
    this.servers = servers || {};
  }

  setSlotOrder(order) {
    this.slotOrder = ['fixed', 'compact', 'grouped'].includes(order) ? order : 'fixed';
  }

  /**
   * Restore sessions from disk, dropping any already past the stale timeout.
   * Silent on any error (missing/corrupt file) — a fresh start is acceptable.
   * State is restored verbatim; the self-correcting hook flow repairs anything
   * that went stale while the plugin was down.
   */
  load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(arr)) return;
    const cutoff = this.now() - this.staleTimeoutMs;
    for (const s of arr) {
      if (!s || typeof s.sessionId !== 'string') continue;
      const lastEventAt = typeof s.lastEventAt === 'number' ? s.lastEventAt : this.now();
      if (lastEventAt < cutoff) continue; // prune stale on load
      const seq = typeof s.seq === 'number' ? s.seq : this.seqCounter;
      this.seqCounter = Math.max(this.seqCounter, seq + 1); // continue past restored max
      this.sessions.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        projectName: typeof s.projectName === 'string' ? s.projectName : '',
        state: s.state || STATES.IDLE,
        slot: Number.isInteger(s.slot) ? s.slot : this.firstFreeSlot(),
        seq,
        stateSince: typeof s.stateSince === 'number' ? s.stateSince : this.now(),
        lastEventAt,
        origin: typeof s.origin === 'string' ? s.origin : 'local',
        source: s.source === 'codex' ? 'codex' : 'claude',
        transcriptPath: typeof s.transcriptPath === 'string' ? s.transcriptPath : '',
        title: typeof s.title === 'string' ? s.title : null,
        titleCheckedAt: 0, // force a re-check after restart
      });
    }
    // Restored idle/done sessions get no further events, so run a one-time title
    // resolution pass now (titleCheckedAt was reset to 0 above; the per-call
    // throttle + SSH concurrency cap still apply). Without this, a session that
    // won't emit another event keeps its stale folder-name label after a restart.
    for (const s of this.sessions.values()) this.maybeResolveTitle(s);
  }

  /** Debounced, atomic write of the current sessions to persistPath. */
  persist() {
    if (!this.persistPath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const tmp = `${this.persistPath}.tmp`;
      const data = JSON.stringify([...this.sessions.values()]);
      fs.writeFile(tmp, data, (err) => {
        if (!err) fs.rename(tmp, this.persistPath, () => {});
      });
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  setStaleTimeoutMs(ms) {
    this.staleTimeoutMs = ms;
  }

  /** Ingest a Claude Code hook payload. Returns the affected session or null. */
  ingest(payload) {
    const event = payload.hook_event_name;
    const sessionId = payload.session_id;
    if (typeof event !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;

    if (event === 'SessionEnd') {
      // Don't drop the tile — a session can end in the CLI (e.g. exiting a copy
      // resumed over SSH) while still open elsewhere, and losing it defeats the
      // "everything acknowledged by end of day" goal. Keep it visible; the user
      // clears it with a long-press, or it prunes after the stale timeout.
      const session = this.sessions.get(sessionId);
      if (!session) return null; // never saw it active; nothing to show
      session.lastEventAt = this.now();
      // Only surface as done/unread if it was actively working when it ended —
      // there may be output to review. A session already acknowledged (idle) or
      // already done shouldn't re-alert just because you opened and exited it
      // (e.g. resuming over SSH from the deck, then quitting without new work).
      if (session.state === STATES.THINKING || session.state === STATES.WAITING) {
        session.state = STATES.DONE_UNREAD;
        session.stateSince = this.now();
        this.onChange(session);
      }
      this.maybeResolveTitle(session);
      this.persist();
      return session;
    }

    const nextState = this.stateForEvent(event, payload, this.sessions.get(sessionId));
    if (nextState === null) return null; // event carries no state signal

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        cwd: '',
        projectName: '',
        state: STATES.IDLE,
        slot: this.firstFreeSlot(),
        seq: this.seqCounter++, // arrival order (stable ordering tiebreak)
        stateSince: this.now(),
        lastEventAt: this.now(),
        origin: typeof payload.origin === 'string' ? payload.origin : 'local',
        source: payload.source === 'codex' ? 'codex' : 'claude',
        transcriptPath: '',
        title: null, // resolved session title (deck name), '' = checked/none
        titleCheckedAt: 0,
      };
      this.sessions.set(sessionId, session);
    }

    if (typeof payload.cwd === 'string' && payload.cwd) {
      session.cwd = payload.cwd;
      session.projectName = path.basename(payload.cwd);
    }
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      session.transcriptPath = payload.transcript_path;
    }
    session.lastEventAt = this.now();

    if (session.state !== nextState) {
      session.state = nextState;
      session.stateSince = this.now();
      this.onChange(session);
    }
    this.maybeResolveTitle(session); // event-driven title refresh (throttled)
    this.persist(); // lastEventAt (and maybe state) changed
    return session;
  }

  /** @returns {string|null} the target state for a hook event, or null to ignore */
  stateForEvent(event, payload, existing) {
    switch (event) {
      case 'UserPromptSubmit':
        return STATES.THINKING;
      case 'PermissionRequest':
        return STATES.WAITING;
      case 'Notification': {
        const type = payload.notification_type;
        if (type === 'permission_prompt') return STATES.WAITING;
        if (type === 'idle_prompt') {
          // idle_prompt also fires ~60s after a turn ends; a finished session
          // should stay green, not flip to amber. Only treat it as "blocked on
          // me" when Claude is mid-turn (e.g. asked a question without Stop).
          return existing && existing.state === STATES.DONE_UNREAD ? null : STATES.WAITING;
        }
        if (type === undefined) {
          // Older payload without notification_type: same done_unread guard.
          return existing && existing.state === STATES.DONE_UNREAD ? null : STATES.WAITING;
        }
        return null; // auth_success etc.
      }
      case 'Stop':
        return STATES.DONE_UNREAD;
      case 'Interrupt':
        // Codex: the user stopped the turn themselves, so they're already at the
        // session — nothing needs their attention.
        return STATES.IDLE;
      case 'StopFailure':
        // Turn ended in an API error (rate limit / overloaded / auth). A real
        // error state, distinct from a normal finish. Tool-level failures
        // (PostToolUseFailure) stay heartbeats — Claude usually recovers.
        return STATES.ERROR;
      default: {
        if (!HEARTBEAT_EVENTS.has(event)) return null; // SubagentStop, SessionStart, unknown
        // Tool events imply Claude is working. But the hook order for a
        // permission-gated tool is PreToolUse -> PermissionRequest -> PostToolUse,
        // and our hooks POST async (fire-and-forget), so a PreToolUse can arrive
        // AFTER the PermissionRequest it preceded. Ignoring PreToolUse while
        // already WAITING stops that reordered event from flipping the amber
        // "needs you" tile back to thinking. PostToolUse/PostToolUseFailure mean
        // the tool actually ran (we're past the prompt), so they DO recover.
        if (event === 'PreToolUse' && existing && existing.state === STATES.WAITING) return null;
        return STATES.THINKING;
      }
    }
  }

  /** Press on a done_unread or error session: back to idle, keep the slot. */
  acknowledge(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || (session.state !== STATES.DONE_UNREAD && session.state !== STATES.ERROR)) return false;
    session.state = STATES.IDLE;
    session.stateSince = this.now();
    this.onChange(session);
    this.persist();
    return true;
  }

  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.onChange({ ...session, removed: true });
    this.persist();
    return true;
  }

  /** Drop sessions with no events for staleTimeoutMs. Returns removed ids. */
  pruneStale() {
    const cutoff = this.now() - this.staleTimeoutMs;
    const removed = [];
    for (const [id, s] of this.sessions) {
      if (s.lastEventAt < cutoff) {
        this.sessions.delete(id);
        removed.push(id);
        this.onChange({ ...s, removed: true });
      }
    }
    if (removed.length) this.persist();
    return removed;
  }

  firstFreeSlot() {
    const used = new Set([...this.sessions.values()].map((s) => s.slot));
    for (let i = 0; i < this.maxSlots; i++) {
      if (!used.has(i)) return i;
    }
    // All maxSlots slots are taken (far more live sessions than physical keys).
    // Overflow sessions collide on the last index; they're still tracked and
    // persisted, and the collision resolves the moment any slot frees. maxSlots
    // (64) is well above any real key count, so this is a theoretical backstop.
    return this.maxSlots - 1;
  }

  /** Session shown in slot index i, or undefined. */
  sessionForSlot(i) {
    if (this.slotOrder === 'fixed') {
      for (const s of this.sessions.values()) {
        if (s.slot === i) return s;
      }
      return undefined;
    }
    return this.orderedSessions()[i];
  }

  /**
   * Sessions in display order for compact/grouped modes (fixed mode uses the
   * stored per-session slot instead). 'compact' = arrival order, gaps removed.
   * 'grouped' = local sessions first, then remote grouped by machine, each group
   * in arrival order. Sort keys are all stable (origin, seq) so tiles only move
   * when a session is added or removed — never on a mere state change.
   */
  orderedSessions() {
    const arr = [...this.sessions.values()];
    if (this.slotOrder === 'grouped') {
      return arr.sort(
        (a, b) =>
          (a.origin === 'local' ? 0 : 1) - (b.origin === 'local' ? 0 : 1) ||
          String(a.origin || 'local').localeCompare(String(b.origin || 'local')) ||
          (a.seq || 0) - (b.seq || 0)
      );
    }
    return arr.sort((a, b) => (a.seq || 0) - (b.seq || 0)); // compact: arrival order
  }

  /**
   * Label shown on the key. Priority (unless nameSource is 'folder'):
   *   1. a [bracketed] hint inside the session title — an explicit short deck
   *      name, e.g. "premise telephony analysis [phone issue]" -> "phone issue"
   *   2. the full session title (the renderer wraps/truncates it to two lines)
   *   3. the cwd basename, disambiguated ("api", "api·2") for same-folder sessions
   * Titles come from the transcript (see resolveTitles); remote sessions have no
   * locally-readable transcript, so they use the folder.
   */
  displayName(session) {
    if (this.nameSource !== 'folder' && session.title) {
      const bracket = session.title.match(/\[([^\]]+)\]/);
      if (bracket && bracket[1].trim()) return bracket[1].trim();
      return session.title;
    }
    if (!session.projectName) return '';
    let nth = 0;
    for (const s of this.sessions.values()) {
      if (s.projectName !== session.projectName || (this.nameSource !== 'folder' && s.title)) continue;
      if (s === session) break;
      nth++;
    }
    return nth === 0 ? session.projectName : `${session.projectName}·${nth + 1}`;
  }

  /**
   * Refresh a session's title from its transcript — event-driven (called from
   * ingest when a hook arrives), not polled: local sessions read the file,
   * remote sessions read it over SSH (the same target used for resume), so a
   * remote read only happens right after a real event, when the tunnel/SSH is
   * necessarily up. Throttled per session — fast while no title is known yet
   * (to catch the auto-title as soon as it lands), lazy once found (just to
   * catch a later rename). Fire-and-forget; never blocks the caller.
   */
  maybeResolveTitle(session) {
    if (!session) return;
    const codex = session.source === 'codex';
    if (!codex && !session.transcriptPath) return;
    const interval = session.title ? TITLE_RECHECK_MS : TITLE_RETRY_MS;
    const now = this.now();
    if (now - (session.titleCheckedAt || 0) < interval) return;

    let read;
    if (codex) {
      // Codex keeps thread names in ~/.codex/session_index.jsonl, keyed by the
      // same session id the hooks send. Local machine only for now.
      if (session.origin && session.origin !== 'local') return;
      session.titleCheckedAt = now;
      read = readCodexTitle(session.sessionId);
    } else if (session.origin && session.origin !== 'local') {
      const target = this.servers[session.origin] && this.servers[session.origin].sshTarget;
      if (!target) return; // no way to reach that machine
      // Cap concurrent SSH reads so many remote sessions firing at once can't
      // fan out an unbounded number of ssh processes. Skip (don't mark checked)
      // so it retries on the next event.
      if (this.sshReadsInFlight >= MAX_SSH_TITLE_READS) return;
      this.sshReadsInFlight++;
      session.titleCheckedAt = now;
      read = readRemoteTranscriptTitle(target, session.transcriptPath).finally(() => {
        this.sshReadsInFlight--;
      });
    } else {
      session.titleCheckedAt = now;
      read = readTranscriptTitle(session.transcriptPath);
    }
    read
      .then((title) => {
        if (title === null) {
          if (session.title === null) session.title = ''; // resolved, none found
          return;
        }
        if (title !== session.title) {
          session.title = title;
          this.onChange(session);
          this.persist();
        }
      })
      .catch(() => {});
  }
}

// Scan transcript text (JSONL) for the current title: the latest
// {"type":"custom-title"} (a rename) wins over the latest {"type":"ai-title"}
// (Claude's auto-title; older transcripts used {"type":"summary"}). Returns
// the string or null.
function parseTitleFromText(text) {
  let customTitle = null;
  let aiTitle = null;
  let summary = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"summary"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Latest of each kind wins. Priority: a user rename (custom-title) over
    // Claude's auto-title (ai-title, formerly "summary").
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle;
    else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
    else if (rec.type === 'summary' && typeof rec.summary === 'string') summary = rec.summary;
  }
  const t = (customTitle || aiTitle || summary || '').trim();
  return t || null;
}

// Local transcript: read only the head + tail to bound cost.
// Codex names threads in session_index.jsonl as {"id","thread_name","updated_at"}
// lines (appended on rename); the last line for an id is the current name.
function readCodexTitle(sessionId) {
  if (!/^[\w-]{1,64}$/.test(sessionId)) return Promise.resolve(null);
  const index = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'session_index.jsonl');
  return new Promise((resolve) => {
    execFile(
      'grep',
      ['-aF', sessionId, index],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        let name = null;
        for (const line of (stdout || '').split('\n')) {
          if (!line) continue;
          try {
            const o = JSON.parse(line);
            if (o.id === sessionId && typeof o.thread_name === 'string' && o.thread_name.trim()) {
              name = o.thread_name.trim();
            }
          } catch {}
        }
        resolve(name);
      }
    );
  });
}

function readTranscriptTitle(file) {
  // grep just the title lines out of the whole file (any size), so a title record
  // buried in the middle of a long transcript is still found. Cheap — only the
  // matching lines are read into memory, not the whole multi-MB file.
  return new Promise((resolve) => {
    execFile(
      'grep',
      ['-aE', TITLE_GREP, file],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ? parseTitleFromText(stdout) : null)
    );
  });
}

// Remote transcript: read head + tail over SSH (reuses the resume ssh target).
// BatchMode/ConnectTimeout so it fails fast and never prompts; validated inputs
// so the single-quoted remote path can't be broken out of.
function readRemoteTranscriptTitle(sshTarget, remotePath) {
  if (!/^[\w.@-]{1,128}$/.test(sshTarget) || !/^[\w /.@:+-]{1,512}$/.test(remotePath)) {
    return Promise.resolve(null);
  }
  const cmd = `grep -aE '${TITLE_GREP}' '${remotePath}' 2>/dev/null`;
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshTarget, cmd],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? null : parseTitleFromText(stdout))
    );
  });
}
