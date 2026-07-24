# Mode sessions — form-at-transition, session-per-mode, evolve-in-place

**Status:** settled design (2026-07-24). This is the authoritative spec for the
mode/session model. It **revises** `../modes-architecture.md` (§The plan
lifecycle, §Mode transitions, §The four modes) — the deltas are listed in
[What this revises](#what-this-revises) and reconciled by Phase 6 of the plan.

## The shape

The maestro's normal workflow is a two-mode cycle with **one seeded session per
mode** and a **forming gate** between them. `recon` and `hack` are explicit
off-ramps, not part of the cycle.

```
        ┌────────────── plan ──────────────┐        ┌──────── auto / hack ────────┐
 boot ▶ │ CONVERSATION only.                │  shift │ EXECUTION.                  │
        │ research · ask · dig · read-only  │  +tab  │ engine drives workers from  │
        │ subagents. NO structure tools.    │ ─────▶ │ plan.json; evolve-in-place. │
        │ converge on understanding.        │  form  │                             │
        └───────────────────────────────────┘  &enter└─────────────────────────────┘
                    ▲                                          │
                    └────────── back (stop-or-stay) ───────────┘

   /recon  ─▶  isolated read-only session  ─▶  leaving restores the target mode's session
   /hack   ─▶  maestro becomes the sequential worker (also reachable via the forming gate)
```

The invariant that makes it hang together: **`plan.json` is durable and lives
outside every session.** A session is only *working context*; the plan is shared
persistent state the harness owns. So forking a session per mode never risks the
plan, and "auto doesn't know the plan structurally, only the intent" is safe.

## Modes

| Mode | Posture | Structure tools | Session |
| --- | --- | --- | --- |
| **plan** (default/boot) | A conversation. Research, `ask`, `dig`, read-only subagents; converge on understanding. | **None** — cannot author mid-conversation, so premature authoring is designed out, not prompted against. | Its own session. |
| **auto** | Orchestrated execution; the engine drives workers from `plan.json`. | Yes, **constrained** (evolve-in-place: append + edit-`planned` only). | Forked + seeded from plan on entry. |
| **hack** | The maestro *becomes* the sequential worker, in-session. | Baseline implementation tools + **constrained** structure-add (evolve-in-place). | Forked + seeded from plan on entry (same gate as auto). |
| **`/recon`** | Explicit read-only reconnaissance off-ramp. | None. | **Isolated** — outside the seed chain; leaving restores the target mode's session. |

## Forward: plan → auto/hack = "form and enter"

`shift+tab` from plan is not a flag flip — it runs a pipeline:

1. **Self-assess.** A maestro turn judges whether material questions are still
   open (the model decides — no classifier). If so, it calls `ask` to surface
   *exactly those questions*, which lands you back in plan. You resolve them,
   then **re-gesture** (answering a question does not auto-commit you across the
   boundary).
2. **Form.** Author deliverables + tasks from the full converged conversation.
   Structure tools are active **only in this forming step**, in the plan session
   (best fidelity — the whole conversation is in context).
3. **Review.** The existing plan-review agent runs on the formed plan.
4. **Ruling.** You approve the *complete* plan (or bounce back to plan). This is
   where human oversight lands — you review a finished plan, not a forming one.
5. **Fork + seed.** Open a fresh auto/hack session seeded with **only** the
   distilled *decisions + rationale + a summary of what we're building*. The
   deliverables/tasks are harness state (`plan.json`), never seeded into the
   conversation.

"Structuring" therefore **demotes from a mode you sit in to a transient action
the gate performs** — the harness enters it for one forming turn and exits.

## Sessions

### Forward — fork and seed
On the ruling's `commit`, run the transition backbone (`stageTransition`):
distill the plan session (self-curated, single-shot) → `ctx.newSession({
parentSession, setup, withSession })`, seeding the lean handoff in `setup(sm)` via
`sm.appendCustomMessageEntry(...)`. The plan is **not** in the seed — the engine
already drives execution from `plan.json`; the auto session only needs the *why*.

### Backward — restore, gated on quiescence
`auto/hack → plan` is allowed **only when no worker is alive**.
- If a worker is running → **ask: "stop them and return to plan, or stay?"**
- On stop+return → `ctx.switchSession(priorPlanPath)` restores the plan session,
  seeded with a short "what executed since" note. `plan.json` persists throughout.

## Evolve-in-place (stay in auto/hack)

You grow and revise the plan mid-execution without leaving:

- **Add** deliverables/tasks freely; `readyChildren` activates any `planned`
  node whose deps are met on the next engine tick.
- **Mutation invariant** (refines today's global freeze at `plan/engine.ts:283`):
  - `planned` (not activated) → fully editable + removable.
  - `active`/`shipped` (started) → frozen; the worker owns it.
  - new nodes → always appendable.
  - **an edge is mutable iff its *dependent* (the waiting node) is `planned`** —
    you may point a planned node at anything (it stacks), but never add/change an
    edge whose dependent has already started.
- Additions are **trusted** — no mid-flight re-gate; the per-node
  execution-readiness "has tasks" check fires at activation (already built).

## Recon, decoupled

Recon is **out of the cycle**. `/recon` (deliberate) drops you into recon's own
**isolated** session — read-only, separate context. Leaving recon **restores the
target mode's existing session** — no distill, no fork, no seed. Recon does not
feed context into the main chain. Deeper recon→plan integration is **deferred**.

## What this revises

Versus the current `modes-architecture.md`:

| Topic | modes-architecture.md (prior) | This design (settled) |
| --- | --- | --- |
| Structure tools in plan | "available throughout" | **None** — conversation-only; tools live in the forming step |
| Where the plan is formed | in the fresh auto session, from the seed | in the **plan session** (full context); auto gets a lean seed |
| Auto seed contents | the distilled context to re-form from | **decisions + rationale + summary**; plan is harness-owned |
| Open-question handling | system prompt only | + **self-assess → `ask` → re-gesture** at the gate |
| Recon | in the forward/backward chain (recon→plan, plan→recon) | **decoupled** isolated off-ramp; cycle is `plan↔auto/hack` only |
| Backward gate | 5-min age check | **worker-alive block + stop-or-stay prompt** (age check optional) |
| Mid-execution plan growth | not specified | **evolve-in-place** with per-node/per-edge freeze |
| Boot mode | recon | **plan** |

Everything else in `modes-architecture.md` (§System prompt composition,
§Persistence, §Deliverable handoff, §Worker tool set, §e2e oracle) stands.

---

# Implementation plan

Ordered phases; each lands with `npm run check` green and its own docs updated
(check-docs enforces code/doc name sync). Phases 4 and 5 are largely independent
and can move earlier or run in parallel.

### Phase 1 — Readiness / exploring-phase teardown *(interim: authoring stays in plan)*
The self-contained cleanup everything sits on. Removes the `readiness` tool and
the `exploring`/`structuring` user-phases **without yet** moving authoring to the
gate — the interim is "structure tools available throughout plan mode, converge
via system prompt" (Option A; `modes-architecture.md` already documents it).
- Delete `createReadinessTool` + `ReadinessParams` (`research.ts`), drop it from
  `createResearchTools` and `RESEARCH_TOOL_NAMES` (`policy.ts:26`); fix the
  `research`-result text + file header.
- Remove both exploring-lock sites (`policy.ts:155-157`, `191-202`); retire
  `STRUCTURE_TOOL_NAMES`/`STRUCTURE_TOOLS` and the `onPhaseChanged` plumbing.
- Collapse `planning-preamble.ts` to a single plan preamble (drop "## Declaring
  readiness" and the phase branch); `engine.setPhase`/`planPhaseV2`/`phase`
  become dead → remove.
- Tests: `policy-phase.test.ts`, `planning-preamble.test.ts`,
  `recon-mode.test.ts`, `worker-tool-policy.test.ts`.
- Docs: `architecture.md`, `commands.md`, `usage.md`, `README.md`; flip
  `modes-architecture.md` backlog #4 to done.

### Phase 2 — The "form and enter" gate *(move authoring to the transition)*
- Extend the `plan->auto`/`plan->hack` gate (`transition-gates.ts`) with a
  **form** step ahead of review: self-assess open questions (→ `ask` → bounce to
  plan), then author deliverables/tasks in the plan session with structure tools
  scoped to this step.
- Remove structure tools from plan-mode conversation (they exist only in the
  forming step) → plan mode becomes conversation-only.
- The existing fail-fast mechanical check becomes the safety net for a forming
  turn that produced a taskless deliverable.
- Docs: revise `modes-architecture.md` §plan lifecycle to "conversation → form
  at the gate."

### Phase 3 — Session fork-and-seed *(the session part)*
- Build `stageTransition(rt, ctx, {to, kickoff})`: self-curated single-shot
  distill → `ctx.newSession({parentSession, setup, withSession})`; seed the lean
  handoff (decisions/rationale/summary) in `setup`; the plan stays harness-owned.
  Wire it as the gate's `commit` action.
- Backward: worker-alive gate → **stop-or-stay** `ask` → `ctx.switchSession`
  restore + "what executed since" note.
- Refactor `/handoff` onto the same fork+seed core (keep it distinct/interactive).
- Docs: `modes-architecture.md` §Mode transitions.

### Phase 4 — Evolve-in-place *(per-node/per-edge freeze)*
- Replace the global `hasExecutionStarted()` structural freeze
  (`engine.ts:283`) with the per-node/per-edge rule (edit/remove iff `planned`;
  edge mutable iff dependent is `planned`).
- Confirm auto/hack expose the constrained structure-add tools; trusted
  additions + per-node activation check (already built).
- Docs + tests for the mutation invariant.

### Phase 5 — Recon decoupling
- `/recon` command → isolated session (own context); leaving restores the target
  mode's session. Remove recon from the forward/backward session chain.
- Flip the boot default `recon → plan`.
- Docs: `modes-architecture.md` §four modes + boot.

### Phase 6 — Docs reconciliation *(anchor sweep)*
- Rewrite `modes-architecture.md` §four modes / §plan lifecycle / §Mode
  transitions to the final model; update the defect backlog (#1/#2/#4/#8).
- Final consistency sweep across `architecture.md`, `commands.md`, `usage.md`,
  `README.md`, and this doc; ensure no dead vocabulary (`readiness`, `exploring`
  as a user phase) survives `check-docs`.

**Risks / watch items**
- *Weak local models authoring before converging* — the original reason for
  `readiness`. Mitigated by the plan system prompt, the `turn_end` taskless-worker
  nudge, and the now fail-fast execution gate; weak-model hardening stays as
  backlog #8, not a blocker.
- *The one unavoidable shim* — pi has no native "compact into a fresh session";
  distill→newSession({setup}) is composed by us (Phase 3).
- *hack's structure surface* — hack historically has no plan tools; evolve-in-place
  gives it constrained append. Confirm that reads right for the "maestro is the
  worker" posture during Phase 4.
