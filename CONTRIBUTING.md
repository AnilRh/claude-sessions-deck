# Contributing / internals

Developer and maintainer notes for **Claude Sessions**. User-facing setup lives
in the [README](README.md); this file is the stuff most users don't need.

## Architecture

```
Claude Code hooks (~/.claude/settings.json)   OpenAI Codex hooks (~/.codex/hooks.json, ?source=codex)
        │ async curl POST per event (max 1s, || true — never blocks the agent)
        ▼
HTTP server  127.0.0.1:9210                   plugin/hook-server.js
  (hook receiver + web board routes)
        ▼
SessionManager  session_id → state machine    plugin/session-manager.js
        ▼                     + slot assignment
Tile renderer  state → 200×200 SVG data URL   plugin/renderer.js  (cached)
        ▼                                  ▼
Ulanzi Studio WebSocket (127.0.0.1:3906)   Web board  GET /board
plugin/app.js + vendored SDK               plugin/board.js
        ▼
D200 keys (SlotRegistry orders keys row-major) plugin/slot-registry.js
```

Everything runs in the single Node.js main service that Ulanzi Studio spawns
(`plugin/app.js`) — or that you run standalone in headless mode (see the
README). No external processes, no cloud, loopback only.

Key modules (all under `com.ulanzi.claudesessions.ulanziPlugin/plugin/`):

| File | Responsibility |
|---|---|
| `app.js` | Entry point; wires the SDK, hook server, session manager, timers; press handling; config |
| `hook-server.js` | Loopback HTTP server: hook receiver (`POST /claude-sessions-event`, with allow-listed `?origin=` machine and `?source=codex` agent tags) + web-board routes (`GET /board*`, `/board/stats`, `POST /board/action`) |
| `session-manager.js` | `session_id → state` machine, slot assignment/ordering, persistence; titles from the Claude transcript (custom-title > ai-title > summary, grepped anywhere in the file) or, for Codex, `~/.codex/session_index.jsonl` thread names |
| `renderer.js` | Pure `state → 200×200 SVG data URL`, cached; the single source of tile design (deck, board, and generated images all use it) |
| `board.js` | The web board page, PWA manifest, and icon |
| `focus.js` | Press actions: Claude Desktop deep-link, terminal resume, SSH resume; Codex → `codex://threads/<id>` or `codex resume` |
| `slot-registry.js` | Maps Studio key contexts → slot order (row-major, multi-profile aware) |
| `config.js`, `hooks.js` | Config load/save; the shared, merge-safe hook installer (Claude Code and Codex) |

## Security model

The hook receiver binds `127.0.0.1` explicitly and is intentionally
unauthenticated: any process on this machine can POST a session event, exactly
like the Claude Code hooks do. This is a conscious trade-off — the listener is
not reachable from the LAN, the payload is validated to look like a hook event,
and the only effect of a forged event is a wrong tile. Remote machines reach it
over an SSH tunnel you set up, not over the open network. Don't expose the port
beyond loopback.

Board *actions* (press/clear) are held to a stricter bar: they require a custom
header **and** a loopback `Host` (so a malicious website can't trigger them with
blind cross-origin POSTs, and DNS-rebinding is rejected). See
`hook-server.js`.

## Dev install

```bash
npm run install:plugin   # copy into Ulanzi Studio + restart it
npm run hooks:install    # wire Claude Code events to the local server
```

`install:plugin` preserves `config.json`/`sessions.json` across reinstalls and
keeps backups **outside** the scanned Plugins folder (in
`~/Library/Application Support/Ulanzi/UlanziDeck/_claude-sessions-backups`,
pruned to the last few) — a pile of same-UUID backup folders inside `Plugins/`
will wedge Studio.

Simulate the whole event pipeline without real sessions:

```bash
npm run fake-events      # scripted lifecycles via curl (see scripts/fake-events.sh)
```

## Tests

```bash
npm test                 # node --test, zero dependencies
```

Covers the two highest-risk areas: the hook installer's merge-safety (never
touches other tools' hooks) and the session state machine's transitions. See
[TESTING.md](TESTING.md) for the full manual + automated test guide.

## Packaging & sharing

```bash
npm run package   # -> dist/com.ulanzi.claudesessions.ulanziPlugin.zip
```

Bundles the runtime dependency (`ws`) and icons, and excludes machine-specific
runtime files (`config.json`, `sessions.json`). To share: send the zip; the
recipient unzips it into
`~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/`, restarts Ulanzi
Studio, and installs the Claude Code hooks (see the README). They're on macOS
too.

## Store / marketing assets

Store-listing images live in `store-assets/` (outside the plugin folder, so
they're not shipped in the installed package). They're generated from the
plugin's **real** tile renderer, so they always match what the deck renders:

```bash
npm run images    # thumbnail + gallery PNGs (366×244) + app-icon-288.png
npm run demo      # animated hero -> store-assets/demo.gif
```

Both need `rsvg-convert`; `demo` also needs `ffmpeg`. The manifest's 256/512 app
icon (`assets/store-icon.png`, `@2x`) and 20×20 action icon
(`plugin/icons/sessionslot/action.png`) come from SVG sources in the same
folders — re-run `rsvg-convert` on those if you restyle. A 16:9 video preview is
optional for the marketplace and not generated here.
