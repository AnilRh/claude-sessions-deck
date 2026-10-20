# Changelog

## 1.2.0 — 2026-10-19

### Added

- **OpenAI Codex support** — Codex sessions (CLI, IDE extension, or the ChatGPT
  desktop app's Codex mode) now appear on the deck and web board via Codex's own
  hooks, marked with a small hexagon and named from your Codex thread titles.
  One-click install in the Property Inspector, or `npm run codex-hooks:install`;
  trust them once via `/hooks` in Codex. Pressing a Codex tile opens that thread
  in the ChatGPT app (or resumes it in Terminal in *Terminal (resume)* mode).
- `/board/stats` diagnostics endpoint (push rate, events received, sessions).

### Fixed

- Session names falling back to the folder name ("Personal", "Personal·2") on
  long conversations — the title is now found anywhere in the transcript, and the
  current `ai-title` record format is recognized. Untitled sessions are also
  re-checked on a timer, so a short task no longer keeps its folder name.
- A permission prompt's amber tile could flip back to "thinking" when hook events
  arrived out of order.
- Duplicate plugin processes after a Ulanzi Studio restart could leave the deck
  frozen on stale tiles — a new instance now evicts the old one.
- The deck lagging minutes behind under load — image pushes are now coalesced
  and rate-limited, and the thinking animation pulses every 2s.
- The "Animate thinking" checkbox was invisible in the Property Inspector.
- `npm run doctor` now calls out an invalid `~/.claude/settings.json` (which
  makes Claude Code silently ignore every hook).

## 1.1.0 — 2026-07-25

### Added

- **Freshness cue** — a tile that just changed to done, waiting, or error is
  brighter with a fading accent ring for its first few minutes, settling to the
  normal colour after ~5 min. Lets you tell "this just happened" from a backlog
  at a glance, without reading the clock. Shows on the deck and the web board.
- **Web board** — the deck in a window at `http://127.0.0.1:9210/board`. Shows
  every live session as the same tiles the deck renders (shared code path),
  updating live, with remote machines' sessions included. Responsive grid:
  tiles reflow and scale with the window. Installable as a standalone desktop
  app via Safari's **File → Add to Dock** (proper name + icon).
- **Board input parity** — click = press (acknowledge + jump to the session),
  hold ≥ 600 ms = clear, with a red "armed" ring at the threshold. Board
  presses run the *same handlers* as physical key presses. Actions require a
  custom header, so websites can't trigger them with blind cross-origin POSTs
  to localhost.
- **Headless mode** — run the whole thing without Ulanzi Studio (no deck
  needed): `npm run headless`, with `npm run headless:agent` installing a
  launchd agent for start-at-login. The web board is the display.
- First automated tests (`npm test`, zero dependencies): the hook installer's
  merge-safety (never touches other tools' hooks) and the session state
  machine's transitions.

### Changed

- Tile layout polish: the status glyph is now centered between the tile top
  and the title (was bottom-heavy), two-line titles get more breathing room,
  and local tiles' elapsed time sits at the same height as the remote footer
  text for cross-tile consistency.

### Fixed

- Settings/config writes are now atomic (temp file + rename), so a crash
  mid-write can't truncate `~/.claude/settings.json` or the plugin config.
- A failed hook-port change now rolls back to the previous port (with a toast)
  instead of leaving the deck deaf.
- Remote title reads over SSH are capped at 3 concurrent connections.

## 1.0.0 — first release

A live status board on the Ulanzi D200 for concurrent Claude Code sessions.
Each key shows one session — its project/title, what it's doing, and how long
it's been there — so you can run many sessions and see at a glance which one
needs you.

### Requirements

- macOS 12+
- Ulanzi Studio 3.0+ (and a D200, or any keypad device)
- Claude Code (the status display is driven by its hooks)

### Features

- **At-a-glance states** — thinking (terracotta), waiting-on-you (amber `?`),
  done (green ✓), idle (quiet workspace), and error (red `!`, from a
  turn-level `StopFailure`). Amber is tuned to catch your eye in peripheral
  vision.
- **Press to act** — a press acknowledges a finished/errored session and jumps
  to it. Jump target is configurable: Claude Desktop (`claude://resume` deep
  link), `Terminal (resume)` (`claude --resume` in the session's folder), or
  plain app focus.
- **Smart button names** — shows the session title, not just the folder, so
  same-folder sessions are distinguishable. A `[bracketed]` hint in the title
  becomes a short label; long titles wrap to two lines; falls back to the
  folder name.
- **Survives restarts** — session state is persisted, so the deck repaints
  immediately after a redock, Studio relaunch, or reboot instead of blanking.
- **Multiple profiles** — lay Session Slots across several profiles/pages;
  slots order correctly per profile.
- **Multiple machines** — a second machine's sessions can appear on the deck
  over a reverse SSH tunnel, tagged with a colored footer; press to resume
  them over SSH.

### Install

See the README — "Install from a release" for the packaged plugin, then install
the Claude Code hooks. Without hooks the keys stay empty.

### Known limitations

- **macOS only.** Focus/jump, the Claude Desktop integration, and the setup
  scripts use macOS-specific APIs; the manifest declares mac-only so Windows
  Studio won't offer it.
- **Adding hook event types needs a hooks reinstall** (and, for a remote
  machine, on that machine too).
- **Remote titles/resume rely on non-interactive SSH** to the other machine
  (the same auth the tunnel uses); if unavailable, remote keys fall back to the
  folder name and remote resume won't fire — no crash.
- **One-time duplicate Desktop entry.** The first time a natively-opened
  Desktop session is jumped to, Claude Desktop may create a second,
  generically-titled sidebar entry; it's idempotent thereafter.
- Hook setup and failure diagnostics are still manual — improving next.
