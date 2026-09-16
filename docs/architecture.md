# Architecture

Pi-maestro is the interactive composition layer of the Pi distribution. One Pi
process is the seat. It owns planning and posture, not delegated execution.

```text
interactive seat                        standalone runtimes
  mode posture                            @vegardx/pi-workflow
  plan authoring/store                      durable runs, checkpoints,
  plan-mode exit loop  ── provider ──▶      compilation, recovery, receipts
  readiness (audited bash)                        │
  publication (audited bash, gh)                  ▼
  classified host bash                    @vegardx/pi-subagent
  recoverable delete                        sandboxed attempts, worktrees,
  prompt assistance                         handoff commits, operator UX
  smart compaction
  structured questions                    owned web extension
  curated skills                            deferred
```

There is no custom worker socket, executor, workflow scheduler, question
transport, web stack, or recovery layer in pi-maestro. Publication is not a
pipeline either: it is a bounded sequence of audited Bash commands over a
receipt a run already produced, decided by a human, and it lands with this
release line — today the seat stops at the run request.

## Ownership

| Concern | Owner |
| --- | --- |
| Interactive mode posture | pi-maestro |
| Plan vocabulary, validation, and storage | pi-maestro |
| The plan-mode exit loop and its dialogs | pi-maestro |
| Readiness of the repositories a plan names | pi-maestro |
| Publication of a run's receipt (audited Bash, human-decided) | pi-maestro |
| Direct seat bash classification | pi-maestro |
| Recoverable delete | pi-maestro |
| Delegated model execution in a sandbox | standalone `@vegardx/pi-subagent` |
| Workflow runs, scheduling, and receipts | standalone `@vegardx/pi-workflow` |
| Web research tools | unavailable until the owned web extension |
| Structured model-authored questions | `@juicesharp/rpiv-ask-user-question` |
| Prompt assistance and compaction | local pi-maestro extensions |

The split is an authority split, not a layering preference. pi-workflow's own
`docs/authority.md` states that the runtime never pushes, merges, or publishes;
pi-maestro does, under its own classified Bash policy and a durable human
decision, which is why publication sits on this side of the table and scheduling
does not.

## The workflow provider seam

**The client lands with this release line; the exit loop that calls it does
not yet.** `workflow-provider.ts` is discovery, compatibility and error
mapping — a seam with tests and no caller until the plan-mode exit loop is
built. Until then, `/plan run` is the only route to a run.

pi-workflow registers a workflow service provider on Pi's event bus, and
pi-maestro acquires it lazily through `packages/maestro/src/workflow-provider.ts`.
The dependency is an **optional** peer: a seat without `@vegardx/pi-workflow`
installed keeps working, and the exit loop simply omits the branches that need a
runtime, falling back to the stored plan and `/plan run`. A provider whose
declared runtime contract does not match the features this seat needs fails
discovery loudly rather than being mis-called.

The client is read-only — list, validate, project a budget, inspect a run,
observe run status — with one narrow exception: it may start a headless builtin
from an allowlist the *runtime* owns, which is how a plan review can be blind to
the planning conversation. An allowlisted definition declares no checkpoint, no
worktree, and no handoff, so it can neither ask for a decision nor write. Every
run that writes stays a model tool call in the transcript.

**Nothing crosses the import boundary.** pi-workflow is not published on npm, so
this package imports nothing from it — not a value, not a type. The discovery
channel, the request schema, the read client's method signatures and the runtime
contract are all declared on this side, in `workflow-provider.ts` and
`workflow-contract.ts`, and those declarations *are* pi-maestro's half of the
contract. Discovery makes three checks before any call: the provider offers an
`acquire` function, its contract validates against a local TypeBox mirror of
pi-workflow's contract schema, and every feature key this seat requires equals
the provider's. The provider is then discovered a second time after `acquire`,
so a runtime swapped mid-acquisition is refused rather than used.

**The duplicated contract is pinned by a fixture.**
`workflow-contract.ts` carries a frozen `REQUIRED_WORKFLOW_CONTRACT` — one
contract revision and the seven feature keys the seat depends on — because it
cannot import pi-workflow's own constant. `test/fixtures/pi-workflow-runtime-contract.json`
is a copy of that constant taken from pi-workflow's built `dist`, and
`test/workflow-provider.test.ts` asserts the literal's revision and every
required key equal it. **The fixture is refreshed by hand**, by regenerating it
from the installed pi-workflow and updating the literal, whenever pi-workflow's
`contractRevision` changes; nothing generates it at build time, because there is
no dependency to generate it from.

Every failure at this seam — no runtime, two runtimes, a revision mismatch, a
replaced provider, a refusal from the runtime, a failed acquisition — becomes one
warning naming what to do instead (`/plan run`, or *Approve as is* when only the
blind reviewer is out of reach). None of them throws into the session.

## Seat authority

The seat supports three explicit postures:

- **plan** — direct `write`, `edit`, and `delete` calls are blocked. Bash allows
  recognized reads, refuses recognized mutations and code execution, and audits
  unresolved commands with a bounded fast model.
- **auto** — direct host tools are available. Ordinary workspace writes and code
  execution are allowed by default; host, remote, privileged, destructive, or
  unresolved effects are confirmed.
- **hack** — direct host tools are available with reduced steering. Ordinary
  effects are allowed by default while privileged and destructive effects remain
  configurable confirmations.

Bash processing is `parse → deterministic effects → optional ambiguity audit →
mode policy → allow/confirm/refuse`. Effects describe filesystem, workspace,
host, remote, code-execution, privileged, and destructive behavior. The auditor
never authorizes execution and cannot remove deterministic effects. For an
unknown PATH executable it may iteratively request validated direct-argv help or
version probes under the one overall audit timeout. There are no execution
routes or sandbox backends.

The classifier is guidance and a refusal rail, not a sandbox claim. Built-in
`write` and `edit` are host-backed in auto and hack. The user selects those modes
when direct seat work is preferable to isolated delegation.

Most implementation work is expected to run through standalone subagents, which
own Gondolin isolation, worktrees, retry/resume, persistence, and operator
controls. A workflow run is safe to start from any mode for the same reason: the
attempt it delegates cannot touch the seat's working tree or the host.

## Plans

The `plan` tool stores repository-qualified authored intent:

```text
<agentDir>/maestro/plans/<slug>/plan.json
```

A plan contains repositories, deliverables, ordering, read dependencies, tasks,
delegated review intent, and optionally the stages each deliverable is built from
and the policy the run should follow. Pi-maestro validates and stores this
vocabulary but does not execute it. `/plan run <slug>` builds the workflow input
and hands the session the `workflow_run { ref: "plan-to-ship", input }` call to
make; `@vegardx/pi-workflow` owns the runtime lowering and state model. See
[Authored plans](workflow-plans.md).

## Extension loading

The root package loads:

- structured ask adapter;
- prompt-assist;
- smart-compact;
- the Maestro seat extension;
- bundled skills through normal Pi discovery.

Subagent, workflow, and web extensions are not bundled. This prevents duplicate
runtime ownership and lets each standalone package carry its own release and
acceptance boundary. The operating skills for those runtimes ship with the
packages that own the tools they describe — `workflows` in
`@vegardx/pi-workflow` and `subagents` in `@vegardx/pi-subagent` — so a skill
cannot describe a revision other than the one installed; pi-maestro bundles only
skills for surfaces it owns or for tools outside this stack.
