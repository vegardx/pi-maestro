# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change posture; plan → auto previews, asks once, then launches |
| `/run [slug]` | List plans, or run/recover a named plan while in auto mode |
| `/stop [why]` | Legacy rollback path only; autonomous workflow runs refuse this command |
| `/maestro [subcommand]` | Open settings, reconcile package pins, or run diagnostics |

`/run` is the workflow recovery operation as well as the launch operation.
Durable phase journals, package run state, repository checkpoints, and
shipping journals determine what resumes; completed phases and commits are not
replayed.

## `/maestro` subcommands

The settings extension owns the single `/maestro` command:

```text
/maestro show
/maestro get <key>
/maestro set [--session|--project|--global] <key> <JSON-value>
/maestro reset [--session|--project|--global] <key>
/maestro explain <model-role>
/maestro validate
/maestro region
/maestro setup
/maestro doctor
```

`setup` requires one human approval before changing global package settings.
It does not install or execute packages. `doctor` performs read-only checks.

## Modes

| Mode | Working tree | Safeguards |
| --- | --- | --- |
| `plan` | read-only | on |
| `auto` | writable | on |
| `hack` | writable | off |

The workflow path is the default. It can temporarily be disabled with the
`maestro.workflowCutover` feature kill switch while the legacy executor remains
available for rollback.

## Seat tools

- `plan` authors or replaces the whole plan and returns all validation errors
  together. Delegated review tasks use `{lens, model, skill?}`; they do not use
  personas.
- `bash` is the seat's gated shell.
- `subagent` remains available for an explicit conversational consultation,
  but workflow review cohorts are launched by `pi-workflow`, not nested through
  this tool.
- `respond` and `flight` are retained by the legacy rollback path and are not
  part of workflow-native execution.

Workflow model stages use Pi's normal file tools within their phase sandbox.
They do not receive Maestro commit, push, pull-request, or nested-subagent
authority. Review stages are read-only. The depth-zero seat performs Git
checkpoints and shipping deterministically between phases.

`ask_user_question` comes from `@juicesharp/rpiv-ask-user-question` and is the
model-facing planning clarification tool. Maestro's internal ask capability is
retained for deterministic setup and Plan → Auto approval gates; autonomous
workflow model phases do not conduct a question-and-answer loop with the user.

## State

Authored plans remain under `<agentDir>/maestro/plans/<slug>/`. A workflow run
gets its own coordinated umbrella containing linked worktrees, package runtime
state, and sealed scratch runtimes. Seat-private approval, review provenance,
decision, checkpoint, and shipping records live outside descendant-writable
roots.
