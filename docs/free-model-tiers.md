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

## 4. Acceptance for the first cut (task #1)

1. A registry listing free models with `source`, `quality`, `provider`, `model`, `enabled`.
2. `opencode-zen-free` (keyless) registered and callable — currently **429 from this IP** (anonymous
   tier is egress-IP gated); needs an OpenCode Zen key or a different egress.
3. OpenRouter `:free` **whitelist** (small-config) wired once a key is present.
4. DeepSeek 5B/day quota wired once the key/quota lands.
5. Roles can select a free model by quality floor, with `prefer-free` fallback.
