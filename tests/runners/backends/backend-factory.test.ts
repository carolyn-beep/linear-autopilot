// tests/runners/backends/backend-factory.test.ts
import { describe, it, expect } from '@jest/globals';

import { createBackend } from '../../../src/runners/backends';
import { ClaudeCodeBackend } from '../../../src/runners/backends/claude-code';
import { CommandBackend } from '../../../src/runners/backends/command';
import { createMockTenant } from '../../utils/fixtures';

describe('createBackend', () => {
  it('defaults to ClaudeCodeBackend when agentBackend is unset', () => {
    expect(createBackend(createMockTenant())).toBeInstanceOf(ClaudeCodeBackend);
  });

  it("returns ClaudeCodeBackend for an explicit { type: 'claude-code' }", () => {
    const tenant = createMockTenant({ agentBackend: { type: 'claude-code' } });
    expect(createBackend(tenant)).toBeInstanceOf(ClaudeCodeBackend);
  });

  it("returns CommandBackend for { type: 'command', ... }", () => {
    const tenant = createMockTenant({
      agentBackend: { type: 'command', command: 'my-agent', args: ['run', '{prompt}'] },
    });
    expect(createBackend(tenant)).toBeInstanceOf(CommandBackend);
  });
});
