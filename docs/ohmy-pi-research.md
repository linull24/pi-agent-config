# OhMyPi (omp) research — by the `researcher` subagent

## Question
What are the most interesting features of **OhMyPi** (`omp`, `omp.sh`, npm scope `@oh-my-pi/*`, v18.6.1), prioritising (a) free-model access, (b) direct agent-to-agent conversation, and (c) other notable subsystems — with exact package names/versions, mechanisms, and a "steal list".

## Evidence

**Core identity / versions**
- `@oh-my-pi/pi-coding-agent@18.6.1` (CLI `omp`), all scope packages at **18.6.1**, published `2026-10-04`. Repo: `github.com/can1357/oh-my-pi` (MIT), site `omp.sh`. Install: `curl -fsSL https://omp.sh/install | sh` / `brew install can1357/tap/omp` / `bun install -g @oh-my-pi/pi-coding-agent`.
- Deps confirm sibling packages: `@oh-my-pi/pi-ai`, `pi-catalog`, `pi-agent-core`, `pi-tui`, `pi-natives` (+ 6 platform addons), `pi-mnemopi`, `snapcompact`, `omp-stats`, `pi-wire`, `omptype`, `pi-utils`, plus **full OpenTelemetry OTLP stack** (traces/metrics/logs).
- `@oh-my-pi/pi-catalog` ships `src/models.json`: **74 providers, 5,618 model rows, 1,782 at $0 in/out** (my analysis of the bundled file).

**Free-model mechanism (from package source)**
- `pkgs/pi-catalog/package/src/provider-models/cline-pass.ts` — `tier: "subscription" | "free"`; e.g. `cline-free/deepseek-v4.1-flash` "free", 1,048,576 ctx / 384,000 max out, `cost:{input:0,output:0,…}`.
- `provider-models/openai-compat.ts` (lines ~2660-2830): *"Free-tier entries arrive as full OpenRouter-style ids (`deepseek/deepseek-v4-flash`, `poolside/laguna-s-2.1:free`) and ride usage billing at $0 outside the subscription quota — their cost is genuinely zero."* Also documents the anti-pattern: *"an all-$0 roster surfaces every model as 'free' in the picker, which was treated as a bug"*, and *"Zero legs mean 'unpriced upstream', not 'free'."*
- `docs/providers.md:80`: *"For ClinePass, set `CLINE_API_KEY`… OMP refreshes membership from Cline's public recommended-models endpoint… Free-tier models are marked `(free)` and use the same key."*

**Agent-to-agent (core)**
- `docs/agent-hub.md:117`: *"`write agent://<id>` steers or follows up with a normal subagent; `agent://all` broadcasts to visible live peers. Messaging a parked subagent revives it."*
- README line 287: `wait` — *"block until the next background result, peer message, or steering interrupt; message peers and control jobs via `agent://` and `proc://`."*
- README line 167 ships a demo where "the constraints block requir[es] an **IRC DM between peers**"; Agent Hub roster shows "unread **IRC** count"; `dist/cli.js` contains `ircPeers`, `ircRoot`, `ircSelfId`, `irc_message`. `docs/task-agent-discovery.md:309`: *"Outbound peer messaging requires `write` in the child tool list and IRC enabled; inbound steering does not."*

**Agent-to-agent (third-party)**
- `omp-fabric@1.25.19` — keywords include `swarm, actors, steering, mesh, workflows`; `docs/agents.md` documents `agents.spawn/create/run/tell/wait`, `residency:"durable"`, topics+mailboxes, "acknowledged mesh control plane", councils, bounded `rlm.query()`.
- `@oh-my-pi/swarm-extension@13.17.0` (official repo path `packages/swarm-extension`, now **404 on main**, 128 versions, last 2026-03-30): YAML DAG pipelines run via `omp-swarm file.yaml` or `/swarm run`.
- `pi-teammate@0.5.0` — *"peer network where every agent is equal… instead of a top-down orchestrator"*, SQLite bus, cross-harness with Claude Code.
- `agent-comms@8.13.13` — *"Cross-harness communication mesh … rooms, DMs, presence… over TCP with zero filesystem dependencies"* (port 19876, gossip + coordinator election).
- `@sjawhar/pi-legion-envoy@7.8.1` — Envoy/NATS messaging where *"inbound messages steer an in-flight turn instead of queueing behind it"*.

**Other**
- `@oh-my-pi/omp-stats` (observability dashboard), `@oh-my-pi/snapcompact` ("Bitmap-frame context compression for vision-capable LLMs"), `@oh-my-pi/pi-mnemopi` (SQLite memory); `docs/memory.md` lists 5 backends (`off|local|hindsight|mnemopi|sharpshooter`).
- `docs/marketplace.md`: *"compatible with the Claude Code plugin registry format"*; `/marketplace add anthropics/claude-plugins-official`.
- README item 15: reads *"Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo"* natively.

## Ranked feature list

1. **`agent://` peer bus + IRC + Agent Hub (core A2A).** Agents talk to each other directly: `write agent://<id>` (steer/follow-up), `agent://all` (broadcast), `read history://` (roster), `wait` (block on peer message/steering), plus `Alt+A` Agent Hub with live transcripts, steering, revive/kill. This is real peer messaging, not just parent→child spawn — *but routing is still rooted/registry-mediated*.
2. **Free-tier gateway catalog (ClinePass + friends).** 1,782 $0 rows; explicit free buckets marked `(free)`; live refresh off Cline's public endpoint. Genuinely free (not "unpriced") for: `cline-pass` free tier, `opencode-zen`/`opencode-go` `*-free`, `zenmux` `*-free`, `vercel-ai-gateway` `*-free`, `openrouter` `:free`, `zai` `*-flash`.
3. **`omp-fabric` programmable agent/mesh runtime.** One `fabric_exec` TypeScript/QuickJS tool composing core tools + MCP + extension tools, with durable **actors**, mailboxes/subscriptions, councils, `fabric-swarm`, recursion, budgets; ships `/fabric chat <agent>` live child conversations.
4. **`/collab` live-session relay.** *"puts your live session on a relay and hands back a link — and a QR"*; `omp join`; read-write vs view-only; client-side sealed frames (Unix socket, never TCP).
5. **Internal URL scheme filesystem (16 schemes).** `pr://`, `issue://`, `agent://`, `skill://`, `conflict://`, `xd://`, `proc://` resolve inside `read`/`grep`/`write` — *"`read pr://1428` returns the same shape as `read src/foo.ts`"*.
6. **Context compression stack.** `@oh-my-pi/snapcompact` bitmap-frame compression + prewalk/compaction + checklist/collapse.
7. **Curated memory.** `retain`/`learn`/`recall`/`reflect`/`memory_edit` with `memory.backend: local | hindsight | mnemopi | sharpshooter`.
8. **Claude-Code-compatible plugin/marketplace + hooks adapter** (`marketplace.json`, `.claude-plugin/`, `@a5c-ai/hooks-adapter-oh-my-pi@6.0.0`).
9. **Observability.** OTLP exporters wired into `pi-coding-agent`; `@oh-my-pi/omp-stats` local usage dashboard; `@oh-my-pi/pi-metaharness` benchmark runners (not published on npm).
10. **Routing knobs.** 9 roles (`default/smol/slow/plan/commit/vision/task/advisor/tiny`), `retry.fallbackChains`, path-scoped `enabledModels`, round-robin credential rotation.
11. **Native Rust core.** In-process ripgrep/glob/brush-bash (67 builtins, no fork/exec), tree-sitter AST (`pi-ast`), LSP/DAP, `pi-iso` worktree isolation.
12. **Misc differentiators.** Advisor (second model reviews every turn), TTSR (regex-triggered mid-stream rule injection), Hashline edits, `web_search` with 23 backends incl. keyless `duckduckgo/startpage/google/ecosia/mojeek/public`.

## Free-model access (exact names)

**In-core free-tier providers (need a key/account but the tier is $0):**

| Provider id | Env var | Free examples (from `models.json`) |
|---|---|---|
| `cline-pass` | `CLINE_API_KEY` | `cline-free/deepseek-v4.1-flash`, `cline-free/mimo-v2.6-flash`, `cline-free/muse-spark-1.3-contributor`, `stealth/space-bunny-alpha` (tier:"free") |
| `opencode-zen` | `OPENCODE_API_KEY` | `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `minimax-m2.5-free`, `laguna-s-2.1-free`, `ling-*`, `longcat-*` |
| `opencode-go` | `OPENCODE_API_KEY` | `longcat-2.5-preview-free`, `ox-alpha-free`, `space-bunny-free` |
| `zai` | `ZAI_API_KEY` | `glm-4.5-flash`, `glm-4.6v-flash`, `glm-4.7-flash` |
| `groq` / `cerebras` | keys | `groq/compound`, `groq/compound-mini`, `qwen-3-coder-480b`, `zai-glm-4.6` |
| `openrouter` | `OPENROUTER_API_KEY` | ~171 `:free`/`-free` ids (`deepseek/deepseek-v4-flash:free`, `arcee-ai/trinity-*:free`, `baidu/cobuddy:free`, …) |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | `minimax/minimax-m3-free`, `nvidia/nemotron-3.5-lightning-free`, `poolside/laguna-s-2.1-free`, `zai/glm-4.6v-flash` |
| `zenmux` | `ZENMUX_API_KEY` | `deepseek/deepseek-v4-pro-free`, `google/gemini-3.5-flash-free`, `anthropic/claude-sonnet-5-free` |
| `kilo` | `KILO_API_KEY` | 226 $0 rows incl. free router/auto entries |
| `nanogpt` / `aimlapi` / `nvidia` / `venice` / `novita` / `fireworks` | respective keys | 508 / 349 / 168 / 44 / 7 / 6 $0 rows (**mostly unpriced-upstream — verify before calling free**) |
| `ollama`/`lm-studio`/`llama.cpp`/`vllm` | optional | **keyless local** |

**⚠️ Caveat:** code explicitly warns zero-cost ≠ free. Only `pricingStatus:"free"`, ClinePass free bucket, and `:free`/`*-free` ids are honest free; big $0 counts (kilo/nanogpt/aimlapi/nvidia) are largely unpriced upstream.

**Pi-ecosystem free-access packages worth knowing (pi-package format, not omp-native):**
- `pi-opencode-direct@0.1.7` — *"Keyless OpenCode Zen free models for Pi … No OpenCode installation, login, API key… Requests are anonymous by default… the literal `public` bearer is used"* (registers provider `opencode-zen-free`). `pi:{extensions:['./src/index.ts']}`.
- `opencode-pi@1.4.0` — bridges local `opencode` CLI free models (`opencode/deepseek-v4-flash-free`, `big-pickle`) into Pi, *"No OpenCode login is required for the bundled free OpenCode models."*
- `pi-clinepass@0.1.7` — ClinePass catalog + billing meter + free models for Pi.
- `free-coding-models@0.5.97`, `nimping@0.1.2`, `freemodelfinder` — free-model latency/availability discovery.
- omp-specific: `omp-router` (in `github.com/bacnh85/omp-extensions`) connects omp to any OpenAI-compatible router (9router/OmniRoute/yardmaster) with `/v1/models` discovery.

## Agent-to-agent (exact packages + mechanism)

| Layer | Package / surface | Mechanism |
|---|---|---|
| **omp core** | built-in `agent://`, `history://`, `proc://`, `task`, `wait`, `write` | Registry/roster of live+parked agents; `write agent://<id>` steers or wakes, `agent://all` broadcasts; `wait` blocks on "next background result, **peer message**, or steering interrupt"; inbound steering needs no `write`, outbound does; UI = Agent Hub (`Alt+A`) |
| **omp core (human↔agent)** | `/collab`, `omp join` | relay + QR; host-authoritative hub, guests never peer; Unix-socket IPC |
| **official repo, now removed** | `@oh-my-pi/swarm-extension@13.17.0` | YAML DAG → execution waves; agents share workspace FS; `/swarm run` or `omp-swarm` |
| **third-party OMP** | `omp-fabric@1.25.19` (`github.com/tickernelz/omp-fabric`) | `fabric_exec` program defines agents; durable **actors** with mailboxes/topics/subscriptions and CAS mesh state; `agents.tell/ask/steer/followUp/stop`; `/fabric chat`, swarm/council/rlm skills |
| **third-party OMP** | `@sjawhar/pi-legion-envoy@7.8.1` | Envoy subjects over **NATS**; inbound messages steer the in-flight turn; role claims with receipts |
| **Pi-side ports** | `pi-fabric@0.106.0`, `pi-teammate@0.5.0`, `agent-comms@8.13.13` | pi-fabric = omp-fabric for Pi; pi-teammate = peer SQLite bus incl. Claude Code peers; agent-comms = cross-harness TCP mesh (rooms/DMs/presence, port 19876) |
| **Other** | `jeopi-swarm-extension@16.6.2`, `@omercnet/paseo-omp`, `@tickernelz/omp-telegram` | fork swarm; client integrations |

## Steal list (ranked by value / portability)

1. **`agent://` peer messaging + `wait` wake-on-message semantics** (core omp; concept, MIT). Highest-value idea: treat peers as addressable FS paths, let `wait` multiplex background results *and* peer messages. Adopt: `agent://<id>`, `agent://all`, `history://`, inbound-steering-without-write-permission, unread-IRC badge.
2. **ClinePass free-tier integration** (`@oh-my-pi/pi-catalog` logic + `pi-clinepass@0.1.7` for Pi). Free models marked `(free)`, same key, live membership refresh, honest cost display that never shows subscription models as free.
3. **`pi-opencode-direct@0.1.7`** — keyless/anonymous `public`-bearer OpenCode Zen free provider. Easiest single free-access win for a Pi distribution.
4. **`@oh-my-pi/omp-stats` + OTLP wiring** — local usage dashboard + OTLP traces/metrics/logs already plumbed; low effort, high observability payoff.
5. **`@oh-my-pi/snapcompact`** — bitmap-frame context compression; novel compaction primitive.
6. **Claude-Code marketplace/plugin compat** (`marketplace.json`, `.claude-plugin/`, `@a5c-ai/hooks-adapter-oh-my-pi@6.0.0`) — instant ecosystem.
7. **`omp-fabric` durable actors/mesh** (if we need true A2A beyond parent-child) — but heavy (QuickJS sandbox, Node 24+, OMP 18.4.4+); steal the *actor + mailbox + topic* model rather than the whole runtime.
8. **Keyless `web_search` fallback chain** (`duckduckgo/startpage/ecosia/mojeek/google/public`) + structured per-site extractors.
9. **Routing knobs**: fallback chains on 429/quota, path-scoped model sets, round-robin credentials.
10. **`@oh-my-pi/swarm-extension` (YAML DAG)** — source is small (`src/swarm/{dag,pipeline,state,schema}.ts`), MIT, in-repo history; good standalone `omp-swarm` runner even though dropped from main.

## Confidence & Open Questions

**Certain:** versions/publish dates (npm 18.6.1, 2026-10-04), catalog size (74 providers / 5,618 models / 1,782 $0), ClinePass free-tier semantics (source + docs quotes), core `agent://`/IRC/`wait` A2A semantics (docs + bundled CLI strings), `omp-fabric` mesh/actors, package names/versions for all third-party packages.

**Uncertain / to verify before relying on:**
- Whether omp exposes **keyless** free LLM access out of the box — docs list `OPENCODE_API_KEY`/`CLINE_API_KEY` for those providers, so core free access appears to require a (free) account; the keyless `public`-bearer trick is proven only in the Pi extension `pi-opencode-direct`.
- How many of the 1,782 $0 rows are genuinely free vs unpriced — the code itself flags this ambiguity; only `:free`/tier="free" ids are trustworthy.
- `@oh-my-pi/swarm-extension` is **removed from `main`** (README 404) though still on npm at 13.17.0 — treat as unmaintained.
- The exact "IRC" protocol spec isn't in the public docs sitemap (only in Agent Hub docs + bundle strings); the full design likely isn't published.
- `github.com/oh-my-pi` org exists (HTTP 200) but its repo list is JS-rendered and couldn't be enumerated; community extensions re-checked via npm instead.
- Some upstream model names (Gemini 3.5/DeepSeek V4/Claude Fable) are from the package's own catalog snapshot and are not independently verified.
