import { createHmac, timingSafeEqual } from 'crypto';
import express, { Request, Response } from 'express';
import { getTenantByTeamId, getAllTenants } from '../config/tenants';
import { fetchTicket, graphql, LinearTicket } from '../linear';
import { ticketQueue } from '../spawner/queue';
import { logger } from '../logger';

const AGENT_READY_LABEL = 'agent-ready';

interface LinearWebhookPayload {
  action: string;
  type: string;
  // Linear sends this as an ms-epoch timestamp; used for replay protection.
  webhookTimestamp?: number;
  data: {
    id: string;
    identifier?: string;
    labelIds?: string[];
    teamId?: string;
  };
  updatedFrom?: {
    labelIds?: string[];
  };
}

// Reject webhooks whose timestamp is more than this far from now (replay protection).
const WEBHOOK_MAX_SKEW_MS = 60_000;

interface LinearLabel {
  id: string;
  name: string;
}

interface LinearLabelsResponse {
  errors?: Array<{ message: string }>;
  data?: {
    issueLabels: {
      nodes: LinearLabel[];
    };
  };
}

export function createWebhookRouter(): express.Router {
  const router = express.Router();

  router.post(
    '/linear',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;

      // Fail closed: refuse to process unsigned webhooks when no secret is configured.
      if (!webhookSecret) {
        logger.error(
          'LINEAR_WEBHOOK_SECRET is required for webhook mode; rejecting unsigned webhook'
        );
        res.status(401).json({ error: 'Webhook secret not configured' });
        return;
      }

      const signature = req.headers['linear-signature'] as string;
      if (!verifyWebhookSignature(req.body, signature, webhookSecret)) {
        logger.warn('Invalid webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      try {
        const payload = JSON.parse(req.body.toString()) as LinearWebhookPayload;

        // Replay protection: reject stale webhooks when a timestamp is present.
        if (
          typeof payload.webhookTimestamp === 'number' &&
          Math.abs(Date.now() - payload.webhookTimestamp) > WEBHOOK_MAX_SKEW_MS
        ) {
          logger.warn('Rejecting webhook with stale timestamp', {
            webhookTimestamp: payload.webhookTimestamp,
          });
          res.status(401).json({ error: 'Stale webhook timestamp' });
          return;
        }

        await handleWebhookEvent(payload);
        res.status(200).json({ ok: true });
      } catch (error) {
        logger.error('Webhook processing error', { error: String(error) });
        res.status(500).json({ error: 'Processing failed' });
      }
    }
  );

  return router;
}

function verifyWebhookSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;

  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  const expectedSignature = hmac.digest('hex');

  // Constant-time comparison to avoid timing attacks; timingSafeEqual requires equal lengths.
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

async function handleWebhookEvent(payload: LinearWebhookPayload): Promise<void> {
  // We're looking for label added events on issues
  if (payload.type !== 'Issue') return;

  const issueId = payload.data.identifier || payload.data.id;

  // Check if agent-ready label was just added
  const currentLabels = payload.data.labelIds || [];
  const previousLabels = payload.updatedFrom?.labelIds || [];

  const wasLabelAdded = await checkAgentReadyLabelAdded(currentLabels, previousLabels);

  if (!wasLabelAdded) {
    return;
  }

  logger.info('Agent-ready label detected', { ticketId: issueId });

  // Fetch full ticket details
  const ticket = await fetchTicket(issueId);

  // Get tenant config for this team
  const tenant = getTenantByTeamId(ticket.team.id);

  if (!tenant) {
    logger.warn('No tenant config for team, skipping', {
      teamId: ticket.team.id,
      teamName: ticket.team.name,
      ticketId: issueId,
    });
    return;
  }

  // Queue the ticket
  ticketQueue.enqueue(ticket, tenant);
}

async function checkAgentReadyLabelAdded(
  currentLabelIds: string[],
  previousLabelIds: string[]
): Promise<boolean> {
  // Find labels that are new
  const newLabelIds = currentLabelIds.filter((id) => !previousLabelIds.includes(id));

  if (newLabelIds.length === 0) return false;

  // Fetch label names to check if any is "agent-ready"
  try {
    const data = await graphql<LinearLabelsResponse>(
      `
        query GetLabels($ids: [String!]!) {
          issueLabels(filter: { id: { in: $ids } }) {
            nodes {
              id
              name
            }
          }
        }
      `,
      { ids: newLabelIds },
      'GetLabels'
    );

    const labels = data.data?.issueLabels?.nodes || [];
    return labels.some((label) => label.name.toLowerCase() === AGENT_READY_LABEL);
  } catch (error) {
    logger.error('Error fetching labels', { error: String(error) });
    return false;
  }
}

// Polling mode for environments where webhooks aren't available
export class PollingWatcher {
  private intervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastChecked: Map<string, Date> = new Map();

  constructor(intervalMs: number = 30000) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    logger.info('Polling watcher started', { intervalMs: this.intervalMs });
    this.poll(); // Initial poll
    this.pollTimer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Polling watcher stopped');
  }

  private async poll(): Promise<void> {
    const tenants = getAllTenants();

    for (const tenant of tenants) {
      try {
        await this.pollTenant(tenant.linearTeamId);
      } catch (error) {
        logger.error('Error polling team', { teamId: tenant.linearTeamId, error: String(error) });
      }
    }
  }

  private async pollTenant(teamId: string): Promise<void> {
    const tenant = getTenantByTeamId(teamId);

    if (!tenant) return;

    interface PollResponse {
      errors?: Array<{ message: string }>;
      data?: {
        team?: {
          issues: {
            nodes: LinearTicket[];
          };
        };
      };
    }

    // Fetch issues with agent-ready label (uses shared graphql with rate limiting & retries)
    const data = await graphql<PollResponse>(
      `
        query GetAgentReadyIssues($teamId: String!, $labelName: String!) {
          team(id: $teamId) {
            issues(
              filter: {
                labels: { name: { eq: $labelName } }
                state: { name: { in: ["Todo", "Backlog"] } }
              }
              first: 10
            ) {
              nodes {
                id
                identifier
                title
                description
                state {
                  id
                  name
                }
                team {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      { teamId, labelName: AGENT_READY_LABEL },
      'GetAgentReadyIssues'
    );

    const issues = data.data?.team?.issues?.nodes || [];

    for (const issue of issues) {
      // Skip if already queued or processed recently
      const lastCheck = this.lastChecked.get(issue.identifier);
      if (lastCheck && Date.now() - lastCheck.getTime() < this.intervalMs * 2) {
        continue;
      }

      this.lastChecked.set(issue.identifier, new Date());
      ticketQueue.enqueue(issue, tenant);
    }
  }
}
