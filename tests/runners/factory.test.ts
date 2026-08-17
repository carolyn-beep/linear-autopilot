// tests/runners/factory.test.ts
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue({}),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { createRunner } from '../../src/runners';
import { SingleAgentRunner } from '../../src/runners/single-agent-runner';
import { PipelineRunner } from '../../src/runners/pipeline-runner';
import { InvokeAgent } from '../../src/runners/types';
import { createMockTenant } from '../utils/fixtures';

const invoke = (async () => ({ output: '' })) as unknown as InvokeAgent;

describe('createRunner', () => {
  it('returns a SingleAgentRunner by default (no runner set)', () => {
    expect(createRunner(createMockTenant(), invoke)).toBeInstanceOf(SingleAgentRunner);
  });

  it("returns a SingleAgentRunner for runner: 'single'", () => {
    expect(createRunner(createMockTenant({ runner: 'single' }), invoke)).toBeInstanceOf(
      SingleAgentRunner
    );
  });

  it("returns a PipelineRunner for runner: 'pipeline'", () => {
    expect(createRunner(createMockTenant({ runner: 'pipeline' }), invoke)).toBeInstanceOf(
      PipelineRunner
    );
  });
});
