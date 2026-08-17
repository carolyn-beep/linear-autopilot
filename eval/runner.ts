// eval/runner.ts
//
// Tier-1 offline orchestration eval. Runs the golden set against the REAL
// decision logic in src/, prints a readable report (per-scenario table +
// aggregate metrics), and exits non-zero if any scenario fails so it can gate
// CI. No external services, no network, no Claude Code spawn.
//
//   npm run eval
//
// See docs/EVALUATION.md for the methodology and for the Tier-2 (live) eval.

import { scenarios } from './scenarios';
import { aggregate, CATEGORY_INTENT, Category, EvalReport, ScenarioResult } from './rubric';

// --- Tiny, dependency-free formatting --------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string): string => paint(32, s);
const red = (s: string): string => paint(31, s);
const dim = (s: string): string => paint(2, s);
const bold = (s: string): string => paint(1, s);

function truncate(s: string, width: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= width ? clean : clean.slice(0, width - 1) + '…';
}

// Matches ANSI SGR escape sequences. Built from a char code so the regex source
// contains no literal control character (keeps eslint's no-control-regex happy).
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function pad(s: string, width: number): string {
  // Pad based on visible length (strip ANSI) so colored cells still align.
  const visible = s.replace(ANSI_PATTERN, '').length;
  return s + ' '.repeat(Math.max(0, width - visible));
}

interface Column {
  header: string;
  width: number;
  value: (r: ScenarioResult, i: number) => string;
}

function printTable(results: ScenarioResult[]): void {
  const columns: Column[] = [
    { header: '#', width: 3, value: (_r, i) => String(i + 1) },
    { header: 'Scenario', width: 40, value: (r) => truncate(r.name, 40) },
    { header: 'Category', width: 18, value: (r) => truncate(r.category, 18) },
    { header: 'Expected', width: 44, value: (r) => truncate(r.expected, 44) },
    { header: 'Actual', width: 30, value: (r) => truncate(r.actual, 30) },
    {
      header: 'Result',
      width: 6,
      value: (r) => (r.pass ? green('PASS') : red('FAIL')),
    },
  ];

  const headerRow = columns.map((c) => pad(bold(c.header), c.width)).join('  ');
  const rule = columns.map((c) => '─'.repeat(c.width)).join('  ');

  console.log(headerRow);
  console.log(dim(rule));
  results.forEach((r, i) => {
    console.log(columns.map((c) => pad(c.value(r, i), c.width)).join('  '));
  });
}

function printCategoryMetrics(report: EvalReport): void {
  console.log('');
  console.log(bold('Pass rate by category'));
  console.log(dim('─'.repeat(48)));
  for (const cat of report.categories) {
    const rate = `${Math.round(cat.passRate * 100)}%`.padStart(4);
    const count = `${cat.passed}/${cat.total}`.padStart(5);
    const label = cat.passRate === 1 ? green(cat.category) : red(cat.category);
    console.log(`${pad(label, 22)} ${count}  ${rate}`);
  }
}

function printFailures(results: ScenarioResult[]): void {
  const failures = results.filter((r) => !r.pass);
  if (failures.length === 0) return;

  console.log('');
  console.log(bold(red('Failures')));
  console.log(dim('─'.repeat(48)));
  for (const f of failures) {
    console.log(`${red('✗')} ${bold(f.name)} ${dim(`[${f.category}]`)}`);
    console.log(`  expected: ${f.expected}`);
    console.log(`  actual:   ${f.actual}`);
    if (f.detail) console.log(dim(`  detail:   ${truncate(f.detail, 300)}`));
  }
}

function printIntent(report: EvalReport): void {
  console.log('');
  console.log(bold('What each category proves'));
  console.log(dim('─'.repeat(48)));
  const seen = new Set<Category>();
  for (const cat of report.categories) {
    if (seen.has(cat.category)) continue;
    seen.add(cat.category);
    console.log(`${bold(cat.category)}`);
    console.log(dim(`  ${CATEGORY_INTENT[cat.category]}`));
  }
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log(bold('Linear Autopilot — Tier-1 Offline Orchestration Eval'));
  console.log(
    dim(
      'Exercises the real validation gate, retry queue, memory store, prompt builder, and redactor.'
    )
  );
  console.log('');

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    try {
      const outcome = await scenario.run();
      results.push({
        id: scenario.id,
        name: scenario.name,
        category: scenario.category,
        ...outcome,
      });
    } catch (error) {
      // A thrown scenario is a failure, not a crash of the harness.
      results.push({
        id: scenario.id,
        name: scenario.name,
        category: scenario.category,
        pass: false,
        expected: scenario.proves,
        actual: 'threw an exception',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  const report = aggregate(results);

  printTable(results);
  printCategoryMetrics(report);
  printFailures(results);
  printIntent(report);

  console.log('');
  const summary = `${report.passed}/${report.total} scenarios passed (${Math.round(
    report.passRate * 100
  )}%)`;
  console.log(bold(report.allPassed ? green(`✔ ${summary}`) : red(`✗ ${summary}`)));
  console.log('');

  process.exit(report.allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Eval harness crashed:', error);
  process.exit(1);
});
