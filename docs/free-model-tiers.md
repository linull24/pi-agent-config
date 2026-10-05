# Free-model abstraction — sources, quality tiers, and how it plugs into roles

Goal: a first-class **free** layer above our model catalog. Free is not one thing: it comes from
different **sources**, and free models are not equally good, so free models are also tagged by
**quality**. Roles then ask for "the best available model of at least quality Q, preferring free".

## 1. Sources of "free"

| Source kind | What it means | Examples |
|---|---|---|
| **keyless** | no credentials at all | `opencode-zen-free` (anonymous, literal `public` bearer); local `ollama` / `lm-studio` / `llama.cpp` / `vllm` |
| **small-config** | a free-tier key, or a toggle + whitelist | OpenRouter `:free` (key + **whitelist**); ClinePass (`CLINE_API_KEY`); Z.AI (`ZAI_API_KEY`, `glm-*-flash`); Groq (`GROQ_API_KEY`, `compound`); Cerebras; Vercel AI Gateway (`AI_GATEWAY_API_KEY`); Zenmux (`ZENMUX_API_KEY`) |
| **quota** | a free daily allowance on an otherwise paid provider | **DeepSeek 5B tokens/day** (incoming) |

Caveat (from omp's catalog): **`$0` ≠ free**. Only `pricingStatus:"free"`, ClinePass's free bucket,
and `:free` / `*-free` ids are honest; big `$0` counts (kilo/nanogpt/aimlapi/nvidia) are mostly
"unpriced upstream".

## 2. Quality tiers (rough, for free models)

`sota > strong > usable > weak > rubbish`

| Tier | Meaning | Free examples |
|---|---|---|
| **sota** | free frontier-class (rare) | Zenmux `anthropic/claude-sonnet-5-free` (verify) |
| **strong** | clearly capable, safe for real work | **DeepSeek** (5B/day quota), `deepseek-v4-flash-free` |
| **usable** | fine for routine/background work | `glm-4.5-flash`, `gemini-3.5-flash-free`, `minimax-m*-free`, `groq/compound` |
| **weak** | light/assist only | **agnes-2.5-flash**, `muse-spark-1.3-contributor-free`, most free `*-flash` |
| **rubbish** | toy/experimental; avoid | `big-pickle`, `space-bunny-alpha`, tiny anonymous models |

Seed classification (rough, per the user): **agnes = weak**, **deepseek = strong**.

## 3. Integration with our roles / router

- Add a **quality** field + a **free** flag to catalog entries (a `free-tier.json` registry or an
  extension over `models.json`).
- A role asks for a *minimum quality*; the router resolves:
  1. the configured primary (paid) model, else
  2. the best **free** model whose quality ≥ the role's minimum, else
  3. a lower tier (degrade), else fail.
- Suggested role floors: `lightest` = weak, `daily` = usable, `hint`/`goal` = usable,
  `research`/`supervisor` = strong, `classifier` = weak.
- A **free policy** knob: `off | prefer-free | free-only` (per role or global). `prefer-free` tries
  free first and falls back to paid; `free-only` never spends.


## 3b. Semantics: **acceptable**, not a chain (user)

A raw fallback chain (try next in order) is wrong, because the **bottom line changes**:

- sometimes the bottom line is **"it must work"** (能用) — cost is irrelevant;
- sometimes it is **"save money"** (省钱) — quality may drop but not below a floor;
- and **rubbish/below-weak models may make things WORSE**, so they are never an acceptable fallback.

Example: OpenRouter always has money, **but we avoid it because it is expensive**. When DeepSeek's
official API runs out of money, the right move is to *escalate to GPT*, not to fall down a list.

So selection is **constraint comparison**, not ordering:

- **Candidate attributes**: `quality` (sota/strong/usable/weak/rubbish), `cost` (free/cheap/expensive),
  `availability` (key / quota / rate-limit state).
- **Objective per turn/role**: a `floor` (minimum quality) + a `budget` (cost ceiling) + a `prefer`
  (optimize quality vs cost).
  - `must-work`: floor = strong, budget = any.
  - `cheap`: budget = free/cheap, floor = usable (or weak for assist work).
- **Acceptable(candidate)** = `quality >= floor && cost <= budget && available`.
- **Choose**: among acceptable, take the one the objective prefers (cheapest that clears the floor,
  or the best when must-work). If **none** is acceptable, decide explicitly: **escalate** (raise the
  budget) or **degrade** (lower the floor) — never silently, and never into `rubbish`.
- **Availability is dynamic**: DeepSeek "no money"/429 ⇒ not acceptable right now ⇒ escalate.
- **Rubbish is a hard floor**: never selected, never a fallback.

This replaces "fallback chain" as the mental model; a role/registry may still *list* candidates in a
preferred order, but resolution is `acceptable`-based with an explicit objective.

## 4. Acceptance for the first cut (task #1)

1. A registry listing free models with `source`, `quality`, `provider`, `model`, `enabled`.
2. `opencode-zen-free` (keyless) registered and callable — currently **429 from this IP** (anonymous
   tier is egress-IP gated); needs an OpenCode Zen key or a different egress.
3. OpenRouter `:free` **whitelist** (small-config) wired once a key is present.
4. DeepSeek 5B/day quota wired once the key/quota lands.
5. Roles can select a free model by quality floor, with `prefer-free` fallback.
