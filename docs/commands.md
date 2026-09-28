# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|ask\|auto\|hack]` | Report or change the interactive seat posture. Leaving plan mode to `ask` or `auto` runs [the hand-off](#the-hand-off) first; to `hack` it only switches |
| `/plan list` | This project's stored plans: slug, title, deliverable count, when it was last written |
| `/plan show <slug>` | Read one back whole: the session and cwd that authored it, repositories, deliverables with `after`/`reads`, tasks, review intent, and any warning about the world |
| `/plan run <slug>` | Start or restart `plan-to-ship` for a stored plan whose run did not start or failed. It takes the gate policy of the mode you are in — `ask` → `ship`, `auto` → `none` — writes it onto the stored plan, and refuses from `plan` or `hack`, which decide no ending for a run |
| `/plan rm <slug>` | Delete a stored plan, after a confirmation. Refused when the session has no UI to confirm with |
| `/plan ship <slug>` | The manual publication fallback, for when the automatic publication after the ship gate did not happen |

Those five are the whole surface, and each is here for a stated reason: `list`
and `show` read this project's plans; `run` starts a run the hand-off normally
starts for you; `rm` removes one; `ship` publishes what the automatic
path did not. `/plan` with no subcommand, or with a subcommand it does not know,
prints the grammar and those reasons, and does nothing else. `run` took an optional
effort until schema 8 removed the dial; it takes a slug and nothing else now, and a
second word is rejected rather than ignored.

**Plans are per project.** The store's root is `<agentDir>/maestro/plans/<key>`,
where `<key>` is the cwd encoded exactly as Pi encodes its own sessions
directory — `/Users/x/src/proj` becomes `--Users-x-src-proj--` — so a project's
sessions, its plans and (soon) its workflow runs are siblings under one name.
`/plan list` reads only the current project's folder and shows no other
project's plans; a slug is unique within a project and two projects may each
have their own `arc`. Plans written before this key existed sit directly under
`<agentDir>/maestro/plans/<slug>`: they are not read, not listed and not
migrated.

`/plan run` is not the normal way to start a run — the hand-off starts one for
you when the plan is stored. It is here for the plan whose run never started or
failed. It writes the run input beside the plan, in the plan's own directory, and
then **starts the run itself**, through the workflow runtime's service seam:
`startBuiltin("plan-to-ship", { input, ceiling })`, which the runtime allowlists by
name and validates exactly as `workflow_run` would. The `ceiling` is the mode you
are standing in.

**It reads the gate policy off that mode, and writes it down.** `ask` writes
`policy.gates: "ship"` onto the stored plan and `auto` writes `"none"`; from `plan`
or `hack` it refuses by name, because neither decides how a run ends. The write
matters: `planDigest` covers the document and publication checks that digest
against the stored bytes, so a run started with gates the stored plan does not
carry is a run nothing can be published from.

The model is not asked to start it and never was part of this command. A seat with
no workflow runtime cannot start anything, and the command says so and leaves the
plan stored. Typing it is the approval — from `ask` the run works through the plan
and stops at its `ship` decision, from `auto` it runs to completion and the seat
publishes — and the session narrates it either way. See
[Authored plans](workflow-plans.md#running-a-plan).

`/plan ship` is the manual fallback for a publication that should have happened
by itself: answering *Ship* in this session's ship dialog publishes, and so does a
`gates: "none"` run completing, and this is what you type when neither did. It is also the one verb that acts on the
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
| `ask` | available | effect policy with ambiguity audit and confirmations | none |
| `auto` | available | effect policy with ambiguity audit and confirmations | none |
| `hack` | available | reduced, configurable effect policy | none |

A mode is **three facts** and the four names are the only coherent combinations of
them: working-tree access, safeguards, and what happens at the end of a plan run
started from here. `ask` and `auto` are identical in the first two and differ in
the third — the run parks at its ship decision and this session asks you, or the
pull request is published when the run is done.

| Mode | Working tree | Safeguards | End of a plan run | `policy.gates` | Delegation ceiling |
| --- | --- | --- | --- | --- | --- |
| `plan` | read | on | forms none | — | `{workspaceModes: ["read-only"]}` |
| `ask` | write | on | parks at the ship decision | `ship` | `{workspaceModes: ["read-only", "worktree"]}` |
| `auto` | write | on | publishes the pull request | `none` | `{workspaceModes: ["read-only", "worktree"]}` |
| `hack` | write | reduced | forms none | — | none |

**A mode is a permission dial, and the one thing it says beyond permissions is how
a run it starts ends.** No mode says how a plan is *executed*, and no mode refuses
a workflow tool by name. What a mode bounds is every **delegated launch** in the
process, stated in pi-subagent's own vocabulary and consulted at launch time — the
last column above.

A ceiling never widens an agent definition: the effective allowance is the
definition's own declaration intersected with the ceiling. A run is still not the
model's to start in plan mode, and it is pi-workflow that says so — it refuses a
start whose definition needs more than the ceiling allows, naming both the need
and the bound, wherever that start came from. That is a better sentence than a
tool allowlist in this seat could write, and it is true of every launch rather
than of two tool names. Publication is never inside a ceiling: pushing is this
seat's own act, under its own classified Bash policy and a durable human
decision.

### The hand-off

Plan mode is a conversation and the plan lives in it. **Leaving plan mode is Go**:
`/mode ask` or `/mode auto` asks the session's own model — directly, outside the
agent loop, with no tools offered — first for the description and then for the v5
document formed from the plan as written, and then offers the run. Every other mode
change is the plain switch it always was, and so is this one on a host with no
dialog UI or no model.

**`/mode hack` is not a hand-off.** Hack is the unrestricted in-session escape
hatch, and forming a plan into a bounded run is the opposite of what it means, so
leaving plan mode to hack only switches. One notice says the conversation's plan was
not formed and that `/mode ask` or `/mode auto` is what turns a conversation into a
run; a plan already stored keeps `/plan run <slug>`, which itself refuses from hack.

**The mode you leave to decides the end of the run.** Both hand-off modes run the
same four steps and start the same run. One field on the plan's policy differs, and
it is derived from the target mode's own `publication` fact rather than asked:

| Leaving to | `policy.gates` | What the run does at the end | What the confirmation card says |
| --- | --- | --- | --- |
| `ask` | `ship` | Parks at its `ship` decision; this session opens the ship dialog with the gate's inputs rendered | *Stops for your ship decision — this session asks you, in a dialog, with the gate's inputs on screen.* |
| `auto` | `none` | No ship gate: the run completes, its terminal output carries the same receipt and the same ship-gate inputs, and the seat publishes | *Ships the PR when done — starting it is the approval for publication too, and the link lands in this conversation.* |

**The posture does not move here.** It moves on exactly three answers: the run
started, *Just switch, keep the plan stored*, and the one case where the model had
nothing to write a plan from, which switches with the reason shown. Everything
else happens in plan mode, which is why no path out ever offers `/mode plan`: the
seat never left it.

**One dialog, and at most one more.** The effort dial used to come first; schema 8
removed it.

| # | Dialog | Asked | First, marked `(default)` | Escape |
| --- | --- | --- | --- | --- |
| 1 | The plan check's findings, when it found something a rewrite cannot answer: `Proceed anyway` / `Keep planning` | at most once | *Proceed anyway* | *Keep planning* |
| 2 | `Start the run?` with the whole thing on screen: `Start the run` / `Edit the description` / `Just switch, keep the plan stored` / `Keep planning` | once | *Start the run* | *Keep planning* |

**Ordering and escape are two different questions, and this flow answers them
separately.** The first option — the one a `select` highlights, and the only one
labelled `(default)` — is the action you most likely want. Escape is the safe way
out, and it never commits to anything: it starts no run, agrees to nothing, and
writes nothing you did not ask for. **No table lets them be the same row.** One
used to — the effort dial, where every answer was a reversible setting on a run the
confirmation still gated — and it is gone. An answer the list does not recognise
takes the escape too, for the same reason: it is not evidence that anybody chose
anything.

Before the first request the hand-off checks the session's context usage. Above
**80%** of the model's context window it stops with a notice naming the usage and
suggesting `/compact` and then leaving plan mode again: asking a full session for
a plan spends a request on a document that would be truncated.

Nothing else is asked, because nothing else is a question for a human:

| Decision | How it is settled |
| --- | --- |
| Gates | The target mode's: `ask` → `ship`, `auto` → `none`. You answered this by typing `/mode ask` or `/mode auto`, and asking again in a select would be the flow's second opinion about what you said. `every-deliverable` is valid vocabulary, and no dialog offers it yet |
| How hard a role thinks | The session's own model and thinking level, inherited per call; reviews keep their tiers. There is no dial: schema 8 removed `policy.effort`, because one answer was standing in for which model implements, how hard it thinks and how many fix rounds the check buys |
| Publication | Derived: an `origin` remote and `gh` on PATH → `pr`; a remote alone → `branch`; neither → `none` |
| Base branch | What this branch tracks, else `origin`'s head, else `main` |
| Review lenses | The plan's own `reviews` and its `policy.reviewDefault`. Every heavy review whose `diverse` is undefined has `diverse: true` written into the **stored** plan, where the digest covers it; one that says `diverse: false` keeps its answer |
| The delegation ceiling | The posture: `plan` → read-only, `ask` and `auto` → read-only or a worktree, `hack` → none |

The derivation is stated in the confirmation, as one sentence naming what was
found and what follows from it, and lands on the plan as `policy.publish`.

#### The two requests

**The description.** Two or three sentences saying what we are doing and why,
written from this conversation. The request carries the session's own history, a
system prompt asking for plain prose, and no tools. The answer has to be between
40 and 700 characters and carry no code fence and no list; anything else is
re-requested with the previous answer and the problem attached, up to **three
attempts**.

**The document.** One JSON object matching the plan schema, requested with the
field guide, the schema itself, the agreed description, and the dials as decisions
already made — the model does not write them, and the harness attaches them to the
stored document. It goes through the document's own validators, and a document
that does not pass is re-requested with the previous answer and the problems
attached, up to **three attempts**.

When either runs out of attempts, or the provider fails, **the posture moves and
the reason is shown**: leaving plan mode with nothing planned is an ordinary thing
to do, and the person gets what they typed with one sentence saying why there is
no plan behind it. A session replaced mid-request ends the hand-off with nothing
committed and the posture untouched.

#### The plan check

As soon as the document is stored it is read in a fresh context by a one-shot
subagent — the plan document and the agreed description, read-only tools, no
workspace, and none of this conversation. See
[the plan check](workflow-plans.md#the-plan-check).

**The harness acts on the findings itself.** There is no walk:

| What the check said | What happens |
| --- | --- |
| Nothing blocking | Dialog 2, with the verdict, the counts and the findings summarised. `major` and `minor` are read there and never asked about |
| Blocking, with directions and no `needsPerson` | The findings go back to the plan's author, the document is rewritten, stored and checked again — silently, **twice at most** |
| Any `needsPerson`, or the bound spent | Dialog 1, with those findings and their questions and nothing else |
| It could not run | Dialog 2 says so and names the reason, sanitized |

#### The confirmation, and the run

Dialog 2 carries everything that is being agreed to: the description in full, the
plan (each deliverable with its tasks, its `after` edges, and who reads its work),
the gates, where publication goes and why, what the check said, and **which ending
you are starting** — the card names the mode and says either *Ships the PR when
done* or *Stops for your ship decision*.

- *Start the run* starts it in the harness —
  `startBuiltin("plan-to-ship", {input, ceiling})`, with the **target** mode's
  ceiling — and then switches to the posture asked for at `/mode`. Starting it is
  the approval, and from `auto` it is the approval for publication too. A runtime
  that refuses leaves the plan stored, takes the posture, and prints the cause.
- *Edit the description* opens an editor and comes back to this same
  confirmation; escaping the editor discards the edit. The description is the
  yardstick, so changing it is a change to what is being agreed, not a way out of
  agreeing.
- *Just switch, keep the plan stored* switches the posture and starts nothing.
- *Keep planning* is what escape takes: nothing runs, nothing switches, and the
  plan is stored with `/plan run <slug>` there when you want it.

A two-deliverable plan on a seat with a working plan check that finds nothing
blocking asks **one** dialog in total: the confirmation.

**What the conversation is told.** One message when the plan is stored, one per
rewrite the check asked for, and one more when the run starts or the hand-off goes
back: the slug, its digest, how many deliverables it has, and the outcome —
naming the run id when a run started, and saying that the harness started it
rather than the conversation. Nothing else the harness did appears in the
transcript, including the check's findings. Every request it made is on the record
in `authoring.json` beside the plan — see [State](#state).

**Then the session narrates the run, and asks what it has to ask.** Each task
completion is one line in a `maestro:progress` message; a review synthesis, a fix
report, a failure, the ship gate arriving and a run that ends without a gate each
get the model a turn to say what it means. Three of those are decisions rather than
news, and each opens a dialog in this session — see
[the run, and the session that narrates it](workflow-plans.md#the-run-and-the-session-that-narrates-it)
and [the decisions](workflow-plans.md#the-decisions-a-run-asks-for).

Two fallbacks keep a reduced seat working. Without a workflow runtime the
hand-off stops before the confirmation, says so, and leaves `/plan run <slug>` as
the way to start it. Without a reachable subagent runtime the plan check says so
in the confirmation and the hand-off continues. Neither throws into the session.

## Seat tools

- `bash` runs on the host after mode-aware classification.
- `delete` moves explicitly named paths to recoverable trash.
- `plan_ship_dialog` opens the parked ship decision as a dialog, with the gate's
  own inputs in it. It **decides nothing**: the person answers the dialog. It is
  offered only while a run of this session is actually parked at a ship decision,
  which is read at call time — so "ship it" in the conversation reaches the same
  dialog the gate opens, and a session with nothing parked is told so by name.
- Pi's built-in `write` and `edit` remain available in ask, auto and hack.
- `ask_user_question` comes from
  `@juicesharp/rpiv-ask-user-question` for model-authored clarifications.
- `subagent` is supplied independently by `@vegardx/pi-subagent`.

There is **no plan-authoring tool**. Writing a plan is not a tool call: the
hand-off asks the model for the document directly and validates it itself — see
[The hand-off](#the-hand-off).

**No workflow tool is refused by name in any posture.** The seat withholds
`write`, `edit` and `delete` in plan mode, and that is the whole tool rule. What
a delegated launch may do is the mode's **ceiling**, stated in pi-subagent's own
vocabulary and consulted at every launch in the process — so `workflow_run` in
plan mode is refused by pi-workflow, where the launch happens, with a sentence
naming what the definition needs and what the ceiling allows.

Pi-maestro does not bundle a subagent, workflow, or web implementation.

## State

Authored plans live under their project's key, beside that project's sessions:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
```

The envelope is `{schemaVersion: 7, savedAt, authoredBy: {sessionId, cwd}, body}`.
`authoredBy` is required, and a schema 7 envelope — whose `policy` carries the
`effort` dial version 8 removed — is refused by name rather than
migrated.

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

What the hand-off asked the model, what the plan check said, and what came back,
is recorded beside the plan it was asking for:

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/authoring.json
```

It holds `{schemaVersion: 2, attempts: [...]}`, one entry per request:
`{kind, startedAt, durationMs, model, thinking, ok, problems, responseDigest}`,
where `kind` is `intent`, `plan`, `revise` or `check`. A `check` entry adds
`verdict` and `counts` — what the plan check said about the plan and how many
findings of each severity — and nothing else: the findings themselves are prose
about somebody's repository, and this file is a record of what the harness did.
`problems` are the validator's own sentences, or the one sanitized reason a check
could not run, and never a provider error, a stack, a path or any of the answer's
text; `responseDigest` stands in for the answer — enough to tell two attempts
apart and not enough to read either.

**Nothing joins the hand-off's steps on disk**, because nothing has to: it never
yields to a model turn, so it is one flow inside one `/mode` call. A session that
goes away mid-hand-off has no hand-off. A `.pending/` directory left by an older
build is inert — nothing reads it.
