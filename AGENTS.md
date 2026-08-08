# AGENTS.md

Guidance for coding agents (Claude, pi, or any harness) working in this repo.
pi-maestro is a **pi coding-agent extension stack** (`package.json`
`pi.extensions`). One interactive `pi` process is the Maestro seat. Autonomous
work runs through a sandboxed `pi-workflow` supervisor and `pi-subagent`; there
is no custom worker socket or alternate executor.

## Build / check

- `npm run check` — the full gate: biome → tsc → feature-flag contract → docs
  check → vitest → smoke. Run it before calling a change done.
- `npm test` — unit tests only (fast). `npm run lint:fix` — autoformat.

## Testing tiers

Pick the lowest tier that can catch the bug you care about — but read the
warning under tier 3 before deciding you are finished.

1. **Unit** (`npm test`) — pure logic, no I/O.
2. **Hermetic e2e** (`npm run test:e2e`) —
   `test/e2e/maestro/workflow-drive.e2e.test.ts` drives the production plan
   runner, real worktrees, detached supervisors, `pi-workflow`, and
   `pi-subagent` against a deterministic fake Pi model process.
3. **Live workflow drive** — not wired yet. It must use real models, real
   commits, a local bare remote, and the production workflow supervisor path.

**Tiers 1 and 2 cannot see the seam between processes.** Four bugs in one day
were found only by tier 3, and each had a full green suite over it: a shell
gate that refused every commit because the tool it named was never declared; an
identity carried as environment that silently overrode the developer's
path-scoped git config; a restarted maestro that wedged a plan while narrating
nothing; children inheriting env vars that were omitted expecting absence.

So: **run the live drive before calling done anything that touches the shell
gate, the spawn path, git identity, or shipping.** No CI job will do it for you
— e2e cannot run on GitHub today, which is why the workflow was deleted rather
than left green over the wrong package.

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

`ToolRegistry.declare` rejects drift at construction: grants derive from the
tool implementation. Workflow manifests bind approved models, repositories,
artifacts, and authority. When you add anything with a name, ask where the
*second* place that name lives is, and whether anything would fail if they
disagreed.
