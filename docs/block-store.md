# Block store (JSON) — everything is a block

**Yes, this is doable**, and it maps 1:1 onto Logseq later (block = block, nesting = the block tree,
`refs` = `((block))`, relation type = a property). Design first, code second.

## 1. The block

One JSON object per block. Big content lives in its own file so a long conversation never forces a
rewrite of a giant document.

```jsonc
{
  "id": "b_01J...",              // stable, unique; also the Logseq block uuid later
  "kind": "conversation | turn | instruction | evidence | plan | plan-step | note | …",
  "title": "short label",
  "body": "text…",              // or a structured body for machine blocks
  "parent": "b_parent | null",   // NESTING (structural, ordered)
  "children": ["b_a", "b_b"],    // ordered children (the block tree)
  "refs": [                      // WEAK relations (links, not containment)
    { "to": "b_evidence_1", "rel": "cites", "note": "why" }
  ],
  "mentions": ["@captain"],      // A2A addressing: `@` (at) semantics, PUBLIC - everyone can see it
  "props": {},                   // kind-specific: role, seq, path, hash, status, …
  "author": "user | session:<id> | captain",
  "createdAt": 0,
  "updatedAt": 0,
  "revision": 1
}
```

**Nesting vs relations** — kept apart on purpose:
- **Nesting** = `parent`/`children`: structure and order (a plan contains steps; a conversation
  contains turns).
- **Relations** = `refs[]`: *weak* links across the tree (a step cites evidence; a turn answers a
  question). A block can be nested in one place and referenced from many.

## 2. Relations — a small, open vocabulary

`rel` is a short string, defaulting to **`refer`** (the generic weak link). A basic starter set:

| rel | meaning |
|---|---|
| `refer` | generic "see also" (default) |
| `at` | `@`-mention of an agent/session (public addressing; the target is woken by a query) |
| `cites` / `citedBy` | evidence ↔ claim |
| `derives` / `derivedFrom` | plan → step, output → input |
| `answers` / `askedBy` | a turn answering a question |
| `supersedes` / `supersededBy` | a newer block replacing an older one |
| `blocks` / `blockedBy` | dependencies (as in Claude-Code task tools) |
| `implements` | work → spec/plan |

Relations are directed edges with an optional `note`; the inverse is derived, not stored, so there is
exactly one truth per link.

## 3. "Everything is a block" — the concrete kinds the user listed

| thing | kind | shape |
|---|---|---|
| long conversation | `conversation` | root block; `children` = turns |
| instruction (instruct) | `instruction` | `props.status`; may nest sub-instructions |
| the **last turn's messages** | `turn` | `props.role` (user/assistant), `props.seq`; `refs` → evidence |
| evidence file | `evidence` | `props.path`, `props.hash`; body = extracted text/summary |
| plan decomposition | `plan` + `plan-step` | `plan` nests `plan-step`s; steps `derives`-ref each other |

So a session reads/writes blocks: append a `turn`, attach `evidence`, nest a `plan-step`, add a
`refer` to something discussed earlier — no messages, no queues.

## 4. Storage layout

```
~/.pi/agent/blocks/
  index.jsonl          # {id, kind, parent, refs:[{to,rel}], updatedAt} — cheap scan for queries
  b_01J….json          # the full block (big bodies live here)
```
- **Per-block files**: big bodies never force a whole-file rewrite; partial reads are cheap.
- **`index.jsonl`**: append-mostly, lets a query (`kind=plan-step and status=open`, or "what refers to
  X") answer without loading every block. Rebuildable from the block files at any time.
- **Revision**: every write bumps `revision` and `updatedAt`; the previous body can be kept as
  `b_….r<n>.json` if we want history (Logseq keeps its own history, so this is interim).

## 5. Migration mapping to Logseq

| ours | Logseq |
|---|---|
| block `id` | block uuid (`id::`) |
| `parent`/`children` | the block tree |
| `refs[].to` | `((block-uuid))` reference |
| `refs[].rel` | a property on the referencing block (e.g. `rel:: cites`) |
| `kind` | a `Class` |
| `props` | block/page properties |
| query | a Logseq query block |

## 6. Feasibility & first cut

Trivially feasible with our existing tools: `node:fs` + JSON, no dependency.
Minimal core to build first (pure, testable):
- `blocks.ts`: `create/update/get`, `nest(parent,child)`, `refer(from,to,rel)`, `refsOf(id)`,
  `childrenOf(id)`, `query({kind,status,…})`.
- `block-store.ts`: the per-file + `index.jsonl` persistence.

Open questions to settle before coding:
1. **One store or per-session stores?** (global blackboard vs session-scoped)
2. **Who may write which kind?** (users/turns/plans/evidence — same rules for all, or per-kind?)
3. **Delete vs tombstone?** (append-only-ish with `supersedes`, or hard delete?)
4. **Body format**: free text, or a typed body per kind (e.g. a turn has role/seq/content)?
