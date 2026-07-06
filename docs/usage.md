# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The root package is the pi bundle manifest. Pi loads the TypeScript extension
entries directly through jiti; there is no build step.

## Commands

- `/plan [title-or-slug]`: enter plan mode. Creates a draft named from your first message.
- `/implement`: start execution of the active plan (group executor).
- `/ship`: push and open/update a PR for the current branch.
- `/hack`, `/ask`, `/auto`: switch permission mode.
- `Alt+M`: cycle `hack → plan → ask → auto`.

## Plan tools

The modes extension registers three LLM tools:

- `group`: create/update/remove/list work groups.
- `task`: create/update/toggle/remove work items within a group.
- `agent`: create/update/remove support agents within a group.

Plus `plan` for rendering the active plan as markdown.

### Example workflow

```
group(add, title="Implement auth", body="OAuth2 login", workerMode="full")
task(add, groupId="implement-auth", title="POST /login", body="In src/routes/auth.ts...")
task(add, groupId="implement-auth", title="Refresh endpoint", body="...")
agent(add, groupId="implement-auth", name="security", mode="read-only",
      slot="alternate", effort="high", focus="Check for auth vulns", after=["worker"])
```

## Groups

A group is the atomic unit of work — one branch, one PR:
- **Worker**: primary agent (full mode, gets tasks, commits)
- **Support agents**: reviewers/fixers (with focus, after graph)

### States

`planned` → `active` → `complete` → `shipped` | `superseded` | `abandoned`

### Dependencies

Groups use `dependsOn` for ordering. By default, dependent groups create
stacked PRs (branch from predecessor tip). Set `stacked: false` for
independent PRs.

## Modes

- `hack`: unrestricted pi default behaviour.
- `plan`: read-only shell policy; only planning tools and `ask` active.
- `ask`: implementation with confirmation prompts.
- `auto`: autonomous implementation mode.

## Shipping

Maestro owns shipping. Agents only commit locally.

- `/ship` pushes the current branch and opens/updates a PR.
- During execution, the GroupExecutor ships terminal groups automatically.
- PR body assembled from group body + task checklist + agent summaries.

## Delegates

During planning, use delegates for research:

| Target | Slot | Effort | Purpose |
|--------|------|--------|---------|
| `explorer` | default | low | Find codebase facts |
| `researcher` | default | low | Web docs/practices |
| `advisor` | alternate | high | Plan review (different model) |

## Model presets

Two slots: `default` (workhorse, cache-friendly) and `alternate` (different
family, fresh perspective).

Configure in settings:
```json
{
  "models": {
    "active": "my-preset",
    "presets": {
      "my-preset": {
        "default": { "model": "anthropic/claude-sonnet-4-20250514" },
        "alternate": { "model": "openai/o3" }
      }
    }
  }
}
```

## Feature flags

Disable a whole extension:

```bash
PI_EXT_MODES=off pi
```

Disable a specific feature path:

```bash
PI_DISABLE="modes.plan-tools" pi
```
