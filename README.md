# pi-maestro

A [pi](https://github.com/badlogic/pi-mono) extension stack that turns one
coding-agent session into an orchestra: the main session (the **maestro**)
plans and coordinates, **workers** implement deliverables in parallel git
worktrees on tmux, and typed one-shot agents research, review, and verify.
Nothing ships until the canonical workflow's blocking findings are resolved
and verified.

This is primarily how I run my own coding agent. It's public because the
design might be useful to anyone curious about structuring agentic work —
the docs explain the ideas, not just the knobs.

## The ideas

- **The plan is the contract.** `/plan` opens a planning session: research
  fans out to parallel subagents, and convergence means tasks written with
  file paths and signatures — detailed enough that a simpler model could
  implement them. Workers follow instructions; they don't design.
- **A deliverable is one branch, one PR.** Deliverables form a dependency
  DAG with stacked PRs by default. Plans can span multiple repos.
- **Workers implement; Maestro owns orchestration.** Every active deliverable
  gets a worker on tmux — observable (`/watch`), steerable (`/steer`), and
  answerable (`/answer`). Exact workflow assignments review immutable SHAs;
  Maestro owns transition rulings, recovery, accounting, and shipping.
- **Reviews converge by construction.** Typed review assignments produce
  canonical finding ids and explicit resolutions; scope-locked verification
  checks fixed claims instead of starting an open-ended rerun. See
  [review workflows](docs/review-loop.md).
- **Sessions have a lifecycle.** As context fills, `/distill` compacts in
  place with user-curated carry-forward; `/handoff` closes an arc and seeds
  a fresh planning session with the unfinished threads.

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The repo root is the pi bundle manifest. Pi loads the TypeScript extension
entries through jiti; there is no build step. Workers need `tmux`; shipping
needs the `gh` CLI.

## A session in 60 seconds

```
/plan payments-retry        # explore, establish readiness, then structure
  research(...)             # parallel persisted codebase/web reports
  deliverable/task/workflow # deliveries, work items, exact assignments/stages
/auto                        # plan-review gate + user ruling, then execution
/agents                      # live workers, child runs, plan, and questions
  ...typed reviewers inspect immutable SHAs; findings resolve and verify...
/ship                        # push + PR for the next shippable delivery
/distill                     # context filling: curate what carries forward
```

## Docs

- [Usage](docs/usage.md) — the full lifecycle: modes, planning, execution,
  review, shipping, carry-forward, and every command.
- [Review workflows](docs/review-loop.md) — immutable targets, canonical
  findings, resolutions, and verification.
- [Models and exact presets](docs/models.md) — session fallback, exact sets,
  preset activation, and no-substitution persistence.
- [Settings](docs/settings.md) — scopes, runtime policies, isolation, and cutover.
- [Commands and tools](docs/commands.md) — exact command contracts and reset/archive.
- [Architecture](docs/architecture.md) — authority, persistence, RPC, and accounting.

## Development

```bash
npm install
npm run check   # biome + tsc + boundaries + feature-flags + tests + smoke + docs
```

`make dogfood` runs pi-maestro isolated from your normal pi config;
`make dogfood-sandbox` points it at a sandbox repo. `make help` lists the rest.
