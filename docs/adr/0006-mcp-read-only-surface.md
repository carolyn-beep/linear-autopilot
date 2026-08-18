# 6. Expose the platform over a read-only MCP surface

## Status

Accepted

## Context

Autopilot already has an HTTP dashboard API (`src/dashboard/index.ts`) exposing
the queue, active agents, costs, and status. The remaining question is how an AI
agent — a Claude Desktop or Claude Code session, or another orchestrator — should
observe and eventually drive Autopilot programmatically. The options range from
no programmatic surface at all, to a bespoke client API, to a Model Context
Protocol server, and — orthogonally — from read-only to write-enabled.

The pull toward MCP is composability: a capability exposed as MCP tools is one
capability that any MCP-capable agent can consume, rather than an integration
each client must hand-roll. The pull toward read-only-first is blast radius: a
tool that can enqueue or cancel work is a tool that a confused or injected agent
can misuse.

## Decision

Ship a **read-only** MCP server (`src/mcp/server.ts`, `src/mcp/tools.ts`) that is
a thin wrapper over the existing dashboard API. It exposes four tools —
`list_queue`, `get_agent_status`, `get_costs`, `get_status` — each of which
fetches a dashboard JSON endpoint and formats it into agent-readable text. Every
tool is annotated `readOnlyHint: true`; none mutates state. The server speaks MCP
over stdio, forwards an optional `DASHBOARD_TOKEN` as a bearer header, and keeps
stdout clean for the protocol (diagnostics go to stderr).

## Consequences

**Positive**

- One capability, many consumers: any MCP client gets Autopilot observability
  with no bespoke integration.
- Read-only means the worst case is information disclosure, not unwanted actions;
  this is the safe first increment.
- Wrapping the existing dashboard API keeps the tools thin and the fetch/format
  logic unit-testable in isolation (`src/mcp/tools.ts`), with no second source of
  truth.

**Negative**

- Observation only: an operator still cannot enqueue, retry, or cancel through
  MCP, so control actions remain out-of-band.
- The server inherits the dashboard API's coupling — an endpoint or shape change
  there ripples into the tool formatters.
- It depends on the dashboard being reachable at `AUTOPILOT_API_URL`; the tools
  surface a clear error, but there is a live dependency between processes.

## Alternatives considered

- **No programmatic surface.** Leaves only the human dashboard; no agent can
  observe Autopilot. Rejected — it forecloses the agent-to-agent direction.
- **A bespoke client API/SDK.** Full control, but every client re-implements the
  integration and loses MCP's plug-in-anywhere property. Rejected in favor of the
  standard protocol.
- **Write-enabled MCP from the start.** Powerful, but exposes state-changing
  actions to any connected agent before the authorization and guardrail story is
  settled. Deferred: read-only first, write later behind explicit controls.
