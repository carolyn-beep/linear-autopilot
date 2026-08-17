# 8. Scaling model: single-node today, a defined horizontal path

## Status

Accepted

## Context

Autopilot needs an honest, written answer to "how far does one instance go, and
what does it take to go further." The current implementation is deliberately a
single node, and several core components assume that. Recording the model now —
the ceiling, the vertical levers, and the concrete horizontal path — keeps the
next scaling decision from being re-derived under pressure.

The single-node assumptions, as they exist in the code:

- **In-memory work queue.** `TicketQueue` (`src/spawner/queue.ts`) holds
  `QueuedTicket`s in process memory. It is not shared and does not survive a
  restart; a crash drops queued work.
- **Local-JSON state.** Cross-session memory (`memory.json`,
  `src/memory/index.ts`), cost tracking (`costs.json`, `src/tracking/index.ts`),
  and completion records (`src/dashboard/index.ts`) are files on the host's local
  disk, read and written by the one process.
- **Host-bound git checkouts.** The spawner runs `git`/`gh` against a checkout on
  the local filesystem (`src/spawner/index.ts`), one working tree per branch. Work
  is pinned to the host that owns the checkout.
- **One process does everything.** The webhook receiver / watcher
  (`src/watcher`), the queue, and the spawner run in the same process
  (`src/server/index.ts`).

## Decision

Ship and document a **single-node** model, expose **vertical levers** for
bounded fan-out and backpressure within that node, and record a **concrete
horizontal path** to take when the node ceiling is actually hit. Do not build the
horizontal machinery speculatively.

**Vertical levers available today.** These bound how much a single node takes on
so it degrades by queueing rather than by thrashing:

- `maxConcurrentAgents` per tenant (`src/config/tenants.ts`) caps concurrent
  agent processes; the spawner enforces it (`canSpawnForTenant`,
  `src/spawner/index.ts`) and simply leaves work queued when at capacity — this
  is the primary backpressure mechanism.
- `MAX_RETRIES` (`src/constants.ts`) caps retry fan-out so a poison ticket cannot
  consume unbounded work.
- Linear API rate limiting and exponential backoff (`src/linear/client.ts`) bound
  outbound call pressure.

**Horizontal path, when the single node is the bottleneck.** In dependency
order:

1. **Externalize the queue.** Replace the in-memory `TicketQueue` with a shared
   store (Postgres `SELECT ... FOR UPDATE SKIP LOCKED`, or Redis) using
   **leased/locked jobs** so multiple workers can pull without double-processing
   and an unfinished lease is reclaimed after a crash. The queue is already a
   single, small interface (`enqueue`/`dequeue`/`requeue`), so this is a
   contained swap.
2. **Move shared state to a shared store.** Memory, costs, and completions move
   off local JSON into a database or object store so any worker reads and writes
   the same state rather than a host-local copy.
3. **Split the webhook receiver from the worker.** Run the watcher / webhook
   endpoint as a stateless front tier that only enqueues, and run the spawner as
   a separate worker tier that scales independently.
4. **Shard by repo.** Because each ticket is pinned to a repo checkout, partition
   work by repository (or tenant) across workers so a given repo's checkouts live
   on one worker and true parallelism comes from working _different_ repos at
   once — not from multiple hosts fighting over one checkout.

## Consequences

**Positive**

- The current model is simple, cheap to operate, and honest about its bounds.
  The vertical levers give real backpressure without any distributed machinery.
- The horizontal path is specific and dependency-ordered, and it lands on
  interfaces that are already small (the queue especially), so it can be taken
  incrementally when demand justifies it rather than pre-built.

**Negative**

- A single node is a single point of failure: an in-memory queue loses queued
  work on restart, and local-JSON state is not shared or replicated.
- Throughput is capped by one host's CPU, memory, and disk, and by
  `maxConcurrentAgents` across all tenants on it.
- **The pipeline runner multiplies per-ticket load.** Each ticket run under the
  pipeline runner ([ADR-0007](0007-single-agent-vs-pipeline-runner.md)) makes
  several agent calls instead of one, so at a fixed `maxConcurrentAgents` the node
  reaches its CPU/memory ceiling with fewer concurrent tickets. Opting a tenant
  into the pipeline brings the horizontal path forward.

## Alternatives considered

- **Build the distributed queue and worker tiers now.** Rejected as premature.
  The single-node model meets current needs, and building leased-job queues,
  shared state, and a split receiver/worker before there is load to justify them
  adds operational surface for no present benefit. The path is recorded so the
  work is cheap to start, not so it is started early.
- **Scale only vertically (bigger host), never horizontally.** Rejected as the
  long-term answer: it does not remove the single-point-of-failure, and a single
  host's ceiling is finite. Vertical levers are the right _first_ response, not
  the only one.
- **Isolated per-agent checkouts to allow many agents per repo on one host.**
  Deferred. This is the same isolation work parallel decomposition would need
  (see [ADR-0007](0007-single-agent-vs-pipeline-runner.md)); until there is
  demand, sharding by repo across workers is the simpler route to parallelism.
