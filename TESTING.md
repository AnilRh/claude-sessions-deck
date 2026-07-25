# Testing

Verify in this order: fake events against the running plugin first (no real
Claude Code sessions needed), then real hooks, then press behavior on the
physical D200.

## 1. Fake-event scenarios (plugin installed, keys placed)

```bash
scripts/fake-events.sh all          # or: lifecycle | permission | multi | restart | end
```

Watch the deck:

| Scenario | Expect on the keys |
|---|---|
| `lifecycle` | key 1: terracotta pulsing → green. Press it → charcoal idle. |
| `permission` | terracotta → amber "?" → (simulated approval) snaps back to terracotta → green. **This is the resume-gap test.** |
| `multi` | three keys: terracotta `web-app`, amber `worker`, green `home-automation` (wraps to two lines). |
| `restart` | kill the plugin process first (`pkill -f claudesessions`); Studio-relaunched instance lights keys correctly from mid-stream events. |
| `end` | key lights up, then goes **green/done** on SessionEnd (the tile is kept, not cleared — long-press to remove, or it prunes after the stale timeout). |

Also verify: `lsof -nP -i :9210` shows only `127.0.0.1` (never `*:9210`), and
from another device `curl http://<your-lan-ip>:9210/` fails.

## 2. Real hooks

```bash
npm run hooks:install
diff ~/.claude/settings.json ~/.claude/settings.json.bak.<newest>   # ours added, nothing lost
```

Start a fresh Claude Code session in any repo:

1. Submit a prompt → key goes terracotta with the repo name.
2. Ask for something that needs permission (e.g. an unapproved command) →
   amber "?" and your beep.sh still beeps (both hooks fire).
3. Approve → key returns to terracotta on the next tool event.
4. Let the reply finish → green with badge.
5. Press the green key → idle. Prompt again → terracotta again, same key.
6. `/clear` or exit the session → key goes empty.
7. With Ulanzi Studio quit entirely: `time claude -p "hi"` — no added latency
   (hooks are async + 1s curl timeout).

## 3. Physical-only checks

- **Peripheral vision**: with the deck at your normal desk position, trigger
  a permission prompt while looking at your monitor — the amber flip should
  be noticeable without looking at the deck.
- **Long-press**: hold a lit key ≥ 600 ms → slot clears. Check Studio's
  plugin log for `keyup after NNNms` lines to confirm keydown/keyup arrive on
  real hardware (they did in the simulator; if they never appear, long-press
  silently doesn't exist on-device — known SDK limitation).
- **Focus**: short-press a terracotta/amber key → configured terminal app
  fronts (approve the one-time Automation prompt).
- **Animation load**: 3+ thinking keys at once — Studio stays responsive
  (pushes are 1 fps per thinking key, cache-gated; idle/green keys push
  only on minute ticks).
- **Studio restart**: quit and relaunch Ulanzi Studio twice in a row — keys
  repopulate, no EADDRINUSE in the plugin log.

## 4. Web board

With the plugin running (Studio or headless), open
<http://127.0.0.1:9210/board>:

- **Mirrors the deck**: every live session appears as the identical tile,
  same order; state changes show within a second; thinking dots animate.
- **Responsive**: narrow the window — tiles shrink and reflow to fewer
  columns; widen it — tiles keep a sane size instead of ballooning.
- **Click = press**: clicking a green tile acknowledges it (goes idle) and
  jumps to the session, exactly like the physical key.
- **Hold = clear**: press-and-hold a tile ≥ 600 ms — a red ring appears
  (armed); release and the tile is removed. Slide off the tile before
  releasing to abort.
- **Connection dot**: quit Ulanzi Studio (or the headless process) — the
  header dot turns red with an offline message; restart — it recovers.
- **Action gate**: `curl -X POST http://127.0.0.1:9210/board/action -d
  '{"id":"x","action":"clear"}' -H 'Content-Type: application/json'` →
  **403** (no custom header = rejected; the board page sends it).
- **Headless smoke**: with Studio quit, `npm run headless` → board serves,
  fake events (`scripts/fake-events.sh`) light tiles, log stays quiet (no
  reconnect churn).

## 5. Automated tests

`npm test` (zero dependencies, Node's built-in runner) covers the hook
installer's merge-safety — foreign hooks survive install/reconcile/
port-change/uninstall, corrupt settings are left untouched — and the session
state machine's transitions (permission-gap recovery, SessionEnd not
re-alerting acknowledged tiles, error handling, phantom-session guards).

## 6. Automated harness (used during development)

A mock Ulanzi Studio (WS server + key-event injector) lives at
`scripts/mock-studio.cjs`; it decodes every pushed tile back to its state
name. Start it (`node scripts/mock-studio.cjs`), run the plugin against it with
`node plugin/app.js 127.0.0.1 3999 en` and drive it with
`scripts/fake-events.sh`. All state transitions, long-press, garbage-input,
SIGTERM port release, and hook-installer merge safety were verified this way
(17/17 checks) before first install.
