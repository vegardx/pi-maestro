# Authored plans

An authored plan describes repositories, deliverables, dependency edges,
implementation tasks, and delegated reviews. It is intent, not runtime state.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- implementation tasks;
- `after` dependencies that order work;
- `reads` dependencies whose outputs may be consulted;
- optional review tasks with `{lens, model, skill?}`.

`reads` must remain a subset of `after`. IDs are bounded workflow-safe slugs and
the graph must be acyclic.

## Current behavior

The `plan` tool validates and stores the complete document. Pi-maestro does not
currently compile, execute, resume, or publish it.

```text
conversation
  → plan tool
  → validation
  → <agentDir>/maestro/plans/<slug>/plan.json
```

There is deliberately no temporary workflow adapter. The owned
`@vegardx/pi-workflow` project will define:

- runtime graph compilation;
- repository/worktree authority;
- implementation/review/fixer stages;
- artifacts and structured findings;
- failure, retry, resume, and recovery;
- publication receipts and pull-request handoff.

Until then, a stored plan is reviewable intent only.
