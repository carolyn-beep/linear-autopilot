# Evaluation

Linear Autopilot spawns autonomous coding agents to work Linear tickets, validates
their output, and opens PRs. The thing worth measuring here is **orchestration
quality** — does the system route, retry, remember, fence, and redact correctly —
not just "does a feature ship." This document defines what "good" means, and lays
out a two-tier eval that measures it honestly.

- **Tier 1 — Offline orchestration eval.** Runs here, in CI, with no external
  services. Exercises the real deterministic decision logic in `src/` against a
  golden set of scenarios and scores each PASS/FAIL. This is `npm run eval`.
- **Tier 2 — Live end-to-end quality eval.** A documented methodology (below) for
  grading the _quality_ of real agent diffs on real tickets. Requires Claude Code,
  Linear, and a target repo, so it is **out of CI scope** and produces no numbers
  in this repo — the results table ships as an empty template on purpose.

## What "good" means for this system

An orchestrator is good when it is **safe by default, honest about outcomes, and
bounded in effort**:

1. **The gate is trustworthy.** A change becomes a PR _only_ when validation
   actually passes; anything else goes back to Backlog. No green-washing.
2. **Effort is bounded.** Failing tickets are retried a fixed number of times and
   then dropped — never retried forever, never silently abandoned early.
3. **Liveness is observable.** A hung agent is detected and surfaced exactly once.
4. **It learns.** Outcomes (successes, categorized failures, file patterns) are
   persisted and fed into the next agent's prompt.
5. **It is secure against its own inputs.** Ticket text is untrusted and fenced as
   data; secrets never reach a subprocess, a PR, a Linear comment, or the memory
   file.

Tier 1 measures 1–5 directly and deterministically. Tier 2 measures something Tier
1 cannot: whether the code the agent actually wrote is _correct and well-scoped_.

## Why offline and live are split

The two tiers answer different questions and have different reliability profiles,
so mixing them would make both worse:

|                 | Tier 1 (offline)                    | Tier 2 (live)                              |
| --------------- | ----------------------------------- | ------------------------------------------ |
| Question        | Is the orchestration logic correct? | Is the agent's output good?                |
| Determinism     | Fully deterministic                 | Non-deterministic (LLM)                    |
| Cost / latency  | Milliseconds, free                  | Minutes, real API + compute cost           |
| Dependencies    | None                                | Claude Code, Linear, target repo, tokens   |
| Fit for CI      | Yes — gates every commit            | No — sampled, run manually / scheduled     |
| Failure meaning | A regression in _our_ code          | A regression in model output _or_ our code |

Gating CI on a non-deterministic, paid, minutes-long process would be flaky and
expensive, and a red result would be ambiguous (model variance vs. real bug). So
Tier 1 gates every commit; Tier 2 is run deliberately against a golden ticket set
and read by a human.

---

## Tier 1 — Offline orchestration eval

```bash
npm run eval
```

The runner (`eval/runner.ts`) loads a golden set (`eval/scenarios/index.ts`),
invokes the **real** functions from `src/` with fixture inputs, scores each
scenario against an explicit expectation, prints a per-scenario table plus
aggregate metrics, and **exits non-zero if any scenario fails** so it can gate CI.

### What is real vs. mocked

The point of Tier 1 is to test _our_ decision logic, so that logic is never
mocked. Only genuinely external effects are avoided:

- **Real (imported directly from `src/`):** the validation gate (`validate`,
  `formatValidationSummary`), the retry queue (`ticketQueue` + `MAX_RETRIES`), the
  memory store (`updateMemory`, `getMemory`, `categorizeError`,
  `formatMemoryForPrompt`), the prompt builder (`buildAutopilotPrompt`), and the
  security layer (`redactSecrets`, `scrubbedEnv`).
- **Provided, not mocked:** a real temporary directory for the validation gate and
  memory store to act on (they are file-system components), created per scenario
  and cleaned up.
- **Avoided entirely:** spawning Claude Code, the network, `git push` / `gh`, and
  the Linear API. These are never called; the eval tests the code _around_ the
  agent spawn, not the spawn itself.

### Scoring rubric

Tier 1 is a **conformance** eval, so scoring is binary per scenario: the observed
behavior either matches the stated expectation or it does not. Partial credit
would hide regressions in safety-critical routing, so there is none. Metrics are:

- **Overall pass rate** = passed / total.
- **Pass rate by category** = passed / total within each category.

The bar for merge is **100%** — every scenario must pass. The rubric definitions
and the aggregation live in `eval/rubric.ts`.

### Categories and what each proves

| Category             | What a PASS proves                                                                                                                                          | Real code exercised                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `validation-routing` | A change becomes a PR only when the gate passes; any failing step (tests _or_ lint) routes it back to Backlog. The gate is conjunctive.                     | `validate`, `formatValidationSummary` against temp repos with passing / failing `test` and `lint` scripts |
| `retry-policy`       | A failure below the cap is requeued; a persistently failing ticket is dropped after exactly `MAX_RETRIES` attempts.                                         | `ticketQueue` (`enqueue`/`dequeue`/`requeue`), `MAX_RETRIES`                                              |
| `stuck-detection`    | An agent under the threshold is not flagged; one past it is flagged exactly once (the `notifiedStuck` latch suppresses repeats).                            | `STUCK_THRESHOLD_MS` + the exact `checkStuckAgents` predicate (see limitation below)                      |
| `memory-learning`    | Failures and successes update the counts, errors are categorized, file patterns are recorded, and the accumulated context is injected into the next prompt. | `updateMemory`, `getMemory`, `categorizeError`, `formatMemoryForPrompt`, `buildAutopilotPrompt`           |
| `prompt-safety`      | A prompt-injection payload in a ticket lands _inside_ the `<ticket_content untrusted="true">` fence, alongside the guardrail instruction.                   | `buildAutopilotPrompt`                                                                                    |
| `secret-redaction`   | Tokens, webhooks, and secret env values are masked before output; secret env keys are stripped before a subprocess sees them.                               | `redactSecrets`, `scrubbedEnv`                                                                            |

There are currently 13 scenarios across these 6 categories.

### Sample output

```
Linear Autopilot — Tier-1 Offline Orchestration Eval
Exercises the real validation gate, retry queue, memory store, prompt builder, and redactor.

#    Scenario                                  Category            Expected                                      Actual                          Result
───  ────────────────────────────────────────  ──────────────────  ────────────────────────────────────────────  ──────────────────────────────  ──────
1    Passing validation routes to the PR path  validation-routing  validate() passes -> route = pr               validate() passed=true -> rou…  PASS
2    Failing tests route back to Backlog       validation-routing  validate() fails on tests -> route = backlog  validate() passed=false, test…  PASS
...
13   Secret env keys are stripped before rea…  secret-redaction    secret keys removed; PATH/HOME/APP_ENV pres…  strippedSecrets=true, keptSaf…  PASS

Pass rate by category
────────────────────────────────────────────────
validation-routing       3/3  100%
retry-policy             2/2  100%
stuck-detection          2/2  100%
memory-learning          3/3  100%
prompt-safety            1/1  100%
secret-redaction         2/2  100%

✔ 13/13 scenarios passed (100%)
```

### Metric definitions (Tier 1)

- **Scenario:** one fixture input + one expected orchestrator behavior.
- **PASS / FAIL:** the observed behavior matches the expectation (binary). A
  scenario that throws is a FAIL, not a harness crash.
- **Overall pass rate:** passed scenarios / total scenarios.
- **Category pass rate:** passed / total within a category.
- **Gate:** exit code is `0` iff every scenario passes; otherwise `1`.

---

## Tier 2 — Live end-to-end quality eval (methodology)

Tier 1 proves the plumbing is correct. Tier 2 asks the harder question: **given a
real ticket, is the code the agent wrote actually good?** This requires running the
full pipeline (Claude Code implementing against a real target repo, real
validation, real PR), so it is **not run in CI** and produces **no numbers in this
repo**. The table below is a template with `[ ]` placeholders — filling it in
requires an actual run and must never be invented.

### Setup

- A **golden ticket set**: 15–25 real Linear tickets against a stable target repo,
  spanning difficulty (typo/one-liner → multi-file feature) and type (bug fix,
  feature, refactor, test-only, docs). Each ticket has a human-written
  **reference expectation** describing what a correct, in-scope solution looks
  like.
- A **frozen target repo** at a known commit, so runs are comparable.
- Fixed model / config, recorded alongside results.

### Rubric dimensions (score 0–3 each)

Each completed ticket is graded by a human reviewer (optionally cross-checked by an
LLM-as-judge, never as the sole grader) on:

| Dimension           | 0                         | 1                      | 2                            | 3                                      |
| ------------------- | ------------------------- | ---------------------- | ---------------------------- | -------------------------------------- |
| **Correctness**     | Doesn't solve the ticket  | Partially solves it    | Solves it with minor gaps    | Fully solves the reference expectation |
| **Scope adherence** | Broad unrelated changes   | Notable scope creep    | Minor extra churn            | Changes confined to the ticket         |
| **Tests pass**      | Validation red / no tests | Tests weakened to pass | Passes, thin coverage        | Passes with meaningful tests           |
| **Diff quality**    | Unreadable / unsafe       | Works but messy        | Reasonable, follows patterns | Clean, idiomatic, matches repo style   |

And these are **recorded, not scored 0–3** (they are costs/facts, aggregated
separately):

| Metric      | Definition                                                        |
| ----------- | ----------------------------------------------------------------- |
| **Cost**    | Total token / dollar cost for the ticket (from usage tracking).   |
| **Latency** | Wall-clock from spawn to PR (or to failure).                      |
| **Retries** | Number of attempts before success or drop (from the retry queue). |

### Scoring

- **Per-ticket score** = sum of the four 0–3 dimensions (0–12).
- **Suite quality score** = mean per-ticket score across the golden set.
- **Autonomous completion rate** = tickets reaching a passing PR with **zero**
  human edits / total tickets.
- Cost, latency, and retries are reported as median + p90, not folded into the
  quality score.

### How results are collected

1. Enqueue the golden ticket set against the frozen repo.
2. Let the pipeline run; capture each PR, the validation summary, and the
   usage/latency/retry records the system already emits.
3. A reviewer grades each PR against its reference expectation using the rubric.
4. Fill the results table. Record model + config + repo commit with the run.

### Results table (TEMPLATE — do not invent numbers)

Per-ticket:

| Ticket | Type | Difficulty | Correctness | Scope | Tests | Diff | Total /12 | Cost | Latency | Retries |
| ------ | ---- | ---------- | ----------- | ----- | ----- | ---- | --------- | ---- | ------- | ------- |
| [ ]    | [ ]  | [ ]        | [ ]         | [ ]   | [ ]   | [ ]  | [ ]       | [ ]  | [ ]     | [ ]     |
| [ ]    | [ ]  | [ ]        | [ ]         | [ ]   | [ ]   | [ ]  | [ ]       | [ ]  | [ ]     | [ ]     |
| [ ]    | [ ]  | [ ]        | [ ]         | [ ]   | [ ]   | [ ]  | [ ]       | [ ]  | [ ]     | [ ]     |

Suite summary:

| Metric                         | Value |
| ------------------------------ | ----- |
| Tickets evaluated              | [ ]   |
| Suite quality score (mean /12) | [ ]   |
| Autonomous completion rate     | [ ]   |
| Median cost / ticket           | [ ]   |
| Median latency / ticket        | [ ]   |
| Median retries / ticket        | [ ]   |
| Model / config / repo commit   | [ ]   |

---

## Honest limitations — what this harness does NOT measure

- **Tier 1 does not run Claude Code.** It never measures whether an agent can
  actually implement a ticket. That is Tier 2's job, by design.
- **Tier 1 does not exercise the real `git`/`gh`/Linear side effects.** PR
  creation, branch cleanup, `git push`, and Linear status transitions are I/O
  wrappers around the decisions we _do_ test; they are integration-tested
  elsewhere, not here.
- **Stuck detection asserts the decision, not the timer.** `checkStuckAgents` is a
  private, timer-driven method whose only effect is a notification. Tier 1 pins
  its exact predicate against the real `STUCK_THRESHOLD_MS`; it does not run the
  interval timer or the notifier. This mirror must be kept in lock-step with the
  source (a comment in `eval/scenarios/index.ts` flags this).
- **Redaction is best-effort.** The eval confirms known token/webhook shapes and
  secret-keyed env values are masked. It cannot prove _no conceivable_ secret
  format leaks — redaction is defense-in-depth, not a guarantee.
- **Concurrency / multi-tenant limits are not stress-tested.** `maxConcurrentAgents`
  and per-tenant isolation have unit coverage but are not load-tested by the eval.
- **Tier 2 quality is human-graded and sampled.** It is subjective at the margins,
  costs real money, and reflects a specific model/config/commit snapshot — it is a
  measurement, not a guarantee of future runs.

```

```
