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


## 3c. Provider **budget types** (user taxonomy)

Each provider has a budget *type* — how money/quota behaves — not just "free/expensive". Two derived
facts matter for selection: **marginal cost** (what one more token costs) and **conserve** (should we
ration it).

| # | Budget type | Marginal cost | Conserve? | Behaviour |
|---|---|---|---|---|
| 1 | **daily-free** | 0 within today's quota; blocked after | yes (resets daily) | free allowance per day (e.g. DeepSeek 5B/day, Groq/Z.AI/Cerebras free tiers) |
| 2 | **one-time-free** | 0 until the credit is spent | yes (finite) | signup/trial credit; gone when depleted |
| 3 | **metered (time-variant)** | token price; may change by time of day | yes (money) | pay-per-use; prefer off-peak when the discount is known |
| 4 | **subscription-flat** | ~0 (already paid) | **NO — use it** (白用白不用) | flat plan; unused capacity is wasted, so prefer it |
| 5 | **subscription-overage** | 0 within the plan, then metered | yes near the limit | use freely up to the cap, then control |
| 6 | **shared-pool** | 0 but shared with friends | yes (fairness) | a pooled quota; ration to stay fair |
| 7 | **own-relay** | ~0 (self-hosted) | **NO** | own relay/proxy; use freely |

**Derived fields per provider**: `budget` (the type above) + `quota` (daily amount / remaining credit /
plan size / shared share / unlimited) + `conserve` (derived: true for 1,2,3,5,6; false for 4,7).

These feed the **acceptable** selector:
- `subscription-flat` and `own-relay` ⇒ cost ≈ 0 AND conserve = false ⇒ **prefer them first**.
- `daily-free` / `one-time-free` / `shared-pool` ⇒ cost ≈ 0 but conserve = true ⇒ use within budget,
  watch the quota.
- `metered` (esp. OpenRouter) ⇒ real money, conserve = true ⇒ **last resort**.
- Availability failure (quota exhausted / 429) ⇒ not acceptable right now ⇒ escalate (e.g. DeepSeek
  out of money → GPT).

Note `cost` in the acceptable model is therefore **not** a static tier but `(budgetType, quotaLeft)`.


### 3c-bis. Refinements (user)

- **Quota period matters**: `daily-free` is one shape; there are also **weekly** / monthly / one-shot
  allowances. Track the *period* alongside the amount.
- **`subscription-flat` is not "hammer it"**: e.g. OpenAI **Pro 20x** — we *should* use it
  (白用白不用) but **not too hard**; fair-use / rate limits / abuse heuristics mean it is a **prefer
  with a soft cap**, not unlimited. So type 4 gets `conserve: false` **but** a `softCap` (burst ok,
  sustain gently) — it still needs consideration.
- **Source identity matters**: the DeepSeek `daily-free` we are getting is a **Shanghai research
  institute** program (not the official DeepSeek API) — a distinct source with its own quota, key and
  expiry. Record sources explicitly, not just providers.

### 3c-ter. NEW role: **subscription maintenance** (订阅维护)

Quotas, keys, renewals and overage/abuse are a *job of their own*, so they get their own
**role/agent/task** rather than being implicit in routing:

- watches quotas (daily/weekly/monthly resets, one-time credit left, plan usage vs soft cap),
- rotates/refreshes keys and OAuth tokens, and flags expired/blocked sources,
- keeps "money in OpenRouter" but keeps it *unused* (last resort),
- escalates before a metered source is used, and never lets a source silently run dry,
- owns the provider registry's `budget` / `quota` / `conserve` / `softCap` fields.

Consumers: the acceptable selector reads the registry the maintenance role keeps fresh.


## 3d. Cost must include **caching**

Effective cost is not `price_in * tokens_in`; it is a function of cache behaviour:

- **Token classes**: `input` (cache miss), `output`, `cacheRead`, `cacheWrite`. Providers price them
  very differently — e.g. cache *reads* are often ~10x cheaper than fresh input, while cache *writes*
  can cost a premium (Anthropic-style write surcharge; OpenAI/DeepSeek discount cached input).
- **TTL**: prompt caches expire quickly (often minutes). A cache only pays off when the same prefix is
  reused soon.
- **Switching costs are hidden but real**: changing model/provider **invalidates the warm cache**, so a
  failover/escalation that looks cheap can re-pay full input price for the whole context. Model choice
  therefore has a **cache-locality** term:
  - stay on the current model within a turn/session ⇒ cache reads (cheap);
  - hop to another provider ⇒ cache miss + cache write (expensive), on top of the new provider's price.
- **Cache hit rate is a per-source health signal**: a source with a poor hit rate is more expensive than
  its sticker price suggests. The registry should carry `cache: { readPrice, writePrice, ttl, hitRate }`
  and the acceptable selector should use **effectiveCost(input, output, cacheRead, cacheWrite, ttl,
  locality)** — not list price.

Practical consequences:
- Prefer **staying** on one model for a session unless a switch is justified by availability or a real
  quality floor, precisely because switching drops the cache.
- Our own usage records already carry `cacheRead`/`cacheWrite`, so a per-source `effectiveCost` can be
  computed and fed back into the registry (subscription-maintenance role).

## 4. Acceptance for the first cut (task #1)

1. A registry listing free models with `source`, `quality`, `provider`, `model`, `enabled`.
2. `opencode-zen-free` (keyless) registered and callable — currently **429 from this IP** (anonymous
   tier is egress-IP gated); needs an OpenCode Zen key or a different egress.
3. OpenRouter `:free` **whitelist** (small-config) wired once a key is present.
4. DeepSeek 5B/day quota wired once the key/quota lands.
5. Roles can select a free model by quality floor, with `prefer-free` fallback.
