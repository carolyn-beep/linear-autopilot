// tests/runners/pipeline-runner.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock memory so the planner prompt is deterministic and touches no disk.
jest.mock('../../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue({}),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { PipelineRunner, parseReviewVerdict } from '../../src/runners/pipeline-runner';
import { AgentInvocationError } from '../../src/runners/invoke';
import { AgentRole, InvokeAgent } from '../../src/runners/types';
import { createMockTicket, createMockTenant } from '../utils/fixtures';

// A silent logger so tests don't spam output.
const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

type InvokeReturn = { output: string; tokens?: number; costUsd?: number };

/**
 * Build a scripted InvokeAgent. `reviewerVerdicts` is consumed in order, one per
 * reviewer call; everything else returns a generic per-role output. Records the
 * ordered sequence of invoked roles for sequencing assertions.
 */
function scriptedInvoke(options: {
  reviewerVerdicts: string[];
  perCall?: Partial<Record<AgentRole, InvokeReturn>>;
}): { invoke: InvokeAgent; roles: AgentRole[] } {
  const roles: AgentRole[] = [];
  let reviewIdx = 0;

  const invoke = (async (role: AgentRole) => {
    roles.push(role);
    if (role === 'reviewer') {
      const verdict = options.reviewerVerdicts[reviewIdx] ?? 'VERDICT: REQUEST_CHANGES';
      reviewIdx++;
      return { output: `review output\n${verdict}`, tokens: 100, costUsd: 0.01 };
    }
    return options.perCall?.[role] ?? { output: `${role} output`, tokens: 100, costUsd: 0.01 };
  }) as unknown as InvokeAgent;

  return { invoke, roles };
}

function ctx(overrides: { pipelineMaxRevisions?: number } = {}) {
  return {
    ticket: createMockTicket({ identifier: 'ABC-1' }),
    tenant: createMockTenant({ repoPath: '/repo', runner: 'pipeline', ...overrides }),
    branchName: 'abc-1',
  };
}

describe('parseReviewVerdict', () => {
  it('approves on VERDICT: APPROVE', () => {
    expect(parseReviewVerdict('looks good\nVERDICT: APPROVE').approved).toBe(true);
  });
  it('does not approve on REQUEST_CHANGES', () => {
    expect(parseReviewVerdict('1. fix x\nVERDICT: REQUEST_CHANGES').approved).toBe(false);
  });
  it('honors the LAST verdict marker', () => {
    expect(parseReviewVerdict('VERDICT: REQUEST_CHANGES\n...\nVERDICT: APPROVE').approved).toBe(
      true
    );
  });
  it('treats a missing marker as not approved', () => {
    expect(parseReviewVerdict('no verdict here').approved).toBe(false);
  });
});

describe('PipelineRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs planner -> implementer -> reviewer in order (APPROVE skips revision)', async () => {
    const { invoke, roles } = scriptedInvoke({ reviewerVerdicts: ['VERDICT: APPROVE'] });
    const getDiff = jest.fn<(repo: string, branch: string) => string>(() => 'diff-content');
    const runner = new PipelineRunner({ invoke, getDiff, logger: silentLogger });

    const result = await runner.run(ctx());

    expect(roles).toEqual(['planner', 'implementer', 'reviewer']);
    expect(result.success).toBe(true);
    // No revision pass -> exactly 3 role calls.
    expect(result.roleResults?.map((r) => r.role)).toEqual(['planner', 'implementer', 'reviewer']);
    expect(getDiff).toHaveBeenCalledWith('/repo', 'abc-1');
  });

  it('feeds the plan into the implementer and the diff into the reviewer', async () => {
    const perCall = { planner: { output: 'PLAN-XYZ', tokens: 10, costUsd: 0.001 } };
    const { invoke } = scriptedInvoke({ reviewerVerdicts: ['VERDICT: APPROVE'], perCall });
    const spy = jest.fn(invoke) as unknown as InvokeAgent;
    const getDiff = jest.fn(() => 'DIFF-ABC');
    const runner = new PipelineRunner({ invoke: spy, getDiff, logger: silentLogger });

    await runner.run(ctx());

    const calls = (spy as jest.Mock).mock.calls as [AgentRole, string, unknown][];
    const implPrompt = calls.find((c) => c[0] === 'implementer')?.[1] as string;
    const reviewPrompt = calls.find((c) => c[0] === 'reviewer')?.[1] as string;
    expect(implPrompt).toContain('PLAN-XYZ');
    expect(reviewPrompt).toContain('DIFF-ABC');
    expect(reviewPrompt).toContain('<git_diff untrusted="true">');
  });

  it('request-changes -> one revise -> re-review -> approve', async () => {
    const { invoke, roles } = scriptedInvoke({
      reviewerVerdicts: ['1. add a test\nVERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE'],
    });
    const getDiff = jest.fn(() => 'diff');
    const runner = new PipelineRunner({ invoke, getDiff, logger: silentLogger });

    const result = await runner.run(ctx({ pipelineMaxRevisions: 1 }));

    expect(roles).toEqual(['planner', 'implementer', 'reviewer', 'implementer', 'reviewer']);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('approved after 1 revision');
  });

  it('passes reviewer feedback into the revision implementer pass', async () => {
    const { invoke } = scriptedInvoke({
      reviewerVerdicts: ['1. handle null input\nVERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE'],
    });
    const spy = jest.fn(invoke) as unknown as InvokeAgent;
    const runner = new PipelineRunner({ invoke: spy, getDiff: () => 'd', logger: silentLogger });

    await runner.run(ctx({ pipelineMaxRevisions: 1 }));

    const calls = (spy as jest.Mock).mock.calls as [AgentRole, string, unknown][];
    const implPrompts = calls.filter((c) => c[0] === 'implementer').map((c) => c[1] as string);
    expect(implPrompts).toHaveLength(2);
    // First pass creates the branch; revision pass carries feedback + no new branch.
    expect(implPrompts[0]).toContain('git checkout -b abc-1');
    expect(implPrompts[1]).toContain('Reviewer Feedback to Address');
    expect(implPrompts[1]).toContain('1. handle null input');
    expect(implPrompts[1]).toContain('do not create a new branch');
  });

  it('terminates and reports failure when the revision cap is reached still unhappy', async () => {
    const { invoke, roles } = scriptedInvoke({
      reviewerVerdicts: [
        'VERDICT: REQUEST_CHANGES',
        'VERDICT: REQUEST_CHANGES',
        'VERDICT: REQUEST_CHANGES',
      ],
    });
    const runner = new PipelineRunner({ invoke, getDiff: () => 'd', logger: silentLogger });

    const result = await runner.run(ctx({ pipelineMaxRevisions: 1 }));

    // planner, impl, review(RC), impl(fix), review(RC) -> cap reached, stop.
    expect(roles).toEqual(['planner', 'implementer', 'reviewer', 'implementer', 'reviewer']);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('revision cap (1)');
  });

  it('with maxRevisions=0, a REQUEST_CHANGES fails immediately (no fix pass)', async () => {
    const { invoke, roles } = scriptedInvoke({ reviewerVerdicts: ['VERDICT: REQUEST_CHANGES'] });
    const runner = new PipelineRunner({ invoke, getDiff: () => 'd', logger: silentLogger });

    const result = await runner.run(ctx({ pipelineMaxRevisions: 0 }));

    expect(roles).toEqual(['planner', 'implementer', 'reviewer']);
    expect(result.success).toBe(false);
  });

  it('aggregates per-role tokens and cost across all calls', async () => {
    const { invoke } = scriptedInvoke({
      reviewerVerdicts: ['VERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE'],
      perCall: {
        planner: { output: 'p', tokens: 10, costUsd: 0.1 },
        implementer: { output: 'i', tokens: 20, costUsd: 0.2 },
      },
    });
    const runner = new PipelineRunner({ invoke, getDiff: () => 'd', logger: silentLogger });

    const result = await runner.run(ctx({ pipelineMaxRevisions: 1 }));

    // planner(10) + implementer(20) + reviewer(100) + implementer(20) + reviewer(100)
    const totalTokens = result.roleResults?.reduce((s, r) => s + r.tokens, 0);
    const totalCost = result.roleResults?.reduce((s, r) => s + r.costUsd, 0);
    expect(result.roleResults).toHaveLength(5);
    expect(totalTokens).toBe(250);
    expect(totalCost).toBeCloseTo(0.1 + 0.2 + 0.01 + 0.2 + 0.01, 5);
    expect(result.summary).toContain('250 tokens');
  });

  it('returns failure (not a throw) when an agent invocation fails', async () => {
    const invoke = (async (role: AgentRole) => {
      if (role === 'implementer') {
        throw new AgentInvocationError('claude (implementer) exited with code 1', 'boom');
      }
      return { output: `${role} output`, tokens: 1, costUsd: 0.001 };
    }) as unknown as InvokeAgent;
    const runner = new PipelineRunner({ invoke, getDiff: () => 'd', logger: silentLogger });

    const result = await runner.run(ctx());

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Pipeline failed');
    // The planner ran before the failure, so its role result is retained.
    expect(result.roleResults?.map((r) => r.role)).toEqual(['planner']);
  });

  it('defaults maxRevisions to 1 when the tenant does not set it', async () => {
    const { invoke, roles } = scriptedInvoke({
      reviewerVerdicts: ['VERDICT: REQUEST_CHANGES', 'VERDICT: APPROVE'],
    });
    const runner = new PipelineRunner({ invoke, getDiff: () => 'd', logger: silentLogger });

    // Tenant with runner:'pipeline' but no pipelineMaxRevisions.
    const result = await runner.run(ctx());

    expect(result.success).toBe(true);
    expect(roles.filter((r) => r === 'implementer')).toHaveLength(2); // one fix pass allowed
  });
});
