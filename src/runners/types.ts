// src/runners/types.ts
//
// Shared contracts for the pluggable agent-runner layer. A runner encapsulates
// HOW a ticket gets implemented (a single Claude Code agent, or a multi-role
// pipeline) behind one interface, so the spawner can pick a strategy per tenant
// without knowing the details.
//
// The agent invocation itself is injected as `InvokeAgent` so runners can be
// unit-tested without ever spawning the real `claude` binary.

import { LinearTicket } from '../linear/types';
import { TenantConfig } from '../config/tenants';

/** The specialized roles a runner can invoke. `single` is the classic one-shot agent. */
export type AgentRole = 'single' | 'planner' | 'implementer' | 'reviewer';

/** Everything a runner needs to work a ticket. */
export interface RunnerContext {
  ticket: LinearTicket;
  tenant: TenantConfig;
  branchName: string;
}

/** Per-role accounting, mirroring the research-swarm's per-agent cost tracking. */
export interface RoleResult {
  role: AgentRole;
  /** Total tokens (input + output) attributed to this role's agent call. */
  tokens: number;
  /** Estimated USD cost for this role's agent call. */
  costUsd: number;
  /** Wall-clock duration of this role's agent call, in milliseconds. */
  durationMs: number;
}

/** The outcome of a full runner execution. */
export interface RunnerResult {
  /** True when the strategy considers the ticket successfully implemented. */
  success: boolean;
  /** Human-readable one-line outcome (surfaced in logs / Linear on failure). */
  summary: string;
  /**
   * Aggregated raw agent output. The spawner passes this to `recordUsage()` so
   * cost accounting stays identical to the pre-runner behavior.
   */
  output: string;
  /** Per-role breakdown (present for both single and pipeline runners). */
  roleResults?: RoleResult[];
}

/** Options passed to a single agent invocation. */
export interface InvokeAgentOptions {
  /** Working directory for the agent (the tenant repo). */
  cwd: string;
  /** The role being invoked (for logging / prompt selection upstream). */
  role: AgentRole;
  /** The ticket identifier, for log correlation. */
  ticketId?: string;
}

/**
 * The result of a single agent invocation. `tokens` and `costUsd` are optional
 * and HONEST: a backend that cannot parse usage telemetry from its CLI leaves
 * them undefined rather than fabricating a number. This is the shape both the
 * runners and the {@link InvokeAgent} seam consume.
 */
export interface AgentResult {
  /** Raw combined stdout/stderr captured from the agent. */
  output: string;
  /** Total tokens (input + output), when the backend can parse usage. */
  tokens?: number;
  /** Estimated USD cost, when the backend can parse usage. */
  costUsd?: number;
}

/**
 * Injectable agent-invocation function. The live implementation delegates to an
 * {@link AgentBackend} (Claude Code by default); tests supply a mock. Resolves
 * with the agent's output plus optional parsed usage; REJECTS when the agent
 * fails to run (non-zero exit / spawn error).
 */
export type InvokeAgent = (
  role: AgentRole,
  prompt: string,
  opts: InvokeAgentOptions
) => Promise<AgentResult>;

/** A strategy for turning a ticket into an implementation on its branch. */
export interface AgentRunner {
  run(context: RunnerContext): Promise<RunnerResult>;
}
