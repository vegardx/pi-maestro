# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change the interactive seat posture. Leaving plan mode asks the [exit questions](#leaving-plan-mode) first |
| `/plan list` | This project's stored plans: slug, title, deliverable count, when it was last written |
| `/plan show <slug>` | Read one back whole: the session and cwd that authored it, repositories, deliverables with `after`/`reads`, tasks, review intent, and any warning about the world |
| `/plan run <slug> [cheap\|standard\|deep]` | Start or restart `plan-to-ship` for a stored plan whose run did not start or failed. Effort defaults to the plan's `policy.effort`, and to `standard` when it sets none |
| `/plan rm <slug>` | Delete a stored plan, after a confirmation. Refused when the session has no UI to confirm with |
| `/plan ship <slug>` | The manual publication fallback, for when the automatic publication after the ship gate did not happen |

Those five are the whole surface, and each is here for a stated reason: `list`
and `show` read this project's plans; `run` starts a run the plan-mode exit
normally starts for you; `rm` removes one; `ship` publishes what the automatic
path did not. `/plan` with no subcommand, or with a subcommand or effort it does
not know, prints the grammar and those reasons, and does nothing else.

**Plans are per project.** The store's root is `<agentDir>/maestro/plans/<key>`,
where `<key>` is the cwd encoded exactly as Pi encodes its own sessions
directory — `/Users/x/src/proj` becomes `--Users-x-src-proj--` — so a project's
sessions, its plans and (soon) its workflow runs are siblings under one name.
`/plan list` reads only the current project's folder and shows no other
project's plans; a slug is unique within a project and two projects may each
have their own `arc`. Plans written before this key existed sit directly under
`<agentDir>/maestro/plans/<slug>`: they are not read, not listed and not
migrated.

`/plan run` is not the normal way to start a run — the plan-mode exit starts one
for you when the plan is stored. It is here for the plan whose run never started
or failed. It does not execute anything itself either: pi-maestro has no
workflow runtime and takes no dependency on one. It writes the run input beside
the plan, in the plan's own directory, and steers the session
with the exact call to make —
`workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }`.
Approval is not part of the command: the run parks at its `approve-plan`
checkpoint and a human decides it. See
[Authored plans](workflow-plans.md#running-a-plan).

`/plan ship` is the manual fallback for a publication that should have happened
by itself: a ship decided at the run's `ship` gate publishes automatically, and
this is what you type when it did not. It is also the one verb that acts on the
world, and the only place pi-maestro pushes. It reads the run's receipt through the workflow runtime,
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

A workflow run is **not** the model's to start in `plan` mode. The seat refuses
`workflow_run` and `workflow_propose` there by name; every workflow read —
listing, validating, inspecting, waiting on a run, its logs, its status — stays
available, because reading a run is planning, and `workflow_decide` was already
yours alone. A run is safe from plan mode (it mutates neither the working tree
nor the host, and what it produces reaches a branch only through publication,
which a human decides separately) and safe was never the question: plan mode is
a conversation, and starting a run is the seat acting. There are two ways a run
starts from plan mode, and both of them are yours — you start any run with
pi-workflow's own `/workflow run <ref>`, and the plan-mode exit below starts the
plan's own run at the last question. In `auto` and `hack` nothing here is
refused.

### Leaving plan mode

Plan mode is a conversation and the plan is written on the way out, by the
harness: it asks the session's own model — directly, outside the agent loop,
with no tools offered — first for the description and then for the document.
`/mode auto` or `/mode hack` from plan mode therefore asks first, in a session
with dialogs and a model, and only on that transition. Every other mode change
is the plain switch it always was, and so is this one on a host with no dialog
UI or no model.

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

*Keep planning* — and escape at 1 — leaves the posture where it was and asks the
model nothing. *Just switch mode* switches immediately and asks nothing.
*Compile* asks the model for the description below; the posture stays `plan`.

Before the first request the exit checks the session's context usage. Above
**80%** of the model's context window it stops with a notice naming the usage
and suggesting `/compact` and then leaving plan mode again: asking a full
session for a plan spends a request on a document that would be truncated.

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

The harness requests two or three sentences saying what we are doing and why,
written from this conversation. The request carries the session's own history,
a system prompt asking for plain prose, and no tools. The answer has to be
between 40 and 700 characters and carry no code fence and no list; anything else
is re-requested with the previous answer and the problem attached, up to **three
attempts**, after which the exit ends back in the conversation with the problem
printed and nothing changed.

| # | Dialog | First, marked `(default)` | Escape |
| --- | --- | --- | --- |
| 3 | `Is this what we are doing?` with the sentences shown, then `Agree` / `Edit` / `Back to the conversation` | *Agree* | *Back to the conversation* |

*Agree* is first because it is usually right — the sentences were written from
your own conversation and are shown in full. **Escape does not agree.**
Agreement is the one thing here that only a human can supply: it becomes the
blind reviewer's yardstick, and an agreement obtained by not answering is not
one.

*Edit* opens the sentences in an editor and asks again with whatever comes back;
escaping the editor discards the edit. *Back to the conversation* says so and
leaves you in plan mode with nothing else changed.

*Agree* requests the document. That request carries the field guide, the plan
schema as JSON Schema, the agreed description, and the dials as decisions
already made — the model does not write them, and the harness attaches them to
the stored document. The answer is one JSON object; it goes through the
document's own validators, and a document that does not pass is re-requested
with the previous answer and the problems attached, up to **three attempts**.
When they run out, or the provider fails, or the session is replaced, the exit
ends exactly like *Back to the conversation*: the posture is unchanged and the
problems are printed.

#### After the plan is written

The rest of the exit runs as soon as the document is stored, in the same
`/mode` call. Anything the plan already answers is never asked.

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

The review lenses are **not** asked about. The plan's own `reviews` and its
`policy.reviewDefault` decide them, and dialog 12 — with *Edit* behind it — is
where a reviewer is changed. Before anything is compiled, every heavy review
whose `diverse` is undefined has `diverse: true` written into the **stored**
plan, so this seat's compiled document and pi-workflow's derive the same graph
from the same bytes. A review that already says `diverse: false` keeps its
answer.

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
reviewer's notes, verbatim, appended to the same mini-conversation the document
came from, with the instruction to send the whole document again — the dials do
not move, and the schema has no field for them. The rewrite is requested,
validated and stored under the same three-attempt bound. It is the one answer in
the walk that does not end the exit: the posture stays `plan`, and the revised
plan is shown at dialog 12 and reviewed again.

**Three blind reviews per exit, and no more**, and **accepts and revises count
against the same bound** — each of them buys one re-review. On the last
review the walk is asked without *Revise with the model*, because nothing would
read another rewrite, and however it is answered that reading ends back in the
conversation with the findings printed. An accepted patch still lands on the
stored plan on the way out.

A three-deliverable plan whose reviewers are already tiered, on a ready machine,
with a clean blind review, asks **five** dialogs in total: two in phase 1, one
for the description, the compiled document, and `Start the run?`.

The exit ends in exactly one of four places: the run request (19) — where the
posture becomes the one asked for at `/mode`, immediately before the model is
handed the `workflow_run` call, because the workflow client this seat holds is
read-only; a stored plan and nothing else; back in the conversation (7a, 7b, 12
or 15, or a request that never produced something storable); or a refusal that
names what stopped it. The three that are not the run leave you in plan mode
with one notice naming `/plan run <slug>` and `/mode <auto|hack>`.

**What the conversation is told.** One message when the plan is stored, and one
more when the run starts or the exit goes back: the slug, its digest, how many
deliverables it has, and the outcome. Nothing else the harness did appears in
the transcript. Every request it made is on the record in `authoring.json`
beside the plan — see [State](#state).

Two fallbacks keep a reduced seat working. Without a workflow runtime — or when
one refuses to validate or project — the flow stops at 11, says so, and leaves
`/plan run <slug>` as the way to start it. When only the blind reviewer is out
of reach, the warning names `Approve as is` and dialog 12 is asked again without
the review option.

## Seat tools

- `bash` runs on the host after mode-aware classification.
- `delete` moves explicitly named paths to recoverable trash.
- Pi's built-in `write` and `edit` remain available in auto and hack.
- `ask_user_question` comes from
  `@juicesharp/rpiv-ask-user-question` for model-authored clarifications.
- `subagent` is supplied independently by `@vegardx/pi-subagent`.

There is **no plan-authoring tool**. Writing a plan is not a tool call: the
plan-mode exit asks the model for the document directly and validates it itself
— see [Leaving plan mode](#leaving-plan-mode).

Pi-maestro does not bundle a subagent, workflow, or web implementation.

## State

Authored plans live under their project's key, beside that project's sessions:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
```

The envelope is `{schemaVersion: 6, savedAt, authoredBy: {sessionId, cwd}, body}`.
`authoredBy` is required, and a schema 5 envelope — which has no such field — is
refused by name rather than migrated.

`/plan ship` appends one receipt per publication, and never rewrites an earlier
one — a second ship of the same plan is a real event:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/publication.json
```

`/plan run` writes the input it built beside the plan it built it from:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/workflow-input.json
```

That file is an export, not state: it is rewritten by every `/plan run` and
nothing reads it back. There is no workflow run state or compiled workflow
bundle in this package; a run's state belongs to the runtime that owns it.

What the plan-mode exit asked the model, and what came back, is recorded beside
the plan it was asking for:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/authoring.json
```

It holds `{schemaVersion: 1, attempts: [...]}`, one entry per request:
`{kind, startedAt, durationMs, model, thinking, ok, problems, responseDigest}`,
where `kind` is `intent`, `plan` or `revise`. `problems` are the validator's own
sentences and never a provider error, a stack, a path or any of the answer's
text; `responseDigest` stands in for the answer — enough to tell two attempts
apart and not enough to read either.

**Nothing joins the exit's steps on disk**, because nothing has to: the exit no
longer yields to a model turn, so it is one flow inside one `/mode` call. A
session that goes away mid-exit has no exit. A `.pending/` directory left by an
older build is inert — nothing reads it.
