# Authored plans

An authored plan describes repositories, deliverables, dependency edges,
implementation tasks, and delegated reviews. It is intent, not runtime state.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- implementation tasks;
- `after` dependencies that order work;
- `reads` dependencies whose outputs may be consulted;
- optional review tasks with `{lens, skill?, model?, tier?, diverse?}`;
- optionally `stages`: the shape of the run built for it.

`reads` must remain a subset of `after`. IDs are bounded workflow-safe slugs and
the graph must be acyclic.

A `reads` edge says one deliverable may consult another's output, not that its
code depends on it. The fan-out a run compiles has no per-item ordering to
express a code dependency, so a plan whose `reads` implies one is **refused by
name** rather than compiled with the edge silently dropped — a dropped ordering
edge is a run that looks correct and builds against a tree that does not exist
yet.

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

### Stages

`stages` is optional, per deliverable, and says what the run does with that
deliverable rather than what the work is. A deliverable without it gets the
default list below, so a plan written before stages existed stays valid and the
stored `schemaVersion` is unchanged.

| `use` | Fields | What it declares |
| --- | --- | --- |
| `implement` | `id`, `tools?` | the one implementation task |
| `verify-and-fix` | `id`, `maxRounds?` (`0`, `1`, `2`), `escalate?` (`thinking`, `none`) | a bounded fix/verify loop, never an open one |
| `review-fan-out` | `id`, `lenses`, `synthesis?` (`required`, `optional`, `none`) | independent reviewers over the same subject |
| `gate` | `id`, `question`, `show?` | a human decision inside the run |
| `dynamic` | `id`, `brief` | reserved; the compiler refuses it today |

Each `lenses[]` entry is `{id, tier?, diverse?, skill?, model?}` — the review
vocabulary above, written per stage instead of per task.

Validation reports every problem at once, as elsewhere:

- `id` is a bounded slug, unique within its deliverable, and becomes a workflow
  namespace, so it is part of run identity;
- `show` may only name sibling stage ids declared **earlier** in the same array;
- when `stages` is present there is exactly one `implement` stage, a
  `verify-and-fix` stage must follow it, and a `gate` must be last;
- no field may hold code, a filesystem path, or a model string that is not
  `provider/model`;
- a lens `id` is a bounded slug, at most 16 per stage, and duplicates are
  disambiguated `-2`, `-3` by declaration order — never by a counter over
  runtime data, which would make the same plan compile differently twice;
- `dynamic` fails with "dynamic stages are not compiled yet".

The default list, for a deliverable that declares no `stages`, is derived from
the policy below:

```jsonc
[ { "use": "implement",      "id": "implement" },
  { "use": "verify-and-fix", "id": "verify", "maxRounds": <policy.maxFixRounds> },
  { "use": "review-fan-out", "id": "review",
    "lenses": [ /* one per task with `by`, tier/diverse from it or policy.reviewDefault */ ],
    "synthesis": "optional" } ]
```

### Policy

`policy` is optional and plan-wide. It is on the document, not only in the
dialogs that collected it, so a reviewer can see where a run is going and the
plan digest covers it.

| Field | Values | Default |
| --- | --- | --- |
| `effort` | `cheap`, `standard`, `deep` | `standard` |
| `gates` | `approve-plan`, `approve-plan+ship`, `every-deliverable` | `approve-plan+ship` |
| `reviewDefault` | `{tier?, diverse?}` | `{tier: "standard", diverse: false}` |
| `maxFixRounds` | `0`, `1`, `2` | `0` cheap, `1` standard, `2` deep |
| `publish` | `{mode: "none"\|"branch"\|"pr", base?}` | `{mode: "none"}` |

`publish` says what happens to the run's result, and publication is pi-maestro's
own audited Bash work — the workflow runtime never pushes, merges, or publishes.
`publish.base` must be a valid ref name. `mode: "pr"` needs `gh` on PATH, which
is a readiness question asked against the real machine before a run starts, not
a validation question asked of the document.

### Example

```jsonc
{
  "slug": "compose-catalogue", "title": "Component catalogue",
  "repos": [{ "key": "wf", "path": "/Users/vegardx/src/github.com/vegardx/pi-workflow" }],
  "policy": { "effort": "standard", "gates": "approve-plan+ship",
              "maxFixRounds": 1, "publish": { "mode": "pr", "base": "main" } },
  "deliverables": [{
    "id": "catalogue", "title": "Ship the component catalogue",
    "after": [], "reads": [],
    "tasks": [{ "id": "impl", "title": "Write src/components/*.ts" },
              { "id": "rev-contracts", "title": "Contract review", "by": { "lens": "contracts", "tier": "heavy", "diverse": true } }],
    "stages": [
      { "use": "implement", "id": "build" },
      { "use": "verify-and-fix", "id": "green", "maxRounds": 2, "escalate": "thinking" },
      { "use": "review-fan-out", "id": "review", "synthesis": "required",
        "lenses": [ { "id": "contracts", "tier": "heavy", "diverse": true },
                    { "id": "replay", "tier": "standard" } ] }
    ]
  }]
}
```

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

## Readiness

Validation asks whether the document is coherent. **Readiness** asks whether the
machine it names is there, and it is asked once, after the plan stores and
before a run is offered. Per repository: the path exists, it is a working-tree
root rather than some directory inside one, the tree is clean, and the base
branch `policy.publish.base` names resolves there (`git rev-parse --verify`).
Once per host: `gh` is on PATH, and only when `policy.publish.mode` is `pr` —
`branch` and `none` publish without it. Every problem is reported at once, as
everywhere else, except that a repository whose path is missing or is not a root
is reported once and asked nothing further: whether it is clean has no meaning
yet.

None of those answers belongs in the plan. The same document is ready on one
machine and not on another, so readiness is a fact about a host at a moment and
is never stored, digested or approved. Nothing here refuses, either: a dirty
tree is reported and the caller decides — continue, knowing every worktree
branches from HEAD, or go back to the conversation. The step is named readiness
in this repository and nowhere is it given the neighbouring name that
`@vegardx/pi-subagent` uses for its own launch-plan compile; [usage](usage.md)
draws that boundary, and the docs gate enforces it.

A missing repository can be created rather than corrected by hand, and that is
the one thing readiness does to the world. It happens only with the caller's
confirmation, and every command goes through the seat's audited Bash tool, so
the classifier and the session mode's confirmation policy apply exactly as they
do to anything else the seat runs — there is no exempt category here:

```text
git init <path>
git -C <path> commit --allow-empty -m "Initial commit"
gh repo create <name> --private --source <path> --remote origin   # mode ≠ none
```

The empty initial commit is not ceremony: every worktree a run creates branches
from a HEAD, and a repository with no commits has none. `gh repo create
--source` wires the remote itself, which is why `origin` is named there rather
than added by a second command against a URL nothing has printed yet. The first
command that fails stops the rest.

## The hand-off to a run

The `plan` tool validates and stores the complete document. Storage is not
execution: pi-maestro does not compile or resume a plan, and a stored plan is
intent until a workflow run is given it.

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

### Publishing what a run produced

**Design. It lands with this release line; there is no publication verb yet.**

A run ends at a receipt: per deliverable a handoff commit in the publication
repository's own object store, its sha256 and size, and the digest of the plan
the run was given. Publication turns that receipt into a branch and, when the
policy asked for one, a pull request — refusing outright when the receipt's
digest is not the stored plan's, because then it names bytes nobody approved.
Every step runs through the seat's audited Bash classifier under the session
mode's policy, the repository's own check runs **on the host** rather than in a
guest, and any failure stops **before** the push with the branch left in place.

The owned `@vegardx/pi-workflow` project owns everything between the input and
that receipt: runtime graph compilation, repository and worktree authority,
implementation and review stages, artifacts and structured findings, failure,
retry, resume and recovery. This package's responsibility ends at a validated
document and the run request built from it, and resumes at the publication of
the receipt that comes back.
