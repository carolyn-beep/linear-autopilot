import express, { Router, Request, Response, NextFunction } from 'express';
import { spawner } from '../spawner';
import { ticketQueue } from '../spawner/queue';
import { getAllTenants } from '../config/tenants';
import { getCostSummary, CostRecord } from '../tracking';
import { formatDuration, formatUptime } from '../utils';
import { renderDashboard } from './template';
import { logger } from '../logger';

interface CompletionRecord {
  ticketId: string;
  tenant: string;
  completedAt: string;
  duration: number;
  prUrl?: string;
}

// In-memory storage for recent completions (for dashboard display)
const recentCompletions: CompletionRecord[] = [];
const MAX_COMPLETIONS = 50;
const startTime = Date.now();

export function recordCompletion(
  ticketId: string,
  tenant: string,
  duration: number,
  prUrl?: string
): void {
  recentCompletions.push({
    ticketId,
    tenant,
    completedAt: new Date().toISOString(),
    duration,
    prUrl,
  });

  // Keep only last N completions
  if (recentCompletions.length > MAX_COMPLETIONS) {
    recentCompletions.shift();
  }
}

export function getRecentCompletions(count: number = 20): CompletionRecord[] {
  return recentCompletions.slice(-count);
}

let warnedUnauthenticated = false;

// Optional bearer/token auth for all dashboard routes. If DASHBOARD_TOKEN is set,
// require it (via `Authorization: Bearer <token>` or `?token=`); otherwise warn once.
function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.DASHBOARD_TOKEN;

  if (!token) {
    if (!warnedUnauthenticated) {
      logger.warn('Dashboard is unauthenticated; set DASHBOARD_TOKEN to require access');
      warnedUnauthenticated = true;
    }
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;

  if (bearer === token || queryToken === token) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export function createDashboardRouter(): Router {
  const router = express.Router();

  router.use(dashboardAuth);

  // API endpoints
  router.get('/api/status', (_req: Request, res: Response) => {
    const status = spawner.getStatus();
    const tenants = getAllTenants();

    // Aggregate costs across all tenants
    let totalCost = 0;
    const totalTokens = { input: 0, output: 0 };

    for (const tenant of tenants) {
      const summary = getCostSummary(tenant.repoPath);
      totalCost += summary.totalCost;
      totalTokens.input += summary.totalTokens.input;
      totalTokens.output += summary.totalTokens.output;
    }

    res.json({
      queueSize: status.queued,
      activeAgents: status.active,
      recentCompletions: getRecentCompletions(20),
      uptime: formatUptime(Date.now() - startTime),
      uptimeMs: Date.now() - startTime,
      totalCost: Math.round(totalCost * 100) / 100,
      totalTokens,
    });
  });

  router.get('/api/agents', (_req: Request, res: Response) => {
    const agents = spawner.getActiveAgents();
    const now = Date.now();

    res.json(
      agents.map((agent) => ({
        ticketId: agent.ticket.identifier,
        title: agent.ticket.title,
        tenant: agent.tenant.name,
        branchName: agent.branchName,
        startTime: agent.startedAt.toISOString(),
        duration: formatDuration(now - agent.startedAt.getTime()),
        durationMs: now - agent.startedAt.getTime(),
      }))
    );
  });

  router.get('/api/costs', (_req: Request, res: Response) => {
    const tenants = getAllTenants();
    const allCosts: Array<CostRecord & { repoPath: string }> = [];

    for (const tenant of tenants) {
      const summary = getCostSummary(tenant.repoPath);
      for (const record of summary.recentRecords) {
        allCosts.push({ ...record, repoPath: tenant.repoPath });
      }
    }

    // Sort by timestamp descending
    allCosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json(allCosts.slice(0, 100));
  });

  router.get('/api/queue', (_req: Request, res: Response) => {
    const queue = ticketQueue.getAll();
    res.json(
      queue.map((item) => ({
        ticketId: item.ticket.identifier,
        title: item.ticket.title,
        tenant: item.tenant.name,
        enqueuedAt: item.enqueuedAt.toISOString(),
        attempts: item.attempts,
      }))
    );
  });

  // HTML Dashboard
  router.get('/', (_req: Request, res: Response) => {
    const status = spawner.getStatus();
    const agents = spawner.getActiveAgents();
    const completions = getRecentCompletions(20);
    const tenants = getAllTenants();
    const now = Date.now();

    // Aggregate costs
    let totalCost = 0;
    for (const tenant of tenants) {
      const summary = getCostSummary(tenant.repoPath);
      totalCost += summary.totalCost;
    }

    const html = renderDashboard({
      queueSize: status.queued,
      activeCount: status.active,
      completionsCount: completions.length,
      totalCost,
      uptime: formatUptime(now - startTime),
      agents: agents.map((agent) => ({
        ticketId: agent.ticket.identifier,
        ticketTitle: agent.ticket.title,
        tenantName: agent.tenant.name,
        duration: formatDuration(now - agent.startedAt.getTime()),
      })),
      completions,
    });

    res.type('html').send(html);
  });

  return router;
}
