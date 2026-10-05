# pi agent config

This repository is my [pi](https://github.com/earendil-works/pi) agent configuration: role
definitions, extensions, prompt templates, and the hooks for the native daemon. Secrets are not
committed; use the `*.template` files.

## Layout

- `agent-config.json` — the single entry point. Roles bind a model (candidate list) plus a prompt
  under `roles/<role>/prompt.md`, and optional subagent metadata. The `agent-config` extension
  applies them everywhere (settings default model, pi-automode classifier, pi-supervisor,
  generated `agents/*.md`, cron per-job models). The `router` extension reads `daily` / `research`
  / `failover`.
- `extensions/` — local extensions:
  - `agent-config/` — applies the central roles.
  - `router/` — virtual `router/auto` model (daily → DeepSeek, research → strong model, failover).
  - `heartbeat/` — git checkpoints, `/rollback`, and the `heartbeat` mechanism (alive/reload/rollback).
  - `self-refine/` — exempted self-modification mode (`/selfrefine`).
  - `autommonitor/` — `/autommonitor` alias for pi-automode.
  - `ban-openrouter/`, `ban-deepseek-pro/`, `ban-openai/` — model bans.
  - `constraints/` — cross-process provider rate limiting.
  - `danger-monitor/` — regex guard for destructive commands.
  - `web-search/` — `web_search` tool (DeepSeek native → OpenAI → DuckDuckGo).
  - `subagent/` — subagent delegation.
- `roles/<role>/prompt.md` — per-role prompts.
- `prompts/` — slash-command prompt templates.
- `models.json` — extra providers (e.g. Agnes); API keys use `!command` so no secret is stored.
- `APPEND_SYSTEM.md` — system-prompt additions (resilience + self-refine contract).

## Secrets

`auth.json` is **not** committed. Create it from the template and authenticate:

```sh
cp auth.json.template auth.json
# then either edit it, or simply run /login inside pi
```

Other secrets referenced but not stored here: the Agnes key lives in `~/.hermes/.env`
(`HERMES_CUSTOM_APIHP_AGNES_AI_COM_API_KEY`), read by `models.json` at request time.

## Install

```sh
pi install npm:@czottmann/pi-automode
pi install npm:@fradser/pi-monitor
pi install npm:@monotykamary/pi-supervisor
pi install npm:@patimweb/pi-cron
pi install npm:pi-scratchpad
```

The full intent and history live in `~/.pi/plan.md`.
