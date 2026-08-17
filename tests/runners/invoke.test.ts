// tests/runners/invoke.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock child_process.spawn with a controllable fake process.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

import {
  createClaudeInvoker,
  estimateCostUsd,
  AgentInvocationError,
} from '../../src/runners/invoke';

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
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 })).toBe(18);
  });
  it('rounds to 4 decimal places', () => {
    expect(estimateCostUsd({ input: 1000, output: 1000 })).toBe(0.018);
  });
});

describe('createClaudeInvoker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('spawns claude with the safe argv and cwd', async () => {
    const proc = primeSpawn();
    const invoke = createClaudeInvoker();
    const p = invoke('planner', 'THE PROMPT', { cwd: '/repo', role: 'planner' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--dangerously-skip-permissions', 'THE PROMPT'],
      expect.objectContaining({ cwd: '/repo' })
    );

    proc.stdout.emit('data', Buffer.from('work'));
    proc.emit('close', 0);
    const result = await p;
    expect(result.output).toContain('work');
  });

  it('parses token usage and computes cost on clean exit', async () => {
    const proc = primeSpawn();
    const invoke = createClaudeInvoker();
    const p = invoke('single', 'p', { cwd: '/repo', role: 'single' });

    proc.stdout.emit('data', Buffer.from('Tokens: 1000 input, 2000 output\n'));
    proc.emit('close', 0);

    const result = await p;
    expect(result.tokens).toBe(3000);
    // 1000/1e6*3 + 2000/1e6*15 = 0.003 + 0.03 = 0.033
    expect(result.costUsd).toBeCloseTo(0.033, 5);
  });

  it('rejects with AgentInvocationError (carrying output) on non-zero exit', async () => {
    const proc = primeSpawn();
    const invoke = createClaudeInvoker();
    const p = invoke('implementer', 'p', { cwd: '/repo', role: 'implementer' });

    proc.stdout.emit('data', Buffer.from('partial'));
    proc.emit('close', 1);

    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
    await p.catch((err) => {
      expect((err as AgentInvocationError).output).toBe('partial');
    });
  });

  it('rejects with AgentInvocationError on spawn error', async () => {
    const proc = primeSpawn();
    const invoke = createClaudeInvoker();
    const p = invoke('reviewer', 'p', { cwd: '/repo', role: 'reviewer' });

    proc.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
  });
});
