# pi-maestro

A [pi](https://github.com/badlogic/pi-mono) extension stack that turns one
coding-agent session into an orchestra: the main session (the **maestro**)
plans and coordinates, **workers** implement deliverables in parallel git
worktrees on tmux, and one-shot **subagents** research, review, and verify.
Nothing ships until the review panel's blocking findings are resolved and
verified.

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
- **Workers own iteration; the maestro owns the gate.** Every deliverable
  gets a worker on tmux — observable (`/watch`), steerable (`/steer`),
  answerable (`/answer`). The worker runs its own review panel and fixes
  findings, but cannot complete while a blocking finding is open.
- **Reviews converge by construction.** One panel round, harness-minted
  finding ids, a resolution ledger, one scope-locked verification — instead
  of open-ended re-review loops. See [the review loop](docs/review-loop.md).
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
/plan payments-retry        # planning session: research, then structure
  research(...)             # parallel codebase/web subagents report back
  deliverable/task/agent    # tools shape the plan: branches, tasks, reviewers
/implement                  # workers spawn in worktrees, panes open
/agents                     # live status: tasks, review ledger, cycles
  ...worker finishes, runs its review panel, fixes findings, verifies...
  ...gate blocks? maestro triages; only repeats reach you as a question...
/ship                       # push + PR for the next shippable deliverable
/distill                    # context filling: curate what carries forward
```

## Docs

- [Usage](docs/usage.md) — the full lifecycle: modes, planning, execution,
  review, shipping, carry-forward, and every command.
- [The review loop](docs/review-loop.md) — findings, the ledger,
  resolutions, verification, and the escalation ladder.
- [Models & settings](docs/models.md) — the tier model, profiles, and the
  settings surface.
- [Architecture](docs/architecture.md) — packages, boundaries, capabilities,
  and the runtime flow.

## Development

```bash
npm install
npm run check   # biome + tsc + boundaries + feature-flags + tests + smoke + docs
```

`make dogfood` runs pi-maestro isolated from your normal pi config;
`make dogfood-sandbox` points it at a sandbox repo. `make help` lists the rest.
