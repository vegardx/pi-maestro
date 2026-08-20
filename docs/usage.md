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
| `plan` | blocked | reads allowed; writes/code/uncertain refused | discuss and author plans |
| `auto` | available | effect-aware with ambiguity audit | ordinary direct seat work |
| `hack` | available | reduced configurable policy | explicit direct work |

Switch posture with:

```text
/mode plan
/mode auto
/mode hack
```

Auto and hack have no OS filesystem boundary. They are explicit choices to let
the interactive seat use host-backed `write`, `edit`, `delete`, and `bash` tools.
Bash accepts an optional `intent` hint and audits unresolved plan/auto commands;
validated help/version probes let the auditor inspect unfamiliar PATH commands
without granting it a general shell. Most substantial implementation work should
be delegated to isolated subagents.

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
- the `repository-lifecycle` skill guides direct commits, pushes, pull requests,
  checks, and checked rebase merges. Future workflow postflight shipping uses a
  separate approved harness authority rather than model-selected Bash.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
