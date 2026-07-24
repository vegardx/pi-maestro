# Architecture

pi-maestro is a TypeScript workspace and pi extension bundle. The host session is the **maestro**. It owns plan mutation, transition rulings, delivery scheduling, recovery, aggregate accounting, and shipping. Workers own implementation turns in dedicated worktrees. One-shot agents own research or typed workflow assignments. The HUD and PR body are projections, never authorities.

## Boundaries

The root manifest loads `ask`, `prompt-assist`, `settings`, `subagents`, `commit`, `smart-compact`, and `modes`. Shared libraries are `contracts`, `core`, `models`, `ui`, `git`, `github`, `rpc`, and `tmux`.

Dependencies cross package boundaries through:

- versioned capabilities such as `agents.v1`, `subagents.v1`, `settings.v1`, and `usage.v1`;
- typed `maestro.*` events; and
- the exhaustive Maestro RPC protocol.

`scripts/check-boundaries.mjs` prevents extension implementation imports. `packages/contracts` remains dependency-light.

## Authoritative state

| State | Authority | Durable location |
|---|---|---|
| Plan, assignments, stage DAG, gates | `PlanEngine` | `<agentDir>/maestro/plans/<slug>/plan.json` |
| Worker process generation/session | `ExecutionAdapter` + plan | plan fields and worker JSONL |
| One-shot run lifecycle | owning `RunStore` | `<runsRoot>/<runId>/status.json`, `events.jsonl`, `result.md` |
| Worker-owned child view | worker `RunStore`; host is a projection | `<planDir>/child-projections.json` |
| Usage aggregation | revisioned cumulative checkpoints | `<planDir>/execution/usage.json` |
| Review provenance | workflow analytics on the delivery | `plan.json`; bounded PR projection |

Writes that cross a process boundary are generation-fenced and persisted before acknowledgement. Worker replacement increments `sessionGeneration`; stale completion, child sync, usage, and controls cannot mutate the new generation. Child reconnect sends cumulative projections, not retry-sensitive deltas.

Unsupported plan, run, and execution schema versions fail with archive/reset guidance. There is no compatibility hydration path in the active runtime.

## Planning and execution

Plan mode is one session with two movements — converge, then author. `research` produces persisted reports and bounded digests; `dig` retrieves full reports. The structure tools (`deliverable`, `task`, `workflow`, `plan`) are available throughout; converge-before-authoring is a behavioral contract in the planning system prompt, not a tool lock.

`workflow` resolves each semantic agent assignment to an immutable model/effort pair and stores an explicit stage DAG. Members of a stage run against one `inputRevision`; stages expose declared input/output contracts and barriers. Duplicate semantic kinds are valid when identities, rationale, and exact model choices are explicit.

Plan → Auto/Hack is a separate execution-readiness gate. A `plan-review` assignment inspects the exact plan, the user rules **Enter execution** or **Stay in plan**, and the host revalidates the same plan fingerprint before changing mode. The session remains in Plan while review and ruling are pending.

A repo-backed delivery is one branch, worktree, and PR. `dependsOn` forms a flat DAG; stacked work defaults to the predecessor tip. The executor activates only ready `planned` deliveries. `/start` activates planned work; `/restart` only replaces/resumes an already-started worker; `/recover` audits failed or uncertain work before resumption.

## Process and RPC model

Workers are persistent pi sessions in tmux with retained JSONL. The Maestro RPC socket authenticates identity and carries status, plan reads/mutations, questions, cumulative usage, child reconciliation, stop preparation, interrupt, and debug proposals. The adapter serializes lifecycle mutations and fences them by generation.

One-shot agents use the common run service. Tmux is the default inspectable transport; headless is reserved for explicitly short internal calls. A worker's child run store remains authoritative. The host persists a read-only projection so rows and totals survive host restart, then marks live rows unconfirmed until the current generation reconciles.

Stop is bounded: first request cooperative preparation, then escalate the remaining tmux sessions at one fleet deadline. `K`/`/kill` requires a proved stop before recording a recoverable delivery failure. Interrupt aborts a turn or one-shot run without implying worker shutdown.

## Accounting and presentation

Token categories are disjoint:

```text
promptTokens = input + cacheRead + cacheWrite
totalTokens  = promptTokens + output
cacheHitRate = cacheRead / promptTokens
```

Every cumulative counter lifetime has a stable source key and monotonic revision. Worker generations are separate sources; a reconnected child keeps its logical run source while only the current owner generation may update it. The ledger restores checkpoints before rendering.

The HUD reads execution and run projections. Terminal elapsed time ends at `completedAt`; live rows use the current clock. Width reduction drops model and token details before truncating identity/status. User-facing controls resolve opaque `worker:*` and `run:*` ids before aliases.

PR generation replaces only `<!-- maestro:provenance:start/end -->`. It includes canonical findings, resolutions, exact SHAs, bounded assignment evidence, token/cost totals, and final verification. Text outside markers is preserved; secrets, prompts, reasoning, and transcripts are excluded or redacted.

## Validation

Deterministic scenario tests provide scripted models, temporary git repositories, fake GitHub/tmux/clock/usage, full event JSONL, and final-state artifacts. Real-process tests use test-owned RPC sockets and forked fake agents. Provider and GitHub dogfood are opt-in host activities; normal worker tests never contact either.
