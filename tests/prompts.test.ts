// tests/prompts.test.ts
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

// Mock the memory module before importing prompts
jest.mock('../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue(emptyMemory),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { buildTicketPrompt, buildAutopilotPrompt } from '../src/prompts';
import { createMockTicket } from './utils/fixtures';
import { getMemory, formatMemoryForPrompt } from '../src/memory';

const mockGetMemory = getMemory as jest.MockedFunction<typeof getMemory>;
const mockFormatMemory = formatMemoryForPrompt as jest.MockedFunction<typeof formatMemoryForPrompt>;

describe('prompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMemory.mockReturnValue(emptyMemory);
    mockFormatMemory.mockReturnValue('');
  });

  describe('buildTicketPrompt', () => {
    it('should build a simple prompt with ticket details', () => {
      const ticket = createMockTicket({
        identifier: 'ABC-123',
        title: 'Fix login bug',
        description: 'Users cannot log in with special characters',
      });

      const prompt = buildTicketPrompt(ticket, '/path/to/repo');

      expect(prompt).toContain('ABC-123');
      expect(prompt).toContain('Fix login bug');
      expect(prompt).toContain('Users cannot log in with special characters');
      expect(prompt).toContain('/path/to/repo');
    });

    it('should use default description when none provided', () => {
      const ticket = createMockTicket({
        identifier: 'ABC-456',
        title: 'Empty description ticket',
        description: undefined,
      });

      const prompt = buildTicketPrompt(ticket, '/path/to/repo');

      expect(prompt).toContain('No description provided');
    });

    it('should not include memory section', () => {
      const ticket = createMockTicket();

      const prompt = buildTicketPrompt(ticket, '/path/to/repo');

      expect(mockGetMemory).not.toHaveBeenCalled();
      expect(prompt).not.toContain('Context from Previous Sessions');
    });

    it('should include implementation instructions', () => {
      const ticket = createMockTicket({ identifier: 'DEF-789' });

      const prompt = buildTicketPrompt(ticket, '/path/to/repo');

      expect(prompt).toContain('Read and understand the ticket requirements');
      expect(prompt).toContain('Run the tests');
      expect(prompt).toContain('DEF-789');
      expect(prompt).toContain('Begin implementing now');
    });
  });

  describe('buildAutopilotPrompt', () => {
    it('should build prompt with all ticket details', () => {
      const ticket = createMockTicket({
        identifier: 'XYZ-100',
        title: 'Add new feature',
        description: 'Detailed feature description',
      });

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/repos/myproject',
      });

      expect(prompt).toContain('XYZ-100');
      expect(prompt).toContain('Add new feature');
      expect(prompt).toContain('Detailed feature description');
      expect(prompt).toContain('/repos/myproject');
    });

    it('should include branch name in instructions when provided', () => {
      const ticket = createMockTicket({ identifier: 'ABC-123' });

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
        branchName: 'feature/custom-branch',
      });

      expect(prompt).toContain('git checkout -b feature/custom-branch');
    });

    it('should use ticket identifier as branch name when not provided', () => {
      const ticket = createMockTicket({ identifier: 'ABC-123' });

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
      });

      expect(prompt).toContain('git checkout -b abc-123');
    });

    it('should include memory when includeMemory is true', () => {
      mockGetMemory.mockReturnValue(emptyMemory);
      mockFormatMemory.mockReturnValue('Previous context info');

      const ticket = createMockTicket();

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
        includeMemory: true,
      });

      expect(mockGetMemory).toHaveBeenCalledWith('/path/to/repo');
      expect(mockFormatMemory).toHaveBeenCalled();
      expect(prompt).toContain('Context from Previous Sessions');
      expect(prompt).toContain('Previous context info');
    });

    it('should not include memory section when formatMemoryForPrompt returns empty', () => {
      mockGetMemory.mockReturnValue(emptyMemory);
      mockFormatMemory.mockReturnValue('');

      const ticket = createMockTicket();

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
        includeMemory: true,
      });

      expect(prompt).not.toContain('Context from Previous Sessions');
    });

    it('should skip memory when includeMemory is false', () => {
      const ticket = createMockTicket();

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
        includeMemory: false,
      });

      expect(mockGetMemory).not.toHaveBeenCalled();
      expect(prompt).not.toContain('Context from Previous Sessions');
    });

    it('should include important rules about branching', () => {
      const ticket = createMockTicket();

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
      });

      expect(prompt).toContain('DO NOT commit to main branch');
      expect(prompt).toContain('DO NOT push to remote');
      expect(prompt).toContain('feature branch');
    });

    it('should use default description when none provided', () => {
      const ticket = createMockTicket({ description: undefined });

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
      });

      expect(prompt).toContain('No description provided');
    });

    it('should include empty string description correctly', () => {
      const ticket = createMockTicket({ description: '' });

      const prompt = buildAutopilotPrompt({
        ticket,
        repoPath: '/path/to/repo',
      });

      // Empty string is falsy, so should show default
      expect(prompt).toContain('No description provided');
    });
  });
});
