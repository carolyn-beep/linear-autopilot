// src/runners/index.ts
//
// Public surface of the runner layer + the per-tenant selection factory.

import { TenantConfig } from '../config/tenants';
import { createBackend } from './backends';
import { createBackendInvoker } from './invoke';
import { PipelineRunner } from './pipeline-runner';
import { SingleAgentRunner } from './single-agent-runner';
import { AgentRunner, InvokeAgent } from './types';

export * from './types';
export {
  createClaudeInvoker,
  createBackendInvoker,
  estimateCostUsd,
  AgentInvocationError,
} from './invoke';
export { createBackend, ClaudeCodeBackend, CommandBackend, PROMPT_PLACEHOLDER } from './backends';
export type {
  AgentBackend,
  AgentBackendConfig,
  CommandBackendConfig,
  PromptDelivery,
} from './backends';
export { SingleAgentRunner } from './single-agent-runner';
export {
  PipelineRunner,
  parseReviewVerdict,
  DEFAULT_PIPELINE_MAX_REVISIONS,
} from './pipeline-runner';

/**
 * Select and construct the runner for a tenant. Defaults to the single-agent
 * runner, preserving today's behavior exactly. `invoke` is injectable for tests;
 * production derives it from the tenant's agent backend (Claude Code unless the
 * tenant configures `agentBackend`), so a tenant that configures nothing gets the
 * classic Claude Code path.
 */
export function createRunner(
  tenant: TenantConfig,
  invoke: InvokeAgent = createBackendInvoker(createBackend(tenant))
): AgentRunner {
  if (tenant.runner === 'pipeline') {
    return new PipelineRunner({ invoke });
  }
  return new SingleAgentRunner({ invoke });
}
