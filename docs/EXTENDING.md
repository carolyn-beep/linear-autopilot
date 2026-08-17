# Extending Autopilot

Autopilot treats the engineer integrating it as the customer. Capabilities are
composable building blocks behind small interfaces, not one-off branches in the
core loop. This guide covers the three extension points and where each plugs in.

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

## 3. Pluggable runners (exploratory)

Everything above is shipped. This one is not.

`src/_experimental/` holds a **runner abstraction** that would let Autopilot pick
a different execution strategy per ticket instead of always spawning a single
Claude Code process. `selectRunner()`
(`src/_experimental/runners/runner-selector.ts`) returns a `RunnerType` —
`claude-code`, `swarm-sdk` (a multi-agent planner/coder/reviewer team), or
`claude-on-rails` (a Rails-specialized swarm) — chosen by explicit tenant config,
project auto-detection, or ticket complexity, falling back to `claude-code`.
`src/_experimental/coordination/` sketches multi-agent coordination over MCP.

**Status:** exploratory. Per `src/_experimental/README.md`, nothing in the
shipped app imports this directory; it's excluded from the build/typecheck
(`tsconfig.json`) and from coverage (`jest.config.ts`), and its relative imports
still point at an older layout and won't compile as-is. Treat it as a design
sketch for where the platform is headed, not a supported extension point.

The intent is the same pattern as providers and checks: the core loop calls one
selection function and stays agnostic to which runner executes the ticket. Wiring
it in would mean replacing the direct `runClaudeCode` call in `src/spawner/index.ts`
with a runner selected via `selectRunner()`.

For the MCP integration this builds toward, see [MCP.md](MCP.md).
