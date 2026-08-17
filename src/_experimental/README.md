# Experimental

This directory holds experimental, **not-yet-wired-in** work. Nothing in the
shipped application imports it.

Current contents:

- `coordination/` — multi-agent coordination via an MCP client/manager
- `runners/` — alternative agent runners (multi-runner selection, swarm, Rails)

Status and caveats:

- Excluded from the build/typecheck (see `exclude` in `tsconfig.json`) and from
  test coverage (see `collectCoverageFrom` in `jest.config.ts`).
- This code was relocated here and its relative imports (e.g. `../logger`,
  `../config/tenants`, `../linear/types`) still point at the old layout and need
  updating before it can compile.

Do not delete — this is preserved work in progress.
