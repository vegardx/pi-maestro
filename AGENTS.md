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

## Testing tiers

Pick the lowest tier that can catch the bug you care about — but read the
warning under tier 3 before deciding you are finished.

1. **Unit** (`npm test`) — pure logic, no I/O.
2. **Hermetic e2e** (`npm run test:e2e`) — `test/e2e/maestro/drive.e2e.test.ts`
   boots a real pi seat, real worktrees, real sockets and real detached
   processes, against a scripted mock model
   (`test/e2e/maestro/scripted-model.ts`). Deterministic, seconds.
3. **Live drive** (`npm run e2e:live`) — `test/e2e/maestro/live.ts`: real
   models, real commits, a local bare remote, a disposable repo under
   `~/src/github.com/`. Flags: `--prod-models`, `--keep`, `--recover` (SIGKILLs
   the maestro mid-flight and starts a new one over the same store).

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

`ToolRegistry.declare` and `PersonaCatalogue.declare` reject at construction:
grants are derived, descriptions generated, and prose that names a declared
tool is refused. When you add anything with a name, ask where the *second*
place that name lives is, and whether anything would fail if the two disagreed.
