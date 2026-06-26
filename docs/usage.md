# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The root package is the pi bundle manifest. Pi loads the TypeScript extension
entries directly through jiti; there is no build step.

## Commands

- `/plan [title-or-slug]`: create or open a plan and enter plan mode.
- `/implement [--ask] [--fanout]`: start execution of the active plan.
- `/ship [deliverableId]`: ship the next shippable deliverable, or the supplied
  deliverable, through `commit.v1`.
- `/sync`: reconcile merged/closed deliverable PRs back into plan state.
- `/park`: create GitHub tracking issues for the active plan.
- `/hack`, `/ask`, `/auto`: switch permission mode.
- `/modes-status`: show current mode and active plan.
- `Alt+M`: cycle `hack → plan → ask → auto`.

## Plan tools

The modes extension registers three LLM tools when enabled:

- `deliverable`: create/update/remove/reorder deliverables.
- `task`: create/update/toggle/remove/move work items.
- `plan`: render the active plan as markdown, deterministic seed, or JSON.

Plan-level loose items can be `followup`, `question`, or `manual`; gating
`task` items must belong to a deliverable.

## Modes

- `hack`: unrestricted pi default behaviour.
- `plan`: read-only shell policy; only planning tools, read tools, and `ask` are
  active.
- `ask`: implementation with prompts/checkpoints routed through UI questions.
- `auto`: autonomous implementation mode.

Mode and active-plan state is persisted into the session so reloads/resumes keep
the current workflow.

## Shipping

`/ship` uses `commit.v1` rather than importing the commit extension. Modes owns
which deliverable is being shipped; commit owns staging, message generation,
push, and PR creation/update. Successful shipping records PR metadata on the
plan and emits `maestro.ship.completed`.

`/sync` uses GitHub PR state to move merged PRs to `shipped` and closed PRs to
`needs-attention`.

## Compaction

`smart-compact` replaces pi's default auto-compaction summary with a single
work-continuity-focused LLM call: it identifies the active task and writes a
summary optimised for continuing it. Compaction is append-only — the previous
summary is reused byte-for-byte as the prefix and only a new section is added,
so the cached prompt prefix stays stable across compactions. Any failure (no
model/auth, empty summary, timeout, error) falls back to pi's default
compaction, so a session is never blocked.

Settings live under `extensionConfig.smart-compact`:

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | background `normal` tier → session model | `provider/id` override for the summariser. |
| `compactAt` | unset | Context-token count at which to proactively compact at turn end. Unset relies on pi's native `compaction.reserveTokens` threshold. |
| `maxSummaryTokens` | `8192` | Max tokens the summary may emit. |
| `maxFileListEntries` | `50` | Cap on entries per read/modified file list. |
| `timeoutMs` | `60000` | Deadline for model resolution + the summary call. |

These are independent of pi's native `compaction.*` settings
(`reserveTokens`, `keepRecentTokens`), which still govern when pi triggers
compaction; `smart-compact` only changes how the summary is produced (and,
with `compactAt`, can trigger earlier).

## Feature flags

Disable a whole extension:

```bash
PI_EXT_MODES=off pi
```

Disable a specific feature path:

```bash
PI_DISABLE="modes.plan-tools" pi
```

Re-enable with `PI_ENABLE` when a project/global setting disables something.
Environment kill switches take precedence.
