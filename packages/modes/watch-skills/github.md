# watch-github

Probing GitHub state with the `gh` CLI. Always use structured output.

## Workflow runs / CI

- Latest run for a branch:
  `gh run list --branch <branch> --limit 1 --json databaseId,status,conclusion,workflowName`
- A specific run: `gh run view <id> --json status,conclusion,jobs`
- Canonical state: project to `status` + `conclusion` per job/run. IGNORE:
  timestamps, durations, URLs, run numbers — they change every poll.
- Known noise: `status` can flap `queued` → `queued` with changing
  timestamps; a job list can reorder — sort by name before joining.
- Terminal conclusions: success, failure, cancelled, timed_out, skipped.
  `status: completed` with any conclusion is a terminal state.

## Pull requests

- `gh pr view <number> --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`
- Canonical state: `state` + `reviewDecision` + per-check `state` sorted by
  check name. IGNORE: `mergeable` flapping UNKNOWN→MERGEABLE right after
  pushes (GitHub recomputes lazily) unless the goal is about mergeability.

## Issues / releases

- `gh issue view <number> --json state,labels,assignees`
- `gh release list --limit 1 --json tagName,isDraft,isPrerelease`
