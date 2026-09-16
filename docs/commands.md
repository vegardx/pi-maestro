# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change the interactive seat posture |
| `/plan list` | Every stored plan: slug, title, deliverable count, when it was last written |
| `/plan show <slug>` | Read one back whole: repositories, deliverables with `after`/`reads`, tasks, review intent, and any warning about the world |
| `/plan run <slug> [cheap\|standard\|deep]` | Build the workflow input for a stored plan and hand it to the model. Effort defaults to `standard` |
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

There is no publication verb. A `ship` subcommand arrives together with the
publication path described in
[Authored plans](workflow-plans.md#publishing-what-a-run-produced); until it is
registered, the grammar above is the whole of `/plan` and publishing a run's
handoff is manual `git` and `gh` work.

## Modes

| Mode | Direct file tools | Bash classifier | OS write boundary |
| --- | --- | --- | --- |
| `plan` | `write`, `edit`, and `delete` blocked | reads allowed; writes/code/uncertain refused | none |
| `auto` | available | effect policy with ambiguity audit and confirmations | none |
| `hack` | available | reduced, configurable effect policy | none |

A workflow run may be started from any mode, including `plan`: a run mutates
neither the working tree nor the host, and what it produces reaches a branch
only through publication, which a human decides separately.

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

`/plan run` writes the input it built beside the plan it built it from:

```text
<agentDir>/maestro/plans/<slug>/workflow-input.json
```

That file is an export, not state: it is rewritten by every `/plan run` and
nothing reads it back. There is no workflow run state or compiled workflow
bundle in this package; a run's state belongs to the runtime that owns it.
