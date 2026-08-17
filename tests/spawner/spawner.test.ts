// tests/spawner/spawner.test.ts
//
// Verifies the spawner is wired to the runner layer: it selects a runner per
// tenant, invokes run(), records usage, and routes success/failure downstream.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

import type { RunnerContext, RunnerResult } from '../../src/runners/types';
import type { TenantConfig } from '../../src/config/tenants';

// --- Mock every side-effecting collaborator so we test wiring, not I/O. ------
const mockRun = jest.fn<(ctx: RunnerContext) => Promise<RunnerResult>>();
const mockCreateRunner = jest.fn<(tenant: TenantConfig) => { run: typeof mockRun }>(() => ({
  run: mockRun,
}));
jest.mock('../../src/runners', () => ({
  createRunner: (tenant: TenantConfig) => mockCreateRunner(tenant),
}));

jest.mock('../../src/linear', () => ({
  updateTicketStatus: jest.fn(async () => undefined),
  addComment: jest.fn(async () => undefined),
}));
jest.mock('../../src/notifications', () => ({
  notify: jest.fn(async () => undefined),
  createAgentStartedEvent: jest.fn(),
  createAgentCompletedEvent: jest.fn(),
  createAgentFailedEvent: jest.fn(),
  createAgentStuckEvent: jest.fn(),
  createPrCreatedEvent: jest.fn(),
}));
jest.mock('../../src/validation', () => ({
  validate: jest.fn(async () => ({ passed: true, results: [], totalDuration: 0 })),
  formatValidationSummary: jest.fn(() => ''),
}));
jest.mock('../../src/tracking', () => ({ recordUsage: jest.fn() }));
jest.mock('../../src/dashboard', () => ({ recordCompletion: jest.fn() }));
jest.mock('../../src/memory', () => ({ updateMemory: jest.fn() }));
jest.mock('child_process', () => ({ execFileSync: jest.fn(() => '') }));

import { spawner } from '../../src/spawner';
import { updateTicketStatus, addComment } from '../../src/linear';
import { validate } from '../../src/validation';
import { recordUsage } from '../../src/tracking';
import { ticketQueue, QueuedTicket } from '../../src/spawner/queue';
import { createMockTicket, createMockTenant } from '../utils/fixtures';

// Reach the private spawnAgent for a focused wiring test (no timers involved).
const spawnAgent = (item: QueuedTicket): Promise<void> =>
  (spawner as unknown as { spawnAgent: (i: QueuedTicket) => Promise<void> }).spawnAgent(item);

function queuedTicket(tenantOverrides = {}): QueuedTicket {
  return {
    ticket: createMockTicket({ identifier: 'ABC-1' }),
    tenant: createMockTenant(tenantOverrides),
    enqueuedAt: new Date(),
    attempts: 0,
  };
}

describe('Spawner runner wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketQueue.clear();
  });

  it('selects a runner per tenant and runs it with the ticket context', async () => {
    mockRun.mockResolvedValue({ success: true, summary: 'ok', output: 'raw', roleResults: [] });

    const item = queuedTicket({ runner: 'pipeline' });
    await spawnAgent(item);

    expect(mockCreateRunner).toHaveBeenCalledTimes(1);
    expect(mockCreateRunner.mock.calls[0][0]).toMatchObject({ runner: 'pipeline' });
    expect(mockRun).toHaveBeenCalledWith({
      ticket: item.ticket,
      tenant: item.tenant,
      branchName: 'abc-1',
    });
  });

  it('on success: records usage and runs the validation gate (default config)', async () => {
    mockRun.mockResolvedValue({
      success: true,
      summary: 'ok',
      output: 'raw-output',
      roleResults: [],
    });

    const item = queuedTicket();
    await spawnAgent(item);

    expect(recordUsage).toHaveBeenCalledWith(
      '/tmp/test-repo',
      'ABC-1',
      'raw-output',
      'test-tenant'
    );
    expect(validate).toHaveBeenCalledWith('/tmp/test-repo');
    // In Progress at start (default config still works end-to-end).
    expect(updateTicketStatus).toHaveBeenCalledWith(item.ticket, 'In Progress');
  });

  it('on failure: routes to the failure path with the runner summary', async () => {
    mockRun.mockResolvedValue({ success: false, summary: 'pipeline exploded', output: '' });

    const item = queuedTicket();
    await spawnAgent(item);

    // Failure comment carries the runner's summary, ticket returns to Backlog.
    const commentArg = (addComment as jest.Mock).mock.calls[0]?.[1] as string;
    expect(commentArg).toContain('pipeline exploded');
    expect(updateTicketStatus).toHaveBeenCalledWith(item.ticket, 'Backlog');
  });
});
