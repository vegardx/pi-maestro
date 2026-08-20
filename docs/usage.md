# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Reload Pi after installation. Configure `@vegardx/pi-subagent` separately when
delegated execution is wanted. Workflow and web extensions are intentionally not
bundled.

## Modes

| Mode | Direct file tools | Bash classifier | Intended use |
| --- | --- | --- | --- |
| `plan` | blocked | write effects refused | discuss and author plans |
| `auto` | available | guided/confirming | ordinary direct seat work |
| `hack` | available | safeguards off | explicit unrestricted direct work |

Switch posture with:

```text
/mode plan
/mode auto
/mode hack
```

Auto and hack have no OS filesystem boundary. They are explicit choices to let
the interactive seat use host-backed `write`, `edit`, `delete`, and `bash` tools.
Most substantial implementation work should be delegated to isolated subagents.

## Planning

Planning remains a conversation. The `plan` tool writes the complete authored
plan after requirements, repositories, dependencies, implementation work, and
review intent are understood.

Plans are validated and stored under:

```text
<agentDir>/maestro/plans/<slug>/plan.json
```

They are not executable yet. The future owned workflow extension will define
compilation, approval, execution, recovery, and publication.

## Questions and delegation

- `ask_user_question` is provided by
  `@juicesharp/rpiv-ask-user-question`.
- `subagent` is provided independently by `@vegardx/pi-subagent`.
- workflow and web tools are unavailable until their owned replacements are
  built.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
