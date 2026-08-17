# 9. Pluggable agent backend with Claude Code as the default

## Status

Accepted

## Context

[ADR-0001](0001-spawn-claude-code-cli.md) decided to shell out to the `claude`
CLI as the coding agent, and that decision still holds: the inner agent loop is
not where Autopilot's value lives. But that ADR left the choice of agent
hard-coded. The runner layer spawned `claude` directly in `src/runners/invoke.ts`,
alongside a Claude-specific token parser and a Claude pricing table.

Two forces pushed on that. First, teams evaluating Autopilot do not all run
Claude Code; some want to point it at a different coding-agent CLI without forking
the runner layer. Second, the single hard-coded spawn site coupled three
concerns — process spawning, Claude's usage-telemetry format, and Claude's
pricing — into one function, so any second agent would have meant a second spawn
site and a copy of that plumbing.

The runner layer already had the right seam for this: runners never spawn an
agent themselves, they call an injected `InvokeAgent` function
(`src/runners/types.ts`). What was missing was a way to produce that function
from something other than "always Claude Code."

## Decision

Introduce an `AgentBackend` interface as the pluggable seam for _which_ coding
agent runs, sitting behind the existing `InvokeAgent` seam that decides _how a
ticket is worked_.

`AgentBackend` (`src/runners/backends/types.ts`) has one method with the same
shape runners already consume:

```ts
invoke(role, prompt, opts): Promise<AgentResult>; // { output; tokens?; costUsd? }
```

Two backends ship:

- **`ClaudeCodeBackend`** (`src/runners/backends/claude-code.ts`) is the default
  and a behavior-preserving extraction of the old `invoke.ts`: the same
  `spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], { env:
scrubbedEnv(), cwd })`, the same token parse, the same Claude 3.5 Sonnet
  pricing.
- **`CommandBackend`** (`src/runners/backends/command.ts`) runs a configurable
  CLI. Config is `{ command, args, promptVia? }`. The prompt reaches the agent
  either by substituting the literal `{prompt}` token in `args` (default,
  `promptVia: 'placeholder'`) or on the child's stdin (`promptVia: 'stdin'`). It
  **always** spawns shell-free (`shell: false`) with `scrubbedEnv()`, so there is
  no shell-injection surface regardless of prompt content.

`createBackend(tenant)` (`src/runners/backends/index.ts`) maps a tenant's
optional `agentBackend` config to a concrete backend: unset or
`{ type: 'claude-code' }` gives `ClaudeCodeBackend`; `{ type: 'command', ... }`
gives `CommandBackend`. `createRunner(tenant)` (`src/runners/index.ts`) now
derives its default `InvokeAgent` from `createBackend(tenant)`. A tenant that
configures nothing gets the classic Claude Code path byte for byte, which is why
the existing suite passes unchanged.

Usage and cost telemetry are honestly optional on the result. Only Claude Code
has a known usage format and a known price, so `CommandBackend` returns `tokens`
and `costUsd` undefined rather than parsing an arbitrary CLI's output or pricing
another vendor's model with Claude's rates.

## Consequences

**Positive**

- Autopilot is no longer hard-wired to one agent. Adding a backend is a new class
  behind `AgentBackend` plus a branch in `createBackend`, with no change to
  runners, the spawner, validation, PR creation, or memory.
- The one real spawn site for the coding agent is now a single backend file, and
  the Claude-specific token/pricing code lives with the Claude backend rather than
  in a general-purpose invoke module.
- The security posture is unchanged and applies to every backend: shell-free
  spawn, scrubbed environment, prompt passed as a literal argv element or stdin,
  never interpolated into a shell string.

**Negative**

- Non-Claude backends may report no token or cost telemetry, so cost tracking
  degrades to "unavailable" for them rather than being wrong. This is the honest
  trade; a fabricated number would be worse.
- Autopilot only observes a backend's exit code and captured text, same as
  ADR-0001. It cannot enforce that an arbitrary CLI actually edits the repo on the
  right branch, so the validation gate (ADR-0002) remains the real guarantee of
  quality regardless of backend.
- The config surface grows by one optional field, and an operator can point
  Autopilot at a CLI that does the wrong thing. The default stays safe.

## Alternatives considered

- **Keep Claude Code hard-coded.** Simplest, and correct while Claude Code was
  the only target. Rejected because it forced a fork for any other agent and kept
  spawning, telemetry parsing, and pricing fused in one function.
- **A full plugin system** (dynamic discovery, third-party backend packages, a
  registry loaded at runtime). More power than the need. It adds a loading and
  trust surface — running arbitrary plugin code — for a project whose realistic
  set of backends is small. Rejected as over-engineering; a typed interface with
  a switch in one factory is enough and stays auditable.
- **A generic backend that scrapes usage from any CLI.** Tempting for cost parity,
  but there is no reliable, model-agnostic usage format, and cost is per-model.
  Rejected in favor of honestly reporting telemetry as unavailable.

```

```
