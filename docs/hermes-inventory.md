# hermes inventory (this machine)

Read-only survey of `~/.hermes` (what C / "captain" must eventually replace). No secrets recorded.

## Process & supervision
- **launchd job `ai.hermes.gateway`** → `~/Library/LaunchAgents/ai.hermes.gateway.plist`.
  KeepAlive, `HERMES_SUPERVISED_CHILD=1`, `HERMES_HOME=/Users/linull/.hermes`.
- Runs a Python venv: `/Users/linull/.hermes/hermes-agent/venv` (Python 3.11.16),
  argv `python -m hermes_cli.main gateway run --external-supervisor`.
- **Uptime ~30 days** (current gateway pid 58297), wrapped by `hermes_cli.stderr_timestamp`
  → `logs/gateway.error.log`.
- `gateway_state.json`: `kind=hermes-gateway`, `gateway_state=running`, `active_agents=0`,
  `code_version=0.21.0`.

## Channels
- **One platform: `qqbot`** — state `connected`.
- WebSocket `wss://api.sgroup.qq.com/websocket`; **session times out roughly hourly
  (`code=4009 Session timed out`) and auto-reconnects** — this is what shows up as QQ traffic.
- `channel_directory.json`: one DM (`qqbot`), id redacted.
- `platforms/pairing/`: `qqbot-pending.json`, `qqbot-approved.json`, `_rate_limits.json`.

## Model
- Default `agnes-2.5-flash` through a custom provider `https://apihub.agnes-ai.com/v1`
  (the same Agnes provider pi already uses).

## Agent runtime (config.yaml highlights)
- `agent.max_turns=500`, `reasoning_effort=medium`, `fast_auto_seconds=60`.
- `terminal`: backend `local`, cwd `.`, timeout 180s, container 1 CPU / 5120 MB / 51200 MB disk,
  `container_persistent=true`, `lifetime_seconds=300`.
- `browser`: backend `browser-use`, inactivity timeout 120s.
- `tool_loop_guardrails` (warn/hard-stop thresholds), `compression` (threshold 0.5, target 0.2,
  protect_last_n 20, checkpoint optional).

## Persistent state / features
| Dir | What |
|---|---|
| `cron/` | `jobs.json` (5 jobs, mostly **script-only** `no_agent: true`), `executions.db`, `notepad.db`, lock files |
| `memories/` | `MEMORY.md` (~3.9 KB) + lock |
| `skills/` | 16 skill dirs (apple, autonomous-ai-agents, creative, devops, …) |
| `kanban.db` | task board (~118 KB) + `kanban/` |
| `sandboxes/` | `singularity` |
| `runtime/` | `active_sessions.json` (+ lock) |
| `scripts/` | reminder scripts (daily-class, network-exp, open-day, project-deadline) |
| `bin/` | `browser`, `browser-use`, `browser-use-tui`, `browseruse` wrappers |
| `logs/` | `gateway.log`, `gateway.error.log`, `ssh-ping-log.txt` |

### cron jobs (names only)
- `ssh-ping-monitor` — `*/10 * * * *` (script)
- `每日课程提醒` — `30 7 * * 1-5` (script)
- `设置texlua公开` — one-shot (script)
- `网络课程综合实验提醒` — one-shot (script)
- `周二上午有课提醒` — one-shot (script)

## Implications for C ("captain")
- Same supervision shape as pi's daemon: a **launchd-supervised, permanently running gateway**.
- Today it exposes exactly **one platform (QQ bot)**; pairing + rate limits are part of the channel
  contract.
- LLM is Agnes — pi already has that provider, so no new credential story is needed.
- Persistent state = cron (mostly scripts), memory, skills, kanban, sandboxes.
- It is a **Python** codebase, separate from pi (Node/TS).
