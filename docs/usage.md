# Usage

## Install and verify

```bash
pi install git:github.com/vegardx/pi-maestro
```

Run `/maestro setup` once after loading the extension. It shows the exact pinned
`pi-workflow`, `pi-subagent`, `pi-web-access`, and
`@vegardx/agent-toolkit` changes and asks before updating global Pi settings.
Reload Pi afterwards. `/maestro doctor` is read-only and checks the package
pins and toolkit discovery, repository identity, Git signing, and GitHub
authentication.

The seat loads `@juicesharp/rpiv-ask-user-question` for model-authored planning
clarifications. The deterministic Plan → Auto and setup confirmations still use
Maestro's blocking approval capability because they are seat gates, not model
tool calls.

## Modes

| Mode | Working tree | Safeguards | Intended use |
| --- | --- | --- | --- |
| `plan` | read-only | on | discuss and author a workflow plan |
| `auto` | writable | on | run an approved autonomous workflow |
| `hack` | writable | off | direct, explicitly unsafeguarded seat work |

`/mode` reports the current mode. From plan mode, `/mode auto` selects the most
recent stored plan, renders its repositories, dependency graph, review
cohorts, models, and authority boundaries, and asks one blocking approval
question. Refusal leaves the seat in plan mode and creates no branch or
worktree. Approval changes the seat to auto and starts the workflow.

In auto mode, `/run <slug>` runs or recovers a named plan. `/run` with no
argument lists stored plans. Workflow runs are autonomous, so `/stop` is not a
workflow control; rerunning the same plan recovers its durable state after a
seat or supervisor failure.

## Plans and repositories

Planning remains a conversation. The maestro writes the complete plan through
the `plan` tool once the repositories, deliverables, dependencies, and review
intent are settled. Repository paths may be children of a non-Git umbrella
directory, so one plan can coordinate several independent repositories.

Each deliverable names:

- its repository and implementation work;
- `after` dependencies, which order deliverables;
- `reads` dependencies, which identify results it must consume;
- zero or more review tasks.

A review task contains a lens, a concrete provider/model, and optionally the
name of an ambient skill to invoke. There is no persona layer. Repeating the
same lens with different models creates independent reviewers—for example,
security with Opus, Fable, and Grok. If no skill is named, Pi's normal skill
discovery remains enabled and the lens prompt may trigger one.

## What happens after approval

Maestro runs three flat workflows with deterministic seat-owned boundaries:

```text
implementation workflow (write files; no Git authority)
  -> seat creates ordinary signed commits
  -> parallel review workflow (read-only)
  -> seat deduplicates findings and removes reviewer identity
  -> decision workflow (write files; no Git authority)
  -> seat commits accepted changes
  -> exact decision and Git-lineage gate
  -> seat pushes branches and creates or updates pull requests
```

Reviewers report only a claim and evidence. They do not prescribe a fix. The
decision model receives the de-attributed list and must record exactly one
`changed` or `no_change` decision, with reasoning, for every finding. There is
no verifier and no second review round.

Commits contain ordinary task-oriented messages. Reviewer/model attribution is
kept only in seat-private local state for later analysis; it is not written to
commits or pull requests. Pull requests contain the intended behavior, the
authored rationale, and the resulting changes.

## Isolation and authority

Every phase runs in a sealed supervisor environment. Implementation and
decision phases may write only approved worktrees and workflow state. Review
phases can read approved worktrees but cannot write them. Workflow descendants
receive neither Git publication credentials nor commit authority. The seat
performs commits, pushes, and pull-request operations after validating the
branch, clean tree, exact final heads, decisions, and lineage.

The sandbox is designed primarily to prevent accidental filesystem damage and
accidental cross-phase disclosure. It is not a hostile same-user process
security boundary.

## Usage footer

The footer shows token and cache-read usage for the current seat session and
for all tracked workflow agents in the Maestro session. When space is tight it
keeps the seat value and drops the aggregate value first.

See [workflow-plans.md](workflow-plans.md) for the compiled workflow contract,
[commands.md](commands.md) for the command surface, and
[settings.md](settings.md) for configuration.
