// Local receiver for Claude Code hook payloads. Loopback only, by design:
// binds 127.0.0.1 explicitly and validates that bodies look like hook
// payloads before handing them to the session manager.

import http from 'http';
import { BOARD_HTML, BOARD_MANIFEST, boardIcon } from './board.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // Edit/Write tool_input can be large

// Defense against DNS rebinding: a malicious page whose hostname is rebound to
// 127.0.0.1 is same-origin in the browser (no preflight, custom headers
// allowed), but its requests still carry the attacker's hostname in Host.
// Board routes only answer to genuine loopback names.
function isLoopbackHost(host) {
  const name = String(host || '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

export default class HookServer {
  /**
   * @param {object} opts
   * @param {(payload: object) => void} opts.onEvent
   * @param {() => object} [opts.getBoard] returns the JSON board state (sessions
   *   + rendered tiles) for the on-screen board; omit to disable the board.
   * @param {(id: string, action: string) => boolean} [opts.onBoardAction] handles
   *   a board press ('press'|'clear') for a session id; omit for read-only board.
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ onEvent, getBoard = null, onBoardAction = null, getStats = null, log = () => {} }) {
    this.onEvent = onEvent;
    this.getBoard = getBoard;
    this.onBoardAction = onBoardAction;
    this.getStats = getStats;
    this.log = log;
    this.server = null;
    this.port = null;
  }

  /** Start listening. Resolves with the port, rejects on EADDRINUSE etc. */
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        this.log(`hook server error: ${err.code || err.message}`);
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = port;
        this.log(`hook server listening on 127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  handle(req, res) {
    // Parse the URL so a query string (e.g. ?origin=<label> from a second
    // machine's hooks) doesn't defeat the path match.
    let url;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    // The on-screen board (loopback only, same as everything else here): the
    // page, the state it polls, its PWA manifest/icon, and the press-action
    // route below. All board routes require a loopback Host (DNS-rebinding
    // defense — see isLoopbackHost).
    const isBoardPath = url.pathname === '/board' || url.pathname.startsWith('/board/');
    if (isBoardPath && !isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET' && this.getBoard) {
      if (url.pathname === '/board' || url.pathname === '/board/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(BOARD_HTML);
        return;
      }
      if (url.pathname === '/board/state') {
        let body = '{"sessions":[]}';
        try {
          body = JSON.stringify(this.getBoard());
        } catch (e) {
          this.log(`board state failed: ${e?.message}`);
        }
        res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(body);
        return;
      }
      if (url.pathname === '/board/stats' && this.getStats) {
        let body = '{}';
        try {
          body = JSON.stringify(this.getStats());
        } catch (e) {
          this.log(`stats failed: ${e?.message}`);
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
        return;
      }
      if (url.pathname === '/board/manifest.webmanifest') {
        res
          .writeHead(200, { 'content-type': 'application/manifest+json' })
          .end(BOARD_MANIFEST);
        return;
      }
      if (url.pathname === '/board/icon.png') {
        const icon = boardIcon();
        if (icon) {
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }).end(icon);
        } else {
          res.writeHead(404).end();
        }
        return;
      }
    }

    // Board input: click = press, hold = clear — runs the same handlers as a
    // physical key press. Requires a custom header: any website can fire blind
    // POSTs at 127.0.0.1 (localhost CSRF), but cross-origin pages can't set
    // custom headers without a CORS preflight we never approve. Forged hook
    // EVENTS only paint a wrong tile (accepted, documented); ACTIONS clear
    // sessions and spawn focus/resume, so they get this stricter gate.
    if (req.method === 'POST' && url.pathname === '/board/action' && this.onBoardAction) {
      if (req.headers['x-claude-sessions-board'] !== '1') {
        res.writeHead(403).end();
        return;
      }
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const id = typeof body?.id === 'string' ? body.id : '';
        const action = body?.action === 'press' || body?.action === 'clear' ? body.action : '';
        let ok = false;
        if (id && action) {
          try {
            ok = this.onBoardAction(id, action) === true;
          } catch (e) {
            this.log(`board action failed: ${e?.message}`);
          }
        }
        res
          .writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok }));
      });
      req.on('error', () => {});
      return;
    }

    const ok = req.method === 'POST' && url.pathname === '/claude-sessions-event';
    if (!ok) {
      res.writeHead(404).end();
      return;
    }
    // Origin tags which machine the session lives on (omitted = this machine).
    // Validated to a short token so it's safe to store, render, and key config on.
    const originParam = url.searchParams.get('origin');
    const origin = originParam && /^[\w-]{1,32}$/.test(originParam) ? originParam : null;
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // Respond immediately; hooks must never wait on rendering.
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return; // not JSON: ignore silently
      }
      if (!payload || typeof payload !== 'object') return;
      if (typeof payload.hook_event_name !== 'string' || typeof payload.session_id !== 'string') return;
      // Origin comes ONLY from the validated query param — never from the JSON
      // body, which would bypass the token validation above.
      delete payload.origin;
      if (origin) payload.origin = origin;
      try {
        this.onEvent(payload);
      } catch (e) {
        this.log(`event handling failed: ${e?.message}`);
      }
    });
    req.on('error', () => {});
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      this.port = null;
      server.close(() => resolve());
      // Don't let lingering keep-alive sockets hold the port open.
      server.closeAllConnections?.();
    });
  }
}
