# Linear Autopilot MCP Server

Linear Autopilot ships a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that exposes Autopilot's control surface as tools an AI agent can
invoke. It is a **thin, read-only wrapper** over the existing dashboard HTTP API
(`src/dashboard/index.ts`): every tool fetches a dashboard JSON endpoint and
returns human-readable text. Nothing here mutates state — an agent can observe
Autopilot but cannot enqueue or cancel work.

The server speaks MCP over **stdio**, so it plugs directly into Claude Desktop,
Claude Code, or any MCP-capable client.

## Tools

| Tool               | Endpoint                    | What it returns                                                                     |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| `list_queue`       | `GET /dashboard/api/queue`  | Pending tickets: identifier, title, tenant, enqueue time, attempt count.            |
| `get_agent_status` | `GET /dashboard/api/agents` | Currently running agents: ticket, tenant, git branch, run duration.                 |
| `get_costs`        | `GET /dashboard/api/costs`  | Recent token usage and estimated cost, with totals and a per-run breakdown.         |
| `get_status`       | `GET /dashboard/api/status` | Overview: queue size, active agents, uptime, total cost/tokens, recent completions. |

All tools are annotated `readOnlyHint: true`. Cost figures are approximate
estimates from configured per-token pricing (`src/tracking`), not an actual bill.

Errors are returned as agent-readable messages (with `isError: true`) rather than
thrown — e.g. a connection failure explains that the Autopilot server may be down,
and a `401` explains that `DASHBOARD_TOKEN` must be set.

## Running

```bash
npm run mcp
```

This starts the server on stdio. It does not print to stdout (that channel is
reserved for the MCP protocol); diagnostics go to stderr.

### Environment

| Variable            | Default                 | Purpose                                                                                                                                     |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOPILOT_API_URL` | `http://localhost:3000` | Base URL of the running Autopilot dashboard API.                                                                                            |
| `DASHBOARD_TOKEN`   | _(unset)_               | If set, sent as `Authorization: Bearer <token>` on every request. Required only when the dashboard itself has `DASHBOARD_TOKEN` configured. |

The Autopilot server must be running (e.g. `npm start`) for the tools to return
data.

## Client configuration

### Claude Desktop

Add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "linear-autopilot": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/linear-autopilot",
      "env": {
        "AUTOPILOT_API_URL": "http://localhost:3000",
        "DASHBOARD_TOKEN": ""
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add linear-autopilot \
  --env AUTOPILOT_API_URL=http://localhost:3000 \
  -- npm run mcp
```

Run the command from the repo root (or point `cwd`/the command at an absolute
path) so `npm run mcp` resolves. Once connected, ask things like
_"What's in the Autopilot queue?"_ or _"How much have the agents cost so far?"_
and the client will call the tools above.
