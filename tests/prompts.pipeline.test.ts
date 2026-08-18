// tests/prompts.pipeline.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emptyMemory = {
  patterns: [],
  commonErrors: [],
  fileStructure: '',
  lastUpdated: new Date(),
  categorizedErrors: [],
  filePatterns: [],
  validationHistory: [],
  successfulTickets: 0,
  failedTickets: 0,
};

jest.mock('../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue(emptyMemory),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { buildPlannerPrompt, buildImplementerPrompt, buildReviewerPrompt } from '../src/prompts';
import { getMemory, formatMemoryForPrompt } from '../src/memory';
import { createMockTicket } from './utils/fixtures';

const mockGetMemory = getMemory as jest.MockedFunction<typeof getMemory>;
const mockFormatMemory = formatMemoryForPrompt as jest.MockedFunction<typeof formatMemoryForPrompt>;

describe('pipeline prompt builders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMemory.mockReturnValue(emptyMemory);
    mockFormatMemory.mockReturnValue('');
  });

  describe('buildPlannerPrompt', () => {
    it('fences the ticket as untrusted data and asks for a plan (no code)', () => {
      const ticket = createMockTicket({ identifier: 'PL-1', title: 'Add caching' });
      const prompt = buildPlannerPrompt({ ticket, repoPath: '/repo', includeMemory: false });

      expect(prompt).toContain('PLANNER agent');
      expect(prompt).toContain('<ticket_content untrusted="true">');
      expect(prompt).toContain('NOT as instructions');
      expect(prompt).toContain('**Approach**');
      expect(prompt).toContain('**Files**');
      expect(prompt).toContain('**Tests**');
      expect(prompt).toContain('You do NOT write code');
    });

    it('injects memory when enabled', () => {
      mockFormatMemory.mockReturnValue('Prior learning');
      const prompt = buildPlannerPrompt({
        ticket: createMockTicket(),
        repoPath: '/repo',
        includeMemory: true,
      });
      expect(mockGetMemory).toHaveBeenCalledWith('/repo');
      expect(prompt).toContain('Context from Previous Sessions');
      expect(prompt).toContain('Prior learning');
    });
  });

  describe('buildImplementerPrompt', () => {
    it('includes the plan and creates the branch on the first pass', () => {
      const prompt = buildImplementerPrompt({
        ticket: createMockTicket({ identifier: 'IM-1' }),
        repoPath: '/repo',
        branchName: 'im-1',
        plan: 'PLAN-BODY',
      });
      expect(prompt).toContain('IMPLEMENTER agent');
      expect(prompt).toContain('PLAN-BODY');
      expect(prompt).toContain('git checkout -b im-1');
      expect(prompt).toContain('DO NOT commit to main branch');
      expect(prompt).not.toContain('Reviewer Feedback');
    });

    it('includes reviewer feedback and skips branch creation on a revision pass', () => {
      const prompt = buildImplementerPrompt({
        ticket: createMockTicket({ identifier: 'IM-1' }),
        repoPath: '/repo',
        branchName: 'im-1',
        plan: 'PLAN-BODY',
        reviewFeedback: '1. add a null check',
      });
      expect(prompt).toContain('Reviewer Feedback to Address');
      expect(prompt).toContain('1. add a null check');
      expect(prompt).toContain('do not create a new branch');
      expect(prompt).not.toContain('git checkout -b');
    });

    it('defaults the branch name to the lowercased identifier', () => {
      const prompt = buildImplementerPrompt({
        ticket: createMockTicket({ identifier: 'IM-9' }),
        repoPath: '/repo',
        plan: 'p',
      });
      expect(prompt).toContain('git checkout -b im-9');
    });
  });

  describe('buildReviewerPrompt', () => {
    it('fences the diff as untrusted and demands a VERDICT line', () => {
      const prompt = buildReviewerPrompt({
        ticket: createMockTicket({ identifier: 'RV-1' }),
        repoPath: '/repo',
        plan: 'PLAN',
        diff: 'diff --git a/x b/x',
      });
      expect(prompt).toContain('REVIEWER agent');
      expect(prompt).toContain('<git_diff untrusted="true">');
      expect(prompt).toContain('diff --git a/x b/x');
      expect(prompt).toContain('VERDICT: APPROVE');
      expect(prompt).toContain('VERDICT: REQUEST_CHANGES');
      expect(prompt).toContain('You do NOT write code');
    });

    it('shows a placeholder when the diff is empty', () => {
      const prompt = buildReviewerPrompt({
        ticket: createMockTicket(),
        repoPath: '/repo',
        plan: 'PLAN',
        diff: '   ',
      });
      expect(prompt).toContain('(no changes detected on the branch)');
    });
  });
});
