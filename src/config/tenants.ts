import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger';
import type { AgentBackendConfig } from '../runners/backends/types';

export type NotificationType = 'email' | 'slack' | 'discord' | 'sms' | 'whatsapp' | 'gchat';

export interface NotificationConfig {
  type: NotificationType;
  config: Record<string, string>;
}

export interface TenantConfig {
  name: string;
  linearTeamId: string;
  repoPath: string;
  maxConcurrentAgents: number;
  githubRepo: string;
  notifications?: NotificationConfig[];
  /**
   * Optional per-tenant GitHub token. Falls back to the global `GITHUB_TOKEN`
   * environment variable when omitted.
   */
  githubToken?: string;
  /**
   * Which runner strategy to use for this tenant. `'single'` (the default) runs
   * one Claude Code agent per ticket — the classic behavior. `'pipeline'` runs
   * the sequential planner -> implementer -> reviewer pipeline.
   */
  runner?: 'single' | 'pipeline';
  /**
   * Max reviewer-driven revision passes for the pipeline runner. Defaults to 1.
   * The pipeline always terminates at this cap. Ignored by the single runner.
   */
  pipelineMaxRevisions?: number;
  /**
   * Which coding-agent backend implements tickets for this tenant. Omitted (the
   * default) means Claude Code, so an existing config keeps the classic behavior
   * exactly. Set `{ type: 'command', ... }` to run a different coding-agent CLI:
   *
   * ```jsonc
   * // Claude Code (explicit form of the default)
   * "agentBackend": { "type": "claude-code" }
   *
   * // A generic CLI, prompt substituted for the {prompt} argv token (default)
   * "agentBackend": {
   *   "type": "command",
   *   "command": "my-agent",
   *   "args": ["run", "--task", "{prompt}"]
   * }
   *
   * // A generic CLI that reads the prompt from stdin
   * "agentBackend": {
   *   "type": "command",
   *   "command": "my-agent",
   *   "args": ["run"],
   *   "promptVia": "stdin"
   * }
   * ```
   *
   * The command is always spawned shell-free with a scrubbed environment. Note
   * that non-Claude backends may not emit parseable token usage, in which case
   * per-role cost telemetry is reported as unavailable rather than fabricated.
   */
  agentBackend?: AgentBackendConfig;
}

interface TenantsFile {
  tenants: TenantConfig[];
}

let tenantsCache: TenantConfig[] | null = null;

function loadTenants(): TenantConfig[] {
  if (tenantsCache) {
    return tenantsCache;
  }

  const tenantsPath = process.env.TENANTS_CONFIG_PATH || join(process.cwd(), 'tenants.json');

  if (!existsSync(tenantsPath)) {
    logger.warn('tenants.json not found', { path: tenantsPath });
    return [];
  }

  try {
    const content = readFileSync(tenantsPath, 'utf-8');
    const data = JSON.parse(content) as TenantsFile;
    tenantsCache = data.tenants || [];
    logger.info('Loaded tenants', { count: tenantsCache.length, path: tenantsPath });
    return tenantsCache;
  } catch (error) {
    logger.error('Error loading tenants.json', { error: String(error) });
    return [];
  }
}

export function getTenantByTeamId(teamId: string): TenantConfig | undefined {
  const tenants = loadTenants();
  return tenants.find((t) => t.linearTeamId === teamId);
}

export function getAllTenants(): TenantConfig[] {
  return loadTenants();
}

export function reloadTenants(): void {
  tenantsCache = null;
  loadTenants();
}
