# pi-maestro

A [Pi](https://pi.dev/) extension stack for turning an approved plan into an
autonomous, multi-repository implementation and review workflow.

Maestro keeps the user-facing modes, plan approval, Git checkpoints, usage
footer, and shipping authority. Durable model orchestration runs through
`@agwab/pi-workflow` and `@agwab/pi-subagent`; web access comes from
`pi-web-access`, structured planning questions from
`@juicesharp/rpiv-ask-user-question`, and globally discoverable review skills
from the separately versioned
[`@vegardx/agent-toolkit`](https://github.com/vegardx/agent-toolkit).

## The workflow

```text
conversation in plan mode
  -> Maestro stores a repository-qualified DAG
  -> /mode auto renders one approval view
       ├─ No  -> remain in plan; create nothing
       └─ Yes -> prepare linked worktrees
                 -> implementation workflow (write, no Git authority)
                 -> seat creates normal signed commits
                 -> parallel read-only review workflow
                 -> seat deduplicates and de-attributes findings
                 -> decision workflow records one decision per finding
                 -> seat commits accepted changes
                 -> exact decision and Git-lineage gate
                 -> seat pushes and creates/updates pull requests
```

The graph is flat. Reviewers do not spawn nested agents, prescribe fixes, or
run repeated verification rounds. A review task is simply a lens, a concrete
model, and optionally an ambient skill name. The same lens can be repeated on
several models.

Reviewer/model attribution stays in a seat-private local ledger for analysis.
Commits remain ordinary human-readable Git history, and pull requests describe
intent, rationale, and changes rather than the internal review process.

## A session

```text
/maestro setup              # approve exact package pins; reload Pi
/maestro doctor             # read-only setup/Git/GitHub checks

# Talk through the work while in plan mode. Maestro writes the plan.
/mode auto                  # preview + one approval + autonomous execution
/run payments-retry         # explicit launch or crash recovery in auto mode
```

`plan`, `auto`, and `hack` remain available. Workflow runs are autonomous, so
the workflow-native path does not expose start/stop choreography. The footer
shows tokens and cache reads for the seat and all tracked workflow agents.

One Pi session may start from a non-Git umbrella directory and coordinate
several independent repositories. Dependencies can cross repository boundaries;
Maestro owns one linked worktree and branch per repository for the run, and the
depth-zero seat is the only component allowed to commit or publish.

## Docs

- [Usage](docs/usage.md) — installation, modes, lifecycle, authority, and footer.
- [Workflow plans](docs/workflow-plans.md) — plan schema and compiled phases.
- [Commands](docs/commands.md) — exact command and tool surface.
- [Settings](docs/settings.md) — configuration scopes and model routing.
- [Workflow cutover design](docs/design/workflow-cutover-plan.md) — decisions,
  contracts, tests, and remaining live-proof work.

## Development

```bash
npm install
npm run check
npm run test:e2e
```

The installed-extension live workflow drive is the remaining acceptance gap
for real providers, Git identity/signing, and hosted shipping. There is no
legacy executor or legacy live-drive command.
