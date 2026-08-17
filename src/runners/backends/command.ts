// src/runners/backends/command.ts
//
// A generic, configurable coding-agent backend. It runs whatever CLI a tenant
// names, so Autopilot is not hard-wired to Claude Code. The prompt reaches the
// agent one of two ways:
//
//   - 'placeholder' (default): the literal token `{prompt}` in `args` is replaced
//     by the prompt, as a single argv element (never spliced into a shell string).
//   - 'stdin': the prompt is written to the child's stdin.
//
// The spawn is ALWAYS shell-free (`shell: false`) with a scrubbed environment,
// so there is no shell-injection surface regardless of what the prompt contains.
//
// Usage telemetry is honestly optional. Unlike Claude Code, an arbitrary CLI has
// no contract for emitting token counts, and cost is model-specific, so this
// backend returns `tokens` / `costUsd` undefined rather than fabricating them.

import { spawn } from 'child_process';
import { scrubbedEnv } from '../../utils/security';
import { logger } from '../../logger';
import { AgentResult, AgentRole, InvokeAgentOptions } from '../types';
import { AgentBackend, CommandBackendConfig } from './types';
import { AgentInvocationError } from './errors';

/** The argv token replaced by the prompt under `promptVia: 'placeholder'`. */
export const PROMPT_PLACEHOLDER = '{prompt}';

export class CommandBackend implements AgentBackend {
  private readonly command: string;
  private readonly args: string[];
  private readonly promptVia: 'placeholder' | 'stdin';

  constructor(config: CommandBackendConfig) {
    if (!config.command) {
      throw new Error('CommandBackend requires a non-empty `command`');
    }
    this.command = config.command;
    this.args = config.args ?? [];
    this.promptVia = config.promptVia ?? 'placeholder';
  }

  invoke(role: AgentRole, prompt: string, opts: InvokeAgentOptions): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      // Build argv. Under 'placeholder', substitute the token as a whole argv
      // element; the prompt is never concatenated into a shell string.
      const args =
        this.promptVia === 'placeholder'
          ? this.args.map((arg) => (arg === PROMPT_PLACEHOLDER ? prompt : arg))
          : this.args;

      const useStdin = this.promptVia === 'stdin';

      const child = spawn(this.command, args, {
        cwd: opts.cwd,
        // stdin is piped only when we need to write the prompt to it.
        stdio: [useStdin ? 'pipe' : 'inherit', 'pipe', 'pipe'],
        // No shell: argv is passed literally, so there is no injection surface.
        shell: false,
        // Scrub secrets so agent-authored code can't read our credentials.
        env: scrubbedEnv(),
      });

      let output = '';

      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        process.stdout.write(data);
      });

      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        process.stderr.write(data);
      });

      child.on('close', (code) => {
        if (code === 0) {
          // Honestly optional: no reliable, model-agnostic usage/cost signal.
          resolve({ output, tokens: undefined, costUsd: undefined });
        } else {
          reject(
            new AgentInvocationError(`${this.command} (${role}) exited with code ${code}`, output)
          );
        }
      });

      child.on('error', (err) => {
        logger.error('Failed to spawn agent backend command', {
          error: err.message,
          command: this.command,
          role,
        });
        reject(new AgentInvocationError(err.message, output));
      });

      if (useStdin) {
        child.stdin?.on('error', (err: Error) => {
          // A child that exits before reading stdin can EPIPE; the close/error
          // handlers above own the outcome, so just log and move on.
          logger.warn('Agent backend stdin error', { error: err.message, command: this.command });
        });
        child.stdin?.write(prompt);
        child.stdin?.end();
      }
    });
  }
}
