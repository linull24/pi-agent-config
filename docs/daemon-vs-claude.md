# Daemon: ours vs Claude Code — gap analysis

Snapshot: 2026-10-05. Ours = the native pi durable server (`dev.pi.native-server`, fork source
`~/pi-src`, `experimental/coordinator.ts` + per-session workers, server id `a6380090-…`).
Reference = Claude Code **v2.1.220** (docs mirrored in `docs/claude-code/`).

## Key verification: sessions are client-independent
Dispatched a background agent from the Agent View, then **killed the client 1 s later**. 35 s later
the session still had its full 3 entries (user / system / **assistant reply**) — the task ran to
completion daemon-side. The client is only a renderer. This is the hardest architectural point and
it already holds.

## Dimension-by-dimension

| Dimension | Ours | Claude Code | Est. |
|---|---|---|---|
| Supervision / residency | launchd KeepAlive + coordinator + on-demand worker, sqlite durable | dedicated supervisor; reconnect on wake, survives auto-update | ~70% |
| **Session independent of client** | ✅ verified (kill client, task still completes) | ✅ | ~90% |
| **Tool lifecycle** | ❌ worker installs only `CodingTools` (+ `Subagent`); extension tools not loaded | tools owned by the session; client only renders/answers | **~20% (top gap)** |
| **needs-input loop** | detected, but background sessions get no interactive tool; peek cannot reply | reply inline in peek | ~15% |
| Agent View UX | state tags, time sort, peek (metadata only), dispatch, rename, stop, Ctrl+A | + reply-in-peek, filters (`s:`/`n:`/`o:`), pin, reorder, Ctrl+S grouping, Alt+n, subagents tab, `?`, PR links, notifications, tab title | ~50% |
| State model | 8 states: working / finishing / needs input / needs instructions / stalled / done / graved / failed | 6 states + process-alive shape (`✻`/`∙`/`✢`) + loop sessions | ~70% |
| Notifications | none | terminal notification channel + hooks | ~5% |
| Isolation (worktrees) | none (shared cwd) | per-session worktree for parallel edits | ~10% |
| Cross-session messaging / teams | none | yes | ~5% |
| CLI / multi-project listing | `pi agents` TUI, `pi-client` list | `claude agents --json`, `--cwd` | ~50% |
| Scheduling (`/loop`, cron) | cron extension (interactive), not daemon-integrated | scheduled sessions, in the view | ~20% |
| Permissions / sandbox | automode / constraints / danger-monitor (interactive only) | per-session permission mode, sandbox | ~30% |
| Resume / recovery | sqlite durable + attach + `pi resume --last` | cross-project / worktree / by-name resume | ~60% |

## Overall
**Roughly 45–55%.** The structural skeleton (durability, client-independence, session workers,
Agent View, state machine, dispatch/stop/rename) is in place. The single blocking root cause is the
**tool lifecycle (A7)**: it simultaneously depresses needs-input, Agent View UX, and permissions.

## To close the gap (priority order)
1. **A7 tool lifecycle** — adapt pi extension `ToolDefinition`s into the durable `Registry`
   (harness-compatible `Tool`/`prepare` wrapper) and run the extension runner in the session worker,
   so tools belong to the session. Then interactive tools block on durable pending state that any
   client (Agent View peek) can render and answer → unlocks full background-agent capability and a
   real needs-input loop.
2. **reply-in-peek + filters (`s:`/`n:`)** — bring the Agent View interaction to parity.
3. **Notifications** (needs-input / finished / failed → terminal notification) — low cost, high
   experience gain.
4. **Worktree isolation + `agents --json`** — parallel edits and scriptability.

Bottom line: *"a daemon that runs sessions in the background"* is already at Claude's level;
*"background sessions that own their full capability"* is still far, and the root cause is that
tools are not yet owned by the session.
