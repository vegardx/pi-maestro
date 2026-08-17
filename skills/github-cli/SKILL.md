---
name: github-cli
description: >
  Use when writing, editing, reviewing, or running GitHub CLI commands with gh,
  including gh auth, gh repo, gh pr, gh issue, gh run, gh workflow, gh release,
  gh secret, gh variable, gh api, REST, GraphQL, --json, --jq, --template,
  GH_TOKEN, GH_HOST, GH_REPO, --repo, --hostname, GitHub.com, GHE.com Data
  Residency, and GitHub Enterprise Server. Covers host/repo targeting,
  non-interactive command patterns, auth checks, token scopes, API fallbacks,
  output formatting, and safe mutation. Do not use for generic shell scripting
  or local Git-only work that does not call GitHub CLI.
license: MIT
---

# GitHub CLI

Apply these conventions when using `gh`. Also follow the generic `github` skill
when platform, Enterprise, Data Residency, visibility, SSO, or API-scope behavior
matters.

For examples, read [references/examples.md](references/examples.md).

## Command Selection

- Prefer focused `gh` commands before `gh api`.
- Use `gh api` when high-level commands cannot express the operation.
- Prefer REST for direct endpoint-shaped tasks from GitHub docs.
- Prefer GraphQL for nested data, batching, or fields missing from high-level
  commands.
- Check command-specific help before relying on memory:

```bash
gh <command> <subcommand> --help
```

## Host and Repository Targeting

- Let `gh` infer host and repository from the local `origin` remote for normal
  work inside a checkout.
- Prefer `GH_HOST=<host>` in scripts, CI, extensions, and mixed-host automation;
  not every command, action, or extension path supports `--hostname`.
- Use `GH_REPO=[HOST/]OWNER/REPO` outside a checkout or when current-directory
  inference could be wrong.
- Use `--repo [HOST/]OWNER/REPO` for one-off commands that support it.
- Use `--hostname` mainly for commands that explicitly support it, such as
  `gh auth` and `gh api`.
- For GHE.com Data Residency, use the GHE host for web/repo commands and the
  dedicated API host where the docs or command require it.

Good:

```bash
export GH_HOST=example.ghe.com
export GH_REPO=example.ghe.com/OWNER/REPO
gh pr view 123 --json title,state,url
```

## Authentication

- Check authentication before performing GitHub operations:

```bash
gh auth status
```

- Use `gh auth status --hostname <host>` when a specific host matters.
- In GitHub Actions, set `GH_TOKEN: ${{ github.token }}`.
- For `github.com` and `*.ghe.com`, use `GH_TOKEN` or `GITHUB_TOKEN`.
- For GitHub Enterprise Server, use `GH_ENTERPRISE_TOKEN` or
  `GITHUB_ENTERPRISE_TOKEN` when required.
- Do not start interactive `gh auth login` unless the user explicitly asks.
- Treat SSO authorization failures separately from missing token scopes.
- Request extra scopes only when a command requires them, such as `project` for
  project mutations.

## Non-Interactive Use

- Prefer explicit flags over interactive prompts.
- Set `GH_PROMPT_DISABLED=1` in scripts and CI when prompts would hang or create
  ambiguous behavior.
- Provide `--title`, `--body`, `--body-file`, `--base`, `--head`, `--repo`, and
  `--ref` explicitly when automation depends on them.
- Use `--body-file -` or JSON on stdin for generated content instead of shell
  escaping large strings.
- Avoid `--web` in agent or CI workflows unless the user explicitly asks to open
  a browser.

## Output

- Prefer `--json` for data the agent will parse.
- Use `--jq` for compact filtering; `jq` does not need to be installed for
  `gh --jq`.
- Use `--template` for human-readable summaries.
- Ask a command for available JSON fields by passing `--json` without fields.
- Avoid parsing human-formatted output when JSON is available.

Good:

```bash
gh pr view 123 --json number,title,state,reviewDecision,statusCheckRollup,url
```

## Pull Requests and Issues

- Inspect state before mutating PRs or issues.
- Prefer `gh pr view`, `gh pr diff`, `gh pr checks`, and `gh issue view` before
  edit, comment, close, or merge operations.
- Prefer `--body-file` for generated PR and issue bodies.
- Use `--fill` for PR creation only when commit messages are intentionally clean
  enough to become public PR text.
- Ask before merging PRs, closing issues, changing labels at scale, or assigning
  users/agents in production repositories.
- Use `--match-head-commit` when merging a PR that must not have changed since
  review.

> NOTE: Prefer explicit PR bodies over `--fill` when the user has not reviewed
> the commit messages as public communication.

## Actions and Runs

- Use `gh run list`, `gh run view`, `gh run view --log-failed`, and
  `gh run watch` for workflow diagnostics.
- Use `gh workflow run <workflow> --ref <ref>` with explicit inputs for manual
  dispatch.
- Confirm the workflow supports `workflow_dispatch` before using
  `gh workflow run`.
- Use `github-actions` conventions for workflow YAML when that skill exists.
- Use `github-agentic-workflows` conventions for `gh aw` and `.md` workflows.

## Secrets and Variables

- Treat `gh secret set`, `gh variable set`, and related org/environment changes
  as sensitive mutations.
- Prefer scoped targets: repository, environment, organization, or user.
- For organization secrets, set visibility deliberately: `private`, `selected`,
  or `all`.
- Prefer stdin or environment input for secret values; do not echo secrets into
  shell history.
- Use `--no-store` only when intentionally producing encrypted output without
  updating GitHub.

## API Calls

- Use placeholders such as `{owner}`, `{repo}`, and `{branch}` where supported.
- Set `--method` explicitly when field flags would otherwise change the method.
- Use `--paginate` when first-page results are not enough.
- Use `--slurp` with `--paginate` when downstream processing expects one JSON
  array.
- Use `-F/--field` for typed values and file/stdin reads.
- Use `-f/--raw-field` for literal strings.
- Use `--input` for prebuilt JSON payloads.
- Use `GH_DEBUG=api` only when debugging; avoid leaking tokens or sensitive
  payloads in logs.

## Safe Mutation

- Inspect current state before mutating GitHub resources.
- Prefer dry-run, previews, or summaries where available.
- Ask before destructive, public, or governance-level operations.
- Treat these as sensitive: repository deletion, visibility changes, PR merges,
  release publication, secret changes, branch protection, rulesets, organization
  settings, enterprise settings, and broad issue/PR edits.
- Use the narrowest token and target scope that can perform the operation.
