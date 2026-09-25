# Architecture

Pi-maestro is the interactive composition layer of the Pi distribution. One Pi
process is the seat.

**The session is the control surface; the run executes in the background; the
session narrates it; the mode bounds every delegation.** That is the whole shape.
The seat owns what a person decides and what a person is told; it owns no
executor.

```text
interactive seat                        standalone runtimes
  mode posture ─── ceiling ─────────────▶  @vegardx/pi-subagent
  plan authoring/store                      sandboxed attempts, worktrees,
  the hand-off  ─── provider ────────┐      handoff commits, operator UX
  the plan check ─── subagent ───────┼──▶       ▲
  run narration ─── observe ─────────┤          │ launches
  publication (audited bash, gh)     └──▶  @vegardx/pi-workflow
  classified host bash                      durable runs, checkpoints,
  recoverable delete                        compilation, recovery, receipts
  prompt assistance
  smart compaction                        owned web extension
  structured questions                      deferred
  curated skills
```

There is no custom worker socket, executor, workflow scheduler, question
transport, web stack, or recovery layer in pi-maestro. Publication is not a
pipeline either: it is a bounded sequence of audited Bash commands over a
receipt a run already produced, decided by a human — `/plan ship <slug>`, ten
steps, each of which stops before the push.

## Ownership

| Concern | Owner |
| --- | --- |
| Interactive mode posture | pi-maestro |
| Plan vocabulary, validation, and storage | pi-maestro |
| The hand-off out of plan mode, and its two dialogs | pi-maestro |
| The plan check, as a one-shot subagent it launches | pi-maestro |
| Narrating a started run into the conversation | pi-maestro |
| The delegation ceiling every launch is bounded by | pi-maestro |
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

`workflow-provider.ts` is discovery, compatibility and error mapping, and the
hand-off is its caller: it starts the plan's own run through the seam once a
person has answered the one confirmation, and the narrator observes that run
through the same client. `/plan run` remains the other route to a run, and the
only one on a seat with no runtime installed.

pi-workflow registers a workflow service provider on Pi's event bus, and
pi-maestro acquires it lazily through `packages/maestro/src/workflow-provider.ts`.
The dependency is an **optional** peer: a seat without `@vegardx/pi-workflow`
installed keeps working, and the hand-off simply omits the branches that need a
runtime, falling back to the stored plan and `/plan run`. A provider whose
declared runtime contract does not match the features this seat needs fails
discovery loudly rather than being mis-called.

The client is read-only — list, validate, project a budget, inspect a run,
observe its appends — with one narrow exception: `startBuiltin` starts the one
definition the *runtime* allowlists for a service consumer, `plan-to-ship`, with
the mode's ceiling, once a person has said yes in a dialog this seat owns. There
is no `runBuiltin` any more: the headless reviewer it existed for is now a
one-shot subagent, which needs no workflow run at all.

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
contract revision and the eight feature keys the seat depends on — because it
cannot import pi-workflow's own constant. `test/fixtures/pi-workflow-runtime-contract.json`
is a copy of that constant taken from pi-workflow's built `dist`, and
`test/workflow-provider.test.ts` asserts the literal's revision and every
required key equal it. **The fixture is refreshed by hand**, by regenerating it
from the installed pi-workflow and updating the literal, whenever pi-workflow's
`contractRevision` changes; nothing generates it at build time, because there is
no dependency to generate it from.

Every failure at this seam — no runtime, two runtimes, a revision mismatch, a
replaced provider, a refusal from the runtime, a failed acquisition — becomes one
warning naming what to do instead: `/plan run <slug>`, because the run is the one
thing a failure here costs. None of them throws into the session.

## The subagent seam

`@vegardx/pi-subagent` is an **exact peer pin**, not an optional one, and
`subagent-provider.ts` is the one file that touches it. Two things go through it:

- **The plan check** is one delegated attempt — compiled, launched, awaited, and
  answered with structured output — of the `plan-reviewer` definition shipped in
  `packages/maestro/agents/` and passed as `agentRoots`, so the reader a check
  runs is the one shipped beside the code that names it. `contextMode: "fresh"`,
  `contextScopes: []` and read-only tools are what make it blind; there is no
  workflow run, no journal and no budget lease, because a document that is read
  once and answered needs none of that.
- **The delegation ceiling** is registered once, for the process, through
  pi-subagent's own `registerDelegationCeilingProvider`. pi-subagent consults it
  for its own `subagent` tool and pi-workflow consults it for `workflow_run`, so
  the mode bounds every delegated launch without either of them knowing what a
  pi-maestro mode is.

The types pi-subagent does not export — the launch request, the service and the
client — are declared locally, narrowed to what this seat builds and calls, and
its two functions are re-typed once against this package's own copy of
pi-coding-agent. Every failure becomes one sanitized sentence: a plan check that
could block a hand-off by being broken would be a worse check than none.

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

A `git` subcommand is classified by what it does, and the workspace boundary is
drawn by whichever path the command names: `git -C <path> commit` and
`git init <path>` are both `host-write` when that path leaves the workspace and
`workspace-write` inside it. `git remote add`, `remove`, `rename` and `set-url`
rewrite the repository's configured remotes and are workspace writes; bare
`git remote`, `git remote -v`, `show` and `get-url` are reads.

The classifier is guidance and a refusal rail, not a sandbox claim. Built-in
`write` and `edit` are host-backed in auto and hack. The user selects those modes
when direct seat work is preferable to isolated delegation.

Most implementation work is expected to run through standalone subagents, which
own Gondolin isolation, worktrees, retry/resume, persistence, and operator
controls.

**The mode's ceiling is how a posture reaches those launches.** `modeCeiling`
maps `plan` to a read-only workspace, `auto` to read-only or a worktree, and
`hack` to no bound, in pi-subagent's own vocabulary — no mode name leaves this
package. It is asked at launch time rather than captured at registration, so a
mode change under a running session bounds the next launch. A start whose
definition needs more than the ceiling allows is refused by the runtime that
performs it, naming both, which is why the seat no longer withholds any workflow
tool from the model by name — see [Modes](commands.md#modes).

## Plans

The plan lives in the conversation. The hand-off asks the session's own model to
form it into a document — directly, outside Pi's agent loop, with no tools offered
— validates it, and stores repository-qualified authored intent:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
```

The root is keyed by project — the cwd encoded the way Pi encodes its sessions
directory — so a project's sessions, plans and workflow runs are siblings, and
one project's `/plan list` never shows another's. The envelope records
`authoredBy: {sessionId, cwd}`.

A plan contains repositories, deliverables, ordering, read dependencies, the
tasks that are the work, and the reviews that read that work when it is done.
It also carries the policy the run follows — effort, gates, publication — which
the harness attaches from the decisions a human made on the way out of plan
mode, never the model; the schema has no field for any of it. Writing a plan is
not a tool call, so there is no plan-authoring tool in any posture. How each
deliverable is run is derived from those three things, by pi-workflow, and is not
written down — this seat no longer compiles a stage document or mirrors the schema
that validated one.

Pi-maestro validates and stores this vocabulary but does not execute it. The
hand-off and `/plan run <slug>` both build the workflow input and start
`plan-to-ship` themselves, through the workflow runtime's service seam —
`startBuiltin("plan-to-ship", {input, effort, ceiling})`, which the runtime
allowlists to that one definition, validates as `workflow_run` would, and refuses
when the definition needs more than the ceiling allows. The run is started by the
harness after the person says yes, and then the session narrates it.
`@vegardx/pi-workflow` owns the runtime lowering and state model. See
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
