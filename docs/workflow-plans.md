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

## Leaving plan mode

Plan mode is a conversation. It does not hold the `plan` tool, so the document
is written on the way out — and a dialog sequence cannot obtain a plan from a
conversation, because no model turn happens inside one. The exit is therefore
split by exactly one model turn: the first half asks what only a human knows,
the model turn writes the plan, and the second half compiles, reviews and
launches it.

**The dialogs.** `/mode auto` or `/mode hack` from plan mode asks six questions
before the posture moves: what to do with the conversation, effort, gates,
publication, a base branch when anything publishes, and one line saying what the
plan is for. The [command reference](commands.md#leaving-plan-mode) lists them
with their defaults. They are the questions a human answers and a document
cannot, so nothing the plan itself will say is asked here.

**The hand-over.** On *Compile it into a workflow run* the posture switches, the
answers are written to `<agentDir>/maestro/plans/.pending/<sessionId>.json`, and
the model is asked — as an ordinary follow-up message, in the transcript — to
call `plan` with the whole document and with those answers copied in verbatim as
the `policy` block described above. Verbatim because they are decisions a human
already made: a model that re-derives them produces a policy nobody chose, and
the digest would then cover a document that disagrees with the dialogs that
produced it. The same message asks for a `stages` array on any deliverable the
conversation implied more than the default list for.

*Just switch mode* switches and records nothing. *Keep planning*, and escape,
leave the posture where it was and record nothing. A session replacement ends
the flow and drops the record: an exit nobody is answering is not an exit in
progress.

**What the record is for.** It is the only thing that survives the model turn,
so it holds only what the turn cannot reproduce: the policy, the one line, and
which session asked. While it exists the `plan` tool is held even in plan mode,
and that window is the whole reason it is on disk rather than in memory. The
record is deleted on every path out of the second half, so the window is only
ever open across the one turn it exists for.

**The second half.** The `plan` tool's own result is the trigger: a stored
document, plus a record naming *this* session. The session id is read from that
tool result rather than from whichever session answered the dialogs, so a plan
written in a session that replaced the one that asked is not read as the
continuation of its exit.

What happens then, in order, with the dialogs listed in the
[command reference](commands.md#after-the-plan-is-written):

1. **Readiness.** The repositories the plan names are probed (above). A missing
   one can be created, with a confirmation, through the seat's own audited
   `bash`; a dirty one is reported and you decide whether every worktree
   branching from HEAD is acceptable. Everything else readiness finds is
   reported at once as a warning — it is a fact about this host, and publication
   will meet it again.
2. **Review lenses**, per deliverable. The candidates are seeded from the
   deliverable's own review intent — its `review-fan-out` lenses, or the ones
   `tasks[].by` implies — so escaping the dialogs keeps exactly the plan that
   was stored, and the stored document is not rewritten at all. A deliverable
   that named no reviewer is offered a standard set instead. A lens the plan
   pinned neither a tier nor a model for is then asked what it is worth, and a
   deliverable that ends up with a `heavy` lens is asked whether it wants a
   reviewer from another model family.
3. **The compiled stage document.** pi-maestro derives it here, from the same
   §2.1 rules `plan-to-ship` compiles from: the default stage list from the
   policy, lenses seeded from `tasks[].by`, duplicate lens ids suffixed `-2` and
   `-3` by declaration ordinal, and `maxRounds` mapped from the plan's fix
   rounds to the component's verify rounds (`fix + 1`, so a fix is never left
   unchecked). It is validated against a local mirror of the runtime's own
   closed schema, so a disagreement between the two readings fails here rather
   than inside a dialog sequence. The runtime then validates the run input and
   projects its budget, and both are shown.
4. **Check it.** *Review it blind* starts the headless `plan-review` through the
   workflow provider — without a model turn, which is what keeps it blind:
   a review reached through the model would have read the planning conversation.
   *Approve as is* skips it. *Edit* opens the compiled document as JSON;
   an edit is validated against the same mirror and written back into the
   plan's `stages`, and escape discards it.
5. **The findings walk.** Every **blocking** finding is asked, one at a time:
   accept it, dismiss it with a reason, or go back to the conversation.
   Accepting applies the finding's RFC 6902 `patch` to the stored plan, runs the
   plan's own validation over the result and saves it — a mechanical apply, never
   a re-prompt. A patch that will not apply is reported and the finding is asked
   again without the accept option. `major` and `minor` findings are printed
   once and never asked about. After at least one accept the plan is recompiled
   and reviewed once more; a second blocking review ends the loop and leaves you
   in the conversation with the findings printed.
6. **The run.** `Start the run?` is the last question. *No* leaves the plan
   stored and starts nothing. *Yes* deletes the record and asks the model — as
   an ordinary follow-up message, in the transcript — to make the
   `workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }`
   call itself. The run is still made in the open, and it still parks at its
   `approve-plan` checkpoint.

**When the runtime is not there.** `@vegardx/pi-workflow` is an optional peer.
Without it — or when it refuses to validate or project — the flow stops at the
compile step with one warning, and the plan is stored with `/plan run <slug>`
still available. When only the blind reviewer is unreachable (a refusal, a
timeout, a verdict this seat cannot read) the warning names `Approve as is` and
the same dialog is asked again without the review option. Neither throws into
the session.

**Nothing here writes outside those places.** The only run this half starts is
`plan-review`, which declares no checkpoint, no worktree and no handoff. The
only shell commands are the repository creation above, through the audited
`bash` tool under the session mode's own confirmation policy. Everything that
writes to a repository is still the model's `workflow_run` call.

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
canonical JSON (keys sorted, no whitespace), and one of `cheap`, `standard` or
`deep`. An effort nobody named is the plan's own `policy.effort` — a decision a
human made on the way out of plan mode, which the digest covers — and
`standard` only when the document sets none. The plan travels by value because a workflow run
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

A run ends at a receipt: per deliverable a handoff commit in the publication
repository's own object store, its sha256 and size, and the digest of the plan
the run was given. `/plan ship <slug>` turns that receipt into a branch and,
when the policy asked for one, a pull request — refusing outright when the
receipt's digest is not the stored plan's, because then it names bytes nobody
approved. Every command runs through the seat's audited Bash tool under the
session mode's policy, so `host-write`, `remote-read`, `code-execution` and
`remote-write` are each classified and, in `auto`, confirmed; the repository's
own check runs **on the host** rather than in a guest; and any failure stops
**before** the push with the branch left in place.

The ten steps, in order, and where each one stops:

| # | Step | Stops when |
| --- | --- | --- |
| 1 | `inspect(runId, {include: ["run","tasks","output"]})` — the receipt, read from the run's committed `run.output.receipt` | the run cannot be inspected, or it carries no plan digest or no handoff |
| 2 | The receipt's digest against `planDigest(stored plan)` | they differ — reported as an error, and **nothing has run yet** |
| 3 | Resolve each `refs/pi-subagent/handoffs/<run>/<attempt>`, fetching from the run's `cwd` first when it is another repository | a ref does not resolve in the publication repository |
| 4 | `git switch -c pi-maestro/<slug>/<yyyymmdd-hhmm> <policy.publish.base>` | the base does not resolve, or the branch exists |
| 5 | `git cherry-pick <handoffCommit>` per deliverable, in plan order | a conflict — the pick is aborted, the branch is left, the deliverable is named, and nothing is recorded |
| 6 | The repository's own check on the host — the gate named in `AGENTS.md`, else `npm ci && npm run check` or `npm ci && npm test` from the manifest | it exits non-zero (the tail is shown), or the repository names no check at all |
| 7 | One confirmation, naming the branch, the commits and the check result | it is declined — the branch stays, nothing is pushed |
| 8 | `git push -u origin <branch>` | the push fails |
| 9 | `gh pr create --base <base> --title <plan title> --body <receipt>`, when the policy says `pr` | `gh` fails. `gh` **absent** is not a failure: the publication degrades to `branch` with a warning, before anything is created |
| 10 | Append the receipt to `<agentDir>/maestro/plans/<slug>/publication.json` | the file exists and is not an array of receipts — it is never overwritten |

One more thing is checked between steps 1 and 2 when the publication was
triggered by an announcement rather than by `/plan ship`: the run's own `ship`
checkpoint must carry a decided `{"ship": true}`, read from
`tasks[].checkpoint.decision.value` on the task whose `kind` is `checkpoint` and
whose `key` is `ship`. The runtime shows that value only when the durable
decision record matches the journalled digest, so it is the human's answer
rather than a report of it. A gate that is undecided, or decided otherwise, is
named — with the run id — and nothing runs. `/plan ship <slug>` does not check
it, because typing the command is itself the decision.

The pull-request body is the receipt: the plan digest, every handoff ref with
its sha256 and size, the check that ran on the host, and the review verdicts
when the inspection carried them.

`publication.json` is an **append-only array**. A second ship of the same plan
is a real event — the first publication's branch and pull request exist — so
each entry is added and no earlier one is ever rewritten. An entry records the
time, the run, the plan digest, the mode, the base, the branch, the check, every
handoff ref, and the pull-request URL when there is one.

A plan whose `policy.publish.mode` is `none` is refused by name: nothing is
branched, picked or pushed, and the message says which policy said so.

Publication has two trigger paths and one implementation. `/plan ship <slug>`
asks the runtime which completed runs carry this plan's digest and, when more
than one does, asks which. A ship decided at the run's own `ship` checkpoint
announces itself on `maestro:workflow-shipped` — from the checkpoint prompt, and
from a listener on the runtime's own run observations, so a decision made with
`/workflow decide` arrives too — and the seat runs the same publication for the
stored plan that digest matches. The announcement is not the authority and is
never treated as one: the observer announces only a run whose `ship` checkpoint
already proves `{"ship": true}`, publication proves it again from its own
inspection, the digest is still checked, and step 7 still asks. There is no
second dialog asking whether the run was shipped, because that question is now
answered from the run.

The owned `@vegardx/pi-workflow` project owns everything between the input and
that receipt: runtime graph compilation, repository and worktree authority,
implementation and review stages, artifacts and structured findings, failure,
retry, resume and recovery. This package's responsibility ends at a validated
document and the run request built from it, and resumes at the publication of
the receipt that comes back.
