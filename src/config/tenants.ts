import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger';

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
