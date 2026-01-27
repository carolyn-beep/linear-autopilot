import { spawn, execSync } from 'child_process';
import { ticketQueue, QueuedTicket } from './queue';
import { TenantConfig } from '../config/tenants';
import { LinearTicket, updateTicketStatus, addComment } from '../linear';
import { buildAutopilotPrompt } from '../prompts';
import { updateMemory } from '../memory';
import {
  notify,
  createAgentStartedEvent,
  createAgentCompletedEvent,
  createAgentFailedEvent,
  createAgentStuckEvent,
  createPrCreatedEvent,
} from '../notifications';
import { logger } from '../logger';
import { validate, formatValidationSummary } from '../validation';
import { recordUsage } from '../tracking';
import { recordCompletion } from '../dashboard';
import {
  STUCK_THRESHOLD_MS,
  MAX_RETRIES,
  SPAWNER_POLL_INTERVAL_MS,
  SPAWNER_HEALTH_CHECK_INTERVAL_MS,
} from '../constants';

interface ActiveAgent {
  ticket: LinearTicket;
  tenant: TenantConfig;
  startedAt: Date;
  branchName: string;
  notifiedStuck: boolean;
}

class Spawner {
  private activeAgents: Map<string, ActiveAgent> = new Map();
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  getActiveCount(tenantId?: string): number {
    if (!tenantId) {
      return this.activeAgents.size;
    }
    return Array.from(this.activeAgents.values()).filter((a) => a.tenant.linearTeamId === tenantId)
      .length;
  }

  canSpawnForTenant(tenant: TenantConfig): boolean {
    return this.getActiveCount(tenant.linearTeamId) < tenant.maxConcurrentAgents;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Spawner started');
    this.pollInterval = setInterval(() => this.processQueue(), SPAWNER_POLL_INTERVAL_MS);
    this.healthCheckInterval = setInterval(
      () => this.checkStuckAgents(),
      SPAWNER_HEALTH_CHECK_INTERVAL_MS
    );
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('Spawner stopped');
  }

  async waitForActiveAgents(): Promise<void> {
    while (this.activeAgents.size > 0) {
      logger.info('Waiting for active agents to finish', { count: this.activeAgents.size });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  private async checkStuckAgents(): Promise<void> {
    const now = Date.now();

    for (const [ticketId, agent] of this.activeAgents) {
      const runningFor = now - agent.startedAt.getTime();

      if (runningFor > STUCK_THRESHOLD_MS && !agent.notifiedStuck) {
        logger.warn('Agent appears stuck', {
          ticketId,
          runningForMinutes: Math.round(runningFor / 60000),
          tenant: agent.tenant.name,
        });

        agent.notifiedStuck = true;

        const event = createAgentStuckEvent(
          agent.ticket,
          agent.tenant,
          agent.branchName,
          runningFor,
          'No progress detected'
        );
        await notify(event);
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (ticketQueue.isEmpty()) return;

    const item = ticketQueue.peek();
    if (!item) return;

    if (!this.canSpawnForTenant(item.tenant)) {
      return;
    }

    const dequeued = ticketQueue.dequeue();
    if (!dequeued) return;

    await this.spawnAgent(dequeued);
  }

  private async spawnAgent(item: QueuedTicket): Promise<void> {
    const { ticket, tenant } = item;
    const branchName = ticket.identifier.toLowerCase();
    const startTime = Date.now();

    logger.info('Spawning agent', {
      ticketId: ticket.identifier,
      title: ticket.title,
      tenant: tenant.name,
      branchName,
    });

    this.activeAgents.set(ticket.identifier, {
      ticket,
      tenant,
      startedAt: new Date(),
      branchName,
      notifiedStuck: false,
    });

    try {
      // Update ticket to In Progress
      await updateTicketStatus(ticket, 'In Progress');

      // Notify: agent started
      await notify(createAgentStartedEvent(ticket, tenant, branchName));

      // Run Claude Code
      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: tenant.repoPath,
        branchName,
        includeMemory: true,
      });

      const result = await this.runClaudeCode(prompt, tenant.repoPath);
      const duration = Date.now() - startTime;

      // Record token usage for cost tracking
      recordUsage(tenant.repoPath, ticket.identifier, result.output, tenant.name);

      if (result.success) {
        await this.handleSuccess(ticket, tenant, item, branchName, duration);
      } else {
        await this.handleFailure(
          ticket,
          tenant,
          item,
          branchName,
          'Claude Code exited with errors'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.handleFailure(ticket, tenant, item, branchName, message);
    } finally {
      this.activeAgents.delete(ticket.identifier);
    }
  }

  private runClaudeCode(
    prompt: string,
    repoPath: string
  ): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const claude = spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], {
        cwd: repoPath,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let output = '';

      claude.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        process.stdout.write(data);
      });

      claude.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        process.stderr.write(data);
      });

      claude.on('close', (code) => {
        resolve({ success: code === 0, output });
      });

      claude.on('error', (err) => {
        logger.error('Failed to spawn Claude Code', { error: err.message });
        resolve({ success: false, output });
      });
    });
  }

  private async handleSuccess(
    ticket: LinearTicket,
    tenant: TenantConfig,
    item: QueuedTicket,
    branchName: string,
    duration: number
  ): Promise<void> {
    logger.info('Agent completed, running validation', {
      ticketId: ticket.identifier,
      tenant: tenant.name,
    });

    try {
      // Run validation before creating PR
      const validation = await validate(tenant.repoPath);

      if (!validation.passed) {
        logger.warn('Validation failed', {
          ticketId: ticket.identifier,
          results: validation.results.map((r) => ({ name: r.name, passed: r.passed })),
        });
        await this.handleFailure(
          ticket,
          tenant,
          item,
          branchName,
          `Validation failed:\n${formatValidationSummary(validation)}`
        );
        return;
      }

      logger.info('Validation passed', {
        ticketId: ticket.identifier,
        duration: validation.totalDuration,
      });

      // Create PR and complete the ticket
      await this.completeTicketWithPR(ticket, tenant, branchName, duration, validation);
    } catch (error) {
      logger.error('Error in post-success handling', {
        ticketId: ticket.identifier,
        error: String(error),
      });
      await updateTicketStatus(ticket, 'Done');
    }
  }

  private async completeTicketWithPR(
    ticket: LinearTicket,
    tenant: TenantConfig,
    branchName: string,
    duration: number,
    validation: import('../validation').ValidationSummary
  ): Promise<void> {
    const prUrl = await this.createPullRequest(tenant, branchName, ticket, validation);

    if (prUrl) {
      await notify(createPrCreatedEvent(ticket, tenant, branchName, prUrl));
      await addComment(
        ticket,
        `✅ Implementation complete!\n\nPR: ${prUrl}\n\n${formatValidationSummary(validation)}`
      );
      await updateTicketStatus(ticket, 'In Review');
      logger.info('Created PR and moved ticket to In Review', {
        ticketId: ticket.identifier,
        prUrl,
      });
      recordCompletion(ticket.identifier, tenant.name, duration, prUrl);
    } else {
      await updateTicketStatus(ticket, 'Done');
      logger.info('Marked ticket as Done (no PR needed)', { ticketId: ticket.identifier });
      recordCompletion(ticket.identifier, tenant.name, duration);
    }

    await notify(createAgentCompletedEvent(ticket, tenant, branchName, duration));

    // Get modified files for memory tracking
    const modifiedFiles = this.getModifiedFiles(tenant.repoPath, branchName);

    updateMemory(tenant.repoPath, {
      learnings: [`Completed ${ticket.identifier}: ${ticket.title}`],
      ticketTitle: ticket.title,
      modifiedFiles,
      validationResults: validation.results.map((r) => ({
        step: r.name,
        passed: r.passed,
        output: r.output,
      })),
      success: true,
    });
  }

  private getModifiedFiles(repoPath: string, branchName: string): string[] {
    try {
      const result = execSync(`git diff --name-only main...${branchName}`, {
        cwd: repoPath,
        encoding: 'utf-8',
      });
      return result.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async handleFailure(
    ticket: LinearTicket,
    tenant: TenantConfig,
    item: QueuedTicket,
    branchName: string,
    errorMessage: string
  ): Promise<void> {
    logger.error('Agent failed', {
      ticketId: ticket.identifier,
      error: errorMessage,
      tenant: tenant.name,
    });

    try {
      this.cleanupBranch(tenant.repoPath, branchName);

      await notify(
        createAgentFailedEvent(
          ticket,
          tenant,
          branchName,
          errorMessage,
          item.attempts + 1,
          MAX_RETRIES
        )
      );

      await addComment(
        ticket,
        `❌ Autopilot failed (attempt ${item.attempts + 1}/${MAX_RETRIES})\n\nError: ${errorMessage}`
      );

      await updateTicketStatus(ticket, 'Backlog');
      updateMemory(tenant.repoPath, {
        errors: [errorMessage],
        ticketTitle: ticket.title,
        success: false,
      });
      ticketQueue.requeue(item);
    } catch (error) {
      logger.error('Error in failure handling', {
        ticketId: ticket.identifier,
        error: String(error),
      });
    }
  }

  private cleanupBranch(repoPath: string, branchName: string): void {
    try {
      execSync(`git checkout main && git branch -D ${branchName}`, {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch {
      logger.debug('Branch cleanup skipped (branch may not exist)', { branchName });
    }
  }

  private async createPullRequest(
    tenant: TenantConfig,
    branchName: string,
    ticket: LinearTicket,
    validation?: import('../validation').ValidationSummary
  ): Promise<string | null> {
    try {
      // Check if there are commits on the branch
      const diffResult = execSync(`git log main..${branchName} --oneline`, {
        cwd: tenant.repoPath,
        encoding: 'utf-8',
      }).trim();

      if (!diffResult) {
        logger.debug('No commits on branch, skipping PR creation', { branchName });
        return null;
      }

      // Push branch to remote
      execSync(`git push -u origin ${branchName}`, {
        cwd: tenant.repoPath,
        stdio: 'pipe',
      });

      // Build validation section if available
      let validationSection = '';
      if (validation) {
        const checks = validation.results
          .map((r) => `- ${r.passed ? '✅' : '❌'} ${r.name}`)
          .join('\n');
        validationSection = `\n\n### Validation\n${checks}`;
      }

      // Create PR using gh CLI
      const prBody = `## ${ticket.title}

${ticket.description || 'No description provided.'}
${validationSection}

---
Linear: ${ticket.identifier}
🤖 Generated by Linear Autopilot`;

      const prResult = execSync(
        `gh pr create --repo ${tenant.githubRepo} --title "${ticket.identifier}: ${ticket.title}" --body "${prBody.replace(/"/g, '\\"')}" --head ${branchName} --base main`,
        {
          cwd: tenant.repoPath,
          encoding: 'utf-8',
        }
      ).trim();

      logger.info('Created PR', { prUrl: prResult, branchName, ticketId: ticket.identifier });
      return prResult;
    } catch (error) {
      logger.error('Failed to create PR', {
        branchName,
        ticketId: ticket.identifier,
        error: String(error),
      });
      return null;
    }
  }

  getStatus(): { active: number; queued: number; agents: string[] } {
    return {
      active: this.activeAgents.size,
      queued: ticketQueue.size(),
      agents: Array.from(this.activeAgents.keys()),
    };
  }

  getActiveAgents(): ActiveAgent[] {
    return Array.from(this.activeAgents.values());
  }
}

// Singleton instance
export const spawner = new Spawner();
