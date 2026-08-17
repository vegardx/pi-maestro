# Examples

## Host Targeting

Use remote inference for normal local work:

```bash
gh repo view
gh pr status
```

Use environment variables for scripts, CI, extensions, or mixed-host work:

```bash
export GH_HOST=example.ghe.com
export GH_REPO=example.ghe.com/OWNER/REPO
export GH_PROMPT_DISABLED=1

gh pr view 123 --json number,title,state,url
```

Use command-level repo targeting for one-off commands:

```bash
gh pr view 123 --repo example.ghe.com/OWNER/REPO
```

Use `--hostname` for commands that support it:

```bash
gh auth status --hostname example.ghe.com
gh api --hostname api.example.ghe.com graphql -f query='query { viewer { login } }'
```

## Authentication

Check auth before acting:

```bash
gh auth status
gh auth status --hostname github.com
gh auth status --hostname example.ghe.com
```

In GitHub Actions:

```yaml
env:
  GH_TOKEN: ${{ github.token }}
  GH_HOST: example.ghe.com
```

When an Enterprise Cloud organization uses SSO, a token with correct scopes can
still fail until authorized for that organization. Check the `github` skill's
SSO guidance before requesting broader scopes.

## JSON Output

Get parseable PR state:

```bash
gh pr view 123 \
  --json number,title,state,reviewDecision,mergeStateStatus,statusCheckRollup,url
```

Filter with built-in `--jq`:

```bash
gh pr list \
  --state open \
  --json number,title,reviewDecision \
  --jq '.[] | select(.reviewDecision == "APPROVED") | .number'
```

Ask for supported fields:

```bash
gh pr view --json
```

## Pull Request Creation

Prefer explicit public text:

```bash
gh pr create \
  --base main \
  --head feature-branch \
  --title "Add repository policy checks" \
  --body-file pr-body.md
```

Use `--fill` only when commit messages are intentionally suitable as public PR
title/body:

```bash
gh pr create --base main --head feature-branch --fill
```

## Pull Request Merge

Inspect before merging:

```bash
gh pr view 123 --json headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks 123
```

Merge only the reviewed head SHA:

```bash
gh pr merge 123 --squash --delete-branch --match-head-commit <sha>
```

## Workflow Runs

Inspect failures:

```bash
gh run list --limit 10
gh run view <run-id> --json status,conclusion,url,jobs
gh run view <run-id> --log-failed
```

Dispatch manually with explicit ref and inputs:

```bash
gh workflow run deploy.yml --ref main -f environment=staging
```

## API Calls

Use REST for endpoint-shaped tasks:

```bash
gh api repos/{owner}/{repo}/rulesets --paginate --slurp
```

Use typed fields for booleans, numbers, null, placeholders, and file/stdin reads:

```bash
gh api repos/{owner}/{repo}/issues/123/comments \
  -F body=@comment.md
```

Set method explicitly when adding fields to a GET request:

```bash
gh api --method GET search/issues \
  -f q='repo:OWNER/REPO is:open label:bug'
```

Use GraphQL for nested data:

```bash
gh api graphql \
  -F owner='{owner}' \
  -F name='{repo}' \
  -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 10, states: OPEN) {
          nodes { number title reviewDecision }
        }
      }
    }'
```

## Secrets

Set a repository secret from stdin:

```bash
printf '%s' "$TOKEN_VALUE" | gh secret set API_TOKEN
```

Set an organization secret for selected repositories:

```bash
printf '%s' "$TOKEN_VALUE" | gh secret set API_TOKEN \
  --org ORG \
  --visibility selected \
  --repos repo-a,repo-b
```
