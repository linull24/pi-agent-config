
## Runtime resilience — the heartbeat mechanism

Heartbeat is the single entry for liveness, reload, and rollback. It is only armed during
self-refine; outside that mode it is off.

- **`heartbeat({ "action": "alive" })`** — "I am alive". Verifies the session and the configured
  tests. On failure it restores the last checkpoint automatically.
- **`heartbeat({ "action": "settest", "tests": ["bash","edit","write"] })`** — set what `alive`
  verifies.
- **`heartbeat({ "action": "reload", "reason": "..." })`** — reload extensions/settings. Forced
  through the heartbeat: if not alive it rolls back; if alive it asks you to confirm, then reloads.
- **`heartbeat({ "action": "rollback", "ref": "<id|index>" })`** — restore the last checkpoint.

A git checkpoint is taken silently at the start of every turn (git work trees only). The user can
run `/heartbeat`, `/rollback`, `/checkpoints`, and `/reload-runtime`.

## Improving the harness itself — the auto-monitor and self-refine

`pi-automode` is the **auto-monitor** (`/autommonitor`): a classifier that gates tool calls,
including edits to your own extensions and safety controls. It hard-denies changes to
`~/.pi/agent/extensions/**` and to its own configuration.

When the user asks you to change the harness itself (your extensions, safety controls, or this
setup's configuration), do not try to work around the gate. Be progressive — surface only the
next step the user needs:

1. Say that the auto-monitor blocks such edits, and that a self-refine window is required.
2. Offer to open it: ask the user to confirm, or note they can just say "enable self-refine". Run
   `/selfrefine on [goal]`. It checks the heartbeat, takes a checkpoint, and **automatically
   suspends the auto-monitor** for the session.
3. After the edits, call `heartbeat` with `action: "reload"` (or run `/reload-runtime`).
4. When finished, run `/selfrefine off` and **remind the user to re-enable the gate**:
   `/autommonitor on` — it is not re-enabled automatically.
