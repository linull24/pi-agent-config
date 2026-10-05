# A2A via a block/node blackboard (modelled on Logseq)

Read from the official docs (`github.com/logseq/docs`, master, 318 pages). The goal is a **shared
blackboard** for agent-to-agent work — **not** a message-passing system (no mailbox, no IRC, no extra
services). Logseq already is such a blackboard, and the shape maps 1:1 onto it, so a later migration
is a port, not a rewrite.

## 1. Logseq semantics (what the docs actually say)

- **Page = node.** The unit of *identity and linking*. Named; carries properties (`title`, `alias`,
  `tags`, `icon`, `public`, `exclude-from-graph-view`).
- **Block = the atomic, addressable unit.** Has a UUID (`id`), lives in a page's ordered block tree,
  and is referenceable from **anywhere** via `((uuid))`. Blocks carry properties too.
- **References** are first-class: `[[page]]` and `((block))`, with optional custom labels; backlinks
  and *linked references* (grouped by page) plus a reference counter.
- **Properties** are typed key→value with cardinality `(1)` / `(N)`; built-in/reserved vs user; page
  level or block level.
- **Classes** are a typed schema layer (`Class`, `Thing`, RDF `sameAs`) — the DB version makes classes
  first-class, which is why the local `logseq-schema.mjs` states the embedding rules:
  1. *Entities are pages* — a page is the unit of identity and linking.
  2. *Chronology inside an entity is blocks* — a block tree is already ordered.
  3. *Relations are properties plus relation blocks.*
- **Queries** are the watch/subscription mechanism (query blocks with `query-table`,
  `query-properties`, `query-sort-by`).
- **Protocol**: `logseq://graph/<graph>?page=<p>&block-id=<uuid>` — deep links into the graph.

## 2. Blackboard architecture

Classic blackboard: a shared, structured, append-mostly working memory that independent **knowledge
sources** read and write; coordination happens by **observing and modifying the shared structure**,
with no direct messaging. Logseq is a natural blackboard:

| blackboard | Logseq |
|---|---|
| shared structure | the graph of pages/blocks |
| addressing | page names + block UUIDs |
| links | `[[page]]` / `((block))` refs |
| typed fields | properties + classes |
| "watch for work" | queries |

## 3. Our A2A design (blackboard, one namespace)

- **The blackboard is a durable block graph**, not a queue. Units are **blocks**:
  `{ id, page, parent, type, author, props, createdAt, revision }`, with `refs: {from, to}`.
- **Agents are knowledge sources**: they read by id/ref/query, write blocks, and **react** to changes.
- **Conversation = appending blocks under a topic page**, with `reply-to` a block id. A reply is a
  block whose `reply-to` points at another block; refs share content by **reference, not copy**.
- **One namespace** (the omp lesson): `block://<id>`, `page://<topic>` resolve inside our read/write
  tools, so there is exactly one addressing scheme rather than one per feature.
- **`wait` = a query subscription**: an agent registers a query (`topic=X, status=open`) and is woken
  when the blackboard changes — the same primitive multiplexes background results and peer activity.
- **Nesting falls out**: a subagent appends its own blocks under its parent's block, and any peer can
  read them by ref.

## 4. Migration mapping to Logseq (why this is safe)

| ours | Logseq |
|---|---|
| `page` | page (node) |
| `block` (id/parent/type/props) | block with `id` + properties |
| `type` | a `Class` |
| `refs` | `((block))` / `[[page]]` refs |
| `author` | a property (e.g. `session`) |
| query subscription | a query block |

So the interim implementation can use our durable sqlite/docs and later move onto the graph with the
same shape.

## Not doing
- No `mailbox` service, no IRC bridge, no `/collab` relay — those are extra systems, which the user
  rejected.

## 5. Addressing = `@` (at) semantics, public to everyone (user)

A2A does **not** send private messages. You **mention** a target on a block:

- `@captain`, `@alice`, `@all` — written **on the block**, therefore **on the shared blackboard**.
- **Everyone can see it.** Visibility is not a delivery decision; the mention is public by
  construction, and any agent may read (and act on) it.
- The mentioned agent does not receive a push; it is **woken by a query subscription**
  (`mentions=@me and status=open`) — the same `wait` primitive as everything else.
- `@all` is a broadcast mention (no per-recipient copy).

So the block carries addressing, not a transport: `mentions: ["@captain"]` (or a `refs` entry with
`rel: "at"` pointing at an agent block). This keeps **one** mechanism: write a block, mention who it
is for, let the query wake the right agent.

## 6. Evaluated and rejected (tasks #6, #7)

Our substrate is the **block blackboard** (one namespace + `@` + query subscriptions). The two
third-party A2A systems were evaluated against that and are **not adopted**:

### `omp-fabric` — actors / mailboxes / councils (REJECT)
- It is a *programmable* mesh runtime: a QuickJS sandbox, durable **actors**, mailboxes/subscriptions,
  councils, budgets — heavy (Node 24+, OMP 18.4.4+), and it brings its own runtime beside the agent.
- Its useful ideas are already expressed here: an **actor** ≈ a session bound to the board, a
  **mailbox** ≈ `blocks where mentions=@me`, a **topic** ≈ a page, a **council** ≈ several blocks
  referencing one plan.
- So: **borrow the concepts, not the runtime.** No new system.

### `pi-teammate` / `agent-comms` (REJECT)
- They are peer networks over a separate bus (SQLite file / TCP mesh, ports, gossip, coordinator
  election) — i.e. exactly the "another messaging system" we decided against.
- Cross-harness reach (Claude Code) is attractive but is a *transport* concern: if we ever need it, it
  belongs behind one adapter that writes/reads blocks, not as a second source of truth.
- So: **reject for now**; revisit only as a block transport.

**Consequence**: A2A is one mechanism — write a block, `@`-mention (public), subscribe with a query.
Nothing else to run.
