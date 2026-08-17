# Architecture Decision Records

This directory records the significant architectural decisions behind Linear
Autopilot: what was decided, why, what we traded away, and which alternatives we
rejected.

## What an ADR is

An Architecture Decision Record captures a single decision with lasting
consequences at the point it was made. It is not documentation of how the system
works today (see [ARCHITECTURE.md](../ARCHITECTURE.md) for that) and it is not a
task guide (see [EXTENDING.md](../EXTENDING.md)). An ADR exists so that a future
maintainer can reconstruct the reasoning — including the constraints and the
options not taken — without having to re-derive it or re-litigate a settled call.

Each record is immutable once accepted. When a decision changes, we do not edit
the old ADR; we add a new one and mark the old one `Superseded`, linking forward.

## Format

Every ADR follows the same structure:

- **Title** — the decision, stated as a short noun phrase.
- **Status** — see legend below.
- **Context** — the forces at play: constraints, requirements, prior state.
- **Decision** — what we chose to do, grounded in the actual code.
- **Consequences** — the results, both positive and negative.
- **Alternatives considered** — the other options, each with why it was rejected.

## Status legend

| Status         | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| **Accepted**   | Decided and in effect in the shipped codebase.                    |
| **Proposed**   | Under consideration or partially built; not fully in effect.      |
| **Superseded** | Replaced by a later ADR (linked). Kept for the historical record. |

## Index

| ADR                                           | Title                                                    | Status   |
| --------------------------------------------- | -------------------------------------------------------- | -------- |
| [0001](0001-spawn-claude-code-cli.md)         | Spawn the Claude Code CLI as the coding agent            | Accepted |
| [0002](0002-validation-as-hard-gate.md)       | Validation as a hard gate before PR creation             | Accepted |
| [0003](0003-cross-session-memory.md)          | Cross-session memory as a summarized JSON learning store | Accepted |
| [0004](0004-security-posture.md)              | Security posture for a code-executing agent              | Accepted |
| [0005](0005-multi-tenant-credential-model.md) | Multi-tenant credential model with optional overrides    | Proposed |
| [0006](0006-mcp-read-only-surface.md)         | Expose the platform over a read-only MCP surface         | Accepted |
