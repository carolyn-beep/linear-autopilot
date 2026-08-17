# Design Brief: Linear Autopilot

_Owner: Product. Audience: engineers evaluating or extending Autopilot, and the
eng-leads who decide whether to point it at a real repo._

This is the "why it's shaped this way" document. For how the pieces fit together
mechanically, read [ARCHITECTURE.md](ARCHITECTURE.md); this brief assumes it and
does not repeat the loop diagram.

## Problem, and who has it

Every backlog has a long tail of small, well-scoped tickets: rename a field, add
a validation rule, wire a new config flag, fix a flaky assertion, bump a
dependency and adjust the call sites. Individually none of them is hard. In
aggregate they are a tax. They interrupt focused work, they age, and they are
exactly the kind of task a senior engineer resents spending an afternoon on and a
junior engineer takes a day to land safely.

The people who feel this:

- **Individual engineers** carrying a backlog of chores alongside real feature
  work, who want the small stuff to move without becoming a second job.
- **Eng-leads and maintainers** who see well-specified tickets sitting idle and
  want throughput on them without lowering the bar on what reaches `main`.

Coding agents can do this work. The problem is that an unsupervised agent is not
trustworthy on its own: it runs out of context, calls tools that fail or that it
hallucinates, and recovers from its own mistakes poorly. The gap Autopilot fills
is not "can an agent write the code." It is "can I let an agent touch my repo
unattended and trust what comes out." Autopilot is the orchestration and
guardrail layer that makes the answer defensibly yes for a bounded class of work.

## Goals

1. Take a ticket a human has judged agent-ready and drive it to a reviewable PR
   with no human in the loop between label and PR.
2. Never let unverified work reach `main`. A PR only exists if it passed the same
   checks a human PR would.
3. Fail safe and fail loud: contain the blast radius of a bad run, and surface
   the failure modes that do not announce themselves.
4. Get better over the life of a repo, not stay flat, by feeding real outcomes
   back into the next run.
5. Be a platform an engineer extends, not a script they fork. Adding a
   notification channel or a validation check should touch a small, typed
   surface.

## Non-goals (explicit)

These are deliberate. Treating them as goals would make the product worse at what
it is for. The full version lives in [LIMITATIONS.md](LIMITATIONS.md).

- **Not a triage or planning tool.** A human decides a ticket is well-scoped and
  applies the `agent-ready` label. Autopilot does not decide what is worth doing
  or split epics into subtasks.
- **Not a CI/CD replacement.** The validation gate protects the PR; it does not
  replace the team's own CI, review, or merge policy. Autopilot opens PRs; humans
  still merge them.
- **Not a merge bot.** It stops at "In Review." It does not auto-merge, and it
  does not read merge status back.
- **Not an autonomy maximizer.** It is scoped for small, well-specified changes,
  not multi-day features or ambiguous "figure out what the user wants" work.
- **Not a security sandbox.** It reduces the risk of running an agent; it does not
  eliminate it. Isolating the runtime is the operator's job and is treated as
  required, not optional.

## Users and jobs-to-be-done

| User                             | Job                                                                        | What Autopilot gives them                                                       |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Engineer with a chore backlog    | "Get this small ticket done without me babysitting it."                    | Label a ticket, get a PR to review.                                             |
| Eng-lead / maintainer            | "Increase throughput on small tickets without lowering the quality floor." | A hard validation gate so only passing PRs land in review.                      |
| Platform owner running Autopilot | "Operate agents across teams, safely, and see what they cost."             | Multi-tenant config, a dashboard, cost tracking, per-tenant credential scoping. |
| Engineer extending Autopilot     | "Add my notification channel / my validation check."                       | Typed extension points and a step-by-step guide ([EXTENDING.md](EXTENDING.md)). |

## System overview

A ticket labeled `agent-ready` is picked up by the watcher (webhook or polling),
enqueued, and picked up by the spawner when the tenant has capacity. The spawner
builds a prompt, shells out to the Claude Code CLI in the target repo with a
scrubbed environment, and on a clean exit runs the validation gate. Pass creates
a PR and moves the ticket to In Review; fail cleans up the branch, comments the
redacted error, and requeues. Every outcome writes back to cross-session memory.

The full loop, the components, and the mermaid diagram are in
[ARCHITECTURE.md → Orchestration loop](ARCHITECTURE.md#orchestration-loop). The
MCP control surface is in [MCP.md](MCP.md). Key architectural decisions and their
tradeoffs are recorded as ADRs in [docs/adr/](adr/).

## Design principles

These are the ideas the code actually commits to, each with where it lives.

**1. Assume the agent fails.** The design premise is not "the agent is usually
right." It is "the agent will fail in known ways (context exhaustion, bad tool
calls, poor recovery), so build the loop around detecting and containing that."
A clean exit from the CLI means "the agent thinks it is done," never "the work is
correct" (`Spawner.handleSuccess`, `src/spawner/index.ts`).

**2. Validation is the gate, not a suggestion.** `validate()`
(`src/validation/index.ts`) runs tests, lint, typecheck, and an optional coverage
check before any PR is created. A validation failure is routed through
`handleFailure` exactly like a crash: branch deleted, ticket commented and moved
to Backlog, run requeued. This is the single most important quality decision in
the system. It trades throughput on failing runs for a high floor on what a human
ever sees.

**3. Capabilities are composable, the loop is fixed.** The orchestration loop is
one code path. The things plugged into it (notification providers, validation
checks, notification events) go through typed interfaces and registries rather
than branches in the core. Six notification providers ship behind one
`NotificationProvider` interface; a seventh is a file plus a test. See the
extension-point table in [ARCHITECTURE.md](ARCHITECTURE.md#extension-points).

**4. Context is a budget, and the prompt is a designed artifact.** The agent gets
one shot per attempt, so `buildAutopilotPrompt` (`src/prompts.ts`) is
deliberate about what it spends context on: ticket identifier, title,
description, and a _summarized_ view of memory (top errors per category,
trouble-prone validation steps), never the raw `memory.json`. Linear comments,
attachments, and reporter identity are excluded on purpose: they cost tokens and
widen the untrusted surface. Memory itself is bounded (`MEMORY_LIMITS`,
`src/constants.ts`) so it cannot grow without limit.

**5. Security is a first-class constraint because this executes untrusted-influenced
code.** Anyone who can label a ticket is an input to a system that runs code on
the host. So: ticket content is fenced as data, not instructions, in the prompt;
the agent and every validation subprocess run with a scrubbed environment
(`scrubbedEnv`, `src/utils/security.ts`) so credentials are not present to leak;
all `git`/`gh` calls use `execFileSync` with argument arrays so ticket text is
never interpolated into a shell; and anything persisted or echoed (PR bodies,
Linear comments, memory) is passed through `redactSecrets`. The full threat model
and control table are in [SECURITY.md](../SECURITY.md).

## Success metrics

Metrics have a dedicated home in [EVALUATION.md](EVALUATION.md) (owned by the
evaluation workstream). The honest split matters more than any single number, so
it is stated here too. **Do not read invented numbers into this document; there
are none.**

**Implemented (computed in code today):** tokens and estimated cost per ticket
(`src/tracking/index.ts`), completions with duration and PR URL
(`src/dashboard/index.ts`), success/failure counts and success rate plus per-step
validation failure counts (`src/memory/index.ts`), and retry attempts per ticket
(`src/spawner/queue.ts`).

**Target (the metrics the platform exists to move, not yet computed):** time from
label to PR, PR acceptance/merge rate, retry rate and mean attempts-to-success,
and cost per _merged_ PR. Several of these have their inputs already (enqueue and
completion timestamps, queue attempts) but are not aggregated, and merge rate
requires reading status back from GitHub, which the platform does not yet do. See
[ARCHITECTURE.md → How success is measured](ARCHITECTURE.md#how-success-is-measured).

Cost figures are estimates from a hardcoded per-token price constant
(Claude 3.5 Sonnet rates in `src/tracking/index.ts`), parsed from CLI output.
They are a directional guide, not a bill.

## Key risks and mitigations

| Risk                                        | Why it matters                         | Mitigation                                                                              | Residual                                                   |
| ------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Agent produces plausible-but-wrong code     | Erodes trust in every PR               | Hard validation gate before any PR                                                      | Bounded by test/lint/typecheck coverage in the target repo |
| Prompt injection via ticket content         | Ticket authors are semi-trusted inputs | Untrusted-content fencing in the prompt; scrubbed env so there is nothing to exfiltrate | Fencing is prompt-level, not a hard guarantee              |
| Secret leakage into PRs / comments / memory | Persistent, hard to walk back          | `scrubbedEnv` + `redactSecrets` on all persisted/echoed text                            | Redaction is pattern-based; novel secret formats can slip  |
| Bad "learnings" poison future runs          | Memory feeds the next prompt           | Bounded, categorized, redacted memory                                                   | Drift is possible; memory is per-repo and resettable       |
| Agent hangs with no exit code               | The failure mode that never returns    | Stuck detection fires an `agent-stuck` alert past a threshold                           | Alert only; it does not yet kill the run                   |
| Running agent-authored code on the host     | Inherent to the product                | Documented requirement to run in an isolated environment                                | The isolation is the operator's responsibility             |

## Roadmap: production-ready vs experimental

Stated plainly, because a portfolio reviewer should be able to tell what is real.

**Production-ready today.** The core loop: watch, queue, spawn, validate, PR or
fail, learn. Multi-tenant configuration and per-tenant credential scoping. Six
notification providers. Cost and completion tracking. The dashboard. The
read-only MCP server. The security controls in [SECURITY.md](../SECURITY.md).

**Real but single-operator.** Multi-tenant means one operator managing several
teams and repos from one instance. The trust model is still single-operator:
tenants are configured by, and share the trust boundary of, whoever runs
Autopilot. It is not multi-user SaaS with isolation between mutually-distrusting
customers.

**Shipped, opt-in.** Beyond the default single-agent path, a sequential
planner → implementer → reviewer pipeline ships as an opt-in runner
(`runner: 'pipeline'`, `src/runners/pipeline-runner.ts`). It is real and wired in
through the `AgentRunner` abstraction (`src/runners/`,
[ADR-0007](adr/0007-single-agent-vs-pipeline-runner.md)); the trade is cost and
latency, roughly N× the agent calls of a single run, which is why it is opt-in
per tenant rather than the default.

**Single-node scaling ceiling.** One instance holds the queue in memory, keeps
memory/cost/completion state in local JSON, and works host-bound git checkouts.
`maxConcurrentAgents`, `MAX_RETRIES`, and Linear rate limits are the vertical
levers; the horizontal path (externalized queue, shared state, split
receiver/worker, shard by repo) is a defined roadmap item, not built yet. The
pipeline runner intensifies this ceiling by multiplying per-ticket load. See
[ADR-0008](adr/0008-scaling-model.md).

**Not yet run.** Live end-to-end evaluations against real repos have not been
run. The metrics scaffolding exists (see above); the evaluation itself is
future work tracked in [EVALUATION.md](EVALUATION.md).
