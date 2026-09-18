# Authored plans

An authored plan describes repositories, deliverables, dependency edges, the
work each deliverable is, and who reads that work when it is done. It is intent,
not runtime state. It is stored at `schemaVersion: 5`.

**Version 5 moved reviews off the task and took the run's shape out of the
document.** A `tasks[]` entry is work — implementation, tests, docs, and nothing
else — and a deliverable lists its reviews once, in `reviews[]`, beside them.
`deliverables[].stages` is gone: how a deliverable runs is derived from its
tasks, its reviews and the policy. There is no migration: a stored
`schemaVersion: 4`, a task still carrying `review` or `by`, and a deliverable
still carrying `stages` are each **refused by name**.

Why: version 4 encoded "this is work" as the *absence* of `review`, and absence
is the one thing a model filling in every field will not produce. Four by-hand
passes put `review` on every task in a deliverable, leaving nobody writing the
code; the same passes filled `skill: ""` and `model: ""` throughout and wrote an
explicit `stages` block that duplicated and contradicted the task reviews it
sat beside. The `plan` tool's guidance had grown to thirty-three field notes and
four kilobytes of capitalised warnings to hold that shape together. When
guidance has to shout, the shape is wrong.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- `tasks`: the work, in order, at least one;
- `reviews`: who reads that work, zero or more, absent and empty meaning the
  same thing;
- `after` dependencies that order work;
- `reads` dependencies whose outputs may be consulted.

The plan itself carries a `slug`, a `title`, an optional `body`, its `repos`,
and a `policy` the seat attaches (below).

`reads` must remain a subset of `after`. IDs are bounded workflow-safe slugs and
the graph must be acyclic.

A `reads` edge says one deliverable may consult another's output, not that its
code depends on it. The fan-out a run compiles has no per-item ordering to
express a code dependency, so a plan whose `reads` implies one is **refused by
name** rather than compiled with the edge silently dropped — a dropped ordering
edge is a run that looks correct and builds against a tree that does not exist
yet.

### Reviews

A review is not a task. A `reviews[]` entry says which independent point of view
to apply to the deliverable's finished work, and how much reviewer it is worth.
`lens` is the only required field:

- `lens` — **required**: the fan-out key, `^[a-z][a-z0-9-]{0,63}$`. A review with
  an empty or missing lens is refused, and the refusal says what to do instead:
  *a review needs a lens; a task that is not a review is simply a task, and
  belongs in `tasks` with no review entry*.
- `model` — an exact `provider/model` ID, validated only when present. Pinning
  one makes the plan run on hosts that have that model and nowhere else.
- `skill` — an ambient skill name to request explicitly in the stage prompt.
- `tier` — `light`, `standard`, or `heavy`: how much reviewer the lens is
  worth, for the host to resolve.
- `diverse` — ask for a reviewer from a different model family than the
  implementer.

A review that names neither a `model` nor a `tier` is legal; the running
workflow's effort dial then decides what the reviewer is. At most sixteen
reviews read one deliverable, which is the fan-out's own bound. The same lens
twice is not an error — it is how one point of view runs under two models — and
the compiler suffixes the duplicates `-2`, `-3` by declaration order.

#### `model` and `skill` are checked against this host

Both name something outside the document, so both are checked against the
session the plan is written in, at plan time, and refused by name when it does
not have them:

- `model` must be a model the host's registry has. The refusal lists the
  registered providers, so the author can correct it in one step.
  **Authentication is not required** — whether a provider is logged in is a
  run-time question about credentials, and a document that depended on a login
  would be valid and invalid by turns.
- `skill` must be a skill Pi has loaded in this session. The refusal names the
  loaded skills, or counts them when there are more than twenty.

Both questions reach validation through one injected port. **With no session to
ask, a pinned `model` or `skill` is refused**, never accepted unchecked: a plan
that pins what nothing could verify is exactly the case the check exists for.
The same port answers for the `plan` tool, for the store, and for the exit
flow's re-validation of a plan it rewrote, so the three cannot disagree about
one document. Version 4 asked these questions twice per review — once at
`tasks[].review` and again at the lens it seeded — which meant a rule an author
could escape by moving the field; there is one site now, and one message.

### How a deliverable runs

Derived, never authored. There is one lowering, and it is
`defaultStagesFor` — so the graph a person approves is the graph the run
executes:

```jsonc
[ { "use": "implement",      "id": "implement" },
  { "use": "verify-and-fix", "id": "verify", "maxRounds": <policy.maxFixRounds> },
  { "use": "review-fan-out", "id": "review",
    "lenses": [ /* one per `reviews` entry, tier and diverse from it or policy.reviewDefault */ ],
    "synthesis": "optional" } ]
```

The review stage is **omitted** rather than declared empty when the deliverable
lists no reviews: a fan-out over zero lenses is not a cheaper review, it is a
stage that cannot be compiled. `maxRounds` is mapped to the component's verify
rounds on the way out (`fix + 1`, so a fix is never left unchecked), and where a
run stops for a human is `policy.gates` on the compiled document rather than a
stage of its own.

### Policy

`policy` is plan-wide and is **not written by the model**: the `plan` tool has
no `policy` parameter. The plan-mode exit's dialogs settle it — the effort a
human chose, the gates this seat defaults to, the publication derived from the
repository — and the seat attaches it to the document the tool stores. Outside
that window the plan carries none and the defaults below apply. It is on the
document, not only in a dialog transcript, so a reviewer can see where a run is
going and the plan digest covers it.

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
  "body": "Why the catalogue is worth building.",
  "repos": [{ "key": "wf", "path": "/Users/vegardx/src/github.com/vegardx/pi-workflow" }],
  "policy": { "effort": "standard", "gates": "approve-plan+ship",
              "maxFixRounds": 1, "publish": { "mode": "pr", "base": "main" } },
  "deliverables": [{
    "id": "catalogue", "title": "Ship the component catalogue",
    "after": [], "reads": [],
    "tasks": [{ "id": "impl", "title": "Write src/components/*.ts" },
              { "id": "tests", "title": "Cover each component" }],
    "reviews": [{ "lens": "contracts", "tier": "heavy", "diverse": true },
                { "lens": "replay", "tier": "standard" }]
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
is written on the way out — and a dialog sequence cannot obtain anything from a
conversation, because no model turn happens inside one. The exit is therefore
split by two model turns: the dialogs ask what only a human knows, the model
writes the description, one dialog agrees it, the model writes the plan, and the
second half compiles, reviews and launches it.

**What plan mode may run.** Nothing the model starts. The seat refuses
`workflow_run` and `workflow_propose` in plan mode, by name, at the tool call;
every workflow read stays available, because reading a run is planning. A run is
safe from plan mode — it touches neither the working tree nor the host — and it
is still not the model's to start there. This was guidance first, written into
the steers, the `plan` tool's trailer and these docs, and a model reviewed its
own plan with `deep-review` from plan mode twice anyway; guidance that fails
twice is a rule. A run starts from plan mode in two ways, and both are the
person's: `/workflow run <ref>`, or the plan's own run at the end of this exit.
The plan itself is checked by the blind reviewer in the second half below,
against the agreed description, on the compiled document; a plan reviewed by its
own author is not reviewed.

**The posture does not move until the run starts.** `/mode auto` used to switch
first and ask later, which left every path that ends without a run — and there
are five — in a posture nobody chose for what they ended up doing. The seat
stays in plan mode for the whole exit, and `setMode` is called in exactly one
place: immediately before the hand-off at the last question.

**The dialogs.** `/mode auto` or `/mode hack` from plan mode asks two questions:
what to do with the conversation, and how much effort the run may spend. The
[command reference](commands.md#leaving-plan-mode) lists them, and lists two
things about each: what is first — the action you most likely want, and the only
row labelled `(default)` — and what escape takes, which is always the answer
that commits to nothing. Those are different questions and this flow keeps them
apart; they coincide only on the effort dial, where nothing is committed either
way.

**What is not asked.** Gates default to `approve-plan+ship`. Publication is
derived from the repository — an `origin` remote and `gh` on PATH means a pull
request, a remote alone means a branch, neither means the work stays here — and
the base branch is what this branch tracks, else `main`. The derivation is
announced in one notification and recorded as `policy.publish`, where the
compiled-document dialog can still change it. A human asked to repeat what the
machine already knows is a human who stops reading dialogs.

**The agreed description.** On *Compile it into a workflow run* the record is
written and the model is asked — as an ordinary follow-up message, in the
transcript — for two or three sentences saying what we are doing and why,
submitted through `plan_intent { summary }`. One dialog shows them back:
*Agree*, *Edit*, or *Back to the conversation*. It comes from the model because
the conversation already contains it, and through a tool because a sentence in a
transcript is a sentence somebody has to parse out again.

The agreed text is the **blind reviewer's yardstick**: it is what `plan-review`
is told the plan is for. A reviewer handed the plan as its own justification can
only check the plan against itself, which is why the `plan` tool's window opens
on agreement and not before — no yardstick, no window. A `plan` call that
arrives earlier is refused by name.

**The hand-over.** Agreeing asks the model for the whole document — and for
nothing else. The dials are named in that message as decisions already made and
are not the model's to write: version 4 pasted them in as a JSON block to copy
back verbatim, which made the author responsible for transcribing a decision
they had no part in and put the compiler's own settings in front of them as if
they were authoring choices. The seat attaches them to the stored document
instead.

*Just switch mode* switches and records nothing. *Keep planning*, and escape,
leave the posture where it was and record nothing. A session replacement ends
the flow and drops the record: an exit nobody is answering is not an exit in
progress.

**What the record is for.** It is the only thing that survives the model turns,
so it holds only what they cannot reproduce: the policy, the posture that was
asked for, the agreed description, and which session asked. While it exists the
exit's tools are held even in plan mode — `plan_intent` from the moment it is
written, `plan` from the moment it carries a description. The record is deleted
on every path out of the second half, so the window is only ever open across the
turns it exists for.

**The second half.** The `plan` tool's own result is the trigger: a stored
document, plus a record naming *this* session and carrying an agreed
description. The session id is read from that tool result rather than from
whichever session answered the dialogs, so a plan written in a session that
replaced the one that asked is not read as the continuation of its exit. The
half runs **detached** from the tool result: the hook returns at once, so the
model's `plan` call is not shown running for as long as the dialogs take.

What happens then, in order, with the dialogs listed in the
[command reference](commands.md#after-the-plan-is-written):

1. **Readiness.** The repositories the plan names are probed (above). A missing
   one can be created, with a confirmation, through the seat's own audited
   `bash`; a dirty one is reported and you decide whether every worktree
   branching from HEAD is acceptable. Everything else readiness finds is
   reported at once as a warning — it is a fact about this host, and publication
   will meet it again.
2. **Normalisation.** Every heavy review whose `diverse` is undefined gets
   `diverse: true` written into the **stored** plan's `reviews`; the result is
   re-validated and saved. A heavy lens reads
   the same work the implementer wrote, and a reviewer from another model family
   fails differently — both compilers agree on that, and they used to disagree
   about the document because an undefined field left each of them to decide for
   itself. Writing it down settles it where the digest covers it. A lens that
   says `diverse: false` has answered the question and keeps its answer. There
   is no dialog here, and no dialog about review lenses anywhere: the plan and
   `policy.reviewDefault` decide them.
3. **The compiled stage document.** pi-maestro derives it here, from the same
   §2.1 rules `plan-to-ship` compiles from: the stage list derived from the
   policy, lenses seeded from `deliverables[].reviews`, duplicate lens ids
   suffixed `-2` and `-3` by declaration ordinal, and `maxRounds` from the plan's fix
   rounds to the component's verify rounds (`fix + 1`, so a fix is never left
   unchecked). It is validated against a local mirror of the runtime's own
   closed schema, so a disagreement between the two readings fails here rather
   than inside a dialog sequence. The runtime then validates the run input and
   projects its budget. What is shown before the dialog is the agreed
   description, the reviewer list, the graph and the projection.
4. **Check it.** *Review it blind* is first and starts the headless
   `plan-review` through the workflow provider — without a model turn, which is
   what keeps it blind: a review reached through the model would have read the
   planning conversation. *Approve as is* skips it. *Edit* opens the compiled
   document as JSON; an edit is validated against the same mirror and its review
   lenses are written back into the plan's `reviews`, and escaping the editor
   discards it. This is the place to change who reviews what, and it is now the
   only thing the compiled graph holds that a plan can still say — an edit to
   anything else is **refused by name** rather than accepted and recompiled away
   behind the person who made it. *Back to the conversation* is what
   escape takes, because the other three all start something: the plan stays
   stored, the record goes, and the posture stays `plan`.
5. **The findings walk.** Every **blocking** finding is asked, one at a time:
   accept it (first, when the reviewer brought a patch — taking it is what
   usually happens), revise with the model (first when it brought none),
   dismiss it with a reason, or go back to the conversation, which is what
   escape takes. Accepting applies the finding's RFC 6902 `patch` to the stored
   plan, runs the plan's own validation over the result and saves it — a
   mechanical apply, never a re-prompt. A patch that will not apply is reported
   and the finding is asked again without the accept option. `major` and `minor`
   findings are printed once and never asked about.
6. **Revising with the model.** A blocking finding whose reviewer brought only
   prose is one a human cannot apply, and the model can. *Revise with the model*
   ends the walk at once — the findings not yet asked travel with the rest,
   because one rewrite answers the whole review — and sends the model every
   finding and the reviewer's notes verbatim, with the instruction to rewrite
   the plan, call `plan` once with the whole document, and stop — the dials do
   not move, and the tool does not take them. It is the only answer in the exit that does not end it:
   the record stays (carrying the review count), the `plan` tool's window stays
   open, the posture stays `plan`, and the model's next stored plan re-enters
   this half from readiness — so the revised plan is shown at the compiled
   document dialog and reviewed again. **Three blind reviews per record**, with
   accepts and revises counted together, because each buys one re-review. The
   last review is walked without *Revise with the model* and ends in the
   conversation with the findings printed, whatever is answered: a fourth read
   of the same plan is the flow arguing with itself, and the conversation is
   where that belongs.
7. **The run.** `Start the run?` is the last question. *No* leaves the plan
   stored, the posture in plan mode, and starts nothing. *Yes* switches to the
   posture asked for at `/mode`, deletes the record, and asks the model — as an
   ordinary follow-up message, in the transcript — to make the
   `workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }`
   call itself. The run is still made in the open, and it still parks at its
   `approve-plan` checkpoint.

Every ending that is not a run says the same two things in one notice: the plan
is stored and `/plan run <slug>` starts it, and `/mode auto` (or `hack`) is
still there when you want it. `/mode plan` is never offered, because the seat
never left it.

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
  → <agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
  → toWorkflowInput(plan, effort)
  → workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }
```

**Per project, and signed by the session that wrote it.** The store's root is
`<agentDir>/maestro/plans/<encoded cwd>`, where the key is the cwd encoded
exactly as Pi encodes its own sessions directory (`/Users/x/src/proj` →
`--Users-x-src-proj--`), so a project's sessions, plans and workflow runs are
siblings under one name. The envelope is schema 6 and carries
`authoredBy: {sessionId, cwd}` — required, taken from the live session — so a
plan read back names who wrote it and where. A schema 5 envelope has no such
field and is refused by name; there is no migration, and plans left directly
under `maestro/plans/<slug>` are not read or listed.

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

`/plan run <slug> [cheap|standard|deep]` is not the normal way to start a run:
the plan-mode exit starts one for you as soon as the plan is stored. It is the
way to start or restart a run for a stored plan whose run never started or
failed. It starts nothing itself either. It loads the stored document, builds
`toWorkflowInput(plan, effort)`, writes that input to
`<agentDir>/maestro/plans/<encoded cwd>/<slug>/workflow-input.json`, and hands
the session the call to make: `workflow_run { ref: "plan-to-ship", input: … }`. pi-maestro has
no workflow runtime and no dependency on one, so the run happens where every
other tool call happens — in the open, in the transcript, where it can be seen
before it is made.

The command cannot approve anything either. The run parks at its `approve-plan`
checkpoint until a human decides it, which is why `/plan run` is safe to offer
at the end of a plan write: the next gate is a person, not the model.

`/plan list` and `/plan show <slug>` read the same store, and read only this
project's plans — no other project's appear, and the same slug in two projects
is two plans. `/plan show` also prints the session id and cwd that authored the
plan. `/plan rm <slug>` removes a plan after a confirmation (refused outright
when the session has no UI to confirm with). Those five verbs are the whole
surface. See the [command reference](commands.md).

### Publishing what a run produced

A run ends at a receipt: per deliverable a handoff commit in the publication
repository's own object store, its sha256 and size, and the digest of the plan
the run was given. A ship decided at the run's `ship` gate publishes by itself;
`/plan ship <slug>` is the manual fallback for when that did not happen. It
turns the receipt into a branch and,
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
| 10 | Append the receipt to `<agentDir>/maestro/plans/<encoded cwd>/<slug>/publication.json` | the file exists and is not an array of receipts — it is never overwritten |

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
