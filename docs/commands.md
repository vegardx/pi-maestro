# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change posture; plan → auto previews and runs the newest stored plan |
| `/run [slug]` | List plans or compile and run one through `pi-workflow` |
| `/publish <slug>` | Validate committed feature branches, push them, and create or update pull requests |
| `/maestro [subcommand]` | Open or edit Maestro settings |

`/run` starts an ordinary `pi-workflow` run. Failed or interrupted workflow work
is inspected and resumed through pi-workflow's own command surface; pi-maestro
has no parallel recovery system.

## `/maestro` subcommands

```text
/maestro show
/maestro get <key>
/maestro set [--session|--project|--global] <key> <JSON-value>
/maestro reset [--session|--project|--global] <key>
/maestro explain <model-role>
/maestro validate
/maestro region
```

## Modes

| Mode | Working tree | Safeguards |
| --- | --- | --- |
| `plan` | read-only | on |
| `auto` | writable | on |
| `hack` | writable | off |

## Seat tools

- `plan` authors or replaces the whole plan and returns all validation errors
  together. Delegated reviews use `{lens, model, skill?}`.
- `bash` is the seat's gated shell.
- `delete` moves explicitly named paths to recoverable trash.
- `ask_user_question` comes from
  `@juicesharp/rpiv-ask-user-question` for model-authored clarifications.
- `subagent`, `workflow_*`, and web tools come from their public Pi packages.

Pi-maestro does not implement a second subagent, workflow, question, or web
stack.

## Workflow authority

- Implementer and fixer stages edit, validate, and create local commits.
- Review stages inspect committed work and return findings with advisory
  suggestions; they do not modify files.
- No workflow stage pushes or creates pull requests.
- `/publish` is the interactive-seat boundary for push and PR creation.

## State

Authored plans remain under `<agentDir>/maestro/plans/<slug>/`. Compiled workflow
bundles are written under `<cwd>/.pi/maestro/workflows/`; pi-workflow owns run
state under `<cwd>/.pi/workflows/`.
