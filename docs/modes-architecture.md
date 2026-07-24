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

| Mode | Posture | Maestro's role | Tools |
| --- | --- | --- | --- |
| **recon** | Read-only research. Vague idea in, understanding out. | Researcher — fans out research, no plan surface. | read-only + research loop + bash (classifier-gated read-only). No `plan`/structure tools. |
| **plan** | Formalize a plan *in context*, surface open questions, author structure as it converges. | Planner — converges on what to build, then authors deliverables/tasks. *Converge-before-authoring* is enforced by the planning **system prompt**, not a tool lock. | read-only + `plan` (read) + `deliverable`/`task` (available throughout) + research + bash (gated). No readiness gate (see [Plan lifecycle](#the-plan-lifecycle)). |
| **auto** | Orchestrated execution. | **Conductor** — spawns workers per deliverable (worktrees, parallel per deps), runs reviews, ships, then sits idle when all deliverables are done. | full plan/structure + orchestration; workers get implementation tools. |
| **hack** | Escape hatch for everything. | **The maestro *becomes* the worker** — does the work itself, sequentially, in-session. No orchestration fan-out. | full baseline implementation tools (edit/write/bash/commit), **no** plan-structure/orchestration tools. |

**hack is the important nuance:** it is not "auto without a plan." It is the
maestro dropping the conductor role and doing the work directly, one thing at a
time, in its own session. Fan-out to workers is exactly what hack turns *off*.

---

## The plan lifecycle

Plan mode formalizes a plan *in context*, then authors structure as it
converges. There is **no gate locking the structure tools** —
`deliverable`/`task` are available throughout plan mode. Premature authoring
(creating deliverables while the model's own open questions are still
unanswered) is prevented by the planning **system prompt**, not by confiscating
tools.

```
/plan ──▶ (fresh planning session, primed) ──▶ converge ──────▶ author ──────▶ plan → auto
             base prompt establishes the        surface open    deliverable/     distill + fork to
             "converge before authoring"        questions,      task as the      auto session; plan
             planning posture                    get answers     plan firms up    review; execute
```

- The planning **system prompt** is the control: surface open questions and
  resolve them with the human *first*; author deliverables/tasks only once
  converged; nudge the human when nothing is open. This behavioral contract
  replaces the old `readiness` tool.
- **plan → auto** is the single gate. The mode change distills the session,
  forks a fresh auto session, runs **plan review** on the authored plan (which
  can flag a missing piece — the human deals with findings or ack's none), and
  auto-starts deliverable #1.

**Why no hard gate.** The old `readiness` tool locked the structure tools during
an `exploring` phase — a blunt fix for a planner that authored prematurely even
while its own open questions sat unanswered. Converge-before-authoring is now a
behavioral contract in the planning system prompt: the structure tools are
available throughout plan mode and the lock/tool are removed (backlog #4, done).
A weak *local* model may still jump the gun on a soft prompt; that is the
separate "help weak models plan" hardening thread (#8), not a reason to
hard-gate capable session models.

---

## Mode transitions — the contract

A transition is not a flag flip. Forward transitions **distill and open a fresh,
primed session**; backward transitions **restore the prior session**.

### Forward (recon→plan, plan→auto)

Each forward step should:

1. **Distill** the current session into a compact structured context (Goal /
   Progress / Key decisions / Next steps / Critical context + links to the
   deeper research markdown docs on disk).
2. **Open a fresh session** seeded with that distilled context. The new
   session's base prompt (global prompt + `AGENTS.md` + `SYSTEM.md`) is rebuilt
   automatically by pi — we do not compose it ourselves.
3. For **plan→auto** specifically, the kickoff instructs the fresh auto session
   to *form the full plan* (deliverables/tasks/reviewers) from the distilled
   context, then run plan review.

### Backward (auto→plan, plan→recon)

Going back should **restore the prior-stage session**, not drag execution state
backward:

1. Walk the `parentSession` lineage to the prior-stage session.
2. **Age check:** if that session is older than **5 minutes** (its provider
   cache is likely cold), ask the human: *resume it (cache-cold, may re-cost) or
   start fresh?*
3. Resume via session switch, or open fresh per the answer.

### pi.dev primitives (grounded in the SDK)

The platform supports this directly; the current code shims it. Authoritative
sources under `node_modules/@earendil-works/pi-coding-agent/`.

| Need | pi.dev-correct primitive |
| --- | --- |
| Base prompt = global + AGENTS.md + SYSTEM.md | Automatic via `ResourceLoader` for *any* fresh session (`usage.md` §Context Files; `sdk.md` §System Prompt). **Do not re-implement.** |
| Open a fresh primed session (extension/RPC) | `ctx.newSession({ parentSession, setup, withSession })` — seed distilled context in `setup(sm)` via `sm.appendCustomMessageEntry("stage-handoff", summary, true)` (in-context); kick with `withSession → ctx.sendUserMessage(kickoff)` (`extensions.md` §ctx.newSession; `types.d.ts` `ExtensionCommandContext.newSession`). |
| Restore prior session (backward) | `ctx.switchSession(priorPath, {...})`; lineage from the `parentSession` header pi records on every forward `newSession` (`session-format.md` §header). |
| Distill | `session.compact(customInstructions?)` or `serializeConversation(convertToLlm(messages))` — reuse pi's structured summary format (`compaction.md`). |
| Per-turn mode guidance | `before_agent_start` → return modified `systemPrompt` (`extensions.md` §before_agent_start). **Per-turn only** — not the mechanism for stage identity. |

### Backbone implementation design (backlog #1/#2/#4)

The concrete shape of the transition backbone, decided against the existing
carry-forward machinery (`/distill`/`/handoff` in `runtime/carry-commands.ts` +
`carry-forward.ts`):

**One new primitive — `stageTransition(rt, ctx, {to, kickoff})`:**

1. **Distill, single-shot.** Forward transitions use a *self-curated,
   non-interactive* distillation (the forced-distill posture: the model curates
   its own threads, no human selection round) — a transition must be one gate,
   not a multi-turn episode. The interactive curation UX stays exclusive to
   `/distill` and `/handoff`.
2. **Fork + seed, pi.dev-correct.** `ctx.newSession({ parentSession, setup,
   withSession })`: the distilled doc is seeded in `setup(sm)` via
   `sm.appendCustomMessageEntry("maestro.stage-handoff", doc, true)` — real
   in-context material in the fresh session. This **replaces** the
   `pendingHandoffSeedPath` + per-turn preamble seed block + idle-polled
   arrival-delivery dance (which exists to work around sending a message across
   a session switch — seeding in `setup` makes that whole problem vanish).
3. **Kickoff per edge.** `withSession → ctx.sendUserMessage(kickoff)`:
   recon→plan orients ("summarize intent, list open questions, wait");
   plan→auto instructs the fresh session to *form the full plan*
   (deliverables/tasks/reviewers) from the seed, then plan review runs and
   execution starts.
4. **Backward = restore.** auto→plan / plan→recon walk the `parentSession`
   lineage and `ctx.switchSession(priorPath)`; if the prior session is >5 min
   old, ask resume-or-fresh first.
5. **Readiness removal** (backlog #4, done): the structure-tool lock and
   `readiness` tool are removed; the planning system prompt carries
   converge-before-authoring. (Landed ahead of the session backbone.)

`/handoff` remains a *distinct* command (arc-closing, interactive curation,
archaeologist) but is refactored onto the same fork+seed core.

### The one unavoidable shim

pi has **no native "compact the current session *into* a fresh session"** —
compaction and `/tree` summaries are strictly *in-place* (same file/id). So
"distill → cross a session boundary → seed" must be composed by us (distill,
then `newSession({setup})`). That composition is the only place a shim is
justified; everything else uses a documented primitive.

There is also **no first-class sub-agent-session primitive** — spawning a primed
worker session is a DIY pattern inside a custom tool via `createAgentSession`.
(Separate concern from mode transitions.)

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
| 1 | P0 | **Mode transitions flip state in place** (`commitMode`); no distill, no fresh session, no context handoff. Each stage drags the full raw prior conversation forward. | Wire forward transitions to distill + `ctx.newSession({setup})`; backward to `switchSession` + age prompt. |
| 2 | P0 | **Preamble carries stage identity** (`before_agent_start` append) instead of a seeded fresh session. | Once #1 lands, reduce the preamble to genuinely per-turn mode guidance; stage context rides the seed. |
| 3 | P1 | **hack mode half-honors execution** — `hooks.ts:152` and the executor `canActivate` treat `hack` like `auto`, so orchestration can activate in hack. | Make hack the sequential in-session worker: no fan-out/execution adapter. |
| 4 | ✓ | ~~**`readiness` tool + `exploring`-phase structure-tool lock** hard-gate authoring.~~ **DONE** — removed; `deliverable`/`task` available throughout plan mode; converge-before-authoring is a planning-system-prompt contract; the fail-fast execution gate catches a half-baked plan at plan→auto. | — |
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
