// src/runners/index.ts
//
// Public surface of the runner layer + the per-tenant selection factory.

import { TenantConfig } from '../config/tenants';
import { createClaudeInvoker } from './invoke';
import { PipelineRunner } from './pipeline-runner';
import { SingleAgentRunner } from './single-agent-runner';
import { AgentRunner, InvokeAgent } from './types';

export * from './types';
export { createClaudeInvoker, estimateCostUsd, AgentInvocationError } from './invoke';
export { SingleAgentRunner } from './single-agent-runner';
export {
  PipelineRunner,
  parseReviewVerdict,
  DEFAULT_PIPELINE_MAX_REVISIONS,
} from './pipeline-runner';

/**
 * Select and construct the runner for a tenant. Defaults to the single-agent
 * runner, preserving today's behavior exactly. `invoke` is injectable for tests;
 * production uses the live Claude Code invoker.
 */
export function createRunner(
  tenant: TenantConfig,
  invoke: InvokeAgent = createClaudeInvoker()
): AgentRunner {
  if (tenant.runner === 'pipeline') {
    return new PipelineRunner({ invoke });
  }
  return new SingleAgentRunner({ invoke });
}
