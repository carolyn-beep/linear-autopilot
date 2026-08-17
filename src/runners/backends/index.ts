// src/runners/backends/index.ts
//
// Public surface of the agent-backend layer + the per-tenant selection factory.
// `createBackend(tenant)` maps a tenant's optional `agentBackend` config to a
// concrete AgentBackend. An unset config means Claude Code, so the default path
// is byte-for-byte the classic behavior.

import type { TenantConfig } from '../../config/tenants';
import { ClaudeCodeBackend } from './claude-code';
import { CommandBackend } from './command';
import { AgentBackend } from './types';

export { ClaudeCodeBackend, estimateCostUsd } from './claude-code';
export { CommandBackend, PROMPT_PLACEHOLDER } from './command';
export { AgentInvocationError } from './errors';
export * from './types';

/**
 * Select and construct the agent backend for a tenant.
 *
 * - unset (default) or `{ type: 'claude-code' }` -> {@link ClaudeCodeBackend}
 * - `{ type: 'command', command, args, promptVia? }` -> {@link CommandBackend}
 */
export function createBackend(tenant: TenantConfig): AgentBackend {
  const config = tenant.agentBackend;

  if (!config || config.type === 'claude-code') {
    return new ClaudeCodeBackend();
  }

  // config.type === 'command'
  return new CommandBackend({
    command: config.command,
    args: config.args,
    promptVia: config.promptVia,
  });
}
