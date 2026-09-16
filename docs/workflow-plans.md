# Authored plans

An authored plan describes repositories, deliverables, dependency edges,
implementation tasks, and delegated reviews. It is intent, not runtime state.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- implementation tasks;
- `after` dependencies that order work;
- `reads` dependencies whose outputs may be consulted;
- optional review tasks with `{lens, skill?, model?, tier?, diverse?}`.

`reads` must remain a subset of `after`. IDs are bounded workflow-safe slugs and
the graph must be acyclic.

### Review intent

A review task says which independent point of view to apply, and how much
reviewer it is worth. All three routing fields are optional:

- `model` — an exact `provider/model` ID, validated only when present. Pinning
  one makes the plan run on hosts that have that model and nowhere else.
- `tier` — `light`, `standard`, or `heavy`: how much reviewer the lens is
  worth, for the host to resolve.
- `diverse` — ask for a reviewer from a different model family than the
  implementer.

A review that names neither a `model` nor a `tier` is legal; the running
workflow's effort dial then decides what the reviewer is.

### Repository paths

Each `repo.path` is validated against the filesystem: it must be an existing
Git working-tree root, so `git rev-parse --show-toplevel` run there resolves to
the path itself. A path inside a repository but below its root is refused and
the error names the real root, because the run creates worktrees from this path
and would otherwise disagree with itself about which tree it is working in.

An uncommitted change in that tree is a warning, never a refusal: authoring a
plan while the tree has edits in it is the normal case. The warning is worth
recording because every worktree a run creates branches from HEAD, so those
edits are not in the run.

## The hand-off to a run

The `plan` tool validates and stores the complete document. Storage is not
execution: pi-maestro does not compile, resume, or publish a plan, and a stored
plan is intent until a workflow run is given it.

```text
conversation
  → plan tool
  → validation
  → <agentDir>/maestro/plans/<slug>/plan.json
  → toWorkflowInput(plan, effort)
  → workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }
```

**By value, with a digest.** `toWorkflowInput(plan, effort)` returns
`{plan, planDigest, effort}`: the whole authored document, the sha256 of its
canonical JSON (keys sorted, no whitespace), and one of `cheap`, `standard`
(the default) or `deep`. The plan travels by value because a workflow run
validates its input against the definition's schema and binds the run's
identity to it — a run given a slug could have the document change underneath
it on resume, and would then be executing something nobody approved. The digest
names exactly which bytes were approved, so a receipt can be checked against
them afterwards.

**One approval record, and it is not here.** The run's `approve-plan`
checkpoint is the approval: immutable, binding-addressed, and stored with the
run's decisions. A plan document therefore has no `approved` field, no approver
and no approval timestamp — a second record of the same fact is a record that
can disagree with the first, and the one a human answered is the one that
counts.

### Running a plan

`/plan run <slug> [cheap|standard|deep]` is the seat's way to start one, and it
starts nothing itself. It loads the stored document, builds
`toWorkflowInput(plan, effort)`, writes that input to
`<agentDir>/maestro/plans/<slug>/workflow-input.json`, and hands the session the
call to make: `workflow_run { ref: "plan-to-ship", input: … }`. pi-maestro has
no workflow runtime and no dependency on one, so the run happens where every
other tool call happens — in the open, in the transcript, where it can be seen
before it is made.

The command cannot approve anything either. The run parks at its `approve-plan`
checkpoint until a human decides it, which is why `/plan run` is safe to offer
at the end of a plan write: the next gate is a person, not the model.

`/plan list` and `/plan show <slug>` read the same store, and `/plan rm <slug>`
removes a plan after a confirmation (refused outright when the session has no UI
to confirm with). See the [command reference](commands.md).

The owned `@vegardx/pi-workflow` project owns everything downstream of that
input: runtime graph compilation, repository and worktree authority,
implementation and review stages, artifacts and structured findings, failure,
retry, resume and recovery, and publication receipts. This package's
responsibility ends at a validated document and the input built from it.
