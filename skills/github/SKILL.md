---
name: github
description: >
  Use when working with GitHub platform behavior across GitHub.com, GitHub
  Enterprise Cloud, GitHub Enterprise Cloud with Data Residency on GHE.com, or
  GitHub Enterprise Server, including repositories, organizations, visibility,
  Enterprise Managed Users, SSO/token authorization, GitHub CLI, Actions,
  Agentic Workflows, REST/GraphQL APIs, Apps, webhooks, permissions, and host
  targeting. Covers platform selection, docs/version lookup, auth boundaries,
  org-vs-enterprise API scope, GHE.com limitations, and safe mutation rules. Do
  not use for local Git-only tasks that do not interact with GitHub.
license: MIT
---

# GitHub

Apply these conventions when GitHub platform behavior matters. Prefer official
GitHub docs for current product behavior, especially for Enterprise, Data
Residency, Actions, permissions, and API details.

For official links, read [references/official-docs.md](references/official-docs.md).

## Platform Model

- Identify the target platform before acting.
- Treat `github.com`, `*.ghe.com`, GitHub Enterprise Server, and "GitHub
  Enterprise" as different concepts.
- Use `github.com` for public GitHub SaaS, including GitHub Enterprise Cloud
  enterprises hosted on GitHub.com.
- Use `<enterprise>.ghe.com` for GitHub Enterprise Cloud with Data Residency.
- Use the customer-controlled hostname for GitHub Enterprise Server.
- Treat GitHub Enterprise as the product/plan umbrella, not a hostname.
- For GitHub Enterprise Server, check the instance version before assuming
  feature behavior or API availability.

> NOTE: Do not collapse "Enterprise" into one mental model. Enterprise Cloud on
> GitHub.com, Enterprise Cloud with Data Residency on GHE.com, and Enterprise
> Server differ in URLs, auth, APIs, feature rollout, and limitations.

## Docs Selection

- Select the matching GitHub Docs version before relying on behavior.
- Use GitHub.com docs for normal GitHub.com behavior.
- Use Enterprise Cloud docs for GitHub Enterprise Cloud on GitHub.com.
- Use Data Residency docs for GHE.com.
- Always check the GHE.com feature overview for current limitations and
  differences from GitHub.com.
- Use Enterprise Server docs for GHES and match the target instance version.

## Repository Visibility

- On GitHub.com, repositories may be public, internal, or private depending on
  account, organization, and plan support.
- On GHE.com, public repositories are not available; use `internal` or `private`.
- Prefer `internal` for innersource inside an enterprise when enterprise members
  should be able to discover or use the repository.
- Use `private` when access must be limited to specific users, teams, or apps.
- Never assume public visibility is possible on GHE.com.

## Enterprise Managed Users

- Enterprise Managed Users can be used with GitHub Enterprise Cloud on
  GitHub.com or GHE.com.
- Managed users are controlled by the enterprise identity provider.
- Managed users have restrictions that affect public collaboration, ownership,
  namespace behavior, and external access.
- On GHE.com, Enterprise Managed Users is the identity model; combine EMU
  restrictions with the GHE.com feature overview.
- Check whether a task crosses enterprise boundaries before using managed-user
  accounts, tokens, actions, or apps.

## Authentication and Authorization

- Check auth state before assuming access.
- For GitHub Enterprise Cloud organizations using SAML SSO, a token can have the
  right scopes but still fail until it is authorized for the target organization.
- Treat SSO/token authorization failures as a separate diagnosis from missing
  scopes.
- Classic personal access tokens and OAuth app tokens may need organization SSO
  authorization.
- Fine-grained personal access tokens are authorized during token creation, but
  may still be limited by selected resources, permissions, and organization
  policies.
- Prefer the narrowest token that can perform the task.
- Do not run interactive login flows from an agent unless the user explicitly
  asks.

## Host Targeting

- Infer the host and repository from the local git remote for normal work inside
  a checkout.
- Prefer explicit host/repo targeting in scripts, CI, and mixed-host automation.
- Prefer `GH_HOST=<host>` when a process must target a specific host; not every
  command, extension, action, or wrapper path supports `--hostname`.
- Use `GH_REPO=[HOST/]OWNER/REPO` when running outside a checkout or when the
  current directory is ambiguous.
- Use command-level `--repo [HOST/]OWNER/REPO` for one-off commands that support
  it.
- Use `--hostname` mainly for commands that explicitly support it, such as auth
  and selected API commands.

## API Scope Model

- Prefer organization-level APIs for organization resources: repositories, teams,
  members, rulesets, Actions settings, secrets, variables, packages, and
  security settings.
- Use enterprise-level APIs for enterprise-wide governance: enterprise policies,
  audit logs, billing, managed users, SCIM, enterprise teams, and cross-org
  administration.
- For GHE.com Data Residency, send REST and GraphQL API requests to the
  enterprise's dedicated API host, such as `api.<enterprise>.ghe.com`.
- For GitHub Enterprise Server, use the instance API base URL and version-matched
  documentation.
- Prefer high-level product commands before direct API calls when a focused skill
  exists, such as `github-cli`.

## Safe Mutation

- Inspect current state before changing GitHub resources.
- Prefer dry-run, preview, or generated summaries when available.
- Ask before destructive, public, or governance-level actions.
- Treat these as sensitive mutations: deleting repositories, changing
  visibility, merging PRs, publishing releases, editing branch protection,
  changing secrets, modifying organization settings, and changing enterprise
  policies.
- Prefer explicit command flags over interactive prompts.
- Avoid broad admin tokens when repository-scoped, organization-scoped, app, or
  workflow-scoped tokens work.

## Related Skills

- Use `github-cli` for concrete `gh` command conventions when that skill exists.
- Use `github-actions` for normal `.github/workflows/*.yml` and `.yaml` when
  that skill exists.
- Use `github-agentic-workflows` for `.github/workflows/*.md` agentic workflows
  and generated `.lock.yml`.
