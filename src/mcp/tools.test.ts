import { jest } from '@jest/globals';
import {
  formatAgents,
  formatCosts,
  formatQueue,
  formatStatus,
  getAgentStatus,
  getBaseUrl,
  getCosts,
  getStatus,
  listQueue,
} from './tools';

/** Extract the concatenated text from a tool result (content is a typed union). */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

/** Build a minimal fetch Response stand-in. */
function mockResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string }
) {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: init?.statusText ?? (ok ? 'OK' : 'Internal Server Error'),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.AUTOPILOT_API_URL;
  delete process.env.DASHBOARD_TOKEN;
});

describe('getBaseUrl', () => {
  it('defaults to localhost:3000', () => {
    expect(getBaseUrl()).toBe('http://localhost:3000');
  });

  it('reads AUTOPILOT_API_URL and strips trailing slashes', () => {
    process.env.AUTOPILOT_API_URL = 'https://autopilot.example.com/';
    expect(getBaseUrl()).toBe('https://autopilot.example.com');
  });
});

describe('pure formatters', () => {
  it('formatQueue handles empty and populated queues', () => {
    expect(formatQueue([])).toContain('empty');
    const text = formatQueue([
      { ticketId: 'ENG-1', title: 'Fix bug', tenant: 'acme', enqueuedAt: 'T0', attempts: 2 },
    ]);
    expect(text).toContain('ENG-1 — Fix bug [tenant: acme]');
    expect(text).toContain('Attempts: 2');
    expect(text).toContain('1 pending');
  });

  it('formatAgents handles empty and populated states', () => {
    expect(formatAgents([])).toContain('No agents');
    const text = formatAgents([
      {
        ticketId: 'ENG-2',
        title: 'Add feature',
        tenant: 'acme',
        branchName: 'autopilot/eng-2',
        startTime: 'T1',
        duration: '5m',
        durationMs: 300000,
      },
    ]);
    expect(text).toContain('ENG-2 — Add feature');
    expect(text).toContain('Branch: autopilot/eng-2');
    expect(text).toContain('Running for 5m');
  });

  it('formatCosts sums totals and notes estimate caveat', () => {
    expect(formatCosts([])).toContain('No cost records');
    const text = formatCosts([
      {
        ticketId: 'ENG-3',
        tokens: { input: 1000, output: 500 },
        estimatedCost: 0.012,
        timestamp: 'T2',
        tenant: 'acme',
        repoPath: '/repo',
      },
      {
        ticketId: 'ENG-4',
        tokens: { input: 2000, output: 1000 },
        estimatedCost: 0.03,
        timestamp: 'T3',
        repoPath: '/repo',
      },
    ]);
    expect(text).toContain('across 2 recent run(s)');
    expect(text).toContain('$0.04'); // 0.012 + 0.03 rounded
    expect(text).toContain('3,000 input tokens');
    expect(text).toContain('1,500 output tokens');
    expect(text).toContain('not an actual bill');
  });

  it('formatStatus renders overview and completions with PR links', () => {
    const text = formatStatus({
      queueSize: 3,
      activeAgents: 1,
      recentCompletions: [
        {
          ticketId: 'ENG-5',
          tenant: 'acme',
          completedAt: 'T4',
          duration: 1000,
          prUrl: 'http://pr',
        },
      ],
      uptime: '2h',
      uptimeMs: 7200000,
      totalCost: 12.5,
      totalTokens: { input: 1234567, output: 234567 },
    });
    expect(text).toContain('Queue size: 3 pending');
    expect(text).toContain('Active agents: 1 running');
    expect(text).toContain('$12.50');
    expect(text).toContain('1,234,567 input');
    expect(text).toContain('ENG-5 [tenant: acme]');
    expect(text).toContain('→ PR: http://pr');
  });

  it('formatStatus handles no completions', () => {
    const text = formatStatus({
      queueSize: 0,
      activeAgents: 0,
      recentCompletions: [],
      uptime: '1m',
      uptimeMs: 60000,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
    });
    expect(text).toContain('Recent completions: none yet.');
  });
});

describe('tool functions — success paths', () => {
  it('listQueue fetches the queue endpoint and formats it', async () => {
    fetchMock.mockResolvedValue(
      mockResponse([
        { ticketId: 'ENG-1', title: 'Fix bug', tenant: 'acme', enqueuedAt: 'T0', attempts: 0 },
      ])
    );
    const result = await listQueue();
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('ENG-1 — Fix bug');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/api/queue',
      expect.anything()
    );
  });

  it('getAgentStatus fetches the agents endpoint', async () => {
    fetchMock.mockResolvedValue(mockResponse([]));
    const result = await getAgentStatus();
    expect(text(result)).toContain('No agents');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/api/agents',
      expect.anything()
    );
  });

  it('getCosts fetches the costs endpoint', async () => {
    fetchMock.mockResolvedValue(mockResponse([]));
    const result = await getCosts();
    expect(text(result)).toContain('No cost records');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/api/costs',
      expect.anything()
    );
  });

  it('getStatus fetches the status endpoint', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        queueSize: 0,
        activeAgents: 0,
        recentCompletions: [],
        uptime: '1m',
        uptimeMs: 60000,
        totalCost: 0,
        totalTokens: { input: 0, output: 0 },
      })
    );
    const result = await getStatus();
    expect(text(result)).toContain('Autopilot status overview');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/api/status',
      expect.anything()
    );
  });
});

describe('auth + base URL wiring', () => {
  it('honors AUTOPILOT_API_URL and sends a bearer token when DASHBOARD_TOKEN is set', async () => {
    process.env.AUTOPILOT_API_URL = 'https://autopilot.example.com';
    process.env.DASHBOARD_TOKEN = 'secret-token';
    fetchMock.mockResolvedValue(mockResponse([]));

    await listQueue();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://autopilot.example.com/dashboard/api/queue');
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  it('omits the Authorization header when no token is set', async () => {
    fetchMock.mockResolvedValue(mockResponse([]));
    await listQueue();
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('tool functions — error handling', () => {
  it('returns an agent-readable error on non-200 responses', async () => {
    fetchMock.mockResolvedValue(
      mockResponse('boom', { ok: false, status: 500, statusText: 'Internal Server Error' })
    );
    const result = await getStatus();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 500');
    expect(text(result)).toContain('boom');
  });

  it('gives a specific hint on 401 Unauthorized', async () => {
    fetchMock.mockResolvedValue(
      mockResponse('Unauthorized', { ok: false, status: 401, statusText: 'Unauthorized' })
    );
    const result = await listQueue();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('401 Unauthorized');
    expect(text(result)).toContain('DASHBOARD_TOKEN');
  });

  it('returns a connection hint on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await getAgentStatus();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Could not reach the Autopilot API');
    expect(text(result)).toContain('ECONNREFUSED');
  });

  it('handles invalid JSON responses gracefully', async () => {
    const bad = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('Unexpected token');
      },
      text: async () => 'not json',
    } as unknown as Response;
    fetchMock.mockResolvedValue(bad);
    const result = await getCosts();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid JSON');
  });
});
