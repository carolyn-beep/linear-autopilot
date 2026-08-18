# Limitations and Non-Goals

What Linear Autopilot deliberately does not do, and where its real edges are.
This is a scoping document, not an apology. Most of what follows is a choice made
to keep the system good at one thing: turning a well-scoped, human-approved
ticket into a validated PR. A few items are genuine known edges. Both are labeled.

For the "why it's shaped this way," see [DESIGN.md](DESIGN.md). For the threat
model, see [SECURITY.md](../SECURITY.md).

## Deliberate non-goals

**Not a triage, planning, or scoping tool.** A human decides a ticket is suitable
and applies the `agent-ready` label. Autopilot does not judge whether work is
worth doing, split epics, or clarify vague requirements. Its input contract is "a
human already decided this is well-scoped." Feeding it ambiguous tickets is
using it against its grain.

**Not a CI/CD replacement.** The validation gate (`src/validation`) protects the
PR before it opens; it is not your pipeline. It runs the target repo's own
`test`/`lint` scripts and a typecheck if there is a `tsconfig.json`, and skips
any step whose script is absent. Coverage is only enforced if `COVERAGE_THRESHOLD`
is set (default `0`, meaning skipped). Keep your CI. Autopilot raises the floor
on what reaches review; it does not certify a merge.

**Not a merge bot.** The loop stops at "In Review." It opens a PR and hands off.
It does not auto-merge, and it does not read merge or acceptance status back from
GitHub, which is exactly why "PR acceptance / merge rate" is a target metric and
not an implemented one.

**Not an autonomy maximizer.** This is scoped for small, well-specified changes.
It is not built for multi-day features, cross-cutting refactors, or "figure out
what the user really wants" work. Pointing it at a large ambiguous ticket is the
most reliable way to hit its limits.

**Not a security sandbox.** The controls in [SECURITY.md](../SECURITY.md) reduce
the risk of running a coding agent; they do not remove it. The agent is spawned
with `--dangerously-skip-permissions` (`src/runners/invoke.ts`) so it can work
unattended, which makes runtime isolation
(a dedicated container or VM, least-privilege tokens, protected `main`,
restricted egress) a **required** operating condition, not a nice-to-have.

**Not multi-user SaaS.** "Multi-tenant" here means one operator managing several
teams and repos from one instance, with optional per-tenant credential scoping
(`src/config/tenants.ts`) to limit blast radius. It is a single-operator trust
model. Tenants share the trust boundary of whoever runs Autopilot. There is no
isolation designed for mutually-distrusting customers.

## Known edges and honest caveats

**Agent quality is bounded by the underlying model.** Autopilot shells out to the
Claude Code CLI rather than embedding its own agent loop (see
[ADR-0001](adr/0001-spawn-claude-code-cli.md)). The upside is that the agent
improves when the CLI improves. The consequence is that Autopilot cannot be
better at writing code than the model it drives. It can only be better at
catching, containing, and learning from what the model gets wrong. The gate
raises the floor; it does not raise the ceiling.

**The validation gate is only as strong as the target repo's checks.** A repo
with thin tests, no lint config, and no types gives the gate little to enforce,
and more plausible-but-wrong code will pass. Steps with no corresponding script
are skipped and reported as passing-by-skip. The gate is a multiplier on the
repo's existing quality signals, not a substitute for having them.

**Cross-session memory can drift.** Memory feeds the next prompt
(`formatMemoryForPrompt`, `src/memory/index.ts`), which means a wrong or stale
"learning" can influence future runs. It is bounded (`MEMORY_LIMITS`,
`src/constants.ts`), categorized, secret-redacted, and per-repo, so the downside
is contained and the file is resettable. But the claim that memory _improves_
outcomes is a hypothesis, not a measured result. Treat it as a mechanism worth
evaluating, not a proven win.

**Cost figures are approximate, and can be absent.** `recordUsage`
(`src/tracking/index.ts`) parses token counts out of the CLI's text output with
regexes. If the output format does not match any known pattern, no cost is
recorded for that run at all. When it does match, the dollar figure uses a
hardcoded price constant (Claude 3.5 Sonnet input/output rates); it does not
track the actual model or current pricing. Read these as a directional guide, not
a bill.

**Stuck detection alerts; it does not intervene.** `checkStuckAgents` flags an
agent running past `AGENT_STUCK_THRESHOLD_MS` and fires a single `agent-stuck`
notification. It does not kill or restart the run. It catches the failure mode
that never returns an exit code, but resolving it is still a human action.

**Branch strategy assumes `main`.** PR base, branch cleanup, and the diff for
modified-file tracking are all against `main` (`src/spawner/index.ts`). Repos
whose default branch is named otherwise are not supported without changes.

**Prompt-injection fencing is a mitigation, not a guarantee.** Untrusted ticket
content is fenced as data in the prompt (`src/prompts.ts`), and that fence is
backed by real structural controls (scrubbed env, argv-not-shell command
construction). But the fence itself is prompt-level; a determined injection can
still influence model behavior. The structural controls are what make the
consequences bounded.

**Retries are bounded and unconditional.** A failed run is requeued up to
`MAX_RETRIES` (3) regardless of _why_ it failed (`TicketQueue.requeue`,
`src/spawner/queue.ts`). A ticket that is fundamentally infeasible will consume
all three attempts before it is dropped. There is no "this will never succeed"
classifier.

**The pipeline runner costs more than it looks.** The planner → implementer →
reviewer pipeline is shipped and opt-in (`runner: 'pipeline'`,
`src/runners/pipeline-runner.ts`, [ADR-0007](adr/0007-single-agent-vs-pipeline-runner.md)),
not the default. It makes several Claude Code calls per ticket instead of one —
planner, implementer, reviewer, and up to `pipelineMaxRevisions` implementer fix
passes — so both cost and wall-clock latency scale roughly N× versus a single
run. It is a quality-for-cost trade to enable deliberately per tenant, not a free
upgrade. The reviewer's `VERDICT` is prompt-driven and can be wrong in either
direction; the validation gate, not the reviewer, remains the hard correctness
check.

**Autopilot is a single node.** The work queue is in memory
(`src/spawner/queue.ts`), memory / cost / completion state is local JSON, and git
checkouts are host-bound, so throughput is capped by one host and queued work does
not survive a restart. `maxConcurrentAgents`, `MAX_RETRIES`, and Linear rate
limiting are the vertical levers; the horizontal path (externalized queue, shared
state, split receiver/worker, shard by repo) is defined but not built. The
pipeline runner brings this ceiling closer by multiplying per-ticket load. See
[ADR-0008](adr/0008-scaling-model.md).

## Not built yet (status, not scope)

These are honestly incomplete, distinct from the deliberate non-goals above.

- **Live end-to-end evaluations have not been run.** The metrics scaffolding
  exists in code (cost, completions, success/failure counts, validation-failure
  counts), but the platform has not been evaluated against real repos at volume.
  The headline outcome metrics (time-to-PR, merge rate, cost-per-merged-PR)
  remain uncomputed. See [EVALUATION.md](EVALUATION.md).

## The through-line

The restraint is the point. Autopilot does one job (well-scoped ticket to
validated PR) and refuses the adjacent jobs that would dilute it: triage, merge
decisions, open-ended features, and pretending the security problem is solved.
The edges above are named so an operator knows exactly where the safe operating
envelope ends, which is the difference between a tool you can trust with a repo
and a demo you cannot.
