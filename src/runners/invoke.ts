// src/runners/invoke.ts
//
// The `InvokeAgent` seam that runners consume. Runners never spawn an agent
// themselves; they call an injected `InvokeAgent`. This module turns an
// AgentBackend (Claude Code by default, or any configured CLI) into that
// function. The actual spawning lives in src/runners/backends/*, so this file
// no longer references a specific agent binary.
//
// The historical exports (`createClaudeInvoker`, `estimateCostUsd`,
// `AgentInvocationError`) are preserved so existing runners and tests are
// unaffected.

import { createBackend } from './backends';
import { ClaudeCodeBackend } from './backends/claude-code';
import { AgentBackend } from './backends/types';
import type { TenantConfig } from '../config/tenants';
import { InvokeAgent } from './types';

// Re-export the shared error and the Claude pricing helper from their new homes
// so callers importing them from './invoke' keep working.
export { AgentInvocationError } from './backends/errors';
export { estimateCostUsd } from './backends/claude-code';

/** Adapt any {@link AgentBackend} into the injectable {@link InvokeAgent} function. */
export function createBackendInvoker(backend: AgentBackend): InvokeAgent {
  return (role, prompt, opts) => backend.invoke(role, prompt, opts);
}

/**
 * Build the production `InvokeAgent` for a tenant. Selects the tenant's agent
 * backend (Claude Code by default) and adapts it to the runner seam. With no
 * tenant, or a tenant that configures nothing, this is the classic Claude Code
 * invoker exactly as before.
 */
export function createClaudeInvoker(tenant?: TenantConfig): InvokeAgent {
  const backend = tenant ? createBackend(tenant) : new ClaudeCodeBackend();
  return createBackendInvoker(backend);
}
