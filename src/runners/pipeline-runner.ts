// src/runners/pipeline-runner.ts
//
// A sequential, role-specialized pipeline: planner -> implementer -> reviewer,
// with a bounded reviewer-driven revision loop.
//
// HONEST SCOPE: this is a SEQUENTIAL pipeline of specialized roles, NOT a set of
// parallel sub-agents editing the same repo at once. Only the implementer writes
// code, and only one agent runs at a time, which sidesteps the parallel-editor
// file-conflict problem entirely. The planner and reviewer add structure and a
// critic pass; they do not touch the working tree.
//
// Control flow:
//   1. planner       -> produces a short implementation plan
//   2. implementer   -> implements on the branch, following the plan
//   3. reviewer      -> reviews the git diff, returns APPROVE | REQUEST_CHANGES
//   4. if REQUEST_CHANGES and revisions remain: one implementer-fix pass, then
//      re-review. Capped at `pipelineMaxRevisions` (default 1). ALWAYS terminates.

import { execFileSync } from 'child_process';
import { logger as defaultLogger } from '../logger';
import { buildImplementerPrompt, buildPlannerPrompt, buildReviewerPrompt } from '../prompts';
import {
  AgentRole,
  AgentRunner,
  InvokeAgent,
  RoleResult,
  RunnerContext,
  RunnerResult,
} from './types';

/** Minimal logger surface the runner needs (satisfied by the app logger). */
type RunnerLogger = Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;

export interface PipelineRunnerOptions {
  invoke: InvokeAgent;
  /**
   * Reads the branch diff for the reviewer. Defaults to a safe, shell-free
   * `git diff` via execFile (same approach the spawner uses). Injectable so the
   * runner is unit-testable without a real git repo.
   */
  getDiff?: (repoPath: string, branchName: string) => string;
  logger?: RunnerLogger;
}

/** Default value for the reviewer-driven revision cap. */
export const DEFAULT_PIPELINE_MAX_REVISIONS = 1;

/**
 * Interpret a reviewer agent's output. The reviewer is instructed to end with a
 * line `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; we honor the LAST such
 * marker. Absent any marker we conservatively treat it as NOT approved.
 */
export function parseReviewVerdict(output: string): { approved: boolean; feedback: string } {
  const matches = [...output.matchAll(/VERDICT:\s*(APPROVE|REQUEST_CHANGES)/gi)];
  const last = matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : '';
  return { approved: last === 'APPROVE', feedback: output.trim() };
}

/** Safe, shell-free branch diff (three-dot: changes on the branch since main). */
function defaultGetDiff(repoPath: string, branchName: string): string {
  try {
    return execFileSync('git', ['diff', `main...${branchName}`], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch {
    return '';
  }
}

export class PipelineRunner implements AgentRunner {
  private readonly invoke: InvokeAgent;
  private readonly getDiff: (repoPath: string, branchName: string) => string;
  private readonly log: RunnerLogger;

  constructor(options: PipelineRunnerOptions) {
    this.invoke = options.invoke;
    this.getDiff = options.getDiff ?? defaultGetDiff;
    this.log = options.logger ?? defaultLogger;
  }

  async run(context: RunnerContext): Promise<RunnerResult> {
    const { ticket, tenant, branchName } = context;
    const repoPath = tenant.repoPath;
    const maxRevisions = Math.max(0, tenant.pipelineMaxRevisions ?? DEFAULT_PIPELINE_MAX_REVISIONS);

    const roleResults: RoleResult[] = [];
    const outputs: string[] = [];

    const runRole = async (role: AgentRole, prompt: string): Promise<string> => {
      const started = Date.now();
      const res = await this.invoke(role, prompt, {
        cwd: repoPath,
        role,
        ticketId: ticket.identifier,
      });
      const durationMs = Date.now() - started;
      const roleResult: RoleResult = {
        role,
        tokens: res.tokens ?? 0,
        costUsd: res.costUsd ?? 0,
        durationMs,
      };
      roleResults.push(roleResult);
      outputs.push(`===== ${role} =====\n${res.output}`);
      this.log.info('Pipeline role completed', {
        role,
        ticketId: ticket.identifier,
        tenant: tenant.name,
        tokens: roleResult.tokens,
        costUsd: roleResult.costUsd,
        durationMs,
      });
      return res.output;
    };

    try {
      // 1. Planner
      this.log.info('Pipeline: planning', { ticketId: ticket.identifier, tenant: tenant.name });
      const plan = await runRole(
        'planner',
        buildPlannerPrompt({ ticket, repoPath, includeMemory: true })
      );

      // 2. Implementer (first pass)
      this.log.info('Pipeline: implementing', {
        ticketId: ticket.identifier,
        tenant: tenant.name,
      });
      await runRole('implementer', buildImplementerPrompt({ ticket, repoPath, branchName, plan }));

      // 3 + 4. Review, with a bounded revision loop.
      let approved = false;
      let revisions = 0;
      while (true) {
        this.log.info('Pipeline: reviewing', {
          ticketId: ticket.identifier,
          tenant: tenant.name,
          revision: revisions,
        });
        const diff = this.getDiff(repoPath, branchName);
        const reviewOutput = await runRole(
          'reviewer',
          buildReviewerPrompt({ ticket, repoPath, plan, diff })
        );
        const verdict = parseReviewVerdict(reviewOutput);

        if (verdict.approved) {
          approved = true;
          break;
        }

        if (revisions >= maxRevisions) {
          // Cap reached and the reviewer is still unhappy: stop, report honestly.
          this.log.warn('Pipeline: revision cap reached without approval', {
            ticketId: ticket.identifier,
            tenant: tenant.name,
            revisions,
            maxRevisions,
          });
          break;
        }

        // Reviewer requested changes and we still have budget: one fix pass.
        revisions++;
        this.log.info('Pipeline: revising per reviewer feedback', {
          ticketId: ticket.identifier,
          tenant: tenant.name,
          revision: revisions,
          maxRevisions,
        });
        await runRole(
          'implementer',
          buildImplementerPrompt({
            ticket,
            repoPath,
            branchName,
            plan,
            reviewFeedback: verdict.feedback,
          })
        );
      }

      const totalTokens = roleResults.reduce((sum, r) => sum + r.tokens, 0);
      const totalCost = roleResults.reduce((sum, r) => sum + r.costUsd, 0);
      const summary = approved
        ? `Pipeline approved after ${revisions} revision(s): ${roleResults.length} role calls, ` +
          `${totalTokens} tokens, $${totalCost.toFixed(4)}`
        : `Pipeline reached the revision cap (${maxRevisions}) without approval: ` +
          `${roleResults.length} role calls, ${totalTokens} tokens, $${totalCost.toFixed(4)}`;

      return {
        success: approved,
        summary,
        output: outputs.join('\n\n'),
        roleResults,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Pipeline failed', {
        ticketId: ticket.identifier,
        tenant: tenant.name,
        error: message,
      });
      return {
        success: false,
        summary: `Pipeline failed: ${message}`,
        output: outputs.join('\n\n'),
        roleResults,
      };
    }
  }
}
