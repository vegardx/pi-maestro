# The review loop

How a deliverable earns the right to ship. This is the part of pi-maestro
that took the most design iteration, because the naive version — "run
reviewers in a loop until they say SHIP" — fails in practice in two
directions at once: verdict flapping (a reviewer blocks, the worker asks
the human, nobody converges) and marathon re-review (a 13-round session
where each round rediscovers slightly different findings and nothing ever
ships).

The redesign rests on five principles:

1. **Reviewers report; they never adjudicate.** A reviewer's job ends at
   findings. Whether a finding is fixed, waived, or disputed is decided by
   the worker (minors), the maestro (blocking disputes), or the human
   (repeat blocks) — never by re-asking the reviewer.
2. **Severity is a contract, not a mood.** The harness computes the
   effective verdict from the findings' severities; a reviewer's own
   VERDICT line loses if they disagree.
3. **The panel runs once.** There is no second panel round. Everything
   after the first round is resolution and verification of *known* findings.
4. **Verification verifies claims, nothing else.** The verifier gets a
   closed list of resolution claims and checks exactly those, with evidence
   per claim. New problems only count if they are regressions introduced by
   the fixes.
5. **Disagreement goes up, not around.** A dispute escalates to the maestro
   and then the human; it never loops back into another review round.

## The panel

Each deliverable's plan declares its reviewers via the `agent` tool: a
**persona** from the palette, an **effort** dial, and an optional **focus**
specialization. Reviewers are one-shot, read-only, headless subagents run
against the worker's worktree — they have no tmux pane and no memory beyond
their report. Running the *same* persona twice on a deliberately different
allowed model is legitimate for sensitive deliverables, but exceptional:
raise effort first, use at most two distinct models for a persona, give each
instance a unique name, and record the cross-model justification. The panel
keeps both provenance trails rather than merging them.

The built-in palette:

| Persona | Focus | Default effort | Gates |
|---|---|---|---|
| `correctness-review` | Logic bugs, edge cases, broken invariants in the diff | high | yes |
| `security-audit` | Injection, authz, secrets, OWASP-10 in changed code | high | yes |
| `test-coverage` | Untested new behaviors; weak or over-mocked tests | medium | yes |
| `simplification` | Over-engineering, duplication, dead code | medium | no |
| `error-handling` | Swallowed errors, missing failure paths, resource leaks | medium | no |
| `api-design` | Interface shape, naming, breaking changes | medium | no |
| `documentation` | Non-obvious "why"; public API / changed-behavior docs | low | no |
| `performance` | N+1, accidental quadratics, hot-path allocations | medium | no |

Every persona reports under the same contract: a VERDICT line, then a
fenced JSON findings block —

```json
{"findings": [{"severity": "critical|major|minor", "category": "<kebab-theme>",
  "file": "path", "line": 123, "claim": "what should hold",
  "actual": "what actually happens"}]}
```

Severity meanings are fixed: `critical` = must not ship (data loss,
security hole, crash, silently wrong results); `major` = blocks ship (a
real defect a user would hit); `minor` = advisory — the worker decides, and
minors never justify a BLOCK.

## The ledger

The harness — not the reviewers — mints canonical finding ids
(`<reviewer>.<n>`) and folds every panel report into a **review ledger**:
one entry per finding, carrying its resolution state and verification
result. The ledger is the single source of truth for the gate, survives
worker compaction (open findings are re-injected into the compaction
summary), persists across worker restarts, and is what `/agents` summarizes
(`cycle 1/3 · 2 blocking open · 1 disputed`).

## The worker's episode

From the worker's side, review is a three-beat episode on the `review` tool:

1. **Panel.** `review()` with no arguments runs the full panel once and
   returns the findings with their canonical ids. (If a reviewer crashed or
   returned an empty report, a repair action re-runs *only the failed
   reviewers* — never the whole panel.)
2. **Resolve.** The worker fixes what it agrees with (and commits), then
   calls `review({resolutions})` — one resolution per finding id:
   - `fixed` — with a note saying what changed;
   - `wont-fix` — **minors only**, with rationale; the worker's call to make;
   - `disputed` — blocking findings only, **once** per finding, with the
     rationale attached so the disagreement travels with the finding;
   - `duplicateOf` — folds a finding into another; the merged entry keeps
     the max severity.

   Resolutions are all-or-nothing: leaving any open blocking finding
   unaccounted for is a tool error and nothing is applied. There is no way
   to quietly ignore a finding.
3. **Verify.** A single scope-locked verifier receives the closed claim
   list and checks each one with evidence, marking it `verified` or
   `still-open`. It may add findings only for regressions introduced by the
   fixes (minted as `verifier-N.n`). Skipped claims stay open —
   conservatism over optimism.

Beats 2–3 repeat as **fix cycles**, budgeted per deliverable
(`maxFixRounds`, default 3) with a grace window per cycle. A worker
claiming completion mid-cycle gets steered back to the open ids instead of
being killed.

## The escalation ladder

When the gate blocks — open blocking findings survive the budget, or a
dispute needs adjudication — escalation climbs:

1. **Maestro triage.** The first block goes to the maestro, which holds the
   whole-plan view. It can send the deliverable back **once** with
   authored guidance (a rework epoch: the ledger survives, cycles reset) or
   escalate to you — and escalating *requires* a recommendation and a why.
2. **The human.** Repeat blocks, and anything the maestro escalates, become
   a gate question with the failing findings inline and the maestro's
   recommendation pre-sorted first: **Send back with guidance** /
   **Override and ship** / **Leave parked** / **Discuss & research first**.
   Overriding requires a reason and records a per-finding waiver — waived
   ids are excluded from every future gate check, so an override can't be
   silently re-litigated. Discuss parks the decision and re-presents it
   after the conversation.

The net effect: reviewers are heard exactly once, every finding has an
auditable fate (fixed, verified, waived, wont-fixed, or disputed-and-ruled),
and the only loops left are bounded fix cycles with a budget.

<!-- verified against eb4ef95ff0cf -->
