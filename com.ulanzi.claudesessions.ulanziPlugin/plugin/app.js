import UlanziApi from './plugin-common-node/index.js';
import SessionManager from './session-manager.js';
import SlotRegistry from './slot-registry.js';
import HookServer from './hook-server.js';
import { renderTile, tileCacheKey, formatElapsed, STATES } from './renderer.js';
import { focusApp, FOCUS_APPS, setDesktopMode } from './focus.js';
import { loadConfig, saveConfig, sanitize, DEFAULTS, SESSIONS_PATH } from './config.js';
import { installHooks, uninstallHooks, hookStatus } from './hooks.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.claudesessions';

const TICK_MS = 1000;
const STALE_SWEEP_EVERY_TICKS = 30;
const LONG_PRESS_MS = 600;
const RECONNECT_DELAY_MS = 3000;
// How long a just-finished (done/error) tile reads as "fresh" before it
// settles to the normal colour — so a tile that just turned green stands out
// from a backlog you'll get to later. Quantized into steps for the tile cache
// so it repaints a handful of times over the window, not every tick.
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const FRESH_STEPS = 10;

function log(...args) {
  console.log('[claude-sessions]', ...args);
}

// Headless mode: run without Ulanzi Studio (no deck) — hook server, session
// state, and the web board still work; only key rendering and toasts need
// Studio. Studio always spawns us as `node app.js <address> <port> <language>`,
// so a bare `node app.js` (or an explicit --headless) means no Studio.
const HEADLESS = process.argv.includes('--headless') || !process.argv[2];

let config = loadConfig();

// Only scan the Claude Desktop session store when Desktop deep-link focus is in
// use; terminal focus modes never need it.
setDesktopMode(config.focusApp === 'Claude');

const $UD = new UlanziApi();
const registry = new SlotRegistry();
const manager = new SessionManager({
  staleTimeoutMs: config.staleTimeoutMin * 60 * 1000,
  onChange: () => scheduleRender(),
  persistPath: SESSIONS_PATH,
  nameSource: config.nameSource,
  servers: config.servers,
  slotOrder: config.slotOrder,
});
const server = new HookServer({
  onEvent: (p) => manager.ingest(p),
  getBoard: boardState,
  onBoardAction: (id, action) => boardAction(id, action),
  log,
});

// User-facing notifications (Studio toasts) for problems the user can act on —
// so failures surface instead of leaving keys silently empty. Queued until the
// Studio WebSocket is up (some fire during startup, before connect). Headless
// has no toast surface — log instead of queueing forever.
let studioConnected = false;
const pendingNotices = [];
function notify(msg) {
  if (HEADLESS) {
    log(`notice: ${msg}`);
  } else if (studioConnected) {
    try {
      $UD.toast(msg);
    } catch {}
  } else {
    pendingNotices.push(msg);
  }
}
// Reporter handed to focusApp: log for debugging AND toast (all of focus.js's
// callbacks are error/problem cases — no SSH target, resume/focus failed).
function focusReport(msg) {
  log(msg);
  notify(`Claude Sessions: ${msg}`);
}

/** last pushed tile cache key per context */
const lastPushed = new Map();
/** keydown timestamps per context, for synthesized long-press */
const keyDownAt = new Map();

let frame = 0;
let tickCount = 0;
let tickTimer = null;
let renderQueued = false;
let shuttingDown = false;
let wsAddress = null;
let wsPort = null;
let hookNudged = false;

// --- rendering ---------------------------------------------------------------

function scheduleRender() {
  // Coalesce bursts of hook events into one render pass on next tick of the
  // event loop; pushes are still gated per-key by the tile cache.
  if (renderQueued) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    renderAll();
  });
}

// Render props for a session's tile. Shared by the physical deck (renderAll)
// and the on-screen board (boardState) so both draw byte-identical tiles.
// Elapsed is since the current state began — shown by every state now,
// including idle ("idle · 2h"), so a quiet workspace still reads as live.
function sessionProps(session, now) {
  return {
    state: session.state,
    projectName: manager.displayName(session),
    elapsed: formatElapsed(now - session.stateSince),
    frame: session.state === STATES.THINKING && config.animateThinking ? frame : 0,
    serverLabel: session.origin && session.origin !== 'local' ? session.origin : '',
    freshness: freshnessOf(session, now),
  };
}

// Recency of a done/error tile as a 1→0 value, quantized to FRESH_STEPS so the
// tile cache only repaints it a few times as it settles (not every tick).
const FRESHABLE = new Set([STATES.DONE_UNREAD, STATES.ERROR, STATES.WAITING]);
function freshnessOf(session, now) {
  if (!FRESHABLE.has(session.state)) return 0;
  const raw = 1 - (now - session.stateSince) / FRESH_WINDOW_MS;
  if (raw <= 0) return 0;
  return Math.round(raw * FRESH_STEPS) / FRESH_STEPS;
}

function renderAll() {
  const contexts = registry.contexts();
  const now = Date.now();
  contexts.forEach((context, slotIdx) => {
    const session = manager.sessionForSlot(slotIdx);
    const props = session ? sessionProps(session, now) : { state: STATES.EMPTY };
    const key = tileCacheKey(props);
    if (lastPushed.get(context) !== key) {
      lastPushed.set(context, key);
      $UD.setBaseDataIcon(context, renderTile(props));
    }
  });
}

// State for the on-screen board: every live session (not just the ones on
// physical keys), in the same order the deck uses, each with its rendered
// tile. The board reflows them responsively, so it grows with session count.
function boardState() {
  const now = Date.now();
  const sessions = manager.orderedSessions().map((session) => {
    const props = sessionProps(session, now);
    return {
      id: session.sessionId,
      state: props.state,
      name: props.projectName,
      elapsed: props.elapsed,
      serverLabel: props.serverLabel,
      svg: renderTile(props),
    };
  });
  return { sessions };
}

function tick() {
  frame = (frame + 1) % 2;
  tickCount++;
  if (tickCount % STALE_SWEEP_EVERY_TICKS === 0) manager.pruneStale();
  renderAll();
}

// --- key press behavior --------------------------------------------------------
// Session-keyed core actions, shared by the physical deck keys and the web
// board so a board click behaves EXACTLY like a key press (same code path).

function pressSession(session) {
  if (session.state === STATES.DONE_UNREAD || session.state === STATES.ERROR) {
    manager.acknowledge(session.sessionId);
  }
  // Every press brings the hosting app to front, including done/idle keys —
  // pressing a key is "take me to this session," not just "clear the badge."
  // Remote sessions (origin != local) route to an SSH resume instead.
  // focusReport surfaces focus/resume problems as toasts, not silent logs.
  focusApp(config.focusApp, session, config.servers, focusReport);
}

function clearSession(session, via) {
  log(`${via}: force-clearing ${session.projectName || session.sessionId}`);
  manager.remove(session.sessionId);
}

function forceClearSlot(slotIdx) {
  const session = manager.sessionForSlot(slotIdx);
  if (session) clearSession(session, `long-press slot ${slotIdx}`);
}

function handlePress(context) {
  const slotIdx = registry.slotIndexOf(context);
  if (slotIdx < 0) return;
  const session = manager.sessionForSlot(slotIdx);
  if (!session) return;
  pressSession(session);
}

// Board input (click = press, hold = clear), keyed by session id since the
// board shows all sessions, not just slotted ones.
function boardAction(id, action) {
  const session = manager.sessions.get(id);
  if (!session) return false;
  if (action === 'press') pressSession(session);
  else if (action === 'clear') clearSession(session, 'board hold');
  else return false;
  return true;
}

// --- Ulanzi wiring -------------------------------------------------------------

$UD.onConnected(() => {
  log('connected to Ulanzi Studio');
  // Capture the real address/port for reconnects (connect() consumes argv).
  wsAddress = $UD.address;
  wsPort = $UD.port;
  studioConnected = true;
  // Flush anything that wanted to notify before the socket was up.
  const queued = pendingNotices.splice(0);
  queued.forEach((m) => {
    try {
      $UD.toast(m);
    } catch {}
  });
  // One-time nudge if the plugin has no way to receive events yet.
  if (!hookNudged) {
    hookNudged = true;
    try {
      if (hookStatus().events.length === 0) {
        notify("Claude Sessions: no Claude Code hooks installed — open a key's settings to install");
      }
    } catch {}
  }
});

$UD.onAdd((msg) => {
  log('key added', msg.context);
  registry.add(msg.context);
  lastPushed.delete(msg.context);
  scheduleRender();
});

$UD.onClear((msg) => {
  if (!msg.param) return;
  for (const item of msg.param) {
    log('key cleared', item.context);
    registry.removeByContext(item.context);
    lastPushed.delete(item.context);
    keyDownAt.delete(item.context);
  }
  scheduleRender();
});

$UD.onKeyDown((msg) => {
  keyDownAt.set(msg.context, Date.now());
});

// The whole short-press/long-press decision lives here. `run` is not used for
// this: on the D200 it fires ~15ms after keydown (essentially on press, not
// release), so it can't tell a short press from a long one — using it as well
// caused every long press to also fire the short-press action instantly, then
// force-clear on release. keyup's held-duration is the only reliable signal.
$UD.onKeyUp((msg) => {
  const downAt = keyDownAt.get(msg.context);
  keyDownAt.delete(msg.context);
  if (!downAt) return;
  const held = Date.now() - downAt;
  if (held >= LONG_PRESS_MS) {
    const slotIdx = registry.slotIndexOf(msg.context);
    if (slotIdx >= 0) forceClearSlot(slotIdx);
  } else {
    handlePress(msg.context);
  }
});

$UD.onSetActive(() => {
  // Profile page became visible again: force a full re-push.
  lastPushed.clear();
  scheduleRender();
});

// Property Inspector <-> main service (pass-through messages; config is
// persisted by the main service in config.json, not the Studio settings API).
function sendHookStatus(context) {
  $UD.sendToPropertyInspector({ type: 'hooks', status: hookStatus(), pluginPort: config.httpPort }, context);
}

$UD.onSendToPlugin(async (msg) => {
  const payload = msg.payload || msg.param || {};
  if (payload.type === 'configRequest') {
    $UD.sendToPropertyInspector({ type: 'config', config, focusApps: FOCUS_APPS, defaults: DEFAULTS }, msg.context);
  } else if (payload.type === 'configUpdate' && payload.config) {
    await applyConfig(sanitize({ ...config, ...payload.config }));
    $UD.sendToPropertyInspector({ type: 'config', config, focusApps: FOCUS_APPS, defaults: DEFAULTS }, msg.context);
  } else if (payload.type === 'hooksStatus') {
    sendHookStatus(msg.context);
  } else if (payload.type === 'hooksInstall') {
    // Install/reconcile the local hooks at the plugin's current port (one-click
    // setup from the PI — no terminal or repo needed).
    try {
      const r = installHooks({ port: config.httpPort });
      $UD.toast(`Claude Sessions: installed ${r.installed} hooks (port ${r.port})`);
    } catch (e) {
      log(`hook install failed: ${e?.message}`);
      $UD.toast(`Claude Sessions: hook install failed — ${e?.message || 'error'}`);
    }
    sendHookStatus(msg.context);
  } else if (payload.type === 'hooksUninstall') {
    try {
      const r = uninstallHooks();
      $UD.toast(`Claude Sessions: removed ${r.removed} hooks`);
    } catch (e) {
      log(`hook uninstall failed: ${e?.message}`);
    }
    sendHookStatus(msg.context);
  }
});

async function applyConfig(next) {
  const prev = config;
  config = next;
  saveConfig(config, log);
  manager.setStaleTimeoutMs(config.staleTimeoutMin * 60 * 1000);
  manager.setNameSource(config.nameSource);
  manager.setServers(config.servers);
  manager.setSlotOrder(config.slotOrder);
  if (prev.focusApp !== config.focusApp) setDesktopMode(config.focusApp === 'Claude');
  if (prev.httpPort !== config.httpPort) {
    await server.close();
    try {
      await server.listen(config.httpPort);
      notify(`Claude Sessions: listening on port ${config.httpPort}`);
    } catch (e) {
      // Roll back to the previous port so the deck keeps receiving events
      // rather than going deaf on a port nothing is listening on.
      const failedPort = config.httpPort;
      log(`failed to bind new port ${failedPort}: ${e?.message}; rolling back to ${prev.httpPort}`);
      config.httpPort = prev.httpPort;
      try {
        await server.listen(prev.httpPort);
      } catch (e2) {
        log(`rollback bind to ${prev.httpPort} also failed: ${e2?.message}`);
      }
      saveConfig(config, log);
      notify(`Claude Sessions: port ${failedPort} unavailable — kept ${prev.httpPort}`);
    }
  }
  lastPushed.clear();
  scheduleRender();
}

// --- lifecycle -------------------------------------------------------------------

async function start() {
  try {
    await server.listen(config.httpPort);
  } catch (e) {
    // Another instance (or another app) owns the port. A second instance most
    // likely means Studio respawned us and an orphan is still exiting; bail
    // and let the newest instance win on its retry.
    log(`could not bind 127.0.0.1:${config.httpPort} (${e?.code}); retrying in 5s`);
    setTimeout(async () => {
      try {
        await server.listen(config.httpPort);
      } catch (err) {
        log(`port ${config.httpPort} still unavailable (${err?.code}); giving up on HTTP`);
        const fix = HEADLESS
          ? 'edit httpPort in config.json and restart (then reinstall hooks)'
          : "change the Hook server port in a key's settings (then reinstall hooks)";
        notify(
          `Claude Sessions: hook port ${config.httpPort} is in use — events can't be received. Either ${fix}, or quit whatever is using it.`
        );
      }
    }, 5000);
  }
  if (HEADLESS) {
    // No Studio: the web board is the display. Everything Studio-specific
    // (key rendering, toasts, PI, reconnect lifecycle) simply never engages —
    // no keys are registered, so renderAll() is a natural no-op.
    log(`headless mode — no Ulanzi Studio; board at http://127.0.0.1:${config.httpPort}/board`);
    try {
      if (hookStatus().events.length === 0) {
        log('no Claude Code hooks installed — run: npm run hooks:install');
      }
    } catch {}
  } else {
    $UD.connect(PLUGIN_UUID);
  }
  tickTimer = setInterval(tick, TICK_MS);
}

$UD.onClose(async () => {
  if (shuttingDown) return;
  studioConnected = false;
  log('websocket closed; freeing HTTP port and retrying connection');
  // Free the port so a respawned replacement instance can claim it.
  await server.close();
  const retry = () => {
    if (shuttingDown) return;
    log('reconnecting to Ulanzi Studio…');
    $UD.connect(PLUGIN_UUID, wsPort || 3906, wsAddress || '127.0.0.1');
  };
  setTimeout(retry, RECONNECT_DELAY_MS);
});

$UD.onConnected(async () => {
  // (Re)acquire the HTTP port after reconnects; first connect is a no-op
  // because start() already bound it.
  if (!server.server && !shuttingDown) {
    try {
      await server.listen(config.httpPort);
    } catch (e) {
      log(`port ${config.httpPort} taken after reconnect (${e?.code}); exiting in favor of newer instance`);
      shutdown(0);
    }
  }
});

$UD.onError((err) => log('websocket error', err));

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  if (tickTimer) clearInterval(tickTimer);
  await server.close();
  try {
    $UD.websocket?.close();
  } catch {}
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (e) => {
  log('uncaught exception', e?.stack || e);
  shutdown(1);
});

start();
