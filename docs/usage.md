# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Reload Pi after installation. The package includes its public extension
dependencies and bundled skills; no separate `/maestro setup` step is required.

## Modes

| Mode | Working tree | Safeguards | Intended use |
| --- | --- | --- | --- |
| `plan` | read-only | on | discuss and author plans |
| `auto` | writable | on | run approved plans and publish committed work |
| `hack` | writable | off | explicit direct work without safeguards |

## Plan and run

Planning remains a conversation. The `plan` tool writes the complete plan after
requirements, repositories, dependencies, implementation work, and review
cohorts are understood.

Every repository path must point at an exact Git working-tree root with a
checked-out branch. The tree must be clean at workflow launch. Default-branch
and ancestry checks belong to `/publish`, not workflow compilation.

Run the newest plan while moving from plan to auto:

```text
/mode auto
```

Or run a named plan:

```text
/run payments-retry
```

Before launch, pi-maestro renders repositories, branches, models, review skills,
and authority. Approval compiles and starts one normal `pi-workflow` run.

## Workflow behavior

For each deliverable:

1. An implementer works in the authored repository, runs focused validation,
   and creates a conventional local commit.
2. Reviewers inspect the committed branch through their authored lens and skill.
   They return evidence-backed findings with advisory suggestions and do not
   modify files.
3. A fixer reads all review artifacts, decides which suggestions are justified,
   applies changes, validates, and creates a new follow-up commit when needed.

Workflow tasks never push or create pull requests.

Use ordinary pi-workflow commands to inspect, wait for, stop, or resume runs.
Pi-maestro has no separate recovery surface.

## Publish

After a workflow leaves clean committed feature branches:

```text
/publish payments-retry
```

The command asks for confirmation, then for every authored repository:

- verifies the worktree is clean;
- refuses the default branch;
- verifies the remote default branch is an ancestor;
- pushes the current feature branch;
- creates or updates its pull request using plan-authored intent and changes.

## Questions, delegation, and web access

- `ask_user_question` is provided by
  `@juicesharp/rpiv-ask-user-question`.
- `subagent` is provided by `@agwab/pi-subagent`.
- `workflow_*` tools and `/workflow` are provided by `@agwab/pi-workflow`.
- web research tools are provided by `pi-web-access`.

Pi-maestro only supplies thin package adapters and does not reimplement those
surfaces.

## Footer

The custom footer shows current context usage, model, and mode. Workflow and
subagent packages retain their own detailed run and usage views.
