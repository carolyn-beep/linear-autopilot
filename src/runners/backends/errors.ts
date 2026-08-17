// src/runners/backends/errors.ts
//
// Shared error type for the agent-backend layer. It lives in its own module so
// every backend (and the `invoke` seam that re-exports it) can throw the SAME
// class without importing each other — keeping the dependency graph acyclic.

/**
 * Raised when an agent process fails to run (non-zero exit or spawn error). It
 * carries whatever output was captured so callers can still record usage / show
 * context, mirroring the pre-runner behavior where output survived a failure.
 */
export class AgentInvocationError extends Error {
  constructor(
    message: string,
    public readonly output: string
  ) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}
