# Multi-model agents: model resolution, subagents, and the ensemble on-ramp

Status: design settled 2026-07-22, not yet implemented. This is the reference
to implement from.

## Why

A multi-model workflow — where a worker weighs several models' work, or a review
runs across a panel — needs three things to line up: how an agent chooses a
model, how one agent spawns subagents, and how the results come back without
drowning the caller. This document settles all three, and maps what is already
built against what is new.

The short version: most of the hard plumbing exists (the ensemble node path,
personas-as-skills, the catalog/tier resolver, per-run usage accounting). The new
work is small and additive — a resolver tweak, two spawn primitives, an advisor
type, a slot-yield, and an authoring on-ramp for ensembles.

---

## 1. Model resolution

The rule, in one line: **inheritance is the floor, the tier menu is the ceiling,
and the persona decides how much of the menu to spend.**

- An agent runs on its **own session model** (inherited) unless it is set to a
  tier. Nothing asked for → the caller's model. (`v2-resolver.ts:214`, the
  `!request.tier` branch.)
- Set to a tier → resolve an **ordered list** of that tier's models, **with the
  session model appended last**. The seat-last position is a *known-good
  fallback*: if the chosen models are unavailable (data residency, quota, an
  unconfigured provider), resolution still lands on a model we know works.
  Choosing a tier means "prefer something other than the seat, but never fail
  because of that choice."
- Agent-type defaults for which tier a role reaches: **explorer → fast**,
  **reviewer → heavy, overflowing into normal** when a fan-out wants more models
  than the first tier holds ("use all your models").
- `notes` on a catalog entry are **descriptive** — they help an agent or a human
  understand what a model is good at. They are **not** the selector. Selection is
  a deterministic ordered list plus seat-to-end, never free-text reasoning over
  prose. (`notes` is stored and editable — `v2-resolver.ts:55`,
  `menu-catalogs.ts` — but nothing consumes it for selection today, correctly.)

Current gap: the tier walk is strict first-available in authored order
(`v2-resolver.ts:255-277`, `winnerIndex = findIndex(available)`) with **no
seat-to-end step**. That is the one change here.

---

## 2. Three layers: persona / agent type / catalog

Model choice is split across three layers so each is editable without disturbing
the others:

| Layer | Owns | Example |
|---|---|---|
| **Persona** (markdown skill) | behavior + *how* to spend the menu | "spawn distinct families from the normal tier, then synthesize" |
| **Agent type** | *which tiers* this type may reach (the allowlist) + tools + workspace | worker → [fast, normal, heavy] |
| **Catalog** (chosen by the seat's profile) | *what models* are in each tier | normal → [gpt-5.5, gpt-5.4, gpt-5.3-codex] |

Personas are pure behavior with **no models** — the loader states it:
`personas.ts` header, *"Personas are PURE behavior: no tools, no models, no
workspace opinions — those derive from the agent type."* A persona names a tier
by word ("normal"); the agent type bounds which tiers are legal; the catalog says
what "normal" contains; the seat's profile chose the catalog. So "distinct
families from the normal tier" resolves to concrete models only at spawn time.

This is already how `coder.md` and `reviewer.md` are written (prompt-conditional:
"if the task calls for multiple perspectives…").

---

## 3. Spawning subagents

- The ability to spawn subagents = **holding the `agent` tool**. It is not a special code path; it is
  a tool grant. Whoever holds the tool can spawn subagents; whoever doesn't is a leaf.
  The tool's fan-out (multiple assignments in one call) gives "spawn N" for free.
- The **persona decides per task**: do the work directly, or fan out and
  aggregate. Not a type-level switch — the same worker does either depending on
  the task.
- **Blocking, not polling.** A spawn-and-wait call returns when its children
  finish or time out. While blocked, the caller's model is idle and spends no
  tokens, then receives every result in one tool result. Polling (as the ensemble
  seed prompt does today) burns a model turn per check to learn "not done yet" —
  pure waste. The await machinery mostly exists: a run handle's `result()`
  already resolves on completion; what's missing is a single action that spawns N
  and returns all results at once.
- **Aggregation is a context firewall.** A sub-agent that fans out absorbs the
  N-way mess in *its own* context and returns *one* normalized result. A review
  coordinator spawns sub-reviewers, dedupes/normalizes, and hands the caller a
  single findings set — the caller never sees N raw reviews. This is the reason
  nested subagents (reviewer → sub-reviewers, advisor → research) is worth
  allowing: it keeps the caller's window clean.

Cost of broad subagent use: nesting returns (see §7).

---

## 4. Two lifecycles

A property of the agent type, not the caller:

| | Spawn | Interact | Reap |
|---|---|---|---|
| **one-shot** (reviewer, explorer) | `run` / fan-out | — (runs to completion) | on completion → `result` |
| **persistent** (worker, advisor) | `run` (standby) | **`ask`** loop (+ `steer` nudges) | when the **parent's run ends** |

- **one-shot**: call → contract result → gone. `run`/`batch` → `result` exists.
- **persistent**: spawned, keeps its context, driven by the caller until the
  parent finishes. Needs a new **`ask(runId, message) → response`** action:
  followUp + wait-for-idle + return the child's response. Today the capability
  only exposes fire-and-forget `steer` (`service.ts:33` `steer(): void`) and raw
  `capture`/`result` — there is no request→response primitive, though the RPC
  transport underneath already has `followUp`.

"One-shot vs persistent" is independent of whether the agent itself spawns subagents: a
review-coordinator is one-shot *externally* (call → normalized result) while
spawning subagents *internally*.

---

## 5. Writers vs readers — two subagent flavors

The decision: **writers stay on the node path; readers use a single runtime
primitive.**

### Writers (ensemble candidates) → the node path

Candidates that write code stay plan-authored child nodes, provisioned and
managed by the executor. This keeps their **ledger durability**: a candidate node
lives in `plan.json` and the ledger, so a maestro restart mid-ensemble is
recoverable — which matters precisely when candidates are long and expensive.

Already built (this is the payoff — the hard part is done):

- Provisioning: a non-branch-owner worker child gets its own worktree on
  `cand/<parent>/<id>`, forked from the parent's branch tip.
  (`node-executor.ts:577`.)
- Concurrency: worker children run in parallel — *"ensembles require it"*
  (`node-executor.ts:15`).
- Ship exclusion: candidates are never branch owners, so the shipper skips them
  (`shipper.ts:455`); `isCandidateBranch()` guards it (`schema.ts:269`); the
  parent ships exactly one PR.
- Reaping: `cleanupWorktrees` (`shipper.ts:444`) removes candidate worktrees by
  DAG retention.
- The invariant is tested: `assertEnsemble` — N cand branches, 0 cand PRs, 1
  parent PR.
- Design spec, in code: `schema.ts:265` — *"Candidate branches are transport,
  never deliverables… cherry-picked by the parent, and reaped — a candidate must
  NEVER ship its own PR."*

Not built (the two gaps that make it unreachable in a real drive):

1. **Authoring on-ramp.** The maestro cannot author a worker-candidate child. The
   plan `agent` tool makes only *support* children, and the type is inferred:
   `inferSupportAgentType()` returns **explorer or reviewer, never worker**
   (`tools.ts:755`). And the structuring preamble has **zero** mention of
   candidates/ensembles. So a real maestro can't build one and isn't told it's an
   option.
2. **Integrator brain.** The parent's "wait for candidates → review diffs →
   cherry-pick the stronger → ship one PR" behavior lives only in the seeded plan
   prompt. No persona encodes it. Wait+integrate is prompt-driven; there is no
   automatic cherry-pick or barrier in code (`node-executor.ts:779` is just the
   candidate's kickoff line). **Gap 2 is half-written already**: `coder.md`'s
   *"spawn candidates… judge with fresh eyes… distill the strongest into your own
   worktree"* is the integrator brain — it's just aimed at the runtime-subagent
   path (which has no plumbing) instead of the node path. Redirect it.

### Readers (review / explore / advisor) → a single runtime primitive

Read-only fan-out gets one blocking spawn action:

```
agent.spawn({
  wait: true,                     // block until all finish or time out
  workspace: "shared-ro" | "none",
  assignments: [ { persona, tier, prompt }, … ],
}) → results[]                    // findings / reports; workspaces reaped on return
```

- `shared-ro`: children read the caller's workdir, cannot write → reviewers,
  explorers.
- `none`: no workspace → pure-reasoning advisors.
- **Ship-gating is free** — tool-spawned readers aren't nodes, and the shipper
  only touches branch-owning nodes, so they *can't* ship. No `cand/`-branch logic
  needed.
- **Reaping is spawn-scoped** — reap when the call returns, not DAG retention.
  Less code than the node path.

Why readers do *not* stay on nodes: they need no worktrees, and runtime spawning
lets an agent decide to fan out mid-task without pre-authored plan structure.

Why writers do *not* move to the tool primitive: a tool-spawned writer would need
worktree provisioning rebuilt on the tool path, and would lose the ledger
durability that matters when candidates are expensive. The one property that
decides it: **candidate implementations must survive a maestro restart** →
writers stay on nodes.

Dropped as redundant: a "fork + draft" runtime *writer* primitive. The node path
already does it, with recovery the tool path can't match.

---

## 6. The advisor type

A new agent type: **read-only, persistent, non-writing consultant.**

- Read-only (`shared-ro` or `none`), so no worktree, commit, or ship concerns.
- Persistent: the caller spawns it and drives it via `ask` over the caller's
  lifetime, then reaps it.
- May itself spawn readers (its own explorers) to ground its advice, then
  aggregate — it holds the `agent` tool.
- Its own persona (`advisor.md`): "propose an approach, argue trade-offs, don't
  touch code" — distinct from explorer ("establish facts, cite file:line").

Advisors are the lightweight complement to ensembles: **ensemble nodes for
competitive bake-offs (real diffs), advisors for guidance (opinions).** A worker
implementing something can consult advisors while staying the single author.

---

## 7. Depth and concurrency

Broad subagent use (readers can fan out; aggregators nest) brings nesting back, so
two things stop being optional:

- **Slot-yield.** A run acquires a semaphore slot at start and holds it until it
  finishes (`runners.ts:218`), so a parent *blocked waiting on children keeps its
  slot*. With blocking spawn-and-wait, deep fan-out fills all slots with waiting
  parents and starves the leaves — classic nesting deadlock. Current headroom:
  `DEFAULT_CONCURRENCY = 50` (`index.ts:240`), which survives moderate trees but
  not pathological ones. Fix: a parent **yields its slot while blocked on
  children** and re-acquires on resume. The state machine already has a "blocked"
  state; it just doesn't release the permit. **Blocking spawn-and-wait and
  slot-yield ship together.**
- **Depth cap.** `DEFAULT_MAX_DEPTH = 3` (`service.ts:94`) = seat(0) → worker(1) →
  child(2) → grandchild(3), i.e. 4 levels, and depth-3 agents can't spawn. Confirm
  this covers the intended trees (worker → aggregator → sub-agents = depth 3), and
  raise it only if a depth-3 agent must itself fan out.

---

## 8. Usage accounting

Both flavors are fully accounted, including cache:

- **Capture is per-run at the shared runner.** Assistant messages carry per-turn
  `tokensIn / tokensOut / cacheRead / cacheWrite / cost`, accumulated per run
  (`projections.ts:36-48`). Both node-writers and tool-readers go through this
  runner, so both get identical numbers; cache-hit rate is `cacheRead / (input +
  cacheRead)`.
- **Rollup follows run-parent links.** Every run carries `parent?: RunId`
  (`agents.ts:232`, `runs.ts`), and `descendantsOf` walks the tree — necessary
  for readers, since aggregators' sub-agents hang off them by run-parent, not off
  any plan node.
- **One explicit requirement:** the higher-level `UsageLedger` (rendered by
  `pr-provenance.ts` as "N assignments · tokens · cost") is organized around
  usage *sources*. Reader-run usage must register a source like node assignments
  do, or the raw per-run numbers exist but the workflow total silently counts
  only node-writers. Same runner, same fields, same ledger — just wire the source.

---

## Implementation plan (phased, each phase a PR)

Ordered so foundational primitives land first and the largest, node-touching work
(ensemble on-ramp) comes once the reader path is proven.

### Phase 1 — Seat-to-end tier ordering
- `v2-resolver.ts`: when walking a tier, append the session model to the end of
  the candidate list (dedup if already present), so first-available prefers
  non-seat models and falls back to the seat.
- Verify: a tier with the seat in it resolves to a non-seat model first, the seat
  last; unit test in the resolver suite.

### Phase 2 — The `ask` primitive
- Surface `followUp` through the subagents capability; add `ask(runId, message) →
  Promise<response>` (followUp + wait-for-idle + return the turn's assistant
  text) to the `agent` tool.
- Files: `subagents/service.ts`, `subagents/agent-tool.ts`, `runners.ts`.
- Verify: spawn a persistent child, `ask` twice on the same context, get correct
  responses; test against a real child (mirror `sut-death.test.ts` style).

### Phase 3 — The single `spawn` primitive (readers)
- A blocking spawn-and-wait action: `workspace: "shared-ro" | "none"`, N
  assignments, returns all results, spawn-scoped reap.
- Files: `subagents/agent-tool.ts` (new action or `batch` + `wait`/`workspace`),
  `subagents/service.ts`.
- Verify: a worker spawns N reviewers `shared-ro`, blocks, receives N findings,
  workspaces reaped; nothing ships.

### Phase 4 — Slot-yield + depth review
- A parent blocked on children releases its semaphore slot and re-acquires on
  resume; confirm/raise `DEFAULT_MAX_DEPTH`.
- Files: `subagents/runners.ts`, `subagents/semaphore.ts`, `subagents/service.ts`.
- Verify: a deep fan-out (depth to the cap, wide at each level) completes without
  deadlock; a test asserts slots free while parents block.

### Phase 5 — Advisor type + persona
- New `advisor` agent type (read-only, persistent, may spawn readers); new
  `advisor.md` persona; tier allowlist entry.
- Files: contracts `SPAWNABLE_AGENT_TYPES`, `subagents/registry.ts`,
  `subagents/personas/advisor.md`, `personas.ts` `CONTRACTS_BY_AGENT`.
- Verify: a worker spawns an advisor, `ask`s it, the advisor optionally spawns an
  explorer and returns synthesized advice.

### Phase 6 — Ensemble authoring on-ramp + integrator persona (writers)
- Let the maestro author worker-candidate children (extend the plan authoring
  surface beyond `inferSupportAgentType`'s explorer/reviewer, or add a dedicated
  ensemble-authoring primitive: parent + N candidates in one call) + structuring
  preamble guidance on when to.
- Integrator persona: adapt `coder.md`'s distill prose to the node path (read
  candidate `cand/` branches, cherry-pick/integrate, ship one PR).
- Files: `tools.ts`, `planning-preamble.ts`, `subagents/personas/` (integrator).
- Verify: a non-seeded maestro authors an ensemble; candidates run, the parent
  integrates and ships one PR; the `assertEnsemble` invariant holds outside the
  seed.

### Phase 7 — Accounting wiring
- Ensure reader-run usage registers a `UsageLedger` source so it aggregates
  alongside node assignments; rollup follows run-parent links.
- Files: `usage-ledger.ts`, `subagents/projections.ts`, `agent-bridge.ts`.
- Verify: a workflow total (and the PR-provenance line) includes tool-spawned
  readers; per-run and aggregated cache metrics are correct.

### Sequencing notes
- Phases 1–3 are independent and small; 3 depends on nothing but is more useful
  after 2 (persistent) exists, though it can land first for one-shot readers.
- Phase 4 must land before broad fan-out is used in anger (it's the deadlock
  guard); pair it with 3.
- Phase 6 is the largest and touches plan authoring — do it last, on top of a
  proven reader path, reusing the built ensemble plumbing.
- Phase 7 can fold a check into each phase instead of standing alone, if
  preferred.

---

## Related

- `docs/design/v2-primitives.md` — the catalog/tier/profile model this builds on.
- `docs/design/persona-commands.md` — persona invocation.
- Personas: `packages/subagents/personas/{coder,reviewer,researcher,…}.md`.
- The ensemble e2e: `test/e2e/driver/seed-plan.ts` (`seedEnsemblePlan`),
  `assertions.ts` (`assertEnsemble`) — the concrete shape and its invariant.
