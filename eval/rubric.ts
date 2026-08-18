// eval/rubric.ts
//
// Scoring rubric and shared types for the Tier-1 offline orchestration eval.
//
// Tier 1 measures *orchestration correctness*: given a fixture input, does the
// REAL deterministic decision logic in src/ route, retry, remember, fence, and
// redact the way it is supposed to? Every scenario is scored as a binary
// PASS/FAIL against an explicit expectation -- there are no partial credits and
// no fabricated numbers. The aggregate report is a straight pass rate, overall
// and per category.
//
// (Tier 2 -- grading the *quality* of a real agent's diff on real tickets with a
// 0-3 rubric -- is documented in docs/EVALUATION.md and deliberately lives
// outside this file and CI. See that doc for why the two tiers are split.)

/**
 * The orchestration concerns exercised by the golden set. Each maps to a real
 * decision point in the pipeline and to a section of docs/EVALUATION.md.
 */
export type Category =
  | 'validation-routing'
  | 'retry-policy'
  | 'stuck-detection'
  | 'memory-learning'
  | 'prompt-safety'
  | 'secret-redaction';

export const CATEGORY_ORDER: Category[] = [
  'validation-routing',
  'retry-policy',
  'stuck-detection',
  'memory-learning',
  'prompt-safety',
  'secret-redaction',
];

/**
 * What each category proves about the system. Printed in the report footer so a
 * reviewer can read the "why" next to the numbers.
 */
export const CATEGORY_INTENT: Record<Category, string> = {
  'validation-routing':
    'A change only becomes a PR when the real validation gate passes; otherwise it is routed back to Backlog.',
  'retry-policy': 'Failures are retried up to MAX_RETRIES and then dropped, never retried forever.',
  'stuck-detection':
    'An agent past the stuck threshold is flagged exactly once, not repeatedly and not early.',
  'memory-learning':
    'Outcomes are recorded across sessions and the accumulated context is injected into the next prompt.',
  'prompt-safety':
    'Untrusted, user-supplied ticket text is fenced as data and cannot be executed as instructions.',
  'secret-redaction':
    'Secrets never reach a subprocess, a PR body, a Linear comment, or the memory file.',
};

/** The outcome a scenario produces after invoking the real src/ code. */
export interface Outcome {
  /** Human-readable statement of the expected orchestrator behavior. */
  expected: string;
  /** Human-readable statement of what actually happened. */
  actual: string;
  /** Binary score. */
  pass: boolean;
  /** Optional extra context shown only for failures. */
  detail?: string;
}

/** A golden-set scenario: metadata plus a runnable check against real code. */
export interface Scenario {
  id: string;
  name: string;
  category: Category;
  /** One line on what a PASS here demonstrates. */
  proves: string;
  /** Invokes the REAL functions from src/ and returns a scored outcome. */
  run: () => Outcome | Promise<Outcome>;
}

/** A scenario's metadata joined with its scored outcome. */
export interface ScenarioResult extends Outcome {
  id: string;
  name: string;
  category: Category;
}

export interface CategoryMetric {
  category: Category;
  passed: number;
  total: number;
  /** 0..1 */
  passRate: number;
}

export interface EvalReport {
  results: ScenarioResult[];
  categories: CategoryMetric[];
  passed: number;
  total: number;
  /** 0..1 */
  passRate: number;
  allPassed: boolean;
}

/**
 * Aggregate scored results into overall and per-category pass rates. Pure: no
 * I/O, so it is trivially testable and deterministic.
 */
export function aggregate(results: ScenarioResult[]): EvalReport {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  const categories: CategoryMetric[] = CATEGORY_ORDER.filter((cat) =>
    results.some((r) => r.category === cat)
  ).map((category) => {
    const inCat = results.filter((r) => r.category === category);
    const catPassed = inCat.filter((r) => r.pass).length;
    return {
      category,
      passed: catPassed,
      total: inCat.length,
      passRate: inCat.length === 0 ? 0 : catPassed / inCat.length,
    };
  });

  return {
    results,
    categories,
    passed,
    total,
    passRate: total === 0 ? 0 : passed / total,
    allPassed: passed === total,
  };
}

/** Assertion helper: builds a PASS/FAIL Outcome from a boolean condition. */
export function check(pass: boolean, expected: string, actual: string, detail?: string): Outcome {
  return { pass, expected, actual, detail };
}
