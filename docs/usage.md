# Usage

The lifecycle of a maestro session: plan → implement → watch/steer/answer →
review gate → ship → distill or handoff. This page follows that arc; the
[command reference](#command-reference) at the end lists everything.

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The root package is the pi bundle manifest; pi loads the TypeScript entries
directly through jiti — no build step. Requirements beyond pi itself:
`tmux` (workers run in tmux sessions) and the `gh` CLI (shipping opens PRs).

## Modes

- `hack` — unrestricted pi default behaviour. `/hack`
- `plan` — read-only shell policy; planning tools and `ask` active. `/plan`
- `auto` — autonomous implementation; execution tools unlocked. `/auto`

A fourth mode, `agent`, is internal: workers run in it with a dedicated tool
policy and preamble. You never switch to it yourself.

## Planning

`/plan [title-or-slug]` opens (or creates) a plan and enters plan mode. A new
plan starts in an **exploring** phase: the maestro researches until it can
write tasks with file paths and signatures — the plan *is* the research
output. Structuring unlocks when the readiness gate passes (or `/ready`
skips it).

Research runs through two tools:

- `research` — fans out parallel read-only subagents (codebase and web;
  web agents can search, fetch pages, and pull library docs). All questions
  for a round go in one call; you get a bounded digest per question.
- `dig` — expands a digest to its full report via the `[ref: …]` printed
  beside it.

The plan is shaped with three flat tools (plus `plan` to render the active
plan as markdown, seed text, or JSON):

- `deliverable` — create/update/remove deliverables, manage the repo
  registry, and wire dependencies. Add many at once with
  `items: [{id, title, dependsOn}, …]` (one batched call; sibling `dependsOn`
  refs resolve to the minted ids).
- `task` — work items within a deliverable: file paths, signatures, edge
  cases. Tasks are the worker's instructions.
- `agent` — support agents within a deliverable: reviewers (a `persona`
  from the [palette](review-loop.md#the-panel), an `effort` dial, a `focus`
  specialization) and helpers, ordered by an `after` graph.

### Deliverables

A deliverable is the atomic unit of work — one branch, one PR. It carries
tasks, a worker, and its review panel. States:

```
planned → active → complete → shipped | superseded | abandoned
```

Deliverables order themselves with `dependsOn`. Dependent deliverables
create **stacked PRs** by default (branch from the predecessor's tip);
`stacked: false` branches from the default branch instead.

### Multi-repo plans

A plan lives in one repo by default, but can register more: the
`deliverable` tool manages a repo registry (key → path), and each
deliverable may target a registry key. Worktrees, branches, and PRs route
to the deliverable's repo. Cross-repo `dependsOn` is ordering-only — no
branch stacking across repos.

## Execution

`/implement` starts the active plan. The executor activates deliverables
whose dependencies are met, creates a worktree per deliverable, and spawns
a worker in each — a full pi session on tmux, seeded with upstream
summaries and its tasks. Workers implement, commit locally (never push),
toggle tasks, and run their own review panel before completing.

While the fleet runs, the maestro session stays yours:

- `/agents` — live overview: deliverable states, task progress, and each
  review ledger (`cycle 1/3 · 2 blocking open`).
- `/watch` — toggle stacked tmux panes showing all active workers.
- `/view <name>` — one worker's session in a split pane.
- `/steer <name> <guidance>` — inject guidance into a running worker.
- `/answer` — answer questions workers have raised.
- `/recap` — summary of completed agent work.

Workers that hit something outside their deliverable escalate to the
maestro over the supervisor channel; the maestro decides, consults, or
raises a question to you.

## The review gate

A worker cannot complete while its ledger has open blocking findings. The
short version: the panel runs **once**, findings get canonical ids, the
worker resolves each one (fix / wont-fix for minors / dispute with
rationale), and a scope-locked verifier checks exactly those claims — with
a bounded fix-cycle budget, maestro triage on the first block, and a human
question only on repeat blocks. The full design is in
[review-loop.md](review-loop.md).

## Verification and recovery

- `/verify [deliverable-id]` — deep verification of started deliverables:
  read-only subagents read each deliverable's actual diff and judge whether
  its tasks were genuinely accomplished.
- `/retry <deliverable-id>` — clear a blocked deliverable and re-attempt it.
- `/recover` — after an interruption: audit the plan against reality
  (worktrees, branches, PRs) and resume interrupted workers from their
  saved sessions.

## Shipping

The maestro owns shipping; workers only commit locally.

- During execution, the executor ships deliverables automatically once they
  complete and the gate is satisfied.
- `/ship` ships the next shippable deliverable (push + open/update PR). The
  PR body is assembled from the deliverable body, task checklist, and agent
  summaries.
- `/sync` reconciles shipped deliverables' PRs — retargets stacked PRs
  whose base has merged.
- `/park` creates GitHub tracking issues for the active plan.
- `/commit` stages and commits with a conventional-commit message (works in
  any mode, plan or no plan).

When every deliverable is delivered, the maestro returns to plan mode —
the arc is over, and the natural next step is one of the two commands
below.

## Session continuity

Long sessions rot: context fills, attention degrades, threads get dropped.
Two commands, one curation flow:

- `/distill` — curated in-place compaction. The maestro inventories the
  session (plan state, open questions, live threads), proposes topics, and
  asks you (multi-select) what carries forward. The curated document
  *replaces* the compaction summary — same plan, same session, keep
  working.
- `/handoff` — close the arc. A transcript archaeologist hunts unanswered
  questions, unimplemented promises, and orphaned threads; you curate; the
  session ends and a **new planning session** opens — no active plan. You
  arrive to a card ("continuing from a handoff · N threads carried") and a
  one-paragraph orientation; the full seed document rides the model's
  context invisibly until a real plan is formed, and stays on disk under
  the old plan's `handoffs/`. Refuses while workers are mid-flight.

A threshold ladder watches context fill: at 30% you're nudged to `/distill`;
at 50% a self-curated distill runs automatically (with a divergence check
that suggests `/handoff` when the session has drifted from its original
goal). Both thresholds are tunable — see [models.md](models.md#distill).

## Command reference

| Command | What it does |
|---|---|
| `/plan [title-or-slug]` | Open or create a plan; enter plan mode |
| `/ready` | Unlock plan structuring (skip the readiness gate) |
| `/implement` | Start executing the active plan |
| `/agents` | Active deliverables and agent status |
| `/watch` | Toggle stacked tmux panes for all active workers |
| `/view <name>` | View one agent's tmux session in a split pane |
| `/steer <name> <guidance>` | Steer a running agent |
| `/answer` | Answer pending agent questions |
| `/recap` | Summary of completed agent work |
| `/verify [deliverable-id]` | Deep-verify started deliverables against their diffs |
| `/retry <deliverable-id>` | Clear a blocked deliverable and re-attempt |
| `/recover` | Audit plan vs reality; resume interrupted workers |
| `/ship` | Ship the next shippable deliverable (push + PR) |
| `/sync` | Retarget stacked PRs whose base merged |
| `/park` | Create GitHub tracking issues for the active plan |
| `/commit` | Conventional commit of current changes |
| `/distill` | Curated in-place compaction; keep working |
| `/handoff` | End the arc; seed a new planning session |
| `/hack`, `/auto` | Switch mode |
| `/maestro` | Settings menu (models, profiles, tiers) |
| `/modes-status` | Show mode and active plan status |

## Feature flags

Disable a whole extension:

```bash
PI_EXT_MODES=off pi
```

Disable or force a specific feature path (kill switch wins):

```bash
PI_DISABLE="modes.plan-tools" pi
PI_ENABLE="modes.some-flag" pi
```

<!-- verified against 83bfcbe -->
