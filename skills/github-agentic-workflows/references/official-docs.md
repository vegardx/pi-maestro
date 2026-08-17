# Official Docs

Use these links when current behavior matters. GitHub Agentic Workflows is still
moving quickly, so prefer official docs over memory for engine, model, network,
and compiler details.

## Core

- Overview: <https://github.github.com/gh-aw/introduction/overview/>
- Create GitHub Agentic Workflows: <https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows>
- Workflow structure: <https://github.github.com/gh-aw/reference/workflow-structure/>
- Frontmatter: <https://github.github.com/gh-aw/reference/frontmatter/>
- Compilation process: <https://github.github.com/gh-aw/reference/compilation-process/>
- Safe outputs: <https://github.github.com/gh-aw/reference/safe-outputs/>
- Security architecture: <https://github.github.com/gh-aw/introduction/architecture/>

## Engines, Models, and Secrets

- Engines: <https://github.github.com/gh-aw/reference/engines/>
- Model aliases: <https://github.github.com/gh-aw/reference/model-tables/>
- Secrets: <https://github.github.com/gh-aw/reference/secrets/>
- MCP servers: <https://github.github.com/gh-aw/reference/mcp/>

Prefer official aliases from the model table. Do not assume a static set of
provider model IDs is available across all accounts, engines, or dates.

Model aliases observed in the official table when this skill was written include:

- Anthropic-style aliases: `sonnet`, `sonnet-6x`, `haiku`, `opus`.
- OpenAI-style aliases: `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-codex`,
  `gpt-5-pro`, and rolling aliases such as `gpt-5.1`.
- Gemini-style aliases: `gemini-flash`, `gemini-flash-lite`, `gemini-pro`,
  `gemini-3-pro`, `gemini-3-flash`.
- Task aliases: `small`, `mini`, `large`, `agent`, `small-agent`, `coding`,
  `reasoning`, `summarization`.
- Engine aliases: `copilot`, `claude`, `codex`, `gemini`.

Check the model table before adding or changing model aliases in a workflow.

## Network and Firewall

- Network configuration: <https://github.github.com/gh-aw/guides/network-configuration/>
- `gh aw domains`: <https://github.github.com/gh-aw/reference/cli/gh_aw_domains/>
- `gh aw logs`: <https://github.github.com/gh-aw/reference/cli/gh_aw_logs/>

Prefer ecosystem identifiers and strict mode. Use raw domains only when the docs
or compiler output show that no ecosystem identifier fits.

## GitHub CLI and Enterprise Hosts

- GitHub CLI with GitHub Enterprise Cloud Data Residency:
  <https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/using-the-github-cli-across-github-platforms>
- GitHub CLI authentication:
  <https://cli.github.com/manual/gh_auth_login>

For Enterprise Cloud with Data Residency, configure both the GitHub CLI host and
the workflow engine API target deliberately. If the engine uses `api-target`, add
the target host to `network.allowed`.

## Local `gh aw` Commands

Check command flags with local help before relying on memory:

```bash
gh aw --help
gh aw new --help
gh aw compile --help
gh aw validate --help
gh aw domains --help
gh aw logs --help
gh aw trial --help
gh aw secrets --help
```

Useful defaults:

```bash
gh aw validate
gh aw compile
gh aw trial <workflow-id>
gh aw domains
```

As of the local tool version used when this reference was written, `gh aw
validate` is equivalent to:

```bash
gh aw compile --validate --no-emit --zizmor --actionlint --poutine
```
