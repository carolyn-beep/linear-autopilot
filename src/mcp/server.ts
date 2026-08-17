#!/usr/bin/env node
/**
 * Linear Autopilot MCP server.
 *
 * Exposes Autopilot's read-only control surface (queue, agents, costs, status)
 * as Model Context Protocol tools that an AI agent can invoke over stdio. It is a
 * thin wrapper over the existing dashboard HTTP API — see `src/dashboard/index.ts`
 * for the endpoints and `src/mcp/tools.ts` for the fetch + formatting logic.
 *
 * IMPORTANT: an MCP stdio server communicates with the client over stdout, so it
 * must NEVER write logs there. All diagnostics go to stderr via `console.error`
 * (the repo `logger` writes to stdout and is therefore intentionally not used here).
 *
 * Env:
 *   AUTOPILOT_API_URL  Base URL of the Autopilot dashboard API (default http://localhost:3000)
 *   DASHBOARD_TOKEN    Optional bearer token, forwarded as `Authorization: Bearer <token>`
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getAgentStatus, getBaseUrl, getCosts, getStatus, listQueue } from './tools';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'linear-autopilot',
    version: '1.0.0',
  });

  server.registerTool(
    'list_queue',
    {
      title: 'List ticket queue',
      description:
        'List Linear tickets waiting in the Autopilot queue to be picked up by an agent. ' +
        'Returns each pending ticket with its identifier, title, tenant, when it was enqueued, ' +
        'and how many times it has been attempted. Use this to see the backlog of upcoming work. ' +
        'Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => listQueue()
  );

  server.registerTool(
    'get_agent_status',
    {
      title: 'Get running agent status',
      description:
        'Show the Autopilot agents that are currently running. Returns each active agent with the ' +
        'ticket it is working on, tenant, git branch, and how long it has been running. Use this to ' +
        'check what work is in progress right now. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => getAgentStatus()
  );

  server.registerTool(
    'get_costs',
    {
      title: 'Get token and cost usage',
      description:
        'Summarize recent token consumption and estimated cost across Autopilot agents. Returns ' +
        'totals plus a per-run breakdown (ticket, tenant, input/output tokens, estimated USD). ' +
        'Costs are approximate estimates from configured per-token pricing, not an actual bill. ' +
        'Use this to monitor spend. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => getCosts()
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get overall status overview',
      description:
        'Get a high-level overview of the whole Autopilot system: queue size, number of active ' +
        'agents, uptime, estimated total cost, total tokens, and recent completions (with PR links ' +
        'where available). Use this as a quick health check or dashboard summary. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => getStatus()
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so stdout stays a clean MCP transport channel.
  console.error(`[linear-autopilot-mcp] ready (API: ${getBaseUrl()})`);
}

// Only start when run directly (not when imported by tests).
if (require.main === module) {
  main().catch((error) => {
    console.error('[linear-autopilot-mcp] fatal error:', error);
    process.exit(1);
  });
}
