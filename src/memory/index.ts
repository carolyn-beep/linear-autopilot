import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../logger';
import { MEMORY_LIMITS } from '../constants';

// Error categories for smarter learning
export type ErrorCategory =
  | 'type_error'
  | 'test_failure'
  | 'lint_error'
  | 'build_error'
  | 'runtime_error'
  | 'unknown';

export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  count: number;
  lastSeen: string;
}

export interface FilePattern {
  ticketKeywords: string[]; // e.g., ["auth", "login", "session"]
  commonFiles: string[]; // files often modified for these keywords
  count: number;
}

export interface ValidationHistory {
  step: string; // e.g., "tests", "lint", "typecheck"
  failureCount: number;
  lastFailure?: string;
  commonCauses: string[];
}

export interface RepoMemory {
  // Legacy fields (kept for backwards compatibility)
  patterns: string[];
  commonErrors: string[];
  fileStructure: string;
  lastUpdated: Date;
  // Enhanced fields
  categorizedErrors: CategorizedError[];
  filePatterns: FilePattern[];
  validationHistory: ValidationHistory[];
  successfulTickets: number;
  failedTickets: number;
}

interface MemoryFile {
  patterns: string[];
  commonErrors: string[];
  fileStructure: string;
  lastUpdated: string;
  // Enhanced fields (optional for backwards compatibility)
  categorizedErrors?: CategorizedError[];
  filePatterns?: FilePattern[];
  validationHistory?: ValidationHistory[];
  successfulTickets?: number;
  failedTickets?: number;
}

const MEMORY_DIR = '.linear-autopilot';
const MEMORY_FILE = 'memory.json';

function getMemoryPath(repoPath: string): string {
  return join(repoPath, MEMORY_DIR, MEMORY_FILE);
}

function createDefaultMemory(): RepoMemory {
  return {
    patterns: [],
    commonErrors: [],
    fileStructure: '',
    lastUpdated: new Date(),
    categorizedErrors: [],
    filePatterns: [],
    validationHistory: [],
    successfulTickets: 0,
    failedTickets: 0,
  };
}

export function getMemory(repoPath: string): RepoMemory {
  const memoryPath = getMemoryPath(repoPath);

  if (!existsSync(memoryPath)) {
    return createDefaultMemory();
  }

  try {
    const content = readFileSync(memoryPath, 'utf-8');
    const data = JSON.parse(content) as MemoryFile;
    return {
      patterns: data.patterns || [],
      commonErrors: data.commonErrors || [],
      fileStructure: data.fileStructure || '',
      lastUpdated: new Date(data.lastUpdated),
      categorizedErrors: data.categorizedErrors || [],
      filePatterns: data.filePatterns || [],
      validationHistory: data.validationHistory || [],
      successfulTickets: data.successfulTickets || 0,
      failedTickets: data.failedTickets || 0,
    };
  } catch (error) {
    logger.error('Error reading memory', { repoPath, error: String(error) });
    return createDefaultMemory();
  }
}

export function saveMemory(repoPath: string, memory: RepoMemory): void {
  const memoryPath = getMemoryPath(repoPath);
  const memoryDir = dirname(memoryPath);

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  const data: MemoryFile = {
    patterns: memory.patterns,
    commonErrors: memory.commonErrors,
    fileStructure: memory.fileStructure,
    lastUpdated: memory.lastUpdated.toISOString(),
    categorizedErrors: memory.categorizedErrors,
    filePatterns: memory.filePatterns,
    validationHistory: memory.validationHistory,
    successfulTickets: memory.successfulTickets,
    failedTickets: memory.failedTickets,
  };

  writeFileSync(memoryPath, JSON.stringify(data, null, 2));
}

export interface SessionLearnings {
  errors?: string[];
  learnings?: string[];
  fileStructure?: string;
  // Enhanced fields
  modifiedFiles?: string[];
  ticketTitle?: string;
  validationResults?: { step: string; passed: boolean; output?: string }[];
  success?: boolean;
}

// Categorize an error message based on its content
export function categorizeError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('type') && (lower.includes('error') || lower.includes('is not assignable'))) {
    return 'type_error';
  }
  if (lower.includes('test') && (lower.includes('fail') || lower.includes('assert'))) {
    return 'test_failure';
  }
  if (lower.includes('lint') || lower.includes('eslint') || lower.includes('prettier')) {
    return 'lint_error';
  }
  if (lower.includes('build') || lower.includes('compile') || lower.includes('tsc')) {
    return 'build_error';
  }
  if (lower.includes('runtime') || lower.includes('undefined') || lower.includes('null')) {
    return 'runtime_error';
  }

  return 'unknown';
}

// Extract keywords from a ticket title for file pattern matching
function extractKeywords(title: string): string[] {
  const stopWords = [
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'to',
    'of',
    'and',
    'or',
    'for',
    'in',
    'on',
    'at',
    'by',
  ];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.includes(word));
}

export function updateMemory(repoPath: string, session: SessionLearnings): void {
  const memory = getMemory(repoPath);
  const now = new Date().toISOString();

  // Track success/failure counts
  if (session.success !== undefined) {
    if (session.success) {
      memory.successfulTickets++;
    } else {
      memory.failedTickets++;
    }
  }

  // Process errors with categorization
  if (session.errors) {
    for (const error of session.errors) {
      // Legacy: still add to commonErrors for backwards compatibility
      if (!memory.commonErrors.includes(error)) {
        memory.commonErrors.push(error);
      }

      // Enhanced: categorize and track
      const category = categorizeError(error);
      const existing = memory.categorizedErrors.find(
        (e) => e.category === category && e.message === error
      );

      if (existing) {
        existing.count++;
        existing.lastSeen = now;
      } else {
        memory.categorizedErrors.push({
          category,
          message: error,
          count: 1,
          lastSeen: now,
        });
      }
    }
    memory.commonErrors = memory.commonErrors.slice(-MEMORY_LIMITS.maxErrors);
    memory.categorizedErrors = memory.categorizedErrors.slice(-MEMORY_LIMITS.maxErrors);
  }

  // Process learnings
  if (session.learnings) {
    for (const learning of session.learnings) {
      if (!memory.patterns.includes(learning)) {
        memory.patterns.push(learning);
      }
    }
    memory.patterns = memory.patterns.slice(-MEMORY_LIMITS.maxPatterns);
  }

  // Track file patterns by ticket keywords
  if (session.modifiedFiles && session.modifiedFiles.length > 0 && session.ticketTitle) {
    const keywords = extractKeywords(session.ticketTitle);
    if (keywords.length > 0) {
      const existing = memory.filePatterns.find((fp) =>
        fp.ticketKeywords.some((k) => keywords.includes(k))
      );

      if (existing) {
        // Merge files and keywords
        for (const file of session.modifiedFiles) {
          if (!existing.commonFiles.includes(file)) {
            existing.commonFiles.push(file);
          }
        }
        for (const keyword of keywords) {
          if (!existing.ticketKeywords.includes(keyword)) {
            existing.ticketKeywords.push(keyword);
          }
        }
        existing.count++;
        // Keep only top 10 most common files
        existing.commonFiles = existing.commonFiles.slice(0, 10);
      } else {
        memory.filePatterns.push({
          ticketKeywords: keywords.slice(0, 5),
          commonFiles: session.modifiedFiles.slice(0, 10),
          count: 1,
        });
      }
      // Keep only 20 file patterns
      memory.filePatterns = memory.filePatterns.slice(-20);
    }
  }

  // Track validation history
  if (session.validationResults) {
    for (const result of session.validationResults) {
      if (!result.passed) {
        const existing = memory.validationHistory.find((vh) => vh.step === result.step);
        if (existing) {
          existing.failureCount++;
          existing.lastFailure = now;
          if (result.output) {
            const cause = result.output.slice(0, 200);
            if (!existing.commonCauses.includes(cause)) {
              existing.commonCauses.push(cause);
              existing.commonCauses = existing.commonCauses.slice(-5);
            }
          }
        } else {
          memory.validationHistory.push({
            step: result.step,
            failureCount: 1,
            lastFailure: now,
            commonCauses: result.output ? [result.output.slice(0, 200)] : [],
          });
        }
      }
    }
  }

  if (session.fileStructure) {
    memory.fileStructure = session.fileStructure;
  }

  memory.lastUpdated = new Date();
  saveMemory(repoPath, memory);
}

export function formatMemoryForPrompt(memory: RepoMemory): string {
  const sections: string[] = [];

  // Success rate context
  const totalTickets = memory.successfulTickets + memory.failedTickets;
  if (totalTickets > 0) {
    const successRate = Math.round((memory.successfulTickets / totalTickets) * 100);
    sections.push(
      `**Session history:** ${memory.successfulTickets}/${totalTickets} tickets completed successfully (${successRate}%)`
    );
  }

  if (memory.patterns.length > 0) {
    sections.push(`**Patterns to follow:**\n${memory.patterns.map((p) => `- ${p}`).join('\n')}`);
  }

  // Show categorized errors (more useful than raw errors)
  if (memory.categorizedErrors.length > 0) {
    const byCategory = memory.categorizedErrors.reduce(
      (acc, err) => {
        if (!acc[err.category]) acc[err.category] = [];
        acc[err.category].push(err);
        return acc;
      },
      {} as Record<ErrorCategory, CategorizedError[]>
    );

    const errorLines: string[] = [];
    for (const [category, errors] of Object.entries(byCategory)) {
      const topErrors = errors.sort((a, b) => b.count - a.count).slice(0, 3);
      errorLines.push(`  ${category}:`);
      for (const err of topErrors) {
        errorLines.push(
          `    - ${err.message.slice(0, 100)}${err.count > 1 ? ` (seen ${err.count}x)` : ''}`
        );
      }
    }
    sections.push(`**Errors to avoid (by category):**\n${errorLines.join('\n')}`);
  } else if (memory.commonErrors.length > 0) {
    // Fallback to legacy errors
    sections.push(
      `**Errors to avoid:**\n${memory.commonErrors
        .slice(-5)
        .map((e) => `- ${e}`)
        .join('\n')}`
    );
  }

  // Show validation trouble spots
  const troubleSteps = memory.validationHistory.filter((vh) => vh.failureCount >= 2);
  if (troubleSteps.length > 0) {
    const lines = troubleSteps.map(
      (vh) =>
        `- ${vh.step}: failed ${vh.failureCount}x${vh.commonCauses.length > 0 ? ` (common cause: ${vh.commonCauses[0].slice(0, 80)}...)` : ''}`
    );
    sections.push(`**Validation steps that often fail:**\n${lines.join('\n')}`);
  }

  if (memory.fileStructure) {
    sections.push(`**Project structure:**\n${memory.fileStructure}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : '';
}

// Helper to get relevant file suggestions based on ticket title
export function getRelevantFiles(memory: RepoMemory, ticketTitle: string): string[] {
  const keywords = extractKeywords(ticketTitle);
  if (keywords.length === 0) return [];

  const matchingPatterns = memory.filePatterns.filter((fp) =>
    fp.ticketKeywords.some((k) => keywords.includes(k))
  );

  const files = new Set<string>();
  for (const pattern of matchingPatterns) {
    for (const file of pattern.commonFiles) {
      files.add(file);
    }
  }

  return Array.from(files).slice(0, 10);
}
