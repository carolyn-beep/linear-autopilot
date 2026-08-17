# 3. Cross-session memory as a summarized JSON learning store

## Status

Accepted

## Context

Each ticket runs in a fresh Claude Code process with no memory of prior runs. A
purely stateless design is simple and safe, but it means the agent repeats the
same type errors, rediscovers which files a given kind of change touches, and
never benefits from the fact that a given validation step keeps failing in this
repo. The failures a fleet of runs produces are signal, and stateless runs throw
that signal away.

The counter-force is that memory injected into a prompt is attacker-adjacent and
budget-bounded: it can be poisoned by bad "learnings," and it competes for
context with the task itself.

## Decision

Maintain a per-repo JSON learning store at `.linear-autopilot/memory.json`
(`src/memory/index.ts`), updated on both success and failure by `updateMemory`.
On failure the error is categorized (`categorizeError` →
`type_error`, `test_failure`, `lint_error`, `build_error`, `runtime_error`) with
occurrence counts; per-step validation failures are tracked in
`validationHistory`. On success, modified files (`git diff --name-only`) are
associated with keywords from the ticket title as `filePatterns`.

Only a **summarized** view reaches the prompt. `formatMemoryForPrompt` renders
the success rate, patterns, the top few errors per category, and the
trouble-prone validation steps — never the raw file. The store is bounded
(`MEMORY_LIMITS` in `src/constants.ts`; file patterns and causes are sliced), and
every string is passed through `redactSecrets` before being written (see
ADR 0004).

## Consequences

**Positive**

- Learning compounds over a repo's lifetime: agents stop repeating known errors
  and get file hints for familiar work.
- Bounded size keeps the context-budget cost small — top-N per category, not full
  history.
- Redaction on write keeps credentials out of a file that is later injected into
  prompts.

**Negative**

- Poisoning risk: a wrong "learning" or a spurious file pattern can mislead
  future runs, and nothing distinguishes a genuine pattern from a coincidental
  one. Bounding and categorization limit but do not eliminate this.
- Keyword-based file patterns are crude; unrelated tickets sharing a common word
  can cross-contaminate.
- The store is per-repo local state and file-based, with no concurrency control,
  so simultaneous writers to one repo could race.

## Alternatives considered

- **Stateless runs.** No poisoning risk, no budget cost, but no compounding
  learning. Rejected: the payoff of not repeating failures was judged worth the
  bounded risk.
- **A vector database of past runs.** Richer retrieval, but adds infrastructure,
  an embedding step, and retrieval-relevance tuning far beyond what a per-repo
  JSON file needs at this scale. Rejected as premature.
- **Inject the raw memory file.** Maximum recall, but blows the context budget
  and enlarges the untrusted/secret surface. Rejected in favor of the summarized
  view.
  </content>
