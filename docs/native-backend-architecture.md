# Target architecture: native backend (Codex/Claude-aligned)

Status snapshot: 2026-10-05. This is the "major surgery" blueprint. The goal is a **native backend**
where the daemon owns sessions end-to-end and the client is a thin renderer — the same shape as
Claude Code (supervisor + background sessions + agent view) and Codex (`codex agents/resume/queue`).

## Target shape

```
supervisor (launchd) ── coordinator ── per-session worker (durable sqlite)
        │                                     │
        │                                     ├── owns tools (extensions loaded session-side)
        │                                     ├── owns state (Working/Needs input/Idle/Done/…)
        │                                     ├── owns questions  (pi.question doc)
        │                                     └── owns goals      (pi.goal doc)
        ▼
thin client  (pi client / pi agents / ← agent view)  — render + send only
```

Principles:
- **Everything durable**: session state, questions, goals, tool execution live in the durable store
  (session sqlite) — no side files, no client-held state.
- **Thin client**: no tool ownership, no lifecycle ownership.
- **Native commands**: `pi server`, `pi client`, `pi agents`, `pi resume`, `pi queue` are first-class,
  not experimental.

## Current state (what is already native vs bolt-on)

| Layer | Now | Target |
|---|---|---|
| Supervisor / residency | launchd KeepAlive + coordinator + on-demand worker (experimental graph) | native graph |
| Session durability | durable sqlite, client-independent (verified) | same |
| Session-owned tools | **A7.1 done** (`experimental/durable/extension-tools.ts`): extensions loaded, `ToolDefinition`s installed into the durable `Registry` (`defineTool`, headless ctx). Verified: background `web_search`. | same, plus UI tools |
| Agent view | `experimental/client-tui.ts` (`←` / `pi agents`) | native |
| State model | derived from the session sqlite (`tasks.status`, mtime) + heuristics | from durable docs/services |
| Questions (needs input) | `request_input` writes session-scoped `pi.question` doc (A7.2 partial) | + answer path + view |
| Goals | extension, per-session **file** `~/.pi/agent/goals/*.json` + subprocess evaluator | **durable `pi.goal` doc + service** |

## Dependency-ordered plan

1. **Native durable state docs** (foundation everything reads)
   - `pi.question` — session scope — **defined** (`experimental/durable/request-input.ts`).
   - `pi.goal` — session scope — to add; replaces the goal file.
   - Agent-view state derived from durable docs, not `statSync(mtime)`/`hasInteractiveToolCall`.
2. **Native answer path for `pi.question`** (completes needs-input)
   - Blocker found: `harness.documentState(token, …)` is **read-only** (`AttachedReplicatedState`);
     writes only happen inside a **commit transaction** (`tx.doc(Doc)`). A client-callable service
     therefore needs either (a) a public harness commit/transaction entry, or (b) a new remote
     service that runs a commit, or (c) reuse the **submission** channel: the client answers with
     `AgentController.prompt(...)` (durable submission) and the tool consumes it.
   - Recommended: (c) — reuse durable submissions; no new protocol surface.
3. **Agent view reply-in-peek** — read `pi.question`, show `needs input`, submit the answer.
4. **Promote the daemon to the native graph**
   - Move `experimental/{coordinator,session-worker,server,client,daemon-commands,client-tui}` into the
     native coding-agent graph; make `pi server/client/agents` first-class.
   - Resolve `check:entry-graphs` / `check:runtime-deps` (published `main.ts` must not import the
     daemon/protocol deps) by giving the daemon its own entry graph rather than hiding it in
     `experimental/`.
5. **Notifications** (needs-input / finished / failed), **worktree isolation**, **`agents --json`**.

## Progress log
- A7.1 — session owns extension tools — **done** (`71d2f4b24`).
- A7.2 — durable `pi.question` doc + `request_input` tool — **partial** (doc + tool written; answer
  path + view pending, see step 2).
- Goal status bar shows the active goal (config `de1e7b9`); **goal is still file-based → must move to
  `pi.goal` durable doc** under step 1.
