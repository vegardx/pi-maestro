# AGENTS.md

Guidance for coding agents (Claude, pi, or any harness) working in this repo.
pi-maestro is a **pi coding-agent extension stack** (`package.json`
`pi.extensions`). One `pi` process becomes a maestro; it spawns detached worker
processes that dial home over a unix socket and speak the small protocol in
`packages/maestro/src/protocol.ts`.

Depth decides what a process is. Depth 0 is the seat, depth 1 a worker, depth 2
a read-only agent. `packages/maestro/src/extension.ts` reads that once, at load.

## Build / check

- `npm run check` — the full gate: biome → tsc → feature-flag contract → docs
  check → vitest → smoke. Run it before calling a change done.
- `npm test` — unit tests only (fast). `npm run lint:fix` — autoformat.

## Testing

`npm test` contains the current unit, component, and integration coverage. The
repository intentionally has no end-to-end or live acceptance suite while its
execution model and testing claims are reassessed. Do not present the regular
test suite as evidence for real-model behavior, cross-process configuration,
Git identity, or shipping.

## Conventions

- **Branch per change → PR to origin; merge only via rebase-merge.** Never
  commit straight to `main`.
- TypeScript throughout; imports use explicit `.js` extensions (nodenext).
  Match the surrounding file's style (tabs, double quotes).
- **Never weaken a test or the harness to make a run pass.** If a drive fails,
  that is a finding about the system, not about the test.
- **A conditional skip inside a test is a test that reports on its
  precondition.** If a test needs one, assert the precondition in its own test
  rather than branching around it — several tests here reported green for
  months while asserting nothing, because the branch always fired.

## The defect this codebase is organised against

A capability used to live in four independent places — the grant, the
implementation, the agent-facing description, the verification — joined only by
strings, with nothing failing when they disagreed.

`ToolRegistry.declare` and `PersonaCatalogue.declare` reject at construction:
grants are derived, descriptions generated, and prose that names a declared
tool is refused. When you add anything with a name, ask where the *second*
place that name lives is, and whether anything would fail if the two disagreed.
