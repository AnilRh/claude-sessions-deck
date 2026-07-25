# Marketplace listing — Claude Sessions

Draft copy for the Ulanzi Studio Marketplace submission. Assets to upload are in
this folder: `app-icon-288.png` (icon), `thumbnail.png` (thumbnail), and the
three `gallery-*.png` files.

---

**Name:** Claude Sessions

**Category:** Productivity (or Developer Tools, if available)

**Tagline (one line):**
Turn your deck into a live status board for your Claude Code sessions.

**Short description (~1–2 sentences):**
See every Claude Code session at a glance — which one is working, which is
waiting on you, which finished, and which errored. Press a key to jump straight
back into that session.

**Long description:**

Claude Sessions turns your Ulanzi deck into a live status board for the Claude
Code sessions you have running. Each key tracks one session and shows what
matters at a glance:

- **Working** — terracotta with animated dots
- **Waiting on you** — a bold amber “?”, tuned to catch your eye in peripheral
  vision so you never leave Claude blocked
- **Done** — green with a checkmark
- **Idle** — a calm, readable card for a workspace you keep returning to
- **Error** — red “!” when a turn hits an API error

Press a lit key to acknowledge a finished session and jump right to it — into
Claude Desktop, or into a terminal resuming that session. Keys are labeled with
the session’s title (not just its folder), so multiple sessions in the same
directory stay easy to tell apart; add a short `[tag]` to a session’s title for
an even tidier label.

Run a dozen sessions across projects without losing track of any of them. The
board survives app restarts, spans multiple deck profiles, and can even show
sessions running on a second machine.

Away from your desk? A built-in **web board** mirrors the same tiles in a
browser window (add it to your Dock as a standalone app) with identical
click-to-jump and hold-to-clear behavior — so undocking your laptop doesn't
mean losing your status board.

**Feature bullets:**

- Live per-session status: working / waiting / done / idle / error
- Unmissable amber “needs you” state for peripheral vision
- Press to acknowledge and jump to a session
- Session-title button labels, with a `[bracket]` shorthand
- Survives redock / restart (state is persisted)
- Works across multiple deck profiles
- Web board: the same tiles in a resizable window (Add to Dock), with full
  press parity — for when the deck isn't in reach
- Optional: show a second machine’s sessions over a secure tunnel

**Requirements:**

- macOS 12 or later
- Ulanzi Studio 3.0+
- Claude Code (Anthropic’s CLI) — provides the session events via hooks

**Notes for reviewers:**

- All data stays on the user’s machine: the plugin runs a loopback-only
  (`127.0.0.1`) HTTP listener that receives Claude Code hook events. Nothing is
  sent to any external service, and there are no in-plugin payments or paywalls.
- macOS only in this release (declared in the manifest’s `OS` field).
