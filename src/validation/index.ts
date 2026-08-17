import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger';
import { VALIDATION_TIMEOUT_MS } from '../constants';
import { scrubbedEnv, redactSecrets } from '../utils/security';

export interface ValidationResult {
  name: string;
  passed: boolean;
  output: string;
  duration: number;
}

export interface ValidationSummary {
  passed: boolean;
  results: ValidationResult[];
  totalDuration: number;
}

const COVERAGE_THRESHOLD = parseInt(process.env.COVERAGE_THRESHOLD || '0', 10);

function hasScript(repoPath: string, scriptName: string): boolean {
  try {
    const packageJsonPath = join(repoPath, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return false;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return !!packageJson.scripts?.[scriptName];
  } catch {
    return false;
  }
}

function hasTsConfig(repoPath: string): boolean {
  return existsSync(join(repoPath, 'tsconfig.json'));
}

function runCommand(
  command: string,
  args: string[],
  repoPath: string,
  name: string
): ValidationResult {
  const startTime = Date.now();

  logger.debug('Running validation step', { name, command, args });

  try {
    const result = spawnSync(command, args, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: VALIDATION_TIMEOUT_MS,
      // Scrub secrets: the command runs code the agent may have written.
      env: { ...scrubbedEnv(), CI: 'true' },
    });

    const duration = Date.now() - startTime;
    const output = (result.stdout || '') + (result.stderr || '');
    const passed = result.status === 0;

    logger.debug('Validation step completed', { name, passed, duration });

    return {
      name,
      passed,
      // Redact secrets before this output is persisted / echoed to Linear / PRs.
      output: redactSecrets(output.slice(-5000)), // Keep last 5000 chars
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      name,
      passed: false,
      output: redactSecrets(error instanceof Error ? error.message : String(error)),
      duration,
    };
  }
}

function runTests(repoPath: string): ValidationResult {
  if (!hasScript(repoPath, 'test')) {
    return {
      name: 'tests',
      passed: true,
      output: 'No test script found, skipping',
      duration: 0,
    };
  }

  return runCommand('npm', ['test'], repoPath, 'tests');
}

function runLint(repoPath: string): ValidationResult {
  if (!hasScript(repoPath, 'lint')) {
    return {
      name: 'lint',
      passed: true,
      output: 'No lint script found, skipping',
      duration: 0,
    };
  }

  return runCommand('npm', ['run', 'lint'], repoPath, 'lint');
}

function runTypeCheck(repoPath: string): ValidationResult {
  if (!hasTsConfig(repoPath)) {
    return {
      name: 'typecheck',
      passed: true,
      output: 'No tsconfig.json found, skipping',
      duration: 0,
    };
  }

  return runCommand('npx', ['tsc', '--noEmit'], repoPath, 'typecheck');
}

function checkCoverage(repoPath: string): ValidationResult {
  if (COVERAGE_THRESHOLD <= 0) {
    return {
      name: 'coverage',
      passed: true,
      output: 'Coverage threshold not set, skipping',
      duration: 0,
    };
  }

  // Try to find coverage report
  const coveragePaths = [
    join(repoPath, 'coverage', 'coverage-summary.json'),
    join(repoPath, 'coverage', 'lcov-report', 'index.html'),
  ];

  const startTime = Date.now();

  for (const coveragePath of coveragePaths) {
    if (!existsSync(coveragePath)) continue;

    try {
      if (coveragePath.endsWith('.json')) {
        const coverage = JSON.parse(readFileSync(coveragePath, 'utf-8'));
        const totalCoverage = coverage.total?.lines?.pct || 0;
        const passed = totalCoverage >= COVERAGE_THRESHOLD;

        return {
          name: 'coverage',
          passed,
          output: `Line coverage: ${totalCoverage.toFixed(1)}% (threshold: ${COVERAGE_THRESHOLD}%)`,
          duration: Date.now() - startTime,
        };
      }
    } catch {
      // Continue to next path
    }
  }

  return {
    name: 'coverage',
    passed: true,
    output: 'No coverage report found, skipping',
    duration: Date.now() - startTime,
  };
}

export async function validate(repoPath: string): Promise<ValidationSummary> {
  const startTime = Date.now();

  logger.info('Starting validation pipeline', { repoPath });

  const results: ValidationResult[] = [];

  // Run validations in order
  results.push(runTests(repoPath));
  if (!results[results.length - 1].passed) {
    logger.warn('Tests failed, stopping validation', { repoPath });
  }

  results.push(runLint(repoPath));
  results.push(runTypeCheck(repoPath));
  results.push(checkCoverage(repoPath));

  const totalDuration = Date.now() - startTime;
  const passed = results.every((r) => r.passed);

  logger.info('Validation pipeline completed', {
    repoPath,
    passed,
    totalDuration,
    results: results.map((r) => ({ name: r.name, passed: r.passed })),
  });

  return {
    passed,
    results,
    totalDuration,
  };
}

export function formatValidationSummary(summary: ValidationSummary): string {
  const lines: string[] = [];

  lines.push(summary.passed ? '## Validation Passed' : '## Validation Failed');
  lines.push('');

  for (const result of summary.results) {
    const icon = result.passed ? '✅' : '❌';
    const time = result.duration > 0 ? ` (${(result.duration / 1000).toFixed(1)}s)` : '';
    lines.push(`${icon} **${result.name}**${time}`);

    if (!result.passed && result.output) {
      lines.push('```');
      lines.push(result.output.slice(0, 1000));
      if (result.output.length > 1000) {
        lines.push('...(truncated)');
      }
      lines.push('```');
    }
  }

  lines.push('');
  lines.push(`Total time: ${(summary.totalDuration / 1000).toFixed(1)}s`);

  return lines.join('\n');
}
