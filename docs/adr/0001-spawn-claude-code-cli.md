# 1. Spawn the Claude Code CLI as the coding agent

## Status

Accepted

## Context

Autopilot needs a component that actually writes code: reads a repository,
edits files, runs tools, and iterates until a task is done. There are three
ways to obtain that capability. Build a bespoke agent loop directly against a
model API (own the tool-use loop, the file-editing operations, the retry and
context management). Adopt an agent framework such as LangGraph or CrewAI.
Or shell out to an existing, maintained coding agent.

The team's judgment is that the inner agent loop is not where Autopilot's value
lives. The differentiated work is the orchestration around the agent — queueing,
per-tenant concurrency, a validation gate, cross-session memory, notifications,
cost tracking. That layer is what a bespoke loop would distract from.

## Decision

Spawn the `claude` CLI as a subprocess for each ticket. The runner layer
invokes it in one place, `src/runners/invoke.ts`, which calls
`spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], ...)` with
the repo as `cwd` and a scrubbed environment, captures stdout/stderr, and treats
exit code `0` as "the agent thinks it is done." The prompt is assembled by
`buildAutopilotPrompt` (`src/prompts.ts`); everything after the process exits —
validation, PR creation, memory — is Autopilot's, not the agent's.

## Consequences

**Positive**

- Tool use, file editing, and multi-step iteration come for free and improve
  whenever the CLI is upgraded, with no change to Autopilot.
- The integration surface is one subprocess boundary: a prompt in, an exit code
  and captured output out. This keeps the spawner small and testable.
- The orchestration layer stays the focus of engineering effort.

**Negative**

- Little control over the inner loop: no hook into individual tool calls,
  token-by-token streaming, or mid-run steering. Autopilot observes only the
  final exit code and text output.
- A hard dependency on the CLI being installed and authenticated on the host.
- Exit code `0` is a weak success signal, which is precisely why ADR 0002 exists.
- `--dangerously-skip-permissions` removes interactive guardrails, which raises
  the stakes on the sandboxing and environment scrubbing in ADR 0004.

## Alternatives considered

- **Bespoke agent loop on a raw model API.** Maximum control, but re-implements
  and must maintain tool use, file editing, and context management — the parts
  the CLI already does well. Rejected: high cost against Autopilot's actual
  differentiator.
- **Agent framework (LangGraph / CrewAI).** Provides loop scaffolding but adds a
  heavy dependency and its own abstractions, while still needing coding-specific
  tools wired in. Rejected as more weight than the single-subprocess boundary.
- **Multi-agent runner strategies.** A single CLI process is the default, but the
  runner layer (`src/runners/`) also ships an opt-in sequential
  planner → implementer → reviewer pipeline. That decision — single-agent default
  vs. the multi-role pipeline, and why the pipeline is sequential rather than a
  parallel swarm — is recorded in
  [ADR-0007](0007-single-agent-vs-pipeline-runner.md). Either way, each role is a
  spawned `claude` process, so this decision stands.
