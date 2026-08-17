// tests/runners/backends/runner-wiring.test.ts
//
// Proves createRunner(tenant) with NO injected invoke derives its InvokeAgent
// from the tenant's agentBackend: an unset tenant spawns `claude`, a command
// tenant spawns the configured CLI. Child process is mocked; no real CLI runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

// Deterministic, disk-free prompt building.
jest.mock('../../../src/memory', () => ({
  getMemory: jest.fn().mockReturnValue({}),
  formatMemoryForPrompt: jest.fn().mockReturnValue(''),
}));

import { createRunner } from '../../../src/runners';
import { createMockTicket, createMockTenant } from '../../utils/fixtures';

class FakeStdin extends EventEmitter {
  write = jest.fn();
  end = jest.fn();
}
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
}

function primeSpawn(): FakeProc {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  return proc;
}

describe('createRunner backend wiring (no injected invoke)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = (tenantOverrides = {}) => ({
    ticket: createMockTicket({ identifier: 'ABC-1' }),
    tenant: createMockTenant({ repoPath: '/repo', ...tenantOverrides }),
    branchName: 'abc-1',
  });

  it('defaults to spawning claude', async () => {
    const proc = primeSpawn();
    const runner = createRunner(createMockTenant({ repoPath: '/repo' }));
    const p = runner.run(context());

    proc.emit('close', 0);
    const result = await p;

    expect(mockSpawn.mock.calls[0][0]).toBe('claude');
    expect(result.success).toBe(true);
  });

  it('spawns the configured command backend CLI', async () => {
    const proc = primeSpawn();
    const tenant = createMockTenant({
      repoPath: '/repo',
      agentBackend: { type: 'command', command: 'my-agent', args: ['run', '{prompt}'] },
    });
    const runner = createRunner(tenant);
    const p = runner.run({ ...context(), tenant });

    proc.emit('close', 0);
    const result = await p;

    const [command, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('my-agent');
    expect(args[0]).toBe('run');
    // The prompt occupies the placeholder slot as one literal argv element.
    expect(args[1]).toContain('git checkout -b abc-1');
    expect(result.success).toBe(true);
    // Command backend reports no fabricated usage.
    expect(result.roleResults?.[0]).toMatchObject({ tokens: 0, costUsd: 0 });
  });
});
