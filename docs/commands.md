# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change the interactive seat posture. Leaving plan mode asks the [exit questions](#leaving-plan-mode) first |
| `/plan list` | Every stored plan: slug, title, deliverable count, when it was last written |
| `/plan show <slug>` | Read one back whole: repositories, deliverables with `after`/`reads`, tasks, review intent, and any warning about the world |
| `/plan run <slug> [cheap\|standard\|deep]` | Build the workflow input for a stored plan and hand it to the model. Effort defaults to `standard` |
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
`maestro:workflow-shipped`, and the seat offers the same publication for the
stored plan that digest matches — one confirmation first, then the steps above.

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

Nothing is compiled, reviewed or run by these dialogs, and nothing here starts a
model turn other than the request for the document.

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
