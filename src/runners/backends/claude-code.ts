// src/runners/backends/claude-code.ts
//
// The default agent backend: Claude Code. This is the ONLY place in the runner
// layer that spawns a real `claude` process. It reuses the exact safe pattern
// the spawner has always used:
//
//   spawn('claude', ['-p', '--dangerously-skip-permissions', prompt],
//         { env: scrubbedEnv(), cwd })
//
// No shell is involved, and secrets are scrubbed from the child environment so
// agent-authored code cannot read our credentials. Extracting it into an
// AgentBackend is behavior-preserving: the argv, env, token parse, and pricing
// are unchanged from the original src/runners/invoke.ts.

import { spawn } from 'child_process';
import { scrubbedEnv } from '../../utils/security';
import { parseTokenUsage } from '../../tracking';
import { logger } from '../../logger';
import { AgentResult, AgentRole, InvokeAgentOptions } from '../types';
import { AgentBackend } from './types';
import { AgentInvocationError } from './errors';

// Pricing per 1M tokens. Mirrors PRICING in src/tracking/index.ts (Claude 3.5
// Sonnet). Kept here because per-role cost is computed in-memory for RoleResult,
// while src/tracking remains the single writer of the persisted costs.json.
const PRICING = {
  input: 3.0,
  output: 15.0,
};

/** Estimate USD cost for a parsed token split, rounded to 4 decimals. */
export function estimateCostUsd(tokens: { input: number; output: number }): number {
  const cost =
    (tokens.input / 1_000_000) * PRICING.input + (tokens.output / 1_000_000) * PRICING.output;
  return Math.round(cost * 10000) / 10000;
}

/**
 * The Claude Code backend. Each `invoke` spawns one `claude` process, streams
 * its output through, and (on clean exit) parses token usage for the per-role
 * RoleResult. On failure it rejects with an {@link AgentInvocationError}.
 */
export class ClaudeCodeBackend implements AgentBackend {
  invoke(role: AgentRole, prompt: string, opts: InvokeAgentOptions): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const claude = spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], {
        cwd: opts.cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        // Scrub secrets so agent-authored code can't read our credentials.
        env: scrubbedEnv(),
      });

      let output = '';

      claude.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        process.stdout.write(data);
      });

      claude.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        process.stderr.write(data);
      });

      claude.on('close', (code) => {
        if (code === 0) {
          const parsed = parseTokenUsage(output);
          const tokens = parsed ? parsed.input + parsed.output : undefined;
          const costUsd = parsed ? estimateCostUsd(parsed) : undefined;
          resolve({ output, tokens, costUsd });
        } else {
          reject(new AgentInvocationError(`claude (${role}) exited with code ${code}`, output));
        }
      });

      claude.on('error', (err) => {
        logger.error('Failed to spawn Claude Code', { error: err.message, role });
        reject(new AgentInvocationError(err.message, output));
      });
    });
  }
}
