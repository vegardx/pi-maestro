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
no dialog UI.

**The posture does not move here.** It moves at the last question, when the run
starts. Everything before that happens in plan mode, which is why no path out of
the exit ever offers `/mode plan`: the seat never left it.

| # | Dialog | First, marked `(default)` | Escape |
| --- | --- | --- | --- |
| 1 | `Compile it into a workflow run` / `Just switch mode` / `Keep planning` | *Compile it into a workflow run* | *Keep planning* |
| 2 | Effort: `standard`, `cheap`, `deep` | `standard` | `standard` |

**Ordering and escape are two different questions, and this flow answers them
separately.** The first option — the one a `select` highlights, and the only one
labelled `(default)` — is the action you most likely want. Escape is the safe
way out, and it never commits to anything: it starts no run, agrees to nothing,
and writes nothing you did not ask for. The two are the same row in exactly one
table, the effort dial, because every answer there is a reversible setting on a
run that four later dialogs still gate. An answer the list does not recognise
takes the escape too, for the same reason: it is not evidence that anybody chose
anything.

*Keep planning* — and escape at 1 — leaves the posture where it was and records
nothing. *Just switch mode* switches immediately and records nothing. *Compile*
writes the [pending record](#state) and asks the model for the description
below; the posture stays `plan`.

Nothing else is asked, because nothing else is a question for a human:

| Decision | How it is settled |
| --- | --- |
| Gates | `approve-plan+ship`, always. The model may raise it to `every-deliverable` when the conversation asked for a check after every deliverable, and only then |
| Publication | Derived: an `origin` remote and `gh` on PATH → `pr`; a remote alone → `branch`; neither → `none` |
| Base branch | What this branch tracks, else `origin`'s head, else `main` |

The derivation is announced in one notification —
`Publication: pull request onto `main` — this repository has an `origin` remote
and `gh` is on PATH.` — and lands on the plan as `policy.publish`, where it can
still be changed at the compiled-document dialog.

#### The agreed description

The model is then asked — as an ordinary follow-up message, in the transcript —
for two or three sentences saying what we are doing and why, written from the
conversation, and submits them with `plan_intent { summary }`. The tool is held
only while an exit is in progress, and it refuses anything that is not two or
three sentences or is longer than 600 characters.

| # | Dialog | First, marked `(default)` | Escape |
| --- | --- | --- | --- |
| 3 | `Is this what we are doing?` with the sentences shown, then `Agree` / `Edit` / `Back to the conversation` | *Agree* | *Back to the conversation* |

*Agree* is first because it is usually right — the sentences were written from
your own conversation and are shown in full. **Escape does not agree.**
Agreement is the one thing here that only a human can supply: it becomes the
blind reviewer's yardstick and it opens the `plan` tool, and an agreement
obtained by not answering is not one.

*Edit* opens the sentences in an editor and asks again with whatever comes back;
escaping the editor discards the edit. *Back to the conversation* deletes the
record, says so, and leaves you in plan mode with nothing else changed.

*Agree* puts the sentences on the record and asks the model for the plan, with
the `policy` block to copy verbatim. **The `plan` tool opens here and not
before**: the agreed description is what the blind review checks the plan
against, so there is no window before there is a yardstick. A `plan` call that
arrives earlier is refused by name, and the refusal says to submit the
description first.

#### After the plan is written

The model's `plan` call is the second half's trigger: when it stores a document
and the [pending record](#state) belongs to *this* session and carries an agreed
description, the rest of the exit runs. It runs **detached** — the tool result
returns immediately, so the model's `plan` call is not shown running for as long
as the dialogs take to answer. Anything the plan already answers is never asked.

| # | Step | Asked | First, marked `(default)` | Escape |
| --- | --- | --- | --- | --- |
| 7 | [Readiness](workflow-plans.md#readiness) of every repository the plan names | nothing, when the machine is ready | — | — |
| 7a | `Create <path>?`, then the creating commands through the audited `bash` | per missing repository | — | *No*, which goes back to the conversation |
| 7b | A dirty tree: `Continue` / `Back to the conversation` | per dirty repository | *Continue* | *Back to the conversation* |
| 12 | The agreed description, the reviewers, the compiled graph and the projected budget: `Review it blind` / `Approve as is` / `Edit` / `Back to the conversation` | once | *Review it blind* | *Back to the conversation* |
| 13 | `Edit` opens the compiled document as JSON | on demand | — | discards the edit |
| 15 | Per **blocking** finding: `Accept the suggestion` (only when the reviewer brought a patch) / `Revise with the model` (only while a review is left) / `Dismiss` / `Back to the conversation` | per finding, until one is answered *Revise* | *Accept the suggestion*; *Revise with the model* when there is no patch to take; *Dismiss* once the patch has been shown not to apply, or on the last review with no patch | *Back to the conversation* |
| 15a | `Dismiss` asks why | per dismissal | — | an empty reason is not a dismissal and the finding is asked again |
| 15b | `Revise with the model` ends the walk at once | on demand | — | the whole review goes back to the model; nothing else is asked |
| 18 | `Start the run?` | once | — | *No*: the plan is stored and nothing runs |

Everything at 12 except *Back to the conversation* starts something — a
reviewer, an editor, or the run — so that is what escape there does: the plan
stays stored, the record is deleted, you stay in plan mode, and the notice is
the same one every other ending prints.

The review lenses are **not** asked about. The plan and its
`policy.reviewDefault` decide them, and dialog 12 — with *Edit* behind it — is
where a reviewer is changed. Before anything is compiled, every heavy lens whose
`diverse` is undefined has `diverse: true` written into the **stored** plan, in
both `tasks[].by` and `stages[].lenses`, so this seat's compiled document and
pi-workflow's derive the same graph from the same bytes. A lens that already
says `diverse: false` keeps its answer.

Steps 11, 14, 16 and 17 open no dialog. 11 compiles the plan into the stage
document and asks the runtime to validate and project it; 14 starts the headless
`plan-review` and says so; 16 recompiles and re-reviews after at least one
accepted finding; 17 prints `major` and `minor` findings as one notification and
never asks about them.

*Accept* applies the finding's RFC 6902 patch to the stored plan, re-validates
it and saves it. A patch that does not apply, or one that would make the plan
stop validating, is reported and the finding is asked again **without** the
accept option.

*Revise with the model* is what a finding with no patch is for. It ends the walk
where it stands — the findings that were not asked go back too, because one
rewrite answers the whole review — and the model is sent **every** finding
(blocking, major and minor, each with its `where` and `what`) plus the
reviewer's notes, verbatim, with the instruction to rewrite the plan, call
`plan` again with the whole document and the `policy` block unchanged, and stop
there. It is the one answer in the whole exit that does not end it: the pending
record stays, the `plan` tool's window stays open, the posture stays `plan`, and
the model's next stored plan runs this half again from readiness — so you are
shown the revised plan at dialog 12 and it is reviewed again.

**Three blind reviews per exit, and no more.** The count lives on the pending
record, so it survives the model turns a revise costs, and **accepts and revises
count against the same bound** — each of them buys one re-review. On the last
review the walk is asked without *Revise with the model*, because nothing would
read another rewrite, and however it is answered that reading ends back in the
conversation with the findings printed. An accepted patch still lands on the
stored plan on the way out.

A three-deliverable plan whose reviewers are already tiered, on a ready machine,
with a clean blind review, asks **five** dialogs in total: two in phase 1, one
for the description, the compiled document, and `Start the run?`.

The exit ends in exactly one of four places: the run request (19) — the only
place `setMode` is called, so the posture becomes the one asked for at `/mode`
immediately before the record is deleted and the model is handed the
`workflow_run` call; a stored plan and nothing else; back in the conversation
(7a, 7b, 12 or 15); or a refusal that names what stopped it. All four delete the
pending record, and the three that are not the run leave you in plan mode with
one notice naming `/plan run <slug>` and `/mode <auto|hack>`. *Revise with the
model* is not one of them: it suspends the exit rather than ending it, keeps the
record, and hands the next turn to the model.

Two fallbacks keep a reduced seat working. Without a workflow runtime — or when
one refuses to validate or project — the flow stops at 11, says so, and leaves
`/plan run <slug>` as the way to start it. When only the blind reviewer is out
of reach, the warning names `Approve as is` and dialog 12 is asked again without
the review option.

## Seat tools

- `plan` authors or replaces the whole plan and returns all validation errors
  together. Delegated reviews use `{lens, skill?, model?, tier?, diverse?}`, and
  a deliverable may carry optional `stages` beside a plan-wide `policy` — see
  [Authored plans](workflow-plans.md#stages). It is held in auto and hack, and
  in plan mode only once an exit's description is agreed.
- `plan_intent` submits the two or three sentences the exit agrees on before the
  plan is written. Held only while a plan-mode exit is in progress, in any
  posture — see [Leaving plan mode](#leaving-plan-mode).
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

It holds `{schemaVersion: 2, sessionId, policy, wanted, intent?, createdAt}` —
the answers to the dialogs above, the posture the human asked for and has not
been given yet, and the agreed description once there is one. It exists because
the exit is split by two model turns, and it is the one thing that says the
split is open: while it is there without an `intent`, `plan_intent` is held even
in plan mode, and once it carries one the `plan` tool is too.

A record that does not parse, speaks another schema version, names another
session or wants a posture that is not `auto` or `hack` is refused by name
rather than read as absent; the refusal prints the path, and deleting the file
starts the exit over. There is no reader for schema 1: a version-1 record says
the posture already moved, which this build would act on and cannot check.
