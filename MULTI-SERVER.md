# Showing a second machine's Claude sessions on the deck

The plugin learns about sessions purely from Claude Code **hooks** that POST to
its HTTP server (`127.0.0.1:9210`) — it reads nothing from another machine's
disk. So a second machine can drive extra keys on the deck simply by getting
its hook POSTs to this plugin. Because the server listens on loopback only (by
design), we bridge with a **reverse SSH tunnel** and tag the second machine's
events with an `origin` label.

Result: that machine's sessions appear as their own lit keys (with a small
label at the top of each tile), show the same active / waiting / done states,
and support press-to-acknowledge. Pressing a remote session's key opens
**Terminal** running `ssh -t <target> claude --resume <id>` — the remote
equivalent of the local Desktop jump (Desktop can't open a transcript that
lives on another machine).

Single-machine setups are unaffected: `origin` defaults to `local`, `servers`
defaults to empty, tiles look exactly as before.

## Setup (three steps)

Pick a short **label** for the second machine, e.g. `build-box`
(`[A-Za-z0-9_-]`, ≤32 chars).

### 1. On the LAPTOP — start the reverse tunnel

```bash
SSH_TARGET=you@build.local LABEL=build-box ./scripts/remote-tunnel-setup.sh
```

Installs a launchd agent that keeps `server:localhost:9210 → laptop:localhost:9210`
alive across drops (including undock/redock). `SSH_TARGET` can be an
`~/.ssh/config` Host alias. Override `SERVER_PORT` / `LOCAL_PORT` if 9210 is
taken on either end.

### 2. On the LAPTOP — tell the plugin how to resume that machine

Easiest: select a Session Slot key to open the Property Inspector, and under
**Remote machines** add the label (e.g. `build-box`) and SSH target
(`you@build.local`), then **Add**. It applies immediately — no restart.

(Or hand-edit `config.json` and restart Studio:
`"servers": { "build-box": { "sshTarget": "you@build.local" } }`. Add an
optional `"claudePath"` if `claude` isn't at `~/.local/bin/claude` there.)

### 3. On the LAPTOP — install the remote hooks (one command)

```bash
ORIGIN=build-box npm run remote-hooks
```

This finds the server's `sshTarget` from the config above, pushes the shared
hook installer over SSH, and runs it — no manual copying, and it handles
locating `node` on the remote. It's merge-safe (timestamped backup; other hooks
untouched) and re-runnable. Override the tunnel port with `SERVER_PORT=…​` if
it isn't 9210; remove with `ORIGIN=build-box ACTION=uninstall npm run remote-hooks`.

(Needs the same non-interactive SSH the tunnel uses. If you'd rather do it by
hand, `CLAUDE_SESSIONS_HOST=127.0.0.1 CLAUDE_SESSIONS_PORT=<port>
CLAUDE_SESSIONS_ORIGIN=<label> node scripts/hooks-install.js` on the server
still works.)

Then restart the plugin (relaunch Ulanzi Studio, or re-run
`scripts/install-plugin.sh`). Start a Claude Code session on the server and its
key should light up with a `BUILD-BOX` label.

## Notes & limits

- **Status is real-time; the jump is a terminal.** Active/waiting/done/ack all
  work remotely. The press action is an SSH terminal resume, not a Desktop tab.
- **While undocked/off-network** the tunnel is down, so the server's events are
  missed (not queued). The deck catches up on the server's next event once the
  tunnel reconnects. Local sessions are unaffected.
- **`claude` must be on PATH over `ssh -t`.** If the resume says
  "command not found", point `sshTarget` at a host whose login shell has it, or
  adjust the command in `plugin/focus.js` (`resumeRemote`) to a login shell.
- **Security.** Nothing is exposed off-machine: the plugin stays loopback-only
  and the tunnel rides your existing SSH auth. The `origin` label and
  `sshTarget` are validated before use.
- More than one server: repeat the three steps with a different `LABEL` /
  `origin`; add another entry under `servers`.
