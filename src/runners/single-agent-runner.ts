// src/runners/single-agent-runner.ts
//
// The default runner. It reproduces the classic behavior exactly: one Claude
// Code agent, prompted with `buildAutopilotPrompt` (memory injected), writing
// code on the ticket branch. The spawner's downstream validation-gate -> PR flow
// is unchanged; this class just wraps the single invocation behind AgentRunner.

import { buildAutopilotPrompt } from '../prompts';
import { AgentInvocationError } from './invoke';
import { AgentRunner, InvokeAgent, RoleResult, RunnerContext, RunnerResult } from './types';

export interface SingleAgentRunnerOptions {
  invoke: InvokeAgent;
}

export class SingleAgentRunner implements AgentRunner {
  private readonly invoke: InvokeAgent;

  constructor(options: SingleAgentRunnerOptions) {
    this.invoke = options.invoke;
  }

  async run(context: RunnerContext): Promise<RunnerResult> {
    const { ticket, tenant, branchName } = context;
    const repoPath = tenant.repoPath;

    const prompt = buildAutopilotPrompt({
      ticket,
      repoPath,
      branchName,
      includeMemory: true,
    });

    const started = Date.now();
    try {
      const { output, tokens, costUsd } = await this.invoke('single', prompt, {
        cwd: repoPath,
        role: 'single',
        ticketId: ticket.identifier,
      });
      const durationMs = Date.now() - started;

      const roleResult: RoleResult = {
        role: 'single',
        tokens: tokens ?? 0,
        costUsd: costUsd ?? 0,
        durationMs,
      };

      return {
        success: true,
        summary: 'Single-agent implementation completed',
        output,
        roleResults: [roleResult],
      };
    } catch (error) {
      const durationMs = Date.now() - started;
      const output = error instanceof AgentInvocationError ? error.output : '';

      return {
        success: false,
        // Preserve the exact failure message the spawner used before runners.
        summary: 'Claude Code exited with errors',
        output,
        roleResults: [{ role: 'single', tokens: 0, costUsd: 0, durationMs }],
      };
    }
  }
}
