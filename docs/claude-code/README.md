# Claude Code docs (local mirror)

Markdown mirrors of the official Claude Code documentation, saved for offline reference
while building pi parity features (Agent View, session picker, interactive mode).

Source: `https://code.claude.com/docs/en/<page>.md` (each page has a `.md` variant).
Mirrored: 2026-10-05 against Claude Code **v2.1.220** (local install).

| File | Upstream page |
|---|---|
| `agent-view.md` | `/docs/en/agent-view` — Agent View (`←`), sessions grouped by state, dispatch |
| `interactive-mode.md` | `/docs/en/interactive-mode` — keyboard shortcuts, `←` on empty prompt |
| `cli-reference.md` | `/docs/en/cli-reference` — `claude agents`, `--resume`, etc. |
| `sub-agents.md` | `/docs/en/sub-agents` |
| `settings.md` | `/docs/en/settings` — `leftArrowOpensAgents`, `defaultToAgentsView` |
| `slash-commands.md`, `hooks.md`, `memory.md` | supporting references |
| `overview.md`, `quickstart.md` | getting started |
| `llms.txt` | full documentation index (discover other pages) |

Refresh: `curl -sL -o <page>.md https://code.claude.com/docs/en/<page>.md`
