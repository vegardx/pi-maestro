# Maestro modes architecture

This is the **reference contract** for how the maestro's modes and their
transitions are *supposed* to work, grounded in the pi.dev platform primitives
that back them. It is also the **e2e oracle**: the externally-driven test
(`docs/e2e-testing.md`) asserts against the behavior described here.

It was reconstructed on 2026-07-18 from a live multi-model shakeout drive plus an
authoritative read of the pi-coding-agent SDK. Where the current implementation
diverges from this contract, it is listed in [Defect backlog](#defect-backlog).

> **Status:** the transition/session backbone described here is **not yet fully
> implemented** — mode changes currently flip state in place. This doc is the
> target; the backlog tracks the gap.

---

## The four modes

Each mode is a **posture**: a tool set, a permission stance, and a role for the
maestro. The active tool set is computed by `computeActiveTools`
(`packages/modes/src/policy.ts`).

The normal workflow is a two-mode cycle — **`plan ↔ auto`** (Shift+Tab) — with
`hack` and `recon` as deliberate off-ramps entered by command. **`plan` is the
boot/default mode.**

| Mode | Posture | Maestro's role | Tools |
| --- | --- | --- | --- |
| **plan** *(boot default)* | Converge on WHAT to build and WHY — approach, trade-offs, open questions. **Conversation-only:** the plan's structure is NOT authored here. | Planner — a dialogue partner. The deliverables/tasks are authored in one step at the transition into execution (see [Plan lifecycle](#the-plan-lifecycle)). | read-only + `plan` (read) + research + bash (gated). **No structure tools** (`deliverable`/`task`/`agent`/`repo`) — they open only in the forming step. |
| **auto** | Orchestrated execution. | **Conductor** — spawns workers per deliverable (worktrees, parallel per deps), runs reviews, ships, then sits idle when all deliverables are done. | full plan/structure + orchestration; workers get implementation tools. |
| **hack** *(off-ramp)* | Escape hatch for everything. | **The maestro *becomes* the worker** — does the work itself, sequentially, in-session. No orchestration fan-out. | full baseline implementation tools (edit/write/bash/commit), **no** plan-structure/orchestration tools. |
| **recon** *(off-ramp)* | Read-only research. Vague idea in, understanding out. | Researcher — fans out research, no plan surface. Runs in its **own isolated session**; leaving restores the session it came from. | read-only + research loop + bash (classifier-gated read-only). No `plan`/structure tools. |

**hack is the important nuance:** it is not "auto without a plan." It is the
maestro dropping the conductor role and doing the work directly, one thing at a
time, in its own session. Fan-out to workers is exactly what hack turns *off*.

**recon is decoupled:** it is no longer in the Shift+Tab cycle and no longer the
boot mode. `/recon` is a deliberate side-trip into a fresh isolated session;
leaving it (Shift+Tab) restores the session you came from. It carries nothing
forward — deeper recon→plan integration is deferred.

---

## The plan lifecycle

Plan mode is a **conversation**: the maestro and the user converge on what to
build and why. It does **not** author the plan — the structure tools are out of
the plan-mode set entirely. The deliverables and tasks are authored in **one
forming step** when the user gestures into execution (Shift+Tab / `/auto`), from
the full context of the planning conversation. Premature authoring is designed
out, not prompted against.

```
/plan ──▶ converge ────────────▶ [Shift+Tab] ──▶ form ──────▶ review ──▶ rule ──▶ auto
  boot     surface open           the user       author the   plan-      human    fork a fresh
  default  questions, research,    gestures into  deliverable/ review     ruling   execution session,
           discuss trade-offs      execution      task tree    agent      on plan  seeded; execute
```

**The forming step** is the first stage of the `plan→auto`/`plan→hack` transition
gate. The model:

1. **Self-assesses open questions.** If a real, user-only question would
   materially change the plan's structure, it calls `ask` and **stops** — the
   transition bounces back to plan; the user answers and re-gestures (answering
   is not auto-commit).
2. Otherwise **authors** the full deliverable/task tree — the structure tools are
   available in this one window (the `forming` flag) and nowhere else in plan
   mode.

Then the existing gate runs: the mechanical fail-fast check (a taskless worker
deliverable can never cross), the **plan-review** agent, and one final human
ruling before any worker runs.

**Why conversation-only.** The old `readiness` tool locked the structure tools
during an `exploring` phase — a blunt fix for a planner that authored
prematurely. That whole apparatus (readiness tool, phase lock) is gone (backlog
#4). Instead of relying on a soft prompt to hold a capable model back from
authoring too early, the structure tools simply are not present until the
transition — so there is nothing to jump the gun with. A weak *local* model that
still needs authoring help is the separate hardening thread (#8).

---

## Mode transitions — the contract

A transition is not a flag flip. Forward transitions **distill and open a fresh,
primed session**; backward transitions **restore the prior session**.

### Forward (plan→auto/hack) — as built

The forward transition is the gate pipeline (form → fail-fast → review → ruling),
and on commit it **forks a fresh execution session**:

1. **Build the seed.** A bounded self-curated turn in the plan session produces
   the handoff — *decisions, rationale, and what we're building* — with a
   mechanical fallback (plan title + understanding) if the turn is unavailable.
   The plan's deliverables/tasks are **not** in the seed: `plan.json` is
   harness-owned and loaded live.
2. **Fork a clean session.** `ctx.newSession()` (a bare call — RPC's signature
   takes only `parentSession`, the TUI's an options object; zero args satisfies
   both). The fresh session is clean of the planning conversation.
3. **Seed rides the system prompt.** The seed is written to
   `<planDir>/transitions/NN-execution.md`; its path is stashed in modes state
   and `executionSeedPromptBlock` injects it into the execution preamble for the
   arc. This is the same RPC-safe mechanism the `/handoff` seed uses — it never
   depends on `newSession`'s `setup`/`withSession` callbacks (absent over RPC).

The fork is **TUI-only**: a fresh session is a UX win for a human conductor, but
over RPC/headless it would switch the session the controller is attached to
mid-run. Without a fork the same session keeps the full planning context, so the
seed (which exists to replace lost context) is correctly skipped there too.

### Backward (auto/hack→plan) — as built

The Shift+Tab backward gesture guards live work, then restores the planning
session:

1. **Worker-alive guard.** If any worker is still working/summarizing, `ask`
   **stop-or-stay**: stay keeps conducting; stop parks the workers (resumable via
   `/restart`) and proceeds. (This replaces the speculative 5-minute age check.)
2. **Restore.** `ctx.switchSession(planSessionPath)` back to the plan session the
   execution session forked from, with a "what executed since" note. `plan.json`
   persists throughout. In-place fallback when no forked session exists.

Natural completion (`onAllSettled`) returns to plan **in place** — the arc is
done and the conductor stands at the `/handoff` doorway, no restore.

### pi.dev primitives (grounded in the SDK)

The platform supports this directly; the current code shims it. Authoritative
sources under `node_modules/@earendil-works/pi-coding-agent/`.

| Need | pi.dev-correct primitive |
| --- | --- |
| Base prompt = global + AGENTS.md + SYSTEM.md | Automatic via `ResourceLoader` for *any* fresh session (`usage.md` §Context Files; `sdk.md` §System Prompt). **Do not re-implement.** |
| Open a fresh session (extension) | `ctx.newSession()` — bare call, **TUI-only**. The `setup`/`withSession` callbacks exist only on the TUI signature; the RPC `newSession(parentSession?)` has neither, so we seed via a path-in-state + preamble block rather than `setup(sm)`. |
| Restore prior session (backward) | `ctx.switchSession(priorPath, {...})` (feature-detected; the plan session path is captured at fork time and stashed in modes state). |
| Distill | `session.compact(customInstructions?)` or `serializeConversation(convertToLlm(messages))` — reuse pi's structured summary format (`compaction.md`). |
| Per-turn mode guidance | `before_agent_start` → return modified `systemPrompt` (`extensions.md` §before_agent_start). **Per-turn only** — not the mechanism for stage identity. |

### Backbone implementation (as built)

The transition backbone lives across `transition-gates.ts` (the gate pipeline)
and `runtime/context.ts` + `runtime/transition-seed.ts` (the session mechanics):

- **Forming** is the gate's first `form` step: a nested `runAgentTurn` in the
  plan session under the `forming` flag (structure tools scoped to it), returning
  `formed` / `bounced` / `no-plan`. An already-authored plan (reopened or seeded)
  skips it.
- **Forward fork-and-seed** rides the gate's `commit`: `stageForwardTransition`
  builds the seed, forks via a bare `ctx.newSession()` (TUI-only), and stashes
  the seed path so the execution preamble injects it. **Seeding is a system-prompt
  block, not `setup(sm).appendCustomMessageEntry`** — the RPC `newSession`
  signature has no `setup`/`withSession` callbacks, so the `/handoff`-style
  path-in-state + preamble-block mechanism is the portable one.
- **Backward restore** is `returnToPlan`: worker-alive stop-or-stay `ask`, then
  `ctx.switchSession(planSessionPath)` (feature-detected).
- **Readiness removal** (backlog #4): the structure-tool lock and `readiness`
  tool are gone; plan mode is conversation-only and authoring is the forming step.

`/handoff` remains a *distinct* command (arc-closing, interactive curation,
archaeologist); it shares the path-in-state + preamble-block seed mechanism.

### The one unavoidable shim

pi has **no native "compact the current session *into* a fresh session"** —
compaction and `/tree` summaries are strictly *in-place* (same file/id). So
"distill → cross a session boundary → seed" is composed by us (build the seed,
then `newSession()` + a preamble-block seed). That composition is the only place
a shim is justified; everything else uses a documented primitive.

There is also **no first-class sub-agent-session primitive** — spawning a primed
worker session is a DIY pattern inside a custom tool via `createAgentSession`.
(Separate concern from mode transitions.)

---

## Evolve-in-place (mid-execution plan growth)

You grow and revise the plan without leaving auto/hack. The structural freeze is
**per-node**, not global (`PlanEngineV2`, `packages/modes/src/plan/engine.ts`):

- A **`planned`** node stays fully editable and removable — even while a sibling
  runs. You can flesh out its tasks, retarget its `after`, or drop it.
- An **`active`/`complete`/`shipped`/`failed`** node is **frozen**: its structure
  and tasks are locked (append children or abandon instead).
- **New nodes are always appendable** — a fresh node starts `planned` and the
  executor's `readyChildren` tick activates it when its deps clear.
- **Edges freeze with their dependent**: `node.after` is editable iff that node
  is still `planned`.
- `addTask` is statused off the target node: a planned node takes gating `task`s;
  a running node takes only `followup`/`manual` (a new gate would un-complete a
  node already executing).

Additions are trusted (no re-gate); the per-node has-tasks check fires at
activation. `hasExecutionStarted()` survives only as plan-phase routing for the
authoring tools (append-vs-add, ensemble authoring), not as the CRUD freeze.

---

## System prompt & context composition

- **AGENTS.md** (global `~/.pi/agent/AGENTS.md`, plus project/ancestor files
  walking up from cwd) and **SYSTEM.md/APPEND_SYSTEM.md** overrides are loaded by
  pi's `ResourceLoader` into every session's base prompt. The maestro must not
  reconstruct these.
- The maestro's contribution is: (a) **per-turn** mode guidance via
  `before_agent_start` (small, mode-specific), and (b) the **distilled stage
  context** seeded into a fresh session at each forward transition. These are
  different layers — (a) must not be used to carry (b).

---

## Task & plan persistence

pi.dev has **no native cross-session task/plan store** — every platform
persistence primitive (`custom` entries via `pi.appendEntry`, `custom_message`,
labels, the shipped `todo.ts` tool-result pattern) is scoped to a *single
session's* JSONL file and is lost on `newSession()`/fork. There is no KV store,
project-state file, or workspace DB (SDK research 2026-07-18).

Therefore the maestro's own on-disk plan store (`plan.json` per slug under the
plans root, via `PlanEngine`) is the **sanctioned and only** way to keep
deliverables/tasks/statuses alive across sessions and forks — and it is correct
as built. This yields a clean **two-channel** persistence model that the
transition backbone depends on:

- **Plan structure** (deliverables/tasks/statuses/reviewers) → the maestro's
  plan store. Survives every session boundary; loaded on `session_start` and
  re-seeded into a forked session *from the store*, not from the session file.
- **Stage context** (understanding, research, decisions) → the session file;
  must be **distilled and re-seeded** into a fresh session on each forward
  transition (see [transitions](#mode-transitions--the-contract)).

The platform provides the *hooks* (`session_start`, `session_shutdown`,
`session_tree`, `before_agent_start`) to know when to load/save; durable state
itself is the extension's responsibility.

## Deliverable handoff

Dependent deliverables pass context through **data in the plan store** — not
session forks, not a messaging bus, not an out-of-band summarize turn. The
mechanism is two **auto-injected lifecycle tasks** the harness bakes into every
deliverable's task DAG (the planner never authors them):

- **Preflight** (first task, no dependencies): the harness **deterministically
  seeds** the worker with its direct dependencies' handoff summaries — this is
  what `exec/seeds.ts` "Prior Work" already does, repointed at the handoff field.
  The worker starts with upstream context *in hand*; it does not fetch it.
- **Postflight** (last task, depends on everything else): the worker writes its
  handoff summary and toggles the task done. **No new tool** — the existing
  `task` toggle gains an optional `summary` field; that text becomes the
  deliverable's downstream handoff, stored in the plan.

Design decisions (all settled 2026-07-18):

- **No `type: pre|post` on tasks.** The task DAG already encodes first/last
  (preflight has no deps; postflight depends on all others). A lightweight
  *reserved id/flag* marks the injected pair so the harness can inject them,
  route the postflight `summary` to the handoff field, and keep them off the
  planner's editable surface — but that is an identity marker, not a type system.
- **Bounded by instruction, not enforcement.** The postflight prompt asks for a
  short, concise summary (≤ ~500 words). We accept mild overrun rather than build
  a validate-and-reshorten loop.
- **One summary, not two.** The postflight `summary` is the downstream handoff;
  the maestro derives status from the completed task DAG + review results, so no
  separate maestro-facing report (split later only if the maestro is under-served).
- **Transitive context is the plan's job.** There is *no* on-demand pull of an
  ancestor's handoff. If a deliverable needs a grandparent's context, the DAG must
  make the dependency explicit or the intermediate handoff must forward the
  relevant bit — "the planner's job is to be precise." (This is why the worker
  `dig` tool is removed.)

This supersedes the injected `summarize` RPC turn (`agent-lifecycle.ts`), and the
earlier `submit-handoff`-tool and worker-session-fork ideas. `/handoff` (=`/fork`
+ compaction) stays a *maestro-transition* mechanism only; worker handoff is plain
plan data.

## Worker tool set

Workers run in **agent mode** with a deliberately tight allowlist — *implement,
run, commit, toggle tasks, review, escalate.* Research and plan-navigation are
**upstream** (the planner's job) and the preflight seed hands over everything a
worker needs, so those aren't worker tools.

Target set (11): `read, grep, find, ls, bash, edit, write, commit, task, review,
ask`.

Removed from the prior 16-tool `isAgent` allowlist:

- `plan` (read) — the preflight seed provides plan context; a worker focuses on
  its deliverable, not the whole plan.
- `dig` — no worker-initiated research or ancestor-handoff pull (see above).
- `websearch` / `webfetch` — research is upstream.
- `suggest_next_prompt` — interactive-UX assist; **full cleanup deferred** to a
  separate pass, so it lingers in the allowlist until then (12 in the interim).

Scope: this trims the modes **`isAgent`** branch (`policy.ts`), which gates
workers and deliverable support/review agents. **Research/review subagents are
unaffected** — they spawn via the subagents path (`--tools` allowlist + the
research-tools extension, `isolateExtensions: true`), so they never hit this
branch and keep their web/research tools.

## The e2e oracle

The externally-driven test asserts on **program state**, tolerates the **model's
path**, and **surfaces reasoning** for human/Claude judgment.

- **Assert (stable):** deliverable statuses, PR existence, files in git history,
  a review ran and produced a verdict, a question surfaced and was answered,
  role→model routing landed on the expected model, a transition forked/seeded a
  new session with the expected lineage.
- **Tolerate (variance):** which tool a model picked, wording, turn count,
  retries, timing.
- **Surface for judgment:** the planner's model-choice reasoning, the plan
  review's findings, the distilled context at each transition — so a human (or
  Claude) can independently decide whether the choice/plan/review was *good*, not
  merely that it ran. Green/red is necessary but not sufficient.

Because plan *authoring* is the most model-sensitive step (a weak local model
hallucinates "deliverables added" with no tool call), the execution-focused e2e
**seeds a known plan** rather than depending on a model to author one. "Can a
model author a plan unaided" is a *separate* observation.

---

## Defect backlog

Discovered during the 2026-07-18 shakeout + SDK research. Severity: **P0**
backbone / **P1** correctness / **P2** ergonomics-or-observability.

| # | Sev | Defect | Fix |
| --- | --- | --- | --- |
| 1 | ✓ | ~~**Mode transitions flip state in place**; no distill, no fresh session, no context handoff.~~ **DONE** — forward `plan→auto/hack` forks a fresh execution session seeded with decisions/rationale (TUI); backward restores the plan session via `switchSession` after a worker-alive stop-or-stay guard. | — |
| 2 | ✓ | ~~**Preamble carries stage identity** instead of a seeded fresh session.~~ **DONE** — the fork gives the fresh session; the seed rides the execution preamble as a path-in-state block (RPC-safe). Plan/recon/hack preambles are per-turn mode guidance. | — |
| 3 | P1 | **hack mode half-honors execution** — `hooks.ts` and the executor `canActivate` treat `hack` like `auto`, so orchestration can activate in hack. | Make hack the sequential in-session worker: no fan-out/execution adapter. |
| 4 | ✓ | ~~**`readiness` tool + `exploring`-phase structure-tool lock** hard-gate authoring.~~ **DONE** — removed; plan mode is conversation-only and authoring is the transition's forming step; the fail-fast execution gate catches a half-baked plan at plan→auto. | — |
| 5 | P2 | ~~No routing-inspection surface (`/maestro explain` never existed).~~ **DONE (#223)** — `/models` + `/models <role>`. | — |
| 6 | P2 | ~~Driver skill referenced the non-existent `/maestro explain`.~~ **DONE (#223).** | — |
| 7 | P1 | **e2e can't reach execution** — a weak planner can't author the plan. | Add a `--seed-plan` capability: write a valid `plan.json` into the isolated plan store; open by slug. |
| 8 | — | **Weak models can't author plans unaided** (didn't self-initiate readiness; hallucinated authoring). | Separate hardening thread: strengthen the planning preamble / tool discoverability. Tracked, not blocking. |
| 9 | P1 | **Deliverable handoff is an injected `summarize` turn outside the plan**; no downstream handoff field; dependents reuse the maestro summary. | Auto-injected preflight-seed / postflight-summarize tasks; `task` gains an optional bounded `summary`; handoff field in the plan store; input via `seeds.ts`. See [Deliverable handoff](#deliverable-handoff). |
| 10 | P2 | **Worker allowlist is broader than a focused implementer needs** (`plan`/`dig`/`websearch`/`webfetch`/`suggest_next_prompt`). | Trim the `isAgent` branch to `read, grep, find, ls, bash, edit, write, commit, task, review, ask` (`suggest_next_prompt` full-cleanup deferred). See [Worker tool set](#worker-tool-set). |
| 11 | ~~P1~~ **FIXED** | **Completion accepts a dirty worktree; ship fails late.** Workers are briefed to commit (and have a commit tool) but a worker that skips it completes anyway — the shipper then refuses ("uncommitted changes") at ship time. Seen live 2026-07-18. | **Done** (cleanliness gate `a4f5570` + escalating hold): `workerMayComplete` refuses while dirty, re-steers `git add -A && git commit` on a 2-min cadence (3 reminders), then escalates — agent failed + deliverable blocked with a `/recover` hint. Every hold/steer/release/escalation logged to `events.jsonl`. Hermetic coverage: `test/e2e/dirty-completion.e2e.test.ts`. |
| 12 | ~~P1~~ **ROOT-CAUSED + FIXED** | **Post-completion sequence never fires in the live drive** — both workers finished all tasks (incl. postflight, handoffs recorded) yet hours later: no summarize, no review agent, no complete/ship. | **Diagnosed from drive-2 evidence:** the wedge WAS defect #11's one-shot fix — workers left dirty worktrees, `workerMayComplete` refused completion, steered "commit" exactly once, then silently re-refused every 5s forever (no log, no retry, no escalation). `finishAgent` logs `done` first-thing and the event log has none → completion was never reached; the only refusing path is the dirty gate (confirmed by elimination). Hermetic e2e missed it because its scripted worker writes no files (tree always clean) and asserted `isWorkerDone` (task toggles) instead of agent completion. Fixed together with #11 (escalating hold + logging); new hermetic test asserts REAL completion (`status === "done"` through summarize). |

Fix order follows the backbone: **1 → 2 → 4** (transition/session core), then
**7** (unblock the e2e), with **3**, **9**, **10** alongside. **5/6 done (#223).**
