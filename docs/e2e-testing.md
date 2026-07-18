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

## The three tiers

Pick the lowest tier that can catch the bug you care about:

| Tier | Command | What's real | Determinism | Speed |
| --- | --- | --- | --- | --- |
| **1 · unit** | `npm test` | pure logic | full | ms |
| **2 · hermetic e2e** | `npm run test:e2e` | engine + adapter + RPC; fakes for tmux/pi/git | full | ~1s |
| **3 · full-stack driver** | `npm run test:e2e:full` (scripted) or the `drive-maestro-e2e` skill (you drive) | **everything** — real `pi --mode rpc`, real workers, real ship | scripted+mock, or real | minutes |

Tiers 1–2 are covered above and below. Tier 3 — the *externally-driven*
full-stack test — is described in [Full-stack driver](#full-stack-driver-tier-3).

## What is real vs. faked

| Layer | In the harness |
| --- | --- |
| `PlanEngine`, `DeliverableExecutor`, `ExecutionAdapter` | **real** — the actual orchestration code |
| RPC (`MaestroRpcServer`/`MaestroRpcClient`, protocol v6) | **real** — a worker connects over a real unix socket |
| The completion gate (`checkCompletionGate`, `workerMayComplete`) | **real** |
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
  (The maestro-side ship gate has been removed — a `complete` deliverable ships;
  the worker owns its findings.)
- **Crash/recovery, parallel deliverables, stacked dependencies** are all
  reachable with the same harness (crash the worker mid-work; add a second
  deliverable with `dependsOn`).

## Full-stack driver (tier 3)

The hermetic harness fakes the process/OS boundaries. The **full-stack driver**
fakes *nothing in the harness*: it boots a real `pi --mode rpc` with the entire
maestro extension stack and drives it from **outside**, exactly the way an IDE or
another agent would. This is possible because pi already exposes a complete
control surface — `--mode rpc` (JSONL commands + a streamed event feed) plus the
`extension_ui_request`/`extension_ui_response` dialog sub-protocol, which lets the
driver **answer every question** the maestro raises (the plan→execution gate,
confirms, worker questions escalated via `CAPABILITIES.ask`). So there is no
internal `/test` command — the system under test stays 100% real and unmodified.

All of it lives in [`test/e2e/driver/`](../test/e2e/driver/) and is shared by two
drivers that differ only in *who decides the prompts and answers*:

- **RpcClient** (`driver/rpc-client.ts`) — the driver side of the wire: strict
  JSONL framing, id-correlated commands, and `extension_ui_request` routing to an
  **Answerer**.
- **Answerer** (`driver/answerer.ts`) — `ScriptedAnswerer` (deterministic rules,
  for CI) or `ForwardingAnswerer` (parks questions for a live agent).
- **launch / scenario / env-profile / assertions** — boot the SUT (`-ne` +
  explicit maestro `-e`, under an isolated pi HOME), the canned `sandbox-features`
  plan, the Live/CI environment, and white-box outcome checks (plan.json statuses
  + git history — never the transcript).

### LLM-driver — you drive it (real models)

A control CLI + background daemon let a coding agent (Claude, or another pi) drive
the harness. Invoke the **`drive-maestro-e2e`** skill
([`.agents/skills/drive-maestro-e2e/`](../.agents/skills/drive-maestro-e2e/)), or
drive it directly:

```bash
# start the daemon in the background; it prints a `ready` line + the plan prompt
node_modules/.bin/jiti test/e2e/driver/cli.ts start --live      # real models + disposable GitHub repo
#   ...or --live --local-remote (no GitHub), or --ci (mock provider)
node_modules/.bin/jiti test/e2e/driver/cli.ts prompt "/plan"
node_modules/.bin/jiti test/e2e/driver/cli.ts prompt "<the plan prompt>"
node_modules/.bin/jiti test/e2e/driver/cli.ts prompt "/start"
node_modules/.bin/jiti test/e2e/driver/cli.ts poll     # new events + parked questions
node_modules/.bin/jiti test/e2e/driver/cli.ts answer <id> "<value>"   # repeat until shipped
node_modules/.bin/jiti test/e2e/driver/cli.ts assert
node_modules/.bin/jiti test/e2e/driver/cli.ts stop     # tears down the sandbox + disposable repo
```

Because the driver is itself an agent, answering the maestro's mid-run questions
is just the driver doing its job — the reason MCP is *not* the right tool here
(MCP feeds tools *into* an agent; it is not a control plane *over* one).

### Scripted driver — CI (deterministic, offline)

`npm run test:e2e:full` runs [`test/e2e/real.e2e.test.ts`](../test/e2e/real.e2e.test.ts):
the same core, but a fixed prompt sequence + `ScriptedAnswerer`, in the **CI
profile** — a mock model provider, a local bare git remote, and a `gh` shim, all
reaching the workers via `PI_MAESTRO_TRANSPORT=headless` (headless spawns workers
as child processes that inherit the env, so no tmux is needed). Deterministic and
free; runs on every PR via [`.github/workflows/e2e-full.yml`](../.github/workflows/e2e-full.yml).

The mock provider replays a **cassette** (`driver/ci/cassette-server.ts`, a
VCR-style record/replay proxy keyed on the request body). The test **self-skips**
until a cassette is recorded, so CI stays green out of the box.

**One-time recording** (needs a real API key; the recorded run must complete):

```bash
PI_E2E_FULL=1 PI_E2E_RECORD=1 ANTHROPIC_API_KEY=… npm run test:e2e:full
```

This proxies model calls to the real upstream and saves each request→response
under `driver/ci/cassettes/`; commit those fixtures. Any prompt change that alters
a request body invalidates the affected entry — re-record the same way. (Getting
*every* worker role to resolve to the cassette-backed provider is the remaining
wiring to make the first recording complete end to end; see the CI profile in
`driver/env-profile.ts`.)

### Rule

Never edit the harness — or weaken an assertion — to make a full-stack run pass.
The whole point is to run the real code unmodified and learn whether it works. A
failure is a finding about the harness, not about the test.
