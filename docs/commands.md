# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change the interactive seat posture. Leaving plan mode asks the [exit questions](#leaving-plan-mode) first |
| `/plan list` | Every stored plan: slug, title, deliverable count, when it was last written |
| `/plan show <slug>` | Read one back whole: repositories, deliverables with `after`/`reads`, tasks, review intent, and any warning about the world |
| `/plan run <slug> [cheap\|standard\|deep]` | Build the workflow input for a stored plan and hand it to the model. Effort defaults to the plan's `policy.effort`, and to `standard` when it sets none |
| `/plan ship <slug>` | Publish what a run produced: branch, cherry-pick, the repository's check on the host, one confirmation, push, and a pull request when the plan's policy asked for one |
| `/plan rm <slug>` | Delete a stored plan, after a confirmation. Refused when the session has no UI to confirm with |

`/plan` with no subcommand, or with a subcommand or effort it does not know,
prints the grammar above and does nothing else.

`/plan run` does not execute anything itself: pi-maestro has no workflow
runtime and takes no dependency on one. It writes the run input to
`<agentDir>/maestro/plans/<slug>/workflow-input.json` and steers the session
with the exact call to make —
`workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }`.
Approval is not part of the command: the run parks at its `approve-plan`
checkpoint and a human decides it. See
[Authored plans](workflow-plans.md#running-a-plan).

`/plan ship` is the one verb that acts on the world, and it is the only place
pi-maestro pushes. It reads the run's receipt through the workflow runtime,
refuses unless the receipt's plan digest is the stored plan's, and then runs
every command — `git fetch`, `git switch`, `git cherry-pick`, the check, `git
push`, `gh pr create` — through the seat's audited Bash tool, so the classifier
and the mode's confirmation policy apply to each. Any failure stops **before**
the push and leaves the branch in place. It needs a UI (it asks before pushing)
and the workflow runtime (it reads the receipt); without either it says so and
does nothing. A plan whose policy is `publish: none` is refused by name. The ten
steps, and what stops where, are in
[Authored plans](workflow-plans.md#publishing-what-a-run-produced).

A ship decided at the run's `ship` checkpoint announces itself on
`maestro:workflow-shipped`, and the seat runs the same publication for the
stored plan that digest matches. The announcement is not the authority: before
anything else, publication re-inspects the run and proves `{"ship": true}` from
the `ship` checkpoint's own decided value, so a run whose gate is undecided or
decided otherwise is named and never published. Nothing is asked twice — the
only confirmation is still the one at the push.

## Modes

| Mode | Direct file tools | Bash classifier | OS write boundary |
| --- | --- | --- | --- |
| `plan` | `write`, `edit`, and `delete` blocked | reads allowed; writes/code/uncertain refused | none |
| `auto` | available | effect policy with ambiguity audit and confirmations | none |
| `hack` | available | reduced, configurable effect policy | none |

A workflow run may be started from any mode, including `plan`: a run mutates
neither the working tree nor the host, and what it produces reaches a branch
only through publication, which a human decides separately.

### Leaving plan mode

Plan mode is a conversation and does not hold the `plan` tool, so the document
is written on the way out. `/mode auto` or `/mode hack` from plan mode therefore
asks first — in a session with dialogs, and only on that transition. Every other
mode change is the plain switch it always was, and so is this one on a host with
no dialog UI: six defaults nobody chose are worse than the switch that was
asked for.

| # | Dialog | Default |
| --- | --- | --- |
| 1 | `Compile it into a workflow run` / `Just switch mode` / `Keep planning` | escape is *Keep planning* |
| 2 | Effort: `cheap`, `standard`, `deep` | `standard` |
| 3 | Gates: `approve-plan only`, `approve-plan + ship`, `every deliverable` | `approve-plan + ship` |
| 4 | Publication: `none`, `branch`, `pull request` | `pull request` |
| 5 | Base branch — asked only when 4 is not `none` | what the repository tracks, else `main`, and you are told which |
| 6 | One line: what the plan is for | the first line of your last message |

Each is asked once and escape takes the default printed beside it. *Keep
planning* — and escape at 1 — leaves the posture exactly where it was and
records nothing. *Just switch mode* switches and records nothing. The other
branch switches the posture, writes the [pending record](#state), and asks the
model for the plan document with the answers as a `policy` block to copy
verbatim — see [Authored plans](workflow-plans.md#leaving-plan-mode).

Nothing is compiled, reviewed or run by those six dialogs, and nothing there
starts a model turn other than the request for the document.

#### After the plan is written

The model's `plan` call is the second half's trigger: when it stores a document
and the [pending record](#state) belongs to *this* session, the rest of the exit
runs. Anything the plan already answers is never asked.

| # | Step | Asked |
| --- | --- | --- |
| 7 | [Readiness](workflow-plans.md#readiness) of every repository the plan names | nothing, when the machine is ready |
| 7a | `Create <path>?`, then the creating commands through the audited `bash` | per missing repository; *No* goes back to the conversation |
| 7b | A dirty tree: `Continue` / `Back to the conversation` | per dirty repository; escape is *Continue* |
| 8 | A review lens for this deliverable: `Include` / `Skip` | per candidate lens; escape keeps the plan's own |
| 9 | What that lens is worth: `light`, `standard`, `heavy` | only where the plan pinned neither a tier nor a model |
| 10 | `A cross-family reviewer on <deliverable>?` | per deliverable, only where a lens is `heavy` |
| 12 | The compiled graph and the projected budget: `Review it blind` / `Approve as is` / `Edit` | once; escape is *Review it blind* |
| 13 | `Edit` opens the compiled document as JSON | on demand; escape discards it |
| 15 | Per **blocking** finding: `Accept the suggestion` / `Dismiss` / `Back to the conversation` | per finding; escape is *Back to the conversation* |
| 15a | `Dismiss` asks why | per dismissal; an empty reason is not a dismissal and the finding is asked again |
| 18 | `Start the run?` | once; *No* leaves the plan stored and runs nothing |

Steps 11, 14, 16 and 17 open no dialog. 11 compiles the plan into the stage
document and asks the runtime to validate and project it; 14 starts the headless
`plan-review` and says so; 16 recompiles and re-reviews **once** after at least
one accepted finding, and a second blocking review ends the loop; 17 prints
`major` and `minor` findings as one notification and never asks about them.

*Accept* applies the finding's RFC 6902 patch to the stored plan, re-validates
it and saves it. A patch that does not apply, or one that would make the plan
stop validating, is reported and the finding is asked again **without** the
accept option.

The exit ends in exactly one of four places: the run request (19), which deletes
the record and hands the model the `workflow_run` call to make in the open; a
stored plan and nothing else; back in the conversation, with the findings
printed and `/mode plan` offered; or a refusal that names what stopped it. All
four delete the pending record.

Two fallbacks keep a reduced seat working. Without a workflow runtime — or when
one refuses to validate or project — the flow stops at 11, says so, and leaves
`/plan run <slug>` as the way to start it. When only the blind reviewer is out
of reach, the warning names `Approve as is` and dialog 12 is asked again without
the review option.

## Seat tools

- `plan` authors or replaces the whole plan and returns all validation errors
  together. Delegated reviews use `{lens, skill?, model?, tier?, diverse?}`, and
  a deliverable may carry optional `stages` beside a plan-wide `policy` — see
  [Authored plans](workflow-plans.md#stages).
- `bash` runs on the host after mode-aware classification.
- `delete` moves explicitly named paths to recoverable trash.
- Pi's built-in `write` and `edit` remain available in auto and hack.
- `ask_user_question` comes from
  `@juicesharp/rpiv-ask-user-question` for model-authored clarifications.
- `subagent` is supplied independently by `@vegardx/pi-subagent`.

Pi-maestro does not bundle a subagent, workflow, or web implementation.

## State

Authored plans remain under:

```text
<agentDir>/maestro/plans/<slug>/plan.json
```

`/plan ship` appends one receipt per publication, and never rewrites an earlier
one — a second ship of the same plan is a real event:

```text
<agentDir>/maestro/plans/<slug>/publication.json
```

`/plan run` writes the input it built beside the plan it built it from:

```text
<agentDir>/maestro/plans/<slug>/workflow-input.json
```

That file is an export, not state: it is rewritten by every `/plan run` and
nothing reads it back. There is no workflow run state or compiled workflow
bundle in this package; a run's state belongs to the runtime that owns it.

A plan-mode exit in progress is recorded beside the plans, one file per session:

```text
<agentDir>/maestro/plans/.pending/<sessionId>.json
```

It holds `{schemaVersion, sessionId, policy, intent, createdAt}` — the answers
to the dialogs above, which the plan the model is about to write cannot yet
carry. It exists because the exit is split by one model turn, and it is the one
thing that says the split is open: while it is there, the `plan` tool is held
even in plan mode. A record that does not parse, speaks another schema version
or names another session is refused by name rather than read as absent; the
refusal prints the path, and deleting the file starts the exit over.
