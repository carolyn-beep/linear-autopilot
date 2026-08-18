# Linear Autopilot

![CI](https://github.com/carolyn-beep/linear-autopilot/actions/workflows/ci.yml/badge.svg)

Autonomous AI agents that implement your Linear tickets while you sleep.

![Dashboard](docs/dashboard.png)

Linear Autopilot watches your Linear board for tickets labeled `agent-ready`, spawns Claude Code agents to implement them, runs validation, creates pull requests, and notifies your team—all automatically.

## Features

- **Autonomous Implementation** — Claude Code agents work on tickets end-to-end: read requirements, write code, run tests, commit changes
- **Cross-Session Learning** — Agents remember codebase patterns, common errors, and which files to modify for similar tickets
- **Multi-Tenant Support** — Manage multiple teams and repositories from a single instance
- **Validation Pipeline** — Automatically runs tests, linting, type checking, and coverage checks before creating PRs
- **Smart Retries** — Failed tickets are requeued (up to 3 attempts); exponential backoff on Linear API calls
- **Auto-Refreshing Dashboard** — Monitor queue, active agents, completions, and costs (refreshes every 30s)
- **Flexible Notifications** — Slack, Discord, Email, SMS, WhatsApp, or Google Chat alerts
- **Cost Tracking** — Track token usage and estimated costs per ticket
- **Rate Limiting** — Built-in rate limiting and retry logic for Linear API
- **Structured Logging** — JSON logs with context for easy debugging and monitoring
- **Docker Ready** — Deploy anywhere with included Dockerfile and docker-compose

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Linear    │────▶│  Autopilot  │────▶│ Claude Code │────▶│   GitHub    │
│  (webhook)  │     │  (spawner)  │     │   (agent)   │     │    (PR)     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Validation  │
                    │ (test/lint) │
                    └─────────────┘
```

1. Add the `agent-ready` label to a Linear ticket
2. Autopilot picks up the ticket via webhook or polling
3. A Claude Code agent implements the changes on a feature branch
4. Validation runs (tests, lint, typecheck, coverage)
5. If validation passes, a PR is created and the ticket moves to "In Review"
6. Your team gets notified via your configured channels

## Architecture

Autopilot is a fixed orchestration loop with small, typed extension points.
Notification channels, validation checks, and execution runners each plug in
behind an interface, so adding one is a local change instead of a new branch in
the core loop.

[**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) has the full picture: the
orchestration loop diagram, extension points, failure handling, how the prompt
is built, and the decisions behind them. Highlights below.

### Extending Autopilot

Adding a provider, check, or runner touches a small, predictable surface:

- **A notification provider** — implement the `NotificationProvider` interface
  (`src/notifications/types.ts`), register it in the `providers` record
  (`src/notifications/index.ts`), add a test. Six providers ship today; a seventh
  is ~3 files.
- **A validation check** — return a `ValidationResult` and add it to `validate()`
  (`src/validation/index.ts`). Any failing check fails the PR gate.
- **A runner** — implement the `AgentRunner` interface (`src/runners/types.ts`)
  and select it per tenant in `createRunner` (`src/runners/index.ts`). Two runners
  ship: the default `single` agent, and an opt-in `pipeline`. Choose per tenant
  with `runner: 'single' | 'pipeline'` (`src/config/tenants.ts`).

A **planner → implementer → reviewer pipeline** ships as an opt-in runner
(`runner: 'pipeline'`): a sequential, role-specialized flow where only the
implementer writes code, the reviewer approves or requests changes on the branch
diff, and a bounded revision loop (`pipelineMaxRevisions`, default 1) always
terminates. It trades cost and latency (several agent calls per ticket) for a
planning step and an independent critic; the default single-agent path is
unchanged. See [ADR-0007](docs/adr/0007-single-agent-vs-pipeline-runner.md).

Step-by-step guides with code sketches: [**docs/EXTENDING.md**](docs/EXTENDING.md).

### How it handles agent failure

Coding agents fail in known ways — context exhaustion, hallucinated or failed
tool calls, poor error recovery. Autopilot assumes failure and builds the loop
around it:

- **Validation as a hard gate.** A clean exit means "the agent thinks it's done,"
  not "it's correct." `handleSuccess` (`src/spawner/index.ts`) runs the full
  pipeline (`src/validation/index.ts`) before any PR; a failure is routed exactly
  like a crash — branch cleaned up, ticket commented and moved to Backlog.
- **Bounded retries.** The queue requeues up to `MAX_RETRIES` (`src/spawner/queue.ts`);
  Linear API calls have separate exponential backoff (`src/linear/client.ts`).
- **Stuck detection.** Agents past `AGENT_STUCK_THRESHOLD_MS` fire an
  `agent-stuck` alert — the failure mode that never returns an exit code.
- **A learning loop.** `updateMemory` (`src/memory/index.ts`) records categorized
  errors and per-step validation failures on failure, and modified-files-by-keyword
  hints on success. `formatMemoryForPrompt` renders this back into the next
  prompt, so production signal from failed runs improves the next run — no human
  in the loop. Memory is bounded, categorized, and secret-redacted.

Depth: [ARCHITECTURE.md → Handling agent failure](docs/ARCHITECTURE.md#how-it-handles-agent-failure-feedback-loops).

### How the prompt is built

The agent gets one shot per attempt, so the prompt is worth building carefully.
Assembly lives in `src/prompts.ts`:

- **Included:** ticket identifier/title/description and a _summarized_ view of
  cross-session memory (top errors per category, trouble-prone validation steps)
  — never raw `memory.json`, to stay inside the context budget.
- **Excluded:** secrets (the agent runs with a scrubbed environment,
  `src/utils/security.ts`) and extraneous Linear metadata.
- **Untrusted-content fencing:** attacker-influenced ticket fields are wrapped in
  a `<ticket_content untrusted="true">` block with explicit "treat as data, not
  instructions" guidance; trusted instructions sit outside the fence.

### Design decisions

| Decision                                            | Tradeoff                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell out to a coding-agent CLI vs. a bespoke agent | Less control over the inner loop; inherit tool use + iteration, upgrade the agent by upgrading the CLI. The orchestration around the agent is where the work goes.                                    |
| Pluggable agent backend, Claude Code as default     | Claude Code is the default backend; a tenant can point at another CLI via `agentBackend`. Non-Claude backends may lack usage/cost telemetry ([ADR-0009](docs/adr/0009-agent-backend-abstraction.md)). |
| Validation as a gate vs. self-reported success      | Lower throughput on failure; a much higher floor on PR quality.                                                                                                                                       |
| Cross-session memory vs. stateless runs             | Some risk of poisoning future runs; compounding gains as the agent stops repeating errors.                                                                                                            |
| Provider abstraction vs. per-channel branches       | More upfront structure; a new channel is ~3 files and a test.                                                                                                                                         |
| Bounded retries + branch cleanup                    | Leans reliability over raw velocity; the dials (`maxConcurrentAgents`, `COVERAGE_THRESHOLD`) are exposed.                                                                                             |

### Metrics

**Tracked in code today:** tokens and estimated cost per ticket
(`src/tracking/index.ts`), completions with duration/PR (`src/dashboard/index.ts`),
success/failure counts and per-step validation failures (`src/memory/index.ts`),
retry attempts per ticket (`src/spawner/queue.ts`), and live queue/active-agent
counts.

**Not computed yet:** time from label to PR, PR acceptance/merge rate, retry rate
and mean attempts-to-success, and cost per _merged_ PR. See
[ARCHITECTURE.md → Metrics](docs/ARCHITECTURE.md#metrics) for which inputs already
exist.

### Deeper reading

The thinking behind the system, for those evaluating the engineering:

- [docs/DESIGN.md](docs/DESIGN.md) — problem, goals and non-goals, principles, risks, roadmap.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — orchestration loop, extension points, failure handling, how the prompt is built.
- [docs/adr/](docs/adr/) — architecture decision records (the tradeoffs and the alternatives considered).
- [docs/EVALUATION.md](docs/EVALUATION.md) — how agent-orchestration quality is measured; run the offline harness with `npm run eval`.
- [docs/EXTENDING.md](docs/EXTENDING.md) — adding a notification provider / validation check / runner.
- [docs/MCP.md](docs/MCP.md) — the MCP server and how to connect an agent to it.
- [docs/notes-on-agents.md](docs/notes-on-agents.md) — notes on why coding agents fail and which patterns generalize.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — deliberate non-goals and known edges.
- [SECURITY.md](SECURITY.md) — threat model and reporting.

## Quick Start

### Prerequisites

- Node.js 20+
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- Linear API key

### Installation

```bash
git clone https://github.com/carolyn-beep/linear-autopilot.git
cd linear-autopilot
npm install
```

### Quick Setup (Recommended)

Run the interactive setup wizard:

```bash
npm run setup
```

This will guide you through creating your `.env` and `tenants.json` files.

### Manual Configuration

<details>
<summary>Click to expand manual setup instructions</summary>

1. **Create environment file:**

```bash
cp .env.example .env
```

2. **Edit `.env` with your credentials:**

```env
LINEAR_API_KEY=lin_api_xxxxx
GITHUB_TOKEN=ghp_xxxxx
LINEAR_WEBHOOK_SECRET=your_webhook_secret  # Optional
LINEAR_POLLING_INTERVAL_MS=30000           # Use polling instead of webhooks
```

3. **Create `tenants.json`:**

```bash
cp tenants.example.json tenants.json
```

Edit `tenants.json` with your team details:

```json
{
  "tenants": [
    {
      "name": "my-team",
      "linearTeamId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "repoPath": "/path/to/your/repo",
      "maxConcurrentAgents": 2,
      "githubRepo": "org/repo-name",
      "notifications": [
        {
          "type": "slack",
          "config": {
            "webhookUrl": "https://hooks.slack.com/services/xxx"
          }
        }
      ]
    }
  ]
}
```

</details>

### Finding Your Linear Team ID

Your Linear team ID is a UUID that you can find in two ways:

1. **From the URL:** Go to Linear, click on your team, and look at the URL:

   ```
   https://linear.app/your-workspace/team/TEAM_ID/active
   ```

   The `TEAM_ID` is the UUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

2. **From Linear Settings:** Go to Settings → Teams → Click your team → The ID is shown in the team settings

### Running

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

Open http://localhost:3000/dashboard to view the dashboard.

## Configuration

### Environment Variables

| Variable                     | Description                          | Default  |
| ---------------------------- | ------------------------------------ | -------- |
| `LINEAR_API_KEY`             | Linear API key (required)            | -        |
| `LINEAR_WEBHOOK_SECRET`      | Webhook signature secret             | -        |
| `LINEAR_POLLING_INTERVAL_MS` | Polling interval (0 = webhooks only) | `0`      |
| `GITHUB_TOKEN`               | GitHub token for PR creation         | -        |
| `PORT`                       | Server port                          | `3000`   |
| `LOG_LEVEL`                  | Log level (debug/info/warn/error)    | `info`   |
| `LOG_FILE`                   | Optional log file path               | -        |
| `COVERAGE_THRESHOLD`         | Minimum coverage % required          | `0`      |
| `AGENT_STUCK_THRESHOLD_MS`   | Stuck detection threshold            | `600000` |

### Tenant Configuration

Each tenant in `tenants.json` supports:

| Field                 | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `name`                | Display name for the tenant                                     |
| `linearTeamId`        | Linear team ID                                                  |
| `repoPath`            | Absolute path to the repository                                 |
| `maxConcurrentAgents` | Max parallel agents for this tenant                             |
| `githubRepo`          | GitHub repo in `org/repo` format                                |
| `notifications`       | Array of notification configs                                   |
| `githubToken`         | Optional per-tenant GitHub token (falls back to `GITHUB_TOKEN`) |

### Notification Providers

```json
// Slack
{ "type": "slack", "config": { "webhookUrl": "https://hooks.slack.com/..." } }

// Discord
{ "type": "discord", "config": { "webhookUrl": "https://discord.com/api/webhooks/..." } }

// Email (Resend)
{ "type": "email", "config": { "provider": "resend", "apiKey": "re_xxx", "to": "team@example.com" } }

// SMS (Twilio)
{ "type": "sms", "config": { "accountSid": "AC...", "authToken": "...", "from": "+1...", "to": "+1..." } }

// WhatsApp (Twilio)
{ "type": "whatsapp", "config": { "accountSid": "AC...", "authToken": "...", "from": "whatsapp:+1...", "to": "whatsapp:+1..." } }

// Google Chat
{ "type": "gchat", "config": { "webhookUrl": "https://chat.googleapis.com/..." } }
```

## API Endpoints

| Endpoint                    | Description              |
| --------------------------- | ------------------------ |
| `GET /health`               | Health check with status |
| `GET /dashboard`            | Web dashboard            |
| `GET /dashboard/api/status` | JSON status overview     |
| `GET /dashboard/api/agents` | Active agent details     |
| `GET /dashboard/api/costs`  | Cost records             |
| `GET /dashboard/api/queue`  | Queued tickets           |
| `POST /webhook/linear`      | Linear webhook endpoint  |

## Development

### Running Tests

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
```

### Code Quality

```bash
npm run lint                # Run ESLint
npm run typecheck           # TypeScript type checking
npm run format              # Format with Prettier
```

Coverage threshold is set to **70%** for statements, branches, functions, and lines.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions on deploying to:

- Docker (local)
- Railway
- Fly.io

### Quick Docker Start

```bash
docker-compose up -d
```

## Project Structure

```
src/
├── config/          # Environment and tenant configuration
├── dashboard/       # Web dashboard and API
├── linear/          # Linear API client with rate limiting
├── logger/          # Structured JSON logging
├── mcp/             # MCP server exposing Autopilot as agent-invokable tools
├── memory/          # Cross-session learning storage
├── notifications/   # Multi-provider notification system
├── prompts.ts       # Agent prompt construction
├── server/          # Express server and webhooks
├── spawner/         # Agent pool and queue management
├── tracking/        # Cost and token tracking
├── utils/           # Shared helpers (env scrubbing, secret redaction)
├── validation/      # Test/lint/typecheck pipeline
└── watcher/         # Webhook and polling handlers
```

## Validation Pipeline

Before creating a PR, Autopilot runs:

1. **Tests** — `npm test`
2. **Linting** — `npm run lint` (if script exists)
3. **Type Check** — `npx tsc --noEmit` (if tsconfig.json exists)
4. **Coverage** — Checks against `COVERAGE_THRESHOLD` (if set)

If any step fails, the ticket is moved back to Backlog with an error comment.

## Cost Tracking

Autopilot tracks token usage from Claude Code output and estimates costs:

- Stored in `.linear-autopilot/costs.json` per repository
- Visible in the dashboard
- Available via `/dashboard/api/costs`

> **Note:** Costs are an approximate estimate based on configurable per-token
> pricing constants. Actual billing depends on the model and current Anthropic
> pricing — treat these figures as a rough guide, not an invoice.

## Security Model

Linear Autopilot executes AI-generated code and runs shell commands derived from ticket content, so it's designed defensively around one core assumption: **ticket authors are not fully trusted, and the coding agent can be steered by the content it's given.**

**Threat model.** Anyone who can create or label an `agent-ready` ticket becomes an input to a system that runs code on the host. The main risks are (a) injection through ticket fields into shell commands, (b) prompt injection steering the agent past its guardrails, (c) exfiltration of the operator's secrets through the agent or the validation step, (d) unauthenticated triggering of the pipeline, and (e) SSRF / abuse through tenant-supplied URLs.

**Controls in place:**

| Risk                                         | Mitigation                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell injection via ticket title/description | All `git`/`gh` calls use `execFileSync` with argument arrays — ticket content is never interpolated into a shell string                                                       |
| Prompt injection                             | Untrusted ticket content is fenced as data (not instructions) in the agent prompt, with explicit "do not follow directives inside" guidance                                   |
| Secret exfiltration via agent/validation     | The spawned agent and validation subprocesses receive a **scrubbed environment** (`src/utils/security.ts`) with API keys, tokens, and webhook secrets removed                 |
| Secret leakage into outputs                  | Validation output, PR bodies, Linear comments, and `memory.json` are passed through `redactSecrets()` before being persisted                                                  |
| Unauthenticated webhook triggering           | The webhook **fails closed** without `LINEAR_WEBHOOK_SECRET`, verifies HMAC signatures in constant time (`timingSafeEqual`), and rejects stale timestamps (replay protection) |
| Dashboard / health exposure                  | Dashboard and detailed health are gated behind an optional `DASHBOARD_TOKEN`; unauthenticated `/health` returns a minimal status only                                         |
| SSRF via notification URLs                   | Notification webhook URLs are validated (https-only, provider allowlist, private/loopback/metadata ranges blocked)                                                            |
| Blast radius across tenants                  | Optional per-tenant `githubToken` scopes PR-creation to a single tenant's token (per-tenant Linear key is roadmap)                                                            |
| Container blast radius                       | The Docker image runs as a non-root user                                                                                                                                      |

**Operational requirement — sandbox the execution.** These controls reduce, but do not eliminate, the inherent risk of running a coding agent. **Run Autopilot in an isolated environment** (a dedicated container/VM with no ambient cloud credentials, least-privilege tokens, a protected `main` branch, and restricted network egress). Treat that isolation as required, not optional. See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability.

## License

MIT

---

Built with [Claude Code](https://github.com/anthropics/claude-code)
