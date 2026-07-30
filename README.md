# pi-maestro

A [pi](https://github.com/badlogic/pi-mono) extension stack that turns one
coding-agent session into an orchestra: the main session (the **maestro**)
plans and coordinates, and **workers** implement deliverables in parallel git
worktrees, each getting its own diff reviewed before it reports.

This is primarily how I run my own coding agent. It's public because the
design might be useful to anyone curious about structuring agentic work —
the docs explain the ideas, not just the knobs.

## The ideas

- **The plan is the contract.** Planning is a conversation; the maestro
  authors the whole document in one call when you have converged, and
  rejections come back with every error at once. Workers follow the plan;
  they do not design.
- **A deliverable is one branch, one PR.** Deliverables form a dependency
  DAG. `after` orders them; `reads` says what a deliverable actually
  inherits, so waiting for something is not paying for its hand-off.
- **Maestro owns both ends.** It creates the worktree, launches the worker,
  and — when the worker reports — ships, records, and only then releases it.
  An agent that controls its own exit can be gone before its result is
  collected.
- **A review nobody acts on did not happen.** There is no review command: a
  worker hands its own diff to a reviewer and fixes what comes back before it
  reports. Findings arrive neutral, and a fan-out returns every opinion
  unreconciled. See [review](docs/review-loop.md).
- **A question is a rare interruption.** A stuck worker asks; the maestro
  answers from the plan context it already has, and only reaches you when it
  genuinely cannot. The answer says who decided.
- **Declared once, derived.** A tool's grant, description and implementation
  come from one declaration and cannot drift — a tool declared without an
  implementation fails at construction. That invariant is the reason the
  system was rebuilt.

## A session in 60 seconds

```
/mode auto                  # writable, safeguards on
                            # then just talk: converge on what to build,
                            # and the maestro authors the plan when you have
/run payments-retry         # worktrees, workers, review, commits, PRs
/stop                       # halt it; running it again picks up where it left off
```

Three commands, and most of a session uses none of them. Workers report as they
land, and a worker that gets stuck asks — the maestro answers if it can, and
only reaches you when it genuinely cannot.

## Docs

- [Usage](docs/usage.md) — the full lifecycle: modes, planning, execution,
  review, shipping, carry-forward, and every command.
- [Review workflows](docs/review-loop.md) — immutable targets, canonical
  findings, resolutions, and verification.
- [Models](docs/models.md) — families and aliases, roster tiers, seat bindings,
  per-agent allowances, and the region filter.
- [Settings](docs/settings.md) — scopes, runtime policies, isolation, and cutover.
- [Commands and tools](docs/commands.md) — exact command contracts and reset/archive.
- [Architecture](docs/architecture.md) — authority, persistence, RPC, and accounting.

## Development

```bash
npm install
npm run check   # biome + tsc + feature-flags + tests + smoke + docs
```

`make dogfood` runs pi-maestro isolated from your normal pi config;
`make dogfood-sandbox` points it at a sandbox repo. `make help` lists the rest.
