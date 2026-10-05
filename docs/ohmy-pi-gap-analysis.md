# OhMyPi (omp) vs our setup — feature gap analysis

OhMyPi (`@oh-my-pi/*`, homepage https://omp.sh, v18.6.1) is a pi distribution with a large
extension ecosystem. This compares its first-party capabilities with what we have, so we can fill
gaps deliberately (phase 1 leans on memory).

## First-party OhMyPi packages
| Package | What it is | Ours |
|---|---|---|
| `@oh-my-pi/pi-coding-agent` | the CLI agent (a pi fork) | ✅ `@earendil-works/pi-coding-agent` (our fork + custom branch) |
| `@oh-my-pi/pi-ai` | unified LLM API, provider discovery | ✅ `@earendil-works/pi-ai` + our `router`/roles + `models.json` |
| `@oh-my-pi/pi-agent-core` | agent core (transport, state) | ✅ pi-agent-core |
| `@oh-my-pi/pi-tui` | TUI library | ✅ pi-tui |
| `@oh-my-pi/pi-catalog` | bundled model DB + provider discovery/classification/equivalence | ⚠️ partial: `models.json` + provider catalog + `models-store.json` |
| `@oh-my-pi/pi-natives` | **Rust bindings**: PDF conversion, audio, WebRTC, grep, clipboard | ❌ we shell out to tools |
| `@oh-my-pi/pi-mnemopi` | **local SQLite memory engine** | ❌ **gap — phase 1** |
| `@oh-my-pi/omp-stats` | local observability dashboard for usage stats | ⚠️ we show per-session cost in the footer only |
| `@oh-my-pi/snapcompact` | bitmap-frame context compression for vision LLMs | ⚠️ we have standard compaction |
| `@oh-my-pi/pi-wire` / `pi-utils` / `omptype` | shared protocol types / utils / schema validation | ➖ internal to us |

## Ecosystem (community) worth borrowing
- `omp-hooks-plus` — install-once **Claude Code hook compatibility** (we have our own hooks/extensions).
- `@oh-my-pi/swarm-extension`, `omp-fabric` — orchestration runtimes (we have subagents + Agent View).
- `@tickernelz/omp-telegram`, `omp-telegram` — Telegram bridges (we have the side channel + QQ).
- `omp-web` / `@kahme247/ompweb` — web UIs (we deliberately stay TUI).

## Gaps to fill (ordered)
1. **Memory** (`pi-mnemopi`-class): a durable local memory store the agent reads/writes across
   sessions. Phase 1. Ours would be a durable doc/service (fits our sqlite + `pi.*` doc pattern),
   not a new package.
2. **Observability** (`omp-stats`-class): a local usage/cost summary (per session/model/day).
3. **Model catalog** (`pi-catalog`-class): richer provider/model metadata + equivalence for the
   router (helps role→model resolution and failover).
4. **Native capabilities** (`pi-natives`-class): PDF/audio/grep/clipboard without external binaries
   — only if a real need appears.

## Deliberately not copying
- Web UIs (`omp-web`) — we stay in the TUI.
- Their model catalog **format** — we keep `models.json` + our router.

## Phase-1 tasks (from the user)
1. This comparison → fill gaps (start: memory).
2. captain-side polish (state model defect I, QQ outbound).
3. use `monitor_start` more proactively (long/noisy/asynchronous work).
4. monitor should also drive **Codex** and **Claude** as background jobs and return one terminal
   result (then "the rest is enough").
