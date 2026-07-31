# Architecture

One `pi` process becomes a maestro. It spawns detached worker processes that
dial home over a unix socket, and those workers spawn read-only agents they wait
on. **Depth decides what a process is**, read once at load in
`packages/maestro/src/extension.ts` — the surface a process does not have is
never registered, rather than switched off afterwards.

```
depth 0  maestro    the seat you talk to       plan · flight · respond · bash · commit · delete · subagent
depth 1  worker     one deliverable, own tree  bash · commit · delete · subagent · finish
depth 2  read-only  explorer/reviewer/advisor  read · grep · find · ls · websearch · webfetch
depth 3  MAX_DEPTH  refused
```

A read-only agent registers none of our tools. It runs on the `--tools`
allowlist it was launched with, and has no shell — because a shell is a write
tool, and withholding it is what makes the posture mean anything.

## The defect this is organised against

A capability used to live in four independent places — the grant, the
implementation, the agent-facing description, the verification — joined only by
strings, with nothing failing when they disagreed. Every serious defect was one
of those four drifting.

`ToolRegistry.declare` rejects at construction: a tool with no implementation, a
tool no posture can hold, a duplicate name, a summary that opens with the tool's
own name. `grantsFor()` derives the grant and `describeFor()` generates the
description, so neither can drift. `PersonaCatalogue.declare` enforces the
mirror rule — prose naming a declared tool is refused, so instructions cannot
teach a model to call something the registry never handed it.

The rule that generalises: **a guard must derive its expectation from the
running system, never restate it.** Guards that restated it have certified
mistakes.

## Packages

| Package | What it is |
| --- | --- |
| `maestro` | the orchestrator: plan, run, executor, protocol, socket, spawn, shipping, safeguards |
| `ask` | the question system — `ask` sends, `respond` settles one that arrived, a transport decides where they go |
| `contracts` | shared types and the capability vocabulary |
| `core` | `defineExtension`: feature-flag gating and the capability facade |
| `models` | families, rosters, bindings, resolution |
| `git`, `github` | typed CLI wrappers |
| `settings` | the settings domain and `/maestro` |
| `commit`, `smart-compact`, `prompt-assist`, `research-tools`, `ui` | smaller extensions |

## Plan and run

`plan.json` is what was authored; `run.json` is what happened. Separate files
because they have separate lifetimes — a plan is rewritten when amended, a run
on every transition.

**Nothing derivable is stored.** A deliverable no dependent can reach is
*stranded*, but that is a fact about the plan's shape plus the set of failures,
so it is computed. A second place to record the same fact is a second place for
it to be wrong.

`after` orders; `reads` declares data flow and must be a subset of `after`.
Waiting for something is not inheriting its hand-off.

## Who does what

The maestro's **code** is deterministic and never consults a model: it creates
worktrees and branches, gathers the hand-offs a deliverable declared it reads,
pushes, opens pull requests, records results, releases workers.

The maestro's **model** does three things: authors plans, answers questions
workers are blocked on, and carries out plan preflight/postflight prose — the
only place it touches the repository directly, which is what `flight` brackets.

Confusing the two is easy and worth resisting: "the maestro creates the
worktree" means the code, always.

## Maestro owns agent exit

A worker calls `finish` and the call **does not return** until the maestro has
shipped, recorded the result, and sent `release`. An agent that controls its own
exit can be gone before its result is collected — that once lost the output of
every node in a run.

The order is ship → record → release, always. `advance` is serialised, so two
workers finishing at once cannot both claim the same successor.

## Safeguards

Every shell command is classified (`bash-policy.ts`) and then runs **confined**
to the actor's write profile, enforced by the OS through
`@anthropic-ai/sandbox-runtime`. Confinement is ambient rather than a
destination: a command the classifier got wrong is still contained.

Where the sandbox cannot start — its own dependencies missing — commands are
refused with the remedy, never run unconfined.

Modes are two properties, cwd access × safeguards, giving plan/auto/hack.
Safeguards do not propagate: a worker is never in hack.

## Further

- [commands.md](commands.md) — every command and tool
- [usage.md](usage.md) — the lifecycle end to end
- [e2e-testing.md](e2e-testing.md) — the three tiers, and what only a live drive can see
- `docs/design/` and `docs/reviews/` — dated records of what was designed when, not claims about today
