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
- `Shift+Tab`: cycle `hack → plan → ask → auto`.

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
