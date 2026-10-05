# pi 1.0.2 -> 1.0.3 steal list (researcher subagent)

## Question

What did the pi coding agent change from **1.0.2 → 1.0.3** (npm `@earendil-works/pi-coding-agent`, latest = 1.0.3), and specifically what should the `github.com/linull24/pi` **`custom`** fork cherry-pick, including exact commits/files and conflicts against its daemon / durable `pi.question` / goal / QQ side-channel / Agent View+captain / promote / TUI-wheel work?

## Evidence

- npm: `dist-tags.latest = 1.0.3`; published artifacts `earendil-works-pi-coding-agent-1.0.{2,3}.tgz` (I unpacked both and diffed).
- Upstream repo: `github.com/earendil-works/pi` (tags `v1.0.2=cd32f772`, `v1.0.3=d78dc83d`). `raw.githubusercontent.com/.../v1.0.3/packages/coding-agent/CHANGELOG.md` → HTTP 200 (authoritative changelog).
- Fork: `github.com/linull24/pi` branch `custom` tip `26d9aed0`.
- **Critical finding:** `git merge-base custom v1.0.3 == b2b5c42f` (the commit *just below* the v1.0.3 tail). `git log custom..v1.0.3` returns **only 5 commits**. The fork does **not** sit on plain 1.0.2 — it already contains 18 of the 23 commits that compose v1.0.3.
- Empirical cherry-pick test in a scratch worktree of `custom`.

## 1) 1.0.2 → 1.0.3 change table

| Change (from v1.0.3 CHANGELOG) | Commit | In fork? |
|---|---|---|
| **Azure Foundry Chat Completions**; provider renamed `azure-openai-responses`→`azure` (**breaking**) | `a37306d4` | ❌ **missing** |
| Codemode `image()` saves to temp file + returns path | `d677d0ee` | ✅ |
| Output files (truncated output / MCP binary / codemode images) chmod `0600` | `d677d0ee` | ✅ |
| `Home`/`End` always editor line start/end; transcript top/bottom → `Ctrl+Home`/`Ctrl+End` | `6100fe5a` | ❌ **missing** |
| Fix OAuth subscription login `refresh_token_invalidated` after cancelled refresh | `bde882c7` | ✅ |
| Fix codemode dying after pnpm global update/removal + restart hint | `1b094148` | ✅ |
| Fix dead-terminal `read/setRawMode EIO` reported as crash | `4c6b724e` | ✅ |
| `durable`: `FileSystem.watch` (node watcher + Windows poll fallback) | `a8451081`,`864777ba`,`be882f3f` | ✅ |
| `durable`: bounded read tool via `BinaryReader.scanLines` | `a19c09d9` | ✅ |
| `durable`: windowed shell output with counted skips | `cdf79797` | ✅ |
| `durable`: bounded binary/dir readers, argv exec with stream info | `4748c627` | ✅ |
| `durable`: configurable progress commit intervals | `674d64f0` | ✅ |
| `durable`: Windows flushFile / env-test fixes | `1543dd8f`,`f5d20047`,`acfc6019`,`2e63fcdf` | ✅ |
| `durable`: CI test stub + macOS watch startup race | `1965a806` | ✅ |
| Nix model-catalog pin bump | `0b7287ce` | ❌ **missing** |
| Changelog "New Features" entries | `2a12fa4e` | ❌ (docs) |
| Release: bump **all** packages + lockfiles to 1.0.3 | `d78dc83d` | ❌ (skip) |

Net: 1.0.3's only *new features* are Azure Foundry + codemode image-to-file. Everything else is durable refactor + bug fixes — **the fork already has almost all of it.**

## 2) Ranked steal list

1. **`6100fe5a` — Home/End keybinding fix.** Clean apply; tiny; affects every fullscreen user. **Take it.**
2. **`a37306d4` — Azure Foundry Chat Completions** (33 files, +559/-188). Take **iff** you want Azure/Foundry (incl. `azure/deepseek-v4-pro`, relevant to DeepSeek users). Clean apply, but it's a **breaking provider rename**; consider adding an `azure-openai-responses` alias (upstream did not).
3. **`0b7287ce` — Nix model-catalog pin.** One line; take only if you build via Nix.
4. **`2a12fa4e` — changelog text.** Optional/docs; conflicts unless #2 is applied first.
5. **`d78dc83d` — release bump.** **Do not cherry-pick** (bumps every monorepo package + lockfiles). Skip; regenerate locks if needed.

**Leverage-from-your-own-tree:** the fork already merged the durable `FileSystem.watch` / `scanLines` / windowed-output commits, but a targeted grep found **no call sites** in `packages/coding-agent/src/experimental` (only `packages/coding-agent/src/extensions/llama/client.ts` has its own `watch`). The daemon may still poll; adopting the new watch/bounded readers could replace polling for session-state/`pi.question`/resume.

## 3) Exact paths / commits

- Azure: new `packages/ai/src/api/azure-openai-config.ts`, `packages/ai/src/providers/azure.ts`, `azure.models.ts`; edits `packages/ai/src/providers/all.ts`, `models.generated.ts`, `env-api-keys.ts`, `types.ts`, `src/api/azure-openai-responses.ts`, `scripts/generate-models.ts`, `test/azure-openai-completions.test.ts`; `packages/coding-agent/src/core/model-resolver.ts:25` (`azure-openai-responses`→`azure`) + `test/model-resolver.test.ts`.
- Home/End: `packages/tui/src/keybindings.ts:98-106,208-209`; `packages/coding-agent/docs/keybindings.md:60-61,116-117`; `packages/tui/test/keybindings.test.ts`; `packages/tui/test/tui-alt-screen.test.ts`.
- Nix: `nix/model-catalog.json` (fork blob `cf677d71` = the "before", so clean).
- Suggested sequence: `git cherry-pick a37306d4 6100fe5a 0b7287ce` then hand-merge `2a12fa4e` if desired.

## 4) Conflicts with fork features

Conflict surface (files changed by the 5-commit delta **and** by the fork's own 45-file delta):
- `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json`, `packages/coding-agent/package.json` — version/lock noise only.
- `packages/tui/test/tui-alt-screen.test.ts` — fork's hunk is the overlay-wheel assertion (~line 1981); upstream's hunks are the Home/End tests (~lines 576, 898). **Different regions → clean auto-merge** (verified).

Cherry-pick test on `custom`: `a37306d4` clean, `6100fe5a` clean, `0b7287ce` clean; `2a12fa4e` = 1 CHANGELOG conflict; `d78dc83d` = 3 conflicts (version bumps).

**No** delta file touches daemon/server/client/agents/resume/queue, durable `pi.question`, goal, QQ side channel, Agent View, captain, promote/authorization, or the TUI wheel code (`packages/tui/src/tui*.ts`, `overlay-wheel-scroll.test.ts`). Semantic caveats:
- `6100fe5a` mutates global TUI keybindings. Grep found no `altScreen.*`/home/end bindings in `experimental/`, so Agent View/client TUI are low-risk — but re-run TUI tests and re-check any Home/End hints.
- `a37306d4`'s rename only bites if fork configs reference `azure-openai-responses` (grep: `azure*` appears only under `packages/ai`, not the coding-agent custom code) → clean.

## Confidence & Open Questions

**Certain:** npm latest is 1.0.3; upstream repo + changelog; the fork's base is `b2b5c42f` and the v1.0.3 delta is exactly 5 commits; 3 of them cherry-pick cleanly; no fork-feature file is touched. **Uncertain:** whether the fork actually wants Azure (product call) and whether `experimental/` wraps the durable watch behind an abstraction I didn't grep for. **Resolve by:** `git cherry-pick a37306d4 6100fe5a 0b7287ce` on a branch and run the TUI + durable test suites.

Sources: `npm view @earendil-works/pi-coding-agent` (dist-tags/time); `github.com/earendil-works/pi` tags `v1.0.2`/`v1.0.3` and commits `a37306d4`, `6100fe5a`, `0b7287ce`, `2a12fa4e`, `d78dc83d`; `raw.githubusercontent.com/earendil-works/pi/v1.0.3/packages/coding-agent/CHANGELOG.md` (HTTP 200); `github.com/earendil-works/pi/releases/tag/v1.0.3`; `github.com/linull24/pi` branch `custom` (`26d9aed0`).
