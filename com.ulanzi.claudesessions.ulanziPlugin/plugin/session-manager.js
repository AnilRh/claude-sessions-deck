// Event-driven session state machine. Deliberately self-correcting: any hook
// event can move a session to the state implied by that event, so a missed or
// out-of-order event is repaired by the next one (there is no hook that fires
// when work resumes after a permission approval — tool events are the
// heartbeat that recovers from `waiting`).

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { STATES } from './renderer.js';

const HEARTBEAT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SAVE_DEBOUNCE_MS = 400;
const MAX_SSH_TITLE_READS = 3; // cap concurrent ssh title reads across sessions
const TITLE_RETRY_MS = 10 * 1000; // re-read this often (on events) while no title yet
const TITLE_RECHECK_MS = 90 * 1000; // re-read this often (on events) once a title is known
const TITLE_HEAD_BYTES = 64 * 1024; // auto-summary sits near the top
const TITLE_TAIL_BYTES = 128 * 1024; // a /rename appends a custom-title near the end

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
        transcriptPath: typeof s.transcriptPath === 'string' ? s.transcriptPath : '',
        title: typeof s.title === 'string' ? s.title : null,
        titleCheckedAt: 0, // force a re-check after restart
      });
    }
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
      case 'StopFailure':
        // Turn ended in an API error (rate limit / overloaded / auth). A real
        // error state, distinct from a normal finish. Tool-level failures
        // (PostToolUseFailure) stay heartbeats — Claude usually recovers.
        return STATES.ERROR;
      default:
        if (HEARTBEAT_EVENTS.has(event)) return STATES.THINKING;
        return null; // SubagentStop, SessionStart, unknown events: no signal
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
    if (!session || !session.transcriptPath) return;
    const interval = session.title ? TITLE_RECHECK_MS : TITLE_RETRY_MS;
    const now = this.now();
    if (now - (session.titleCheckedAt || 0) < interval) return;

    let read;
    if (session.origin && session.origin !== 'local') {
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
// {"type":"custom-title"} (set by a rename) wins over the latest
// {"type":"summary"} (Claude's auto-title). Returns the string or null.
function parseTitleFromText(text) {
  let customTitle = null;
  let summary = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"') && !line.includes('"summary"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle;
    else if (rec.type === 'summary' && typeof rec.summary === 'string') summary = rec.summary;
  }
  const t = (customTitle || summary || '').trim();
  return t || null;
}

// Local transcript: read only the head + tail to bound cost.
async function readTranscriptTitle(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const readAt = async (pos, len) => {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await handle.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    let text;
    if (size <= TITLE_HEAD_BYTES + TITLE_TAIL_BYTES) {
      text = await readAt(0, size);
    } else {
      text = (await readAt(0, TITLE_HEAD_BYTES)) + '\n' + (await readAt(size - TITLE_TAIL_BYTES, TITLE_TAIL_BYTES));
    }
    return parseTitleFromText(text);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Remote transcript: read head + tail over SSH (reuses the resume ssh target).
// BatchMode/ConnectTimeout so it fails fast and never prompts; validated inputs
// so the single-quoted remote path can't be broken out of.
function readRemoteTranscriptTitle(sshTarget, remotePath) {
  if (!/^[\w.@-]{1,128}$/.test(sshTarget) || !/^[\w /.@:+-]{1,512}$/.test(remotePath)) {
    return Promise.resolve(null);
  }
  const cmd = `head -c ${TITLE_HEAD_BYTES} '${remotePath}' 2>/dev/null; printf '\\n'; tail -c ${TITLE_TAIL_BYTES} '${remotePath}' 2>/dev/null`;
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshTarget, cmd],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? null : parseTitleFromText(stdout))
    );
  });
}
