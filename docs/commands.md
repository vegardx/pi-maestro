# Command and tool reference

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Report or change the interactive seat posture |

Workflow execution and publication commands are intentionally absent until the
owned workflow extension is built.

## Modes

| Mode | Direct file tools | Bash classifier | OS write boundary |
| --- | --- | --- | --- |
| `plan` | `write`, `edit`, and `delete` blocked | write effects refused | none |
| `auto` | available | guided by execution policy | none |
| `hack` | available | safeguards off | none |

## Seat tools

- `plan` authors or replaces the whole plan and returns all validation errors
  together. Delegated reviews use `{lens, model, skill?}`.
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

There is no workflow run state or compiled workflow bundle until the owned
workflow extension is introduced.
