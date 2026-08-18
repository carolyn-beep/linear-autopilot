# Extending Autopilot

A developer adds a notification provider, a validation check, or a runner by
implementing a small interface, not by adding branches to the core loop. This
guide covers those extension points and where each plugs in.

For how these fit the overall system, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Add a notification provider

This is the cleanest example of the pattern: a typed interface, a registry, and a
test. Adding a provider touches three files and nothing in the core loop.

The contract is `NotificationProvider` (`src/notifications/types.ts`):

```ts
export interface NotificationProvider {
  name: string;
  send(event: NotificationEvent, config: Record<string, string>): Promise<void>;
}
```

`NotificationEvent` is a discriminated union (`agent-started`, `agent-completed`,
`agent-failed`, `agent-stuck`, `pr-created`) — switch on `event.type` to render
each.

**Step 1 — implement the provider** in `src/notifications/providers/`.
Existing providers (`slack.ts`, `discord.ts`, etc.) reuse the shared
`formatter.ts` helpers and the `sendWebhook` helper (`src/notifications/webhook.ts`),
which enforces the SSRF allowlist. A minimal webhook provider:

```ts
// src/notifications/providers/mattermost.ts
import { NotificationProvider, NotificationEvent } from '../types';
import { formatMarkdown } from '../formatter';
import { sendWebhook } from '../webhook';

export const mattermostProvider: NotificationProvider = {
  name: 'mattermost',
  async send(event: NotificationEvent, config: Record<string, string>): Promise<void> {
    const { webhookUrl } = config;
    if (!webhookUrl) throw new Error('Mattermost webhookUrl is required');
    await sendWebhook(webhookUrl, { text: formatMarkdown(event) }, 'Mattermost');
  },
};
```

**Step 2 — register it** in the `providers` record
(`src/notifications/index.ts`). This record is the single dispatch table `send()`
looks up by `notification.type`:

```ts
const providers: Record<NotificationType, NotificationProvider> = {
  slack: slackProvider,
  discord: discordProvider,
  email: emailProvider,
  gchat: gchatProvider,
  sms: smsProvider,
  whatsapp: whatsappProvider,
  mattermost: mattermostProvider, // <-- add here
};
```

Add `'mattermost'` to the `NotificationType` union (`src/config/tenants.ts`) so
tenant configs type-check.

**Step 3 — add a test** in `tests/notifications/providers.test.ts`. The existing
tests mock `global.fetch` and assert on: the provider `name`, a successful POST to
the webhook URL, a thrown error when required config is missing, and a thrown
error on a non-OK response. Mirror that shape.

That's the whole surface. `notify()` fan-out, `Promise.allSettled` isolation (one
provider failing doesn't block the others), and logging are already handled in
`src/notifications/index.ts`.

## 2. Add a validation check

Validation checks are the gate before a PR is created (see ARCHITECTURE.md). A
check is a function returning a `ValidationResult` (`src/validation/index.ts`):

```ts
export interface ValidationResult {
  name: string;
  passed: boolean;
  output: string;
  duration: number;
}
```

**Step 1 — write the check.** Reuse `runCommand`, which already runs in the
repo's directory with a scrubbed environment (`scrubbedEnv()`), enforces
`VALIDATION_TIMEOUT_MS`, and redacts secrets from captured output. Guard on the
project actually supporting the check so it's a no-op skip otherwise — this is the
convention every existing check follows:

```ts
function runSecurityAudit(repoPath: string): ValidationResult {
  if (!hasScript(repoPath, 'audit')) {
    return { name: 'audit', passed: true, output: 'No audit script found, skipping', duration: 0 };
  }
  return runCommand('npm', ['run', 'audit'], repoPath, 'audit');
}
```

**Step 2 — add it to the pipeline** in `validate()`:

```ts
results.push(runTests(repoPath));
results.push(runLint(repoPath));
results.push(runTypeCheck(repoPath));
results.push(checkCoverage(repoPath));
results.push(runSecurityAudit(repoPath)); // <-- add here
```

`passed` is computed as `results.every(r => r.passed)`, so any failing check
fails the gate and routes the run to `handleFailure`. `formatValidationSummary`
already renders new checks in ticket comments and PR bodies with no change.

**Step 3 — test** in `tests/validation/pipeline.test.ts`.

Note the convention: an unsupported check returns `passed: true` with a "skipping"
message rather than failing. Checks are opt-in per repo capability, so a repo
without the relevant script is never blocked by it.

## 3. Add a runner

A runner encapsulates _how_ a ticket gets implemented — a single Claude Code
agent, or the multi-role pipeline — behind one interface. This is a shipped
extension point, same pattern as providers and checks: the spawner calls one
factory and stays agnostic to which runner executes the ticket.

The contract is `AgentRunner` (`src/runners/types.ts`):

```ts
export interface AgentRunner {
  run(context: RunnerContext): Promise<RunnerResult>;
}
```

`RunnerContext` carries the `ticket`, the `tenant`, and the `branchName`.
`RunnerResult` reports `success`, a one-line `summary`, the aggregated `output`
(which the spawner passes to `recordUsage`), and an optional per-role
`roleResults` breakdown (tokens, cost, duration per `AgentRole`).

Two runners ship: `SingleAgentRunner` (`src/runners/single-agent-runner.ts`, the
default, behavior-preserving) and `PipelineRunner`
(`src/runners/pipeline-runner.ts`, the opt-in planner → implementer → reviewer
pipeline). The design rationale is [ADR-0007](adr/0007-single-agent-vs-pipeline-runner.md).

**Step 1 — implement `AgentRunner`.** Take the agent invocation as an injected
`InvokeAgent` (`src/runners/types.ts`) rather than spawning an agent yourself.
That is what keeps runners unit-testable: tests pass a mock, production passes an
invoker derived from the tenant's agent backend. The real spawn boundary lives in
the backend layer (`src/runners/backends/`), not in runners — see section 4. Do
not add a spawn site inside a runner.

```ts
// src/runners/my-runner.ts
import { AgentRunner, InvokeAgent, RunnerContext, RunnerResult } from './types';

export class MyRunner implements AgentRunner {
  constructor(private readonly invoke: InvokeAgent) {}

  async run(context: RunnerContext): Promise<RunnerResult> {
    const { ticket, tenant, branchName } = context;
    const started = Date.now();
    const { output, tokens, costUsd } = await this.invoke('single', /* prompt */ '', {
      cwd: tenant.repoPath,
      role: 'single',
      ticketId: ticket.identifier,
    });
    return {
      success: true,
      summary: 'My runner completed',
      output,
      roleResults: [
        {
          role: 'single',
          tokens: tokens ?? 0,
          costUsd: costUsd ?? 0,
          durationMs: Date.now() - started,
        },
      ],
    };
  }
}
```

Reuse the prompt builders in `src/prompts.ts` (`buildAutopilotPrompt`, or the
role-specific `buildPlannerPrompt` / `buildImplementerPrompt` /
`buildReviewerPrompt`) so your runner inherits the same untrusted-content fencing
and memory injection. If your runner reads the branch diff, use `execFileSync`
with an argument array (as `PipelineRunner` does), never a shell.

**Step 2 — wire it into the factory.** Add a `runner` value to the tenant config
union (`src/config/tenants.ts`) and a branch in `createRunner`
(`src/runners/index.ts`):

```ts
export function createRunner(
  tenant: TenantConfig,
  invoke = createBackendInvoker(createBackend(tenant))
): AgentRunner {
  if (tenant.runner === 'pipeline') return new PipelineRunner({ invoke });
  if (tenant.runner === 'my-runner') return new MyRunner(invoke); // <-- add here
  return new SingleAgentRunner({ invoke });
}
```

The default `invoke` is derived from the tenant's agent backend (section 4), so a
runner works with whatever backend the tenant configured. The spawner already
calls `createRunner(tenant).run(...)` (`src/spawner/index.ts`); the validation
gate, PR creation, and memory downstream are unchanged, so a new runner needs no
changes there.

**Step 3 — test it** by constructing the runner with a mock `InvokeAgent` and
asserting on the returned `RunnerResult` (success, summary, `roleResults`). No
real agent process is involved.

## 4. Add or configure an agent backend

A runner decides _how_ a ticket is worked; a backend decides _which coding agent_
runs each call. The two are independent extension points — a backend works under
either runner. This is what makes the coding agent pluggable rather than
hard-wired to Claude Code.

The contract is `AgentBackend` (`src/runners/backends/types.ts`):

```ts
export interface AgentBackend {
  invoke(role: AgentRole, prompt: string, opts: InvokeAgentOptions): Promise<AgentResult>;
}
```

`AgentResult` is `{ output; tokens?; costUsd? }` — the same shape runners already
consume. `tokens` and `costUsd` are optional and must stay honest: if a backend's
CLI does not emit parseable usage, leave them undefined rather than fabricating a
number.

Two backends ship: `ClaudeCodeBackend` (`src/runners/backends/claude-code.ts`,
the default) and `CommandBackend` (`src/runners/backends/command.ts`). The design
rationale is [ADR-0009](adr/0009-agent-backend-abstraction.md).

### Configure the generic command backend (no code)

Most alternative agents need no new code — just point `CommandBackend` at the CLI
via a tenant's `agentBackend` field (`src/config/tenants.ts`):

```jsonc
// Prompt substituted for the {prompt} argv token (default)
"agentBackend": {
  "type": "command",
  "command": "my-agent",
  "args": ["run", "--task", "{prompt}"]
}

// Prompt delivered on the child's stdin
"agentBackend": {
  "type": "command",
  "command": "my-agent",
  "args": ["run"],
  "promptVia": "stdin"
}
```

The command is always spawned shell-free with a scrubbed environment, and the
prompt is a single literal argv element (or stdin) — never interpolated into a
shell string, so ticket content cannot inject a command.

### Add a new backend type (code)

When a CLI needs bespoke handling (a different token format, a wrapper protocol),
implement `AgentBackend` and wire it into the factory:

**Step 1 — implement the backend** in `src/runners/backends/`. Spawn shell-free
with `scrubbedEnv()` and the repo as `cwd`, capture stdout/stderr, resolve an
`AgentResult` on clean exit, and reject with `AgentInvocationError`
(`src/runners/backends/errors.ts`) on non-zero exit or spawn error — carrying the
captured output so the spawner can still record context. Parse usage only if the
CLI reliably emits it.

**Step 2 — wire it into the factory** by extending the `AgentBackendConfig` union
(`src/runners/backends/types.ts`) and adding a branch in `createBackend`
(`src/runners/backends/index.ts`):

```ts
export function createBackend(tenant: TenantConfig): AgentBackend {
  const config = tenant.agentBackend;
  if (!config || config.type === 'claude-code') return new ClaudeCodeBackend();
  if (config.type === 'my-backend') return new MyBackend(config); // <-- add here
  return new CommandBackend(config);
}
```

**Step 3 — test it** by mocking `child_process.spawn` with a fake process and
asserting on the argv, `shell: false`, the scrubbed env, the resolved
`AgentResult`, and the `AgentInvocationError` path. Never spawn a real CLI in a
test. See `tests/runners/backends/` for the pattern.

For the MCP control surface, see [MCP.md](MCP.md).
