// src/runners/backends/types.ts
//
// The agent-backend seam. A backend encapsulates WHICH coding agent actually
// runs (Claude Code, or any configurable CLI) behind one method, so the runner
// layer never has to know. Runners still consume the injected `InvokeAgent`
// function; `createBackend(tenant)` (see ./index.ts) turns the selected backend
// into that function. This is the extension point for pluggable agents.

import { AgentResult, AgentRole, InvokeAgentOptions } from '../types';

/**
 * A pluggable coding-agent backend. `invoke` has the same shape as the runner's
 * {@link InvokeAgent} seam: a role, a prompt, and options in; an
 * {@link AgentResult} out. It REJECTS with an
 * {@link ./errors.AgentInvocationError} when the agent fails to run.
 */
export interface AgentBackend {
  invoke(role: AgentRole, prompt: string, opts: InvokeAgentOptions): Promise<AgentResult>;
}

/** How the prompt is handed to a {@link CommandBackend}'s child process. */
export type PromptDelivery = 'placeholder' | 'stdin';

/** Configuration for the generic {@link CommandBackend}. */
export interface CommandBackendConfig {
  /** The CLI executable to spawn (argv[0]). Never passed through a shell. */
  command: string;
  /**
   * The argument vector. Each element is a literal argv entry (never a shell
   * string). With `promptVia: 'placeholder'` the exact token `{prompt}` in any
   * element is replaced by the prompt.
   */
  args: string[];
  /**
   * How the prompt reaches the agent. `'placeholder'` (default) substitutes the
   * `{prompt}` token in `args`; `'stdin'` writes the prompt to the child's stdin.
   */
  promptVia?: PromptDelivery;
}

/**
 * Per-tenant backend selection, stored on `TenantConfig.agentBackend`. Omitted
 * (the default) means Claude Code, preserving the classic behavior exactly.
 */
export type AgentBackendConfig =
  | { type: 'claude-code' }
  | ({ type: 'command' } & CommandBackendConfig);
