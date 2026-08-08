# Architecture

One interactive Pi process is the depth-zero Maestro seat. The workflow-native
path launches a dedicated sandboxed supervisor process; `pi-workflow` schedules
flat tasks and `pi-subagent` launches their Pi model processes. Workflow agents
do not dial a custom Maestro socket and do not recursively spawn agents.

```text
depth 0 seat
  modes · plan store · approval · repository prep · commits · ledger · shipping
       |
       +-- implementation supervisor  [approved worktrees writable]
       |     `-- pi-workflow -> pi-subagent -> model tasks
       |
       +-- review supervisor          [approved worktrees read-only]
       |     `-- pi-workflow -> pi-subagent -> model tasks
       |
       `-- decision supervisor        [approved worktrees writable]
             `-- pi-workflow -> pi-subagent -> one decision task
```

There is no custom worker socket, persona runtime, or alternate executor.

## Authority boundaries

The depth-zero seat owns all durable authority transitions:

- show the compiled plan and persist one human approval;
- resolve repository base branches and commits, then create linked worktrees;
- create ordinary local commits after implementation and decision phases;
- normalize review findings and retain contributor provenance privately;
- validate exact finding decisions, changed paths, commit references, branches,
  ancestry, clean trees, and final heads;
- non-force push each branch and create or update its pull request.

Model tasks can edit only during write phases. They receive no commit, push,
GitHub, Maestro socket, or nested-subagent authority. Review tasks receive a
read-only filesystem boundary. All descendants inherit a replacement
environment with a private Pi home, approved provider credentials only, no
publication credentials, and a sealed snapshot of `agent-toolkit`.

The outer sandbox is an accidental-damage boundary: it prevents descendants
from writing outside the coordinated run's approved worktrees/runtime/scratch.
It is not intended to defeat a deliberately hostile process running under the
same OS user.

## Plans and workflow state

The authored plan is repository-qualified intent: deliverables, ordered
implementation tasks, `after` edges, `reads` edges, and review tasks expressed
as `{lens, model, skill?}`. It contains no runtime task IDs, personas, commits,
or pull-request state.

Compilation creates three package-native workflow specs. Because
`pi-workflow` 0.11 does not honor stage-specific cwd during compilation, every
prompt names its approved worktree and the phase supervisor receives the exact
coordinated repository set. Same-repository implementations are serialized;
cross-repository `after` dependencies remain graph edges.

Runtime state is intentionally split:

```text
<agentDir>/maestro/plans/          authored plans
<agentDir>/maestro/workflow-state/ seat-private approvals, ledgers, checkpoints
<agentDir>/maestro/workflow-runs/  per-run coordinated umbrellas
  <run>/repos/                     linked worktrees
  <run>/runtime/.pi/workflows/     pi-workflow durable state
  <run>/scratch/workflow-supervisors/<phase>/
                                   sealed per-phase Pi runtimes
```

The command-run identity, runner journal, package run records, repository
registry, checkpoint journal, and shipping journal make `/run <slug>` the
recovery operation. A changed plan cannot silently resume an approved digest;
a failed pre-approval preview is released so a corrected plan starts fresh.

## Review and decisions

Reviewers report claim plus evidence. A deterministic normalizer strips unknown
fields, validates repository/path evidence, deduplicates mechanically, and
separates the public finding projection from private lens/model/task
provenance. The decision task receives only `{id, claim, evidence}`.

Completion requires exactly one decision per finding. `changed` decisions must
name paths that the seat actually committed after the implementation
checkpoint; `no_change` decisions require reasoning and no commit. The gate
checks coverage and lineage, never whether the model made the "right" choice.

## Packages

| Package/module | Responsibility |
| --- | --- |
| `@agwab/pi-workflow` | durable flat workflow scheduling and task records |
| `@agwab/pi-subagent` | model-process launch and usage reporting |
| `pi-web-access` | workflow web tools |
| `@vegardx/agent-toolkit` | ambient review skills, installed separately |
| `maestro/workflow/*` | approval, supervisor, phase composition, ledgers, checkpoints, shipping |
| `ask` + rpiv adapter | deterministic seat approvals and model-facing planning questions |
| `contracts`, `core`, `settings` | capability vocabulary, feature gates, `/maestro` configuration |
| `git`, `github` | typed deterministic Git/GitHub operations |

## The defect this remains organised against

A capability must not be independently named in its grant, implementation,
description, and verification. Declarations derive those views and reject
drift at construction. Workflow manifests extend the same rule: approved specs,
model/profile artifacts, repository roots, toolkit tree, environment digest,
and writable/read-denied roots are bound once and re-verified inside the child
before scheduling.

See [workflow-plans.md](workflow-plans.md), [usage.md](usage.md),
[commands.md](commands.md), and [e2e-testing.md](e2e-testing.md).
