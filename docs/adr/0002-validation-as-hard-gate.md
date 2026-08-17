# 2. Validation as a hard gate before PR creation

## Status

Accepted

## Context

A Claude Code run that exits `0` means "the agent believes it finished," not
"the work is correct." Autonomous coding agents hallucinate success, leave tests
red, and misjudge their own output. If Autopilot trusts the exit code and opens a
PR, every one of those failures lands on a human reviewer, and the value
proposition — work that arrives ready to review — collapses.

The question is where verification happens: inside the loop before a PR exists,
or downstream in human review after it does.

## Decision

Make validation a hard gate between agent completion and PR creation.
`handleSuccess` (`src/spawner/index.ts`) runs `validate()`
(`src/validation/index.ts`) before any branch is pushed. The pipeline runs
tests, lint, typecheck, and an optional coverage check; `passed` is
`results.every(r => r.passed)`. If validation fails, the run is routed to
`handleFailure` exactly as if the agent had crashed — the branch is cleaned up,
the ticket is commented and moved to Backlog, and it is requeued. A PR is created
only after the gate passes.

Each check runs via `runCommand` with a scrubbed environment and a
`VALIDATION_TIMEOUT_MS` cap, and each is a no-op skip when the repo lacks the
relevant script or `tsconfig.json`, so a repo is never blocked by a check it does
not support.

## Consequences

**Positive**

- A quality floor: reviewers see only PRs that already pass tests, lint, and
  typecheck. Hallucinated success is caught before it reaches a human.
- Validation failure becomes signal, not noise — it feeds the memory loop
  (ADR 0003) via `validationHistory`.
- The gate is extensible: adding a check is one `results.push(...)` line.

**Negative**

- Throughput cost. A failed gate means a full retry, so total agent time per
  ticket rises. This is a deliberate trade of speed for a higher PR-quality
  floor.
- Quality is bounded by the repo's own checks. A repo with weak or missing tests
  gets a weak gate; the skip-if-unsupported convention means an untested repo
  passes trivially.
- Validation runs the agent's code with a timeout, so a pathological build can
  consume up to `VALIDATION_TIMEOUT_MS` before failing.

## Alternatives considered

- **Trust the agent's self-report and open a PR immediately.** Faster and
  simpler, but shifts all verification onto reviewers and defeats the goal of
  review-ready output. Rejected.
- **Post the PR, then validate via CI and comment.** Uses existing CI, but a
  broken PR still exists, still notifies, and still costs reviewer attention;
  the branch-cleanup containment in `handleFailure` would be lost. Rejected in
  favor of gating before the PR exists.
- **A soft gate (warn but proceed).** Preserves throughput but reintroduces the
  exact silent-bad-output problem the gate is meant to remove. Rejected.
  </content>
