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

### A ↔ C relationship (settled)
- **C = A ⊕ Δ** — C is A's base plus C's own overlay (a git branch / worktree). C reads A; C has **no
  write path into A**.
- **Δ is git.** The increment is simply C's git diff/commit on its own branch — no bespoke delta
  format, no spec language, no artifacts.
- **C hands Δ to A; A applies it.** A consumes the diff into its own tree under its own commit. C
  never writes A and never touches the A/B machinery.
- **Then the traditional A/B runs** — the existing checkpoint/reload path, unchanged. The heartbeat
  stays a clean resilience mechanism (checkpoint + verify + rollback); promotion is **not** bolted
  onto it and does not pollute its protocol. No "dirty C proposes its commit straight into A/B".

### Authorization is an independent abstraction (settled)
Authorization is a separate axis, exposed **only as an abstract provider interface**. The design
deliberately **excludes any evidence system**: no tickets, no hash binding, no audit artifacts.
A provider answers a tiered yes / no / pending, and nothing else flows through it.

| Tier | Trigger | Use for |
|---|---|---|
| **T1 — explicit user** | an IM reply/button, a notification action, a TUI operation | high risk, irreversible, credentials, the outside world |
| **T2 — semantic / spec** | the change conforms to a declared rule/spec | medium risk with a checkable rule |
| **T3 — main-agent judgment** | the agent decides on its own | low risk, reversible, internal-only |

Providers are pluggable and independent of both C and the apply path. **A decides the tier** (C does
not declare its own requirement).

### C lifecycle (settled)
- **C is a system-level, absolutely persistent process** — a replacement for hermes (an always-on
  gateway), independent of pi sessions. It is not owned, started, or stopped by a TUI session; it
  lives outside us.
- **C is never destroyed.** It is permanent infrastructure.
- **C solves its own problems.** Baseline drift, conflicts, its own garbage collection, and internal
  failures are C's concern — not the promotion path's.
- **Δ is a byproduct.** C's purpose is the system-level gateway; producing promotable changes is
  incidental output, expressed as a **git** delta.
- **No pollution.** C must not pollute A or the system. Pollution = writing outside the delta's
  declared scope, leaving side effects behind (processes, files, launch agents), leaking secrets, or
  weakening safety controls. Every promotion therefore still goes through review + authorization
  (the three tiers), and the applier is **A**, never C.

### Mechanism (settled direction)
1. **C**: an independent, absolutely persistent system process (hermes replacement), never destroyed,
   self-solving. It is automode-exempt on its own surfaces.
2. **Δ**: whatever C wants promoted is expressed as a git delta — a declared subset, via git.
3. **Hand-off**: C offers the delta; **A** applies it under A's own commit.
4. **A/B**: the existing checkpoint/reload path runs afterwards, untouched.
5. **Authorization**: an abstract provider per tier (T1/T2/T3) — no evidence system — gating anything
   that could pollute.
6. **Side channel**: `experimental/side-channel.ts` (transport-agnostic) is the T1 entry surface —
   IM out via notifications, IM in answers a durable `pi.question` or steers the session.

### Agent View: the C divider (future)
The agents page keeps its activity-time sort and adds a **divider**: **pi (A) sessions on top**,
then **C below**. The C section is a **single entry** — one session, one entry point — not one row per
gateway; the different gateways live *inside* that session and are visible to the LLM operating in C.
Because C is an independent process ("not our concern"), the page needs a **C source adapter**
(registered like a channel adapter) that yields the one C entry, plus an `origin` marker
(`"pi" | "c"`).
