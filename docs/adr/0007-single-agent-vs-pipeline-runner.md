# 7. Single-agent default with an opt-in multi-agent pipeline runner

## Status

Accepted

## Context

Until now every ticket was worked by exactly one Claude Code process
(ADR-0001): one prompt in, one exit code out, then the validation gate. That is
simple and cheap, but it asks a single agent to plan, implement, and self-check
in one pass. For some tickets a division of labor — a planning step, an
implementation step, and an independent critic step — produces better-scoped
changes and catches obvious mistakes before the validation gate ever runs.

We wanted to support that without regressing the common case. Two forces shaped
the decision:

1. **The single-agent path must stay behavior-preserving.** It is the default,
   it is cheap, and most well-scoped tickets do not need more. Introducing a
   runner abstraction must not change what happens for a tenant that does
   nothing.
2. **More agents on one repo is a concurrency problem, not just a cost problem.**
   The obvious "multi-agent" design — several agents decomposing a ticket and
   editing the working tree in parallel — creates file-level write conflicts on
   a single shared checkout. Two agents touching the same file, or the same
   region of a file, produce interleaved or lost edits with no clean merge story.
   Autopilot works one checkout per branch on the host (ADR-0004), so parallel
   editors would fight over that checkout.

## Decision

Introduce an `AgentRunner` strategy behind a single interface
(`src/runners/types.ts`) and select it per tenant
(`createRunner`, `src/runners/index.ts`). The spawner calls
`createRunner(tenant).run(...)` (`src/spawner/index.ts`); everything downstream
of the runner — the validation gate, PR creation, memory — is unchanged.

Two runners ship:

- **`SingleAgentRunner`** (`src/runners/single-agent-runner.ts`) is the default.
  It reproduces the classic behavior exactly: one Claude Code process prompted
  by `buildAutopilotPrompt`, with memory injected. A tenant that sets nothing
  gets this.
- **`PipelineRunner`** (`src/runners/pipeline-runner.ts`) is opt-in via
  `runner: 'pipeline'` in tenant config (`src/config/tenants.ts`). It runs a
  **sequential**, role-specialized flow: `planner` → `implementer` → `reviewer`.

The pipeline is deliberately sequential, and only the implementer writes code:

- The **planner** reads the ticket and summarized memory and produces a short
  plan; it does not touch the working tree (`buildPlannerPrompt`).
- The **implementer** implements on the branch, following the plan
  (`buildImplementerPrompt`).
- The **reviewer** reads the branch diff (`git diff main...<branch>` via
  `execFileSync`, no shell) and ends with a machine-parseable
  `VERDICT: APPROVE | REQUEST_CHANGES` (`buildReviewerPrompt`,
  `parseReviewVerdict`).
- On `REQUEST_CHANGES` with budget remaining, the implementer runs one fix pass
  addressing the feedback, then the reviewer re-reviews. This revision loop is
  bounded by `pipelineMaxRevisions` (default `1`) and **always terminates** at
  the cap.

Because only one agent runs at a time and only the implementer writes, the
parallel-editor file-conflict problem does not arise. The planner and reviewer
add structure and an independent critic pass; they never edit the tree. The
runner interface injects its agent invocation (`InvokeAgent`,
`src/runners/invoke.ts`), which is the only place a real `claude` process is
spawned, so runners are unit-testable without the CLI. Each role reports its own
tokens, cost, and duration (`RoleResult`), and the spawner still records one
aggregate usage entry per ticket so cost accounting is unchanged.

## Consequences

**Positive**

- The default case is untouched: single agent, same prompt, same cost, same
  downstream flow.
- Role specialization gives the pipeline an independent critic before the
  validation gate, and a bounded self-correction pass, without a human in the
  loop.
- Sequential execution with a single writer sidesteps write conflicts on the
  shared checkout entirely — there is nothing to merge.
- The runner boundary is a real, tested extension point (see
  [EXTENDING.md](../EXTENDING.md)): a new strategy implements `AgentRunner` and
  is selected in `createRunner`.

**Negative**

- **Cost and latency scale with the number of role calls.** A pipeline ticket
  makes roughly N Claude Code calls where N is `2 + 2 × revisions` in the worst
  case (planner + implementer, then reviewer and one implementer fix pass per
  revision) — at the default cap, three to four calls versus one. Each call is a
  full process spawn. This is a deliberate cost-for-quality trade, opt-in per
  tenant.
- Multiplying per-ticket agent calls intensifies the single-node load ceiling.
  See [ADR-0008](0008-scaling-model.md).
- The reviewer verdict is prompt-driven. Absent a `VERDICT:` marker the pipeline
  conservatively treats the run as not approved, and a reviewer can be wrong in
  either direction; the validation gate remains the hard correctness check, not
  the reviewer.

## Alternatives considered

- **Single-agent only (status quo).** Simplest and cheapest, and still the
  default. Rejected as the _sole_ option because it offers no structured
  planning or independent critic for tickets that benefit from one. Keeping it
  as the default rather than the only choice is the actual decision.
- **Parallel sub-agent decomposition / swarm.** Multiple agents splitting a
  ticket and editing the same checkout concurrently. Rejected: file-level write
  conflicts on one shared working tree have no clean resolution, and the
  coordination cost (locking regions, merging partial edits) outweighs the
  benefit for the small, well-scoped tickets Autopilot targets. Deferred rather
  than dismissed — if work ever justifies true parallelism it would require
  per-agent isolated checkouts (git worktrees or separate clones) and a merge
  strategy, which is a larger change tied to the horizontal path in
  [ADR-0008](0008-scaling-model.md).
- **A framework-driven multi-agent orchestrator** (e.g. a graph/crew library).
  Rejected for the same reasons as ADR-0001: it adds a heavy dependency and its
  own abstractions for a flow we can express as a short, explicit, testable
  sequence over the existing single-subprocess boundary.
