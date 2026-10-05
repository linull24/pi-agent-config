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

## Assistant/supervisor boundaries (clean split)

Independent model work must be split by **how much context it may share**:

| Consumer | Session | Rationale |
|---|---|---|
| **Security review** (automode classifier, danger-monitor) | **independent**, own session | must not be influenced by the working session's context; it gates actions |
| **Goal supervision** (met / not-met / impossible / blocked) | **reuse** the same supervisor session as hint | both read the conversation and judge/assist; no need for isolation |
| **Hint** (likely user replies / next steps) | **reuse** the goal-supervisor session | same context, different prompt; one long-lived session avoids per-call cost |

Rules:
- **Hint auto-triggers after a turn ends** (client poller on the current session's transition to
  `needs-instructions`), and **Tab auto-completes** the composer with the top suggestion
  (Tab again cycles).
- Goal evaluation and hint share one role/model (`hint` role; mirrors the goal supervisor) — and in
  future one long-lived session rather than a fresh process per call.
- Security review stays independent (already true: `@czottmann/pi-automode` classifier runs in its
  own context).

## C is the playground, A is the base — promotion via A/B, IM as the side channel

Corrected model (this supersedes the earlier "A is the playground" reading):

- **C = playground.** The agent owns it and has high autonomy there: it can fix *itself*, wire up
  new integrations (QQ bot / IM gateway), and experiment. C is isolated and disposable — breaking
  it must not touch A.
- **A = base.** The stable runtime the user relies on. It changes only when a change is *promoted*
  out of C.
- **A/B = the promotion gate.** A change moves `C → A` through the normal mechanism: apply →
  `heartbeat` checkpoint (B) → verify → keep, else roll back.
- **IM = the side channel.** Out-of-band in both directions, for when the TUI is running on the
  computer but the user has walked away:
  - outbound: `emitAgentNotification` (`needs-input` / `finished` / `failed`) → an IM channel;
  - inbound: an IM message answers a durable `pi.question`, or submits a new instruction, and the
    session resumes.

### The sweet-spot scenario
Leave a TUI running at the desk, go out. Something breaks. The agent attempts the fix in **C**. If it
needs a decision it emits a notification → the user answers from the phone over IM → the agent
continues. A validated fix is **promoted to A** through A/B (checkpoint → verify → reload), so it
survives the next restart.

### Who controls C
- The **agent** controls C — that is what "playground" means: full autonomy inside C.
- The **user** controls the promotion `C → A`, mediated by the A/B gate (checkpoint + verify + reload).
- The **IM side channel** is the user's remote override while away.

### Control layers (what the playground autonomy does *not* include)
| Layer | Owner | Mechanism |
|---|---|---|
| C (playground) | agent | isolated worktree + its own extension/config overlay |
| A (base) | user, via promotion | A/B gate: checkpoint → verify → reload |
| B (checkpoints) | daemon | `heartbeat` |
| side channel | user | `emitAgentNotification` (out) + durable `pi.question` (in) |
| secrets / credentials | user | never copied into C; read at request time only |

### A ↔ C relationship (corrected)
- **C is a derived overlay**: `C = A ⊕ Δ` — A's base plus C's own extension/config overlay and an
  isolated worktree. C reads A; C **never writes A**.
- **C publishes a subset increment Δ** (a declared, reviewable delta). Publishing is all C can do.
- **A is the applier.** The *update action belongs to A, not C*: A **pulls** Δ, validates it, obtains
  authorization, applies it under a checkpoint, verifies, and keeps or rolls back. The trusted side
  performs the mutation; C is untrusted input. (Security: a playground that can write the base is not
  a playground.)

### Authorization is an independent axis — three tiers
Authorization is neither part of C nor part of the promotion mechanism. It is a separate, pluggable
decision surface. A delta declares the tier it requires.

| Tier | Trigger | Use for |
|---|---|---|
| **T1 — explicit user** | an IM reply/button, a notification action, or a TUI operation | high risk, irreversible, touches credentials or the outside world |
| **T2 — semantic / spec** | the delta conforms to a declared spec or policy (a deterministic check, or an independent reviewer) | medium risk with a machine-checkable rule |
| **T3 — main-agent judgment** | the agent decides on its own | low risk, reversible, internal-only |

Authorization providers are pluggable and independent of the transport: IM in (the side channel), a
notification action button, a TUI confirm, or a config rule that auto-approves T2/T3.

### Δ (the increment) and the applier
- Δ = `{ files, manifest }`; the manifest declares `scope`, `riskClass`, `requiredTier`, `verify`.
- Applier = an A-side component (`pi promote`): read Δ → run the T2 policy check → resolve the
  required tier → obtain T1/T3 authorization → `heartbeat` checkpoint → apply to A → verify → keep,
  else roll back.

### Mechanism v1 (what to build)
1. **C playground**: a worktree (`<repo>/.pi/worktrees/agent-*`) plus a C-local extension/config
   overlay, automode-exempt inside C. (Worktree isolation already exists for dispatched agents.)
2. **Δ publish**: C writes a manifest + files; it does not touch A.
3. **Applier** (`pi promote`, A-side): pull Δ → policy (T2) → tier → authorize → checkpoint → apply →
   verify.
4. **Side channel**:
   - out: `registerNotificationChannel(imChannel)` — QQ bot via the bot API (or a local bridge);
   - in: a bridge receives IM messages and writes to the durable channel — answer a pending
     `pi.question` (reuse `Questions`), else submit a new instruction to the session.
   - `experimental/side-channel.ts` already provides the transport-agnostic core.
