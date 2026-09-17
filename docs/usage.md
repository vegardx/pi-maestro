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
audited Bash work and never the runtime's. See
[Authored plans](workflow-plans.md#publishing-what-a-run-produced).

## Leaving plan mode with a run

Switching out of `plan` mode when there is a conversation but no plan is a flow
split by two model turns, because a dialog sequence cannot obtain anything from
a conversation:

1. **Two dialogs, in the `/mode` handler.** Compile the conversation into a
   workflow run, just switch, or keep planning; then how much effort the run may
   spend. That is all that is asked. Gates take their default, and publication
   and the base branch are derived from the repository and announced. The
   answers are recorded — and **the mode does not change**.
2. **The description.** The model writes two or three sentences saying what we
   are doing and why, and submits them with `plan_intent`. One dialog agrees,
   edits, or sends you back to the conversation. The agreed text is what the
   blind reviewer checks the plan against, and it is what opens the `plan`
   tool's window — which is the only moment `plan` exists in plan mode.
3. **The model turn.** The model calls `plan` with the whole document, carrying
   the recorded answers verbatim as the plan's `policy` block, so the choices
   are part of the document that gets validated, digested and reviewed.
4. **The second half, when the plan stores.** Readiness on every repository the
   plan names; every heavy review lens gets `diverse: true` written into the
   stored plan so both compilers agree; compilation with a budget projection; an
   optional blind review of the compiled graph, with an editor behind it for
   changing reviewers; the findings walk; and one confirmation. That last *yes*
   is where the posture finally becomes the one asked for in step 1. The run
   itself is still the model's `workflow_run` call, in the open, in the
   transcript — the flow never starts it behind the session's back.

Escape is always an answer, and it is always the **safe** one — never the
first-listed one, which is a different thing: the first option is what you most
likely want, and escape is what commits to nothing. Escaping the start keeps
planning, escaping the description dialog goes back to the conversation rather
than agreeing on your behalf, escaping the compiled document starts no reviewer
and no run, and declining the last confirmation stores the plan and runs
nothing. Every ending but the run leaves you in plan mode with `/plan run
<slug>` and `/mode auto` both named. The dialog tables, with a column for each
of the two, are in the
[command reference](commands.md#leaving-plan-mode).

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
  ship gate, under the mode's confirmation policy. `/plan ship <slug>` performs
  it: branch, cherry-pick, the repository's check on the host, one confirmation,
  push, and a pull request when the plan's policy asked for one. Publishing a
  handoff by hand, when one of those steps stops, is `git` and `gh` work under
  this skill.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
