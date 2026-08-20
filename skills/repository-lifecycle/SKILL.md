---
name: repository-lifecycle
description: >
  Use when preparing and publishing repository changes through local commits,
  feature-branch pushes, pull-request creation or updates, checks, and rebase
  merge. Covers explicit staging, conventional commits, host/repository
  targeting, stale-head protection, and partial-failure recovery. Do not use for
  workflow-owned worktree handoff, releases, force pushes, default-branch
  pushes, or repository administration.
license: MIT
---

# Repository Lifecycle

Move one focused change from a working tree to a merged pull request. The
interactive seat owns remote publication. Isolated subagents finish with local
worktree changes; their host runtime captures handoff commits separately.

## 1. Establish the target

- Resolve the Git root, current branch, remotes, and working-tree status.
- Discover the remote default branch rather than assuming `main`.
- Refuse direct work on the default branch. Create or switch to a focused feature
  branch first.
- For GitHub operations, infer the host and owner/repository from the selected
  Git remote, verify `gh` authentication for that host, and target it explicitly
  with `GH_HOST` and `GH_REPO` when inference could be ambiguous.

Complete this step when the exact repository, host, feature branch, default
branch, and current status are known.

## 2. Prepare a commit

- Review both the unstaged and staged diff before changing the index.
- Select explicit repository-relative paths. Never use `git add -A` or `git add
  .` when unrelated changes may exist.
- Never stage `.env`, credentials, private keys, tokens, or secret-like files.
- Refuse unrelated paths already present in the index; do not silently include,
  unstage, or overwrite another actor's staged work.
- Run the smallest relevant validation before committing. Validation remains the
  caller's responsibility; do not invent evidence or claim checks that were not
  run.
- Stage the explicit paths, inspect the staged path list and staged diff, then
  create one conventional commit:

```text
type(scope): subject
```

Use an allowed type, keep the subject at most 72 characters, and add a body only
when the rationale is not evident from the diff.

Complete this step when `HEAD` identifies the intended commit, its changed paths
match the explicit selection, and the remaining working-tree state is reported.

## 3. Push the feature branch

- Verify the worktree is in an acceptable state and the branch is not the
  default branch.
- Fetch the remote default branch and verify it is an ancestor of the candidate
  branch. Rebase or merge the default branch locally when required; never hide a
  divergence with force push.
- Inspect the exact local and remote refs before pushing.
- Push only the current feature branch, setting its upstream when absent.
- Never force push through this lifecycle.

Remote writes follow the active seat policy. In auto they normally require
confirmation; in hack they follow the configured hack policy.

Complete this step when the remote feature ref resolves to the expected local
head SHA.

## 4. Create or update the pull request

- Look up open pull requests by exact head branch before creating one.
- Create a PR when none exists. Update the one exact open match when it exists.
  Refuse ambiguous matches.
- Use an explicit concise title. Generate the body from committed intent and
  observable changes; do not expose internal prompts, hidden reasoning, tokens,
  or machine-local paths.
- Prefer `--body-file` or stdin over shell-escaping a generated multi-line body.
- Set the discovered default branch as the base and the current feature branch
  as the head.
- Return the PR number and URL.

Complete this step when one open PR is bound to the expected head branch and
head SHA.

## 5. Check readiness

Inspect the PR as structured data, including its head SHA, base branch, state,
review decision, mergeability, and status checks. Do not parse human-formatted
output when `gh --json` is available.

Wait for or diagnose required checks. Re-read PR state immediately before any
merge; earlier output is stale evidence.

Complete this step when the current head SHA and all repository-required merge
conditions are known.

## 6. Merge by reviewed identity

Use rebase merge only. Bind the operation to the head SHA that was inspected and
reviewed, using `--match-head-commit`. Refuse when the PR head changed, checks are
not ready, the PR is not mergeable, or repository policy disallows rebase merge.

Merge is a distinct consequential operation. Confirm it according to the active
seat policy immediately before execution. Delete the feature branch only when
explicitly requested and after the merge is proved.

Complete this step when GitHub reports the PR merged and the resulting state is
re-read successfully.

## Partial failure

Never restart the lifecycle blindly after a failure. Reconcile observable state:

- commit succeeded, push failed: retain the commit and retry only the push;
- push succeeded, PR failed: verify the remote ref, then create or update the PR;
- PR mutation timed out: query by exact head before retrying;
- merge timed out: re-read PR state and merge commit identity before acting.

Report the last proved local SHA, remote SHA, PR identity, and failed operation.
