/**
 * Autopilot MCP tools.
 *
 * These are thin, read-only wrappers over Linear Autopilot's existing dashboard
 * HTTP API (see `src/dashboard/index.ts`). Each exported tool fetches a JSON
 * endpoint and formats it into agent-readable text. The fetch + format logic
 * lives here (rather than in `server.ts`) so it can be unit-tested in isolation.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_BASE_URL = 'http://localhost:3000';

/** Shape returned by the MCP SDK's tool callbacks. */
export type ToolResult = CallToolResult;

// --- Response shapes (mirrors src/dashboard/index.ts) ---

interface QueueItem {
  ticketId: string;
  title: string;
  tenant: string;
  enqueuedAt: string;
  attempts: number;
}

interface AgentInfo {
  ticketId: string;
  title: string;
  tenant: string;
  branchName: string;
  startTime: string;
  duration: string;
  durationMs: number;
}

interface CostRecord {
  ticketId: string;
  tokens: { input: number; output: number };
  estimatedCost: number;
  timestamp: string;
  tenant?: string;
  repoPath: string;
}

interface CompletionRecord {
  ticketId: string;
  tenant: string;
  completedAt: string;
  duration: number;
  prUrl?: string;
}

interface StatusResponse {
  queueSize: number;
  activeAgents: number;
  recentCompletions: CompletionRecord[];
  uptime: string;
  uptimeMs: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
}

// --- Configuration (read from env at call time so tests can vary it) ---

/** Base URL of the Autopilot dashboard API (no trailing slash). */
export function getBaseUrl(): string {
  const raw = process.env.AUTOPILOT_API_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env.DASHBOARD_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// --- HTTP helper with agent-readable error messages ---

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the Autopilot API at ${url} (${detail}). ` +
        `Make sure the Autopilot server is running and AUTOPILOT_API_URL points to it.`
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        `Autopilot API returned 401 Unauthorized for ${url}. ` +
          `The dashboard requires a token — set DASHBOARD_TOKEN to a valid value.`
      );
    }
    let body = '';
    try {
      body = (await response.text()).trim();
    } catch {
      // ignore body read failures
    }
    throw new Error(
      `Autopilot API request to ${url} failed with HTTP ${response.status} ${response.statusText}` +
        (body ? `: ${body}` : '.')
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Autopilot API returned an invalid JSON response from ${url} (${detail}).`);
  }
}

// --- Result / formatting helpers ---

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

function usd(value: number): string {
  // Show sub-cent precision for tiny per-run costs, 2 decimals otherwise.
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

// --- Pure formatters (exported for direct unit testing) ---

export function formatQueue(items: QueueItem[]): string {
  if (items.length === 0) {
    return 'The ticket queue is empty — no tickets are pending.';
  }
  const lines = items.map((item, i) => {
    return (
      `${i + 1}. ${item.ticketId} — ${item.title} [tenant: ${item.tenant}]\n` +
      `   Enqueued: ${item.enqueuedAt} · Attempts: ${item.attempts}`
    );
  });
  return `Ticket queue (${items.length} pending):\n\n${lines.join('\n')}`;
}

export function formatAgents(agents: AgentInfo[]): string {
  if (agents.length === 0) {
    return 'No agents are currently running.';
  }
  const lines = agents.map((agent, i) => {
    return (
      `${i + 1}. ${agent.ticketId} — ${agent.title} [tenant: ${agent.tenant}]\n` +
      `   Branch: ${agent.branchName} · Running for ${agent.duration} (started ${agent.startTime})`
    );
  });
  return `Active agents (${agents.length} running):\n\n${lines.join('\n')}`;
}

export function formatCosts(records: CostRecord[]): string {
  if (records.length === 0) {
    return 'No cost records found yet — agents have not reported any token usage.';
  }
  const totals = records.reduce(
    (acc, r) => ({
      cost: acc.cost + r.estimatedCost,
      input: acc.input + r.tokens.input,
      output: acc.output + r.tokens.output,
    }),
    { cost: 0, input: 0, output: 0 }
  );

  const lines = records.map((r, i) => {
    const tenant = r.tenant ? ` [tenant: ${r.tenant}]` : '';
    return (
      `${i + 1}. ${r.ticketId}${tenant} — ${usd(r.estimatedCost)} · ` +
      `${num(r.tokens.input)} in / ${num(r.tokens.output)} out · ${r.timestamp}`
    );
  });

  return (
    `Token & cost usage across ${records.length} recent run(s):\n` +
    `Totals: ${usd(totals.cost)} · ${num(totals.input)} input tokens · ${num(totals.output)} output tokens\n` +
    `(Estimates from configured per-token pricing, not an actual bill.)\n\n` +
    lines.join('\n')
  );
}

export function formatStatus(status: StatusResponse): string {
  const header =
    'Autopilot status overview\n' +
    '=========================\n' +
    `Queue size: ${status.queueSize} pending\n` +
    `Active agents: ${status.activeAgents} running\n` +
    `Uptime: ${status.uptime}\n` +
    `Estimated total cost: ${usd(status.totalCost)}\n` +
    `Total tokens: ${num(status.totalTokens.input)} input / ${num(status.totalTokens.output)} output`;

  const completions = status.recentCompletions ?? [];
  if (completions.length === 0) {
    return `${header}\n\nRecent completions: none yet.`;
  }

  const lines = completions.map((c, i) => {
    const pr = c.prUrl ? ` → PR: ${c.prUrl}` : '';
    return `${i + 1}. ${c.ticketId} [tenant: ${c.tenant}] — completed ${c.completedAt}${pr}`;
  });

  return `${header}\n\nRecent completions (${completions.length}):\n${lines.join('\n')}`;
}

// --- Tool functions (fetch + format + error handling) ---

export async function listQueue(): Promise<ToolResult> {
  try {
    const items = await fetchJson<QueueItem[]>('/dashboard/api/queue');
    return ok(formatQueue(items));
  } catch (error) {
    return fail(error);
  }
}

export async function getAgentStatus(): Promise<ToolResult> {
  try {
    const agents = await fetchJson<AgentInfo[]>('/dashboard/api/agents');
    return ok(formatAgents(agents));
  } catch (error) {
    return fail(error);
  }
}

export async function getCosts(): Promise<ToolResult> {
  try {
    const records = await fetchJson<CostRecord[]>('/dashboard/api/costs');
    return ok(formatCosts(records));
  } catch (error) {
    return fail(error);
  }
}

export async function getStatus(): Promise<ToolResult> {
  try {
    const status = await fetchJson<StatusResponse>('/dashboard/api/status');
    return ok(formatStatus(status));
  } catch (error) {
    return fail(error);
  }
}
