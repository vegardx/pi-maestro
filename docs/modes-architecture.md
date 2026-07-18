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
| **plan** | Formalize a plan *in context* (as discussion/text), surface open questions. | Planner — converges on what to build; **does not** author formal structure until the plan→auto gate. | read-only + `plan` (read) + research + bash (gated) + `readiness`. Structure tools (`deliverable`/`task`) **locked** until `structuring` (see [Plan lifecycle](#the-plan-lifecycle)). |
| **auto** | Orchestrated execution. | **Conductor** — spawns workers per deliverable (worktrees, parallel per deps), runs reviews, ships, then sits idle when all deliverables are done. | full plan/structure + orchestration; workers get implementation tools. |
| **hack** | Escape hatch for everything. | **The maestro *becomes* the worker** — does the work itself, sequentially, in-session. No orchestration fan-out. | full baseline implementation tools (edit/write/bash/commit), **no** plan-structure/orchestration tools. |

**hack is the important nuance:** it is not "auto without a plan." It is the
maestro dropping the conductor role and doing the work directly, one thing at a
time, in its own session. Fan-out to workers is exactly what hack turns *off*.

---

## The plan lifecycle

Plan mode has an internal phase (`planPhase`, derived from plan state) with a
gate. Verified live 2026-07-18.

```
/plan ──▶ exploring ──[readiness gate: human confirms]──▶ structuring ──▶ author
              │  structure tools LOCKED                        │  deliverable/task UNLOCKED
              │  (only read/research/readiness)                ▼
              │                                            plan → auto transition
              ▼                                            (2nd gate; distill+fork;
        research, discuss, open questions                  plan review runs)
```

1. **exploring** — read/research/discuss. `deliverable`/`task` are *locked*
   (calling one returns "not found" because it isn't in the active set). The
   human drives convergence; the model should **nudge** when there are no open
   questions but must not self-decide the plan is done.
2. **readiness gate** — the transition toward forming/executing the plan
   presents a confirm ("Ready to form the plan?"). On confirm, phase flips
   `exploring → structuring` and structure tools unlock.
3. **structuring** — author deliverables/tasks/reviewers.
4. **plan → auto** — the human moves to auto. This is where the **plan review**
   runs and can flag a missing piece; the human deals with findings (or ack's
   none). Then execution auto-starts deliverable #1.

**Open design point (see backlog #4):** today there is *both* a `readiness` tool
and a separate `requestMode` transition gate. The intent is that the
**mode-change attempt itself is the readiness signal** — attempting plan→auto
*is* "I'm ready" — collapsing the two into one gate.

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
| 4 | P1 | **Two gates for one intent** — separate `readiness` tool and `requestMode` transition gate. | Make the plan→auto attempt *be* the readiness gate (distill+fork+author on confirm). |
| 5 | P2 | **No routing-inspection surface** — no command shows role→model resolution (`/maestro explain` was documented but never existed). | Add a read-only routing/model-inspection command; also surfaces the planner's model reasoning for the oracle. |
| 6 | P2 | **Driver skill omits the readiness handshake** and references the non-existent `/maestro explain`. | Fix `.agents/skills/drive-maestro-e2e/` + the #221 doc references. |
| 7 | P1 | **e2e can't reach execution** — a weak planner can't author the plan. | Add a `--seed-plan` capability: write a valid `plan.json` into the isolated plan store; open by slug. |
| 8 | — | **Weak models can't author plans unaided** (didn't self-initiate readiness; hallucinated authoring). | Separate hardening thread: strengthen the planning preamble / tool discoverability. Tracked, not blocking. |

Fix order follows the backbone: **1 → 2 → 4** (transition/session core), then
**7 → 5/6** (unblock + observe the e2e), with **3** and **8** alongside.
