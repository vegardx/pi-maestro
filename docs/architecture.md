# Architecture

Pi-maestro is a composition package around public Pi extensions. One interactive
Pi process is the seat; model work runs through `pi-workflow` and
`pi-subagent` using the operator's normal Pi configuration and ambient skills.

```text
interactive seat
  modes · plan store · approval · publish · footer
       |
       `-- pi-workflow
             ├─ implementer tasks  [edit + validate + local commit]
             ├─ reviewer tasks     [read-only + advisory suggestions]
             `─ fixer tasks        [edit + validate + follow-up commit]
                  |
                  `-- pi-subagent model processes
```

There is no custom worker socket, executor, child runtime, scheduler, question
transport, or recovery layer.

## Ownership

| Concern | Owner |
| --- | --- |
| Workflow scheduling, artifacts, status, resume | `@agwab/pi-workflow` |
| Delegated model process lifecycle | `@agwab/pi-subagent` |
| Model-authored human questions | `@juicesharp/rpiv-ask-user-question` |
| Web tools | `pi-web-access` |
| Plan vocabulary and compilation | pi-maestro |
| Mode posture and guarded seat shell | pi-maestro |
| Local commits | implementer/fixer workflow tasks |
| Push and pull requests | interactive-seat `/publish` command |
| Usage footer | pi-maestro |

## Plans

The authored plan describes repositories, deliverables, `after` ordering,
`reads` relationships, implementation tasks, and delegated review tasks. The
compiler lowers it to one ordinary `pi-workflow` artifact graph:

- implementation stages follow deliverable and same-repository ordering;
- review stages run after their implementation stage;
- one fixer stage per reviewed deliverable reduces all review artifacts.

The compiler does not create another scheduler or run journal.

## Authority

- Implementers and fixers may edit the named repository and create local
  commits. Their prompts explicitly prohibit push and PR creation.
- Reviewers inspect committed work and return evidence plus advisory
  suggestions. Their stages are declared read-only.
- `/publish` refuses the default branch, dirty worktrees, branches with no new
  commits, and branches not based on the remote default branch.
- The seat asks for confirmation immediately before workflow launch and
  publication.

## State

```text
<agentDir>/maestro/plans/<slug>/plan.json   authored intent
<cwd>/.pi/maestro/workflows/               compiled workflow bundles
<cwd>/.pi/workflows/                        pi-workflow-owned run state
```

Failed or interrupted work is inspected and resumed with pi-workflow's own
commands. Pi-maestro stores no duplicate execution or recovery projection.

## Extension loading

The root Pi package manifest loads thin adapters for the public ask, subagent,
workflow, and web packages, followed by pi-maestro's local extensions. Skills
ship from the root `skills/` directory and use normal Pi ambient discovery.
