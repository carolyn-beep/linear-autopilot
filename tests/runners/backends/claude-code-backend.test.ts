// tests/runners/backends/claude-code-backend.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

jest.mock('../../../src/utils/security', () => ({
  scrubbedEnv: () => ({ SCRUBBED: '1' }),
}));

import { ClaudeCodeBackend, estimateCostUsd } from '../../../src/runners/backends/claude-code';
import { AgentInvocationError } from '../../../src/runners/backends/errors';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function primeSpawn(): FakeProc {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  return proc;
}

describe('estimateCostUsd', () => {
  it('prices input and output tokens (Claude 3.5 Sonnet rates)', () => {
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 })).toBe(18);
  });
});

describe('ClaudeCodeBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves the exact safe argv, cwd, and scrubbed env', async () => {
    const proc = primeSpawn();
    const backend = new ClaudeCodeBackend();
    const p = backend.invoke('planner', 'THE PROMPT', { cwd: '/repo', role: 'planner' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--dangerously-skip-permissions', 'THE PROMPT'],
      expect.objectContaining({ cwd: '/repo', env: { SCRUBBED: '1' } })
    );

    proc.stdout.emit('data', Buffer.from('work'));
    proc.emit('close', 0);
    const result = await p;
    expect(result.output).toContain('work');
  });

  it('parses token usage and computes cost with Claude pricing on clean exit', async () => {
    const proc = primeSpawn();
    const backend = new ClaudeCodeBackend();
    const p = backend.invoke('single', 'p', { cwd: '/repo', role: 'single' });

    proc.stdout.emit('data', Buffer.from('Tokens: 1000 input, 2000 output\n'));
    proc.emit('close', 0);

    const result = await p;
    expect(result.tokens).toBe(3000);
    // 1000/1e6*3 + 2000/1e6*15 = 0.033
    expect(result.costUsd).toBeCloseTo(0.033, 5);
  });

  it('rejects with AgentInvocationError (carrying output) on non-zero exit', async () => {
    const proc = primeSpawn();
    const backend = new ClaudeCodeBackend();
    const p = backend.invoke('implementer', 'p', { cwd: '/repo', role: 'implementer' });

    proc.stdout.emit('data', Buffer.from('partial'));
    proc.emit('close', 1);

    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
    await p.catch((err) => {
      expect((err as AgentInvocationError).output).toBe('partial');
    });
  });

  it('rejects with AgentInvocationError on spawn error', async () => {
    const proc = primeSpawn();
    const backend = new ClaudeCodeBackend();
    const p = backend.invoke('reviewer', 'p', { cwd: '/repo', role: 'reviewer' });

    proc.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
  });
});
