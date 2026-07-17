# End-to-end testing the harness

pi-maestro's core promise — *a worker runs in a worktree, reports over RPC, and
nothing ships until its review gate is satisfied* — spans the engine, the
execution adapter, the RPC protocol, and (in production) tmux + `pi` + git + gh.
Unit tests cover the pieces; **dogfooding** (`dogfood-prompt.md`,
`scripts/reset-dogfood.sh`) covers the whole thing but needs real tmux, a real
`pi`, real model calls, and sibling sandbox repos — too heavy to run on every
change, and impossible for an agent to drive unattended.

This doc describes the **hermetic e2e harness**: it boots the *real*
orchestrator and drives a deliverable through its lifecycle over the *real* RPC
protocol, with **no tmux, no `pi`, no API, no git/gh**. It runs in ~1s and an
LLM (Claude) can author and run it while building a feature.

Prototype: [`test/e2e/lifecycle.e2e.test.ts`](../test/e2e/lifecycle.e2e.test.ts).

## What is real vs. faked

| Layer | In the harness |
| --- | --- |
| `PlanEngine`, `DeliverableExecutor`, `ExecutionAdapter` | **real** — the actual orchestration code |
| RPC (`MaestroRpcServer`/`MaestroRpcClient`, protocol v6) | **real** — a worker connects over a real unix socket |
| The completion + ship gate (`checkCompletionGate`, `workerMayComplete`, `deliverableGateSatisfied`) | **real** |
| tmux | **stub** (`stubTmux`) — records the spawn; sessions never "alive", so kill is a no-op |
| the worker `pi` process | **scripted** — a real `MaestroRpcClient` plays the agent side of the wire |
| git worktree / gh ship | **skipped** — the deliverable is pre-provisioned `active` with a `worktreePath`; see limitations |

The point: everything that could actually be *wrong in the orchestration* runs
for real. Only the process/OS boundaries are faked.

## The seams that make it possible

`ExecutionAdapterOpts` is built for injection (see
`packages/modes/src/exec/execution-adapter.ts`):

- `tmux?: TmuxApi` — swap in a stub/fake instead of real tmux.
- `socketPath?`, `token?` — fixed, test-owned RPC endpoint + auth.
- `resolveWorkerModel?` — deterministic model resolution (no gateway).
- `ctx: { cwd } as ExtensionContext` — a minimal cast is enough.
- `workspaceValidation?`, `restartKillTimeoutMs`, `restartPollMs`,
  `stopGraceMs` — inject git facts / shorten timers.

Pre-provisioning a deliverable as `active` with a `worktreePath` makes the
executor hydrate and spawn its worker **without** touching real git worktree
provisioning.

## Authoring a scenario

1. **Boot** (see the `beforeEach` in the prototype): `memStore()` →
   `PlanEngine.create` → `engine.addDeliverable` / `addWorkItem` →
   `setDeliverableStatus("...","active")` + `updateDeliverable(..., {worktreePath})`
   → `new ExecutionAdapter({... tmux, token, socketPath ...})` →
   `await adapter.start()` → `getExecutor().unblockDeliverable(id)` →
   `await adapter.tick()`.
2. **Connect a scripted worker** as `"<deliverableId>/worker"` over the real
   socket with the run token. Reflexively answer `ping` → `pong` and
   `summarize` → `summary` (the maestro's completion path waits for the
   summary).
3. **Drive the wire**: `status:working` → `planMutate toggleTask` for each task
   → `status:idle`. Toggling the last task only *arms* completion; the idle
   report is what triggers the real gate.
4. **Assert** against real adapter/engine state:
   - `adapter.isWorkerDone(id)` — the worker completed.
   - `engine.get().deliverables[0].tasks.every(t => t.done)` — plan mutated.
   - `adapter.deliverableGateSatisfied(id)` / `failingRequiredReviewers(id)` —
     the ship gate.
   - `adapter.snapshot()` — tokens, sessions, timings.

The prototype has two scenarios: the happy path (worker completes, gate
satisfied with no reviewers) and the gate hold (a required `plan-review`
assignment keeps the ship gate blocked even after every task is done).

## Running it

```bash
npm run test:e2e            # runs test/**/*.e2e.test.ts only
npx vitest run test/e2e/lifecycle.e2e.test.ts   # one file
```

E2E files use the `*.e2e.test.ts` suffix and are **excluded from the default
`vitest run`** (and thus from `npm run check`) so the unit suite stays fast;
`test:e2e` runs them explicitly. Add e2e coverage here whenever you change the
worker lifecycle, the RPC protocol, or the gate.

## Limitations / good next extensions

- **Ship-to-PR is not exercised.** `shipDeliverable` resolves to
  `shipper.ts`'s real git+gh path inside the adapter and is not injectable.
  Adding a `shipDeliverable?` override (or a `gh`/`git` seam) to
  `ExecutionAdapterOpts` would let the harness assert a deliverable reaching
  `shipped`. *(Tracked as a review finding.)*
- **Higher-fidelity out-of-process worker.** `test/fixtures/fake-tmux.ts` +
  `fake-agent.ts` can fork a scripted agent as a child process, exercising the
  adapter's real spawn-command building and session kill/crash paths. A
  scenario can pass `tmux: new FakeTmux(...)` and script agent behavior per
  deliverable instead of driving the client in-test.
- **Worker-side review.** In the intended model reviewers run worker-side via
  the `review()` tool and the worker owns its findings (there is no maestro hard
  gate on unresolved findings). The prototype drives the worker's task/idle wire
  but does not yet drive a `review()` round; a higher-fidelity scenario would
  script the worker running its panel and escalating a finding to the maestro.
  (The scenario tagged `[stale gate, to be removed]` characterizes the leftover
  `deliverableGateSatisfied` code and should be deleted with that gate.)
- **Crash/recovery, parallel deliverables, stacked dependencies** are all
  reachable with the same harness (crash the worker mid-work; add a second
  deliverable with `dependsOn`).
