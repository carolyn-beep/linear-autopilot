// tests/runners/backends/command-backend.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock child_process.spawn with a controllable fake process.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

// Make scrubbedEnv identifiable so we can assert the backend uses it.
jest.mock('../../../src/utils/security', () => ({
  scrubbedEnv: () => ({ SCRUBBED: '1' }),
}));

import { CommandBackend, PROMPT_PLACEHOLDER } from '../../../src/runners/backends/command';
import { AgentInvocationError } from '../../../src/runners/backends/errors';

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

const opts = { cwd: '/repo', role: 'single' as const, ticketId: 'ABC-1' };

describe('CommandBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('substitutes the {prompt} placeholder as a single argv element (default)', async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({
      command: 'my-agent',
      args: ['run', '--task', PROMPT_PLACEHOLDER, '--json'],
    });

    const p = backend.invoke('single', 'PROMPT WITH "quotes" && $(danger)', opts);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spawnOpts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('my-agent');
    // The prompt is one literal argv entry; nothing is spliced into a shell.
    expect(args).toEqual(['run', '--task', 'PROMPT WITH "quotes" && $(danger)', '--json']);
    // Shell-free spawn with cwd and the scrubbed environment.
    expect(spawnOpts).toMatchObject({ cwd: '/repo', shell: false, env: { SCRUBBED: '1' } });

    proc.stdout.emit('data', Buffer.from('work'));
    proc.emit('close', 0);
    const result = await p;
    expect(result.output).toContain('work');
  });

  it('does not touch stdin when using placeholder delivery', async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({ command: 'my-agent', args: [PROMPT_PLACEHOLDER] });
    const p = backend.invoke('single', 'the prompt', opts);
    proc.emit('close', 0);
    await p;
    expect(proc.stdin.write).not.toHaveBeenCalled();
  });

  it("passes the prompt via stdin when promptVia is 'stdin'", async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({
      command: 'my-agent',
      args: ['run'],
      promptVia: 'stdin',
    });

    const p = backend.invoke('single', 'THE PROMPT', opts);

    const [, args, spawnOpts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    // args are passed through unchanged; no placeholder substitution.
    expect(args).toEqual(['run']);
    // stdin must be piped so we can write the prompt.
    expect((spawnOpts.stdio as unknown[])[0]).toBe('pipe');
    expect(proc.stdin.write).toHaveBeenCalledWith('THE PROMPT');
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);

    proc.emit('close', 0);
    await p;
  });

  it('returns undefined tokens/cost (no fabricated usage telemetry)', async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({ command: 'my-agent', args: [PROMPT_PLACEHOLDER] });
    const p = backend.invoke('single', 'p', opts);

    // Even if the CLI happens to print Claude-like usage, we do not attribute it.
    proc.stdout.emit('data', Buffer.from('Tokens: 1000 input, 2000 output\n'));
    proc.emit('close', 0);

    const result = await p;
    expect(result.tokens).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  it('rejects with AgentInvocationError (carrying output) on non-zero exit', async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({ command: 'my-agent', args: [PROMPT_PLACEHOLDER] });
    const p = backend.invoke('implementer', 'p', opts);

    proc.stdout.emit('data', Buffer.from('partial'));
    proc.emit('close', 3);

    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
    await p.catch((err) => {
      expect((err as AgentInvocationError).message).toContain('exited with code 3');
      expect((err as AgentInvocationError).output).toBe('partial');
    });
  });

  it('rejects with AgentInvocationError on spawn error', async () => {
    const proc = primeSpawn();
    const backend = new CommandBackend({ command: 'missing-agent', args: [] });
    const p = backend.invoke('reviewer', 'p', opts);

    proc.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toBeInstanceOf(AgentInvocationError);
  });

  it('throws when constructed without a command', () => {
    expect(() => new CommandBackend({ command: '', args: [] })).toThrow(/non-empty/);
  });
});
