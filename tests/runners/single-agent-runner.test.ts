// tests/runners/single-agent-runner.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock memory so buildAutopilotPrompt is deterministic and touches no disk.
jest.mock('../../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue({}),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { SingleAgentRunner } from '../../src/runners/single-agent-runner';
import { AgentInvocationError } from '../../src/runners/invoke';
import { InvokeAgent } from '../../src/runners/types';
import { createMockTicket, createMockTenant } from '../utils/fixtures';

describe('SingleAgentRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = () => ({
    ticket: createMockTicket({ identifier: 'ABC-1' }),
    tenant: createMockTenant({ repoPath: '/repo' }),
    branchName: 'abc-1',
  });

  it('invokes exactly one agent with the autopilot prompt and returns success', async () => {
    const invoke = jest.fn(async () => ({
      output: 'done',
      tokens: 1000,
      costUsd: 0.02,
    })) as unknown as InvokeAgent;

    const runner = new SingleAgentRunner({ invoke });
    const result = await runner.run(context());

    expect(invoke).toHaveBeenCalledTimes(1);
    const [role, prompt, opts] = (invoke as jest.Mock).mock.calls[0] as [string, string, unknown];
    expect(role).toBe('single');
    // The prompt is the classic autopilot prompt (branch + untrusted fence).
    expect(prompt).toContain('git checkout -b abc-1');
    expect(prompt).toContain('<ticket_content untrusted="true">');
    expect(opts).toMatchObject({ cwd: '/repo', role: 'single', ticketId: 'ABC-1' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
    expect(result.roleResults).toHaveLength(1);
    expect(result.roleResults?.[0]).toMatchObject({ role: 'single', tokens: 1000, costUsd: 0.02 });
    expect(result.roleResults?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves the classic failure message and output when the agent fails', async () => {
    const invoke = jest.fn(async () => {
      throw new AgentInvocationError('claude (single) exited with code 1', 'partial output');
    }) as unknown as InvokeAgent;

    const runner = new SingleAgentRunner({ invoke });
    const result = await runner.run(context());

    expect(result.success).toBe(false);
    // Exact message the spawner used before runners existed.
    expect(result.summary).toBe('Claude Code exited with errors');
    // Output survives failure so the spawner can still record usage.
    expect(result.output).toBe('partial output');
    expect(result.roleResults?.[0]).toMatchObject({ role: 'single', tokens: 0, costUsd: 0 });
  });

  it('defaults missing tokens/cost to zero', async () => {
    const invoke = jest.fn(async () => ({ output: 'ok' })) as unknown as InvokeAgent;
    const runner = new SingleAgentRunner({ invoke });
    const result = await runner.run(context());
    expect(result.roleResults?.[0]).toMatchObject({ tokens: 0, costUsd: 0 });
  });
});
