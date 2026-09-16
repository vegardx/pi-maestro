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

**Starting a workflow run from `plan` mode is intended, not a loophole.** A run
mutates neither the working tree nor the host: its implementation work happens in
a sandboxed subagent attempt against a worktree of its own, its output is a
handoff commit in the repository's object store, and nothing reaches a branch or
a remote until publication — a separate step, decided by a human, outside the
run. A read-only research or review run started while planning is therefore an
ordinary thing to do, and the mode's refusal rail is not the thing that makes it
safe.

## Planning

Planning remains a conversation. The `plan` tool writes the complete authored
plan after requirements, repositories, dependencies, implementation work, and
review intent are understood.

Plans are validated and stored under:

```text
<agentDir>/maestro/plans/<slug>/plan.json
```

Storing a plan is not running one. `/plan run <slug> [cheap|standard|deep]`
builds the workflow input and hands the session a
`workflow_run { ref: "plan-to-ship", input }` call; standalone
`@vegardx/pi-workflow` owns compilation, approval, execution, recovery, and the
receipt from there. This package's responsibility ends at a validated document
and a run request — and picks up again at publication, which is pi-maestro's own
audited Bash work and never the runtime's.

## Leaving plan mode with a run

**Design. It lands with this release line; nothing below is registered yet.**

Switching out of `plan` mode when there is a conversation but no plan becomes a
two-phase flow, split by exactly one model turn, because a dialog sequence cannot
obtain a plan document from the conversation:

1. **Phase one, in the `/mode` handler.** Six questions at most, each asked once:
   compile the conversation into a workflow run or just switch; effort; which
   gates the run stops at; whether publication is none, a branch, or a pull
   request; the base branch; and one line of intent for the blind reviewer.
   Declining the first question keeps the conversation and leaves the mode
   unchanged. The answers are recorded, the mode switches, and the session is
   steered to write the plan.
2. **The model turn.** The model calls `plan` with the whole document, carrying
   those answers verbatim as the plan's `policy` block, so the choices are part
   of the document that gets validated, digested, and reviewed. With this flow
   the `plan` tool is no longer registered in `plan` mode, which is what keeps
   planning a conversation.
3. **Phase two, when the plan stores.** Readiness on every repository the plan
   names, then the per-deliverable review lenses, then compilation with a budget
   projection, then an optional blind review of the compiled graph, and finally
   one confirmation. The run itself is still the model's `workflow_run` call, in
   the open, in the transcript — the flow never starts it behind the session's
   back.

Escape is always an answer: declining at the start keeps the mode, escaping a
per-deliverable dialog keeps what the plan already said, going back to the
conversation after a review leaves the findings printed, and declining the last
confirmation stores the plan and runs nothing. `/plan run` remains available
afterwards either way.

### Readiness is not preflight

**Readiness** is this harness step: each repository the plan names exists, is a
working-tree root, is clean, has the base branch the policy asked for, and has
`gh` on PATH when a pull request was requested. Creating a missing repository is
confirmed, and every command it runs goes through the same audited Bash
classifier as anything else the seat does.

**Preflight** is not a pi-maestro word. It belongs to `@vegardx/pi-subagent`,
where it names the launch-plan compile for a delegated attempt. The two steps
answer different questions in different processes, so this repository calls its
own step readiness everywhere and leaves preflight alone.

## Questions and delegation

- `ask_user_question` is provided by
  `@juicesharp/rpiv-ask-user-question`.
- `subagent` is provided independently by `@vegardx/pi-subagent`.
- workflow tools are provided independently by `@vegardx/pi-workflow`; web
  tools are unavailable until their owned replacement is built.
- the `repository-lifecycle` skill guides direct commits, pushes, pull requests,
  checks, and checked rebase merges. Shipping downstream of a plan run belongs
  to pi-maestro's own audited Bash authority, not to model-selected Bash: the
  workflow runtime never pushes, merges, or publishes (its own
  `docs/authority.md` says so), and publication happens here, after the run's
  ship gate, under the mode's confirmation policy. Until the `ship` verb of
  `/plan` lands with that publication path, publishing a run's handoff is manual
  `git` and `gh` work under this skill.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
