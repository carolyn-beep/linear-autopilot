# 5. Multi-tenant credential model with optional per-tenant overrides

## Status

Proposed

## Context

Autopilot is multi-tenant: one deployment serves several Linear teams, each
mapped to a repository via `tenants.json` (`src/config/tenants.ts`). Each tenant
needs a GitHub token to push branches and open PRs, and a Linear key to read
tickets and update status. Two credential models sit at the extremes. A single
global set of tokens is trivial to operate but means one compromised token
reaches every tenant's repo. Strict per-tenant isolation from day one bounds the
blast radius but forces every operator to provision and manage a full credential
set per tenant before the platform is otherwise useful.

## Decision

Stage it. Ship global credentials (`GITHUB_TOKEN`, `LINEAR_API_KEY` via
`getConfig`, `src/config/index.ts`) as the baseline, with one **optional**
per-tenant override declared on `TenantConfig`: `githubToken`.

The GitHub override is wired end-to-end: `createPullRequest`
(`src/spawner/index.ts`) resolves the token as
`tenant.githubToken ?? process.env.GITHUB_TOKEN` and passes it as `GH_TOKEN` to
the push and `gh pr create` calls. This is the credential that writes to tenant
repositories, so it is where scoping matters most and is delivered first.

A matching per-tenant Linear key is deliberately **not** shipped as a config
field yet. Adding a `linearApiKey` override that the Linear client
(`src/linear/client.ts`) still ignored would be worse than its absence: an
operator could set it and reasonably assume Linear calls were scoped when they
were not. Per-tenant Linear scoping is the documented next step; until it is
wired end-to-end, the client authenticates with the global `config.linearApiKey`.

## Consequences

**Positive**

- Low barrier to start: a global token pair gets a deployment running; overrides
  are added only for tenants that need isolation.
- The highest-value scoping — the GitHub token that writes to repos — is real
  today, so a per-tenant token limits repo blast radius now.
- No misleading half-controls: the config exposes only overrides the code
  actually honors, so an operator can't set a knob that silently does nothing.

**Negative**

- Not true isolation yet. With no GitHub override set, a single global token
  still reaches every tenant repo, and Linear access is global for all tenants.
- Per-tenant Linear scoping requires threading a key through the Linear client,
  which is deferred — so Linear-side blast radius is currently unbounded across
  tenants.
- Tenant tokens live in `tenants.json` on disk, which raises the bar for how that
  file is stored and permissioned.

## Alternatives considered

- **Global credentials only.** Simplest, but no path to blast-radius reduction
  and no way for a security-sensitive tenant to isolate. Rejected as a ceiling.
- **Strict per-tenant isolation from day one.** The right end state, but front-loads
  credential provisioning onto every operator before the platform proves useful,
  and would gate launch on the full Linear-client rewiring. Deferred, not
  rejected — this ADR is the staging toward it.
- **Single-tenant only.** Sidesteps the problem by dropping multi-tenancy, which
  is a core requirement. Rejected.
