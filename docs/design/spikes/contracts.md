# Spike: v2 contract shapes — schemas, extraction, validation, versioning

Status: proposal, 2026-07-20. Read against `docs/design/v2-primitives.md`
(design settled). No repo files were modified.

## 0. What exists today (investigated facts)

| Mechanism | Where | Fact |
| --- | --- | --- |
| `AgentOutputContract` | `packages/contracts/src/agents.ts:90` | `{ id, description, requiredMarkers?, maxWords? }`. **`requiredMarkers` and `maxWords` are never enforced at runtime** — grep shows no consumer outside the registry declarations. They are prompt-shaping only. |
| Contract declarations | `packages/subagents/src/registry.ts:94-117` | `bounded-report` (700 words), `research-digest` (`## Digest` marker), `structured-review` (`VERDICT:`), `scoped-verification` (`VERDICT:`). All descriptive. |
| Verdict parse | `packages/modes/src/exec/verdicts.ts` | Tolerant free-text parser: last `VERDICT:` line (case-insensitive), accepts approve/pass and request-changes/block wire words, collects `- ` bullets after it. No verdict → `"none"` (non-blocking). Purely mechanical, no LLM in the decision. |
| Findings parse | `packages/modes/src/exec/findings.ts` | Two-tier: `parseJsonFindings` takes the **last** ```` ```json ```` fence in the report, expects `{ findings: [...] }`, normalizes each against `StructuredFinding` (`packages/contracts/src/plan.ts:89`); on any invalid finding the whole JSON tier is rejected and it falls back to `parseVerdict` bullets promoted to `severity: "major"`. `computedVerdict()` derives approve/request-changes from severities (`isBlockingSeverity` = anything but minor). |
| Worker summary | `packages/modes/src/exec/execution-adapter.ts:846-871` | `requestSummary` sends a `summarize` RPC (consumer + preamble + `SUMMARY_TOKEN_BUDGET`, 120s timeout); on timeout/dead agent falls back to `lastAssistantFromTranscript` (walk session JSONL backwards for the last assistant text, :1950); final fallback is the literal `"## Summary\n(agent produced no summary)"`. Result is `truncateSummary`'d at paragraph boundaries (`seeds.ts:197`). |
| Findings flow to later agents | `packages/modes/src/exec/seeds.ts` | `buildSeed` frames prior summaries under `# Prior Work` and sibling agent summaries under `# Findings from Earlier Review` — byte-stable, cache-friendly. Consumes plain summary strings today. |
| One-shot results | `packages/contracts/src/runs.ts:181` | `RunResult { status, summary?, error?, stop? }` — `summary` is the child's final text; watchdog-stopped runs deliver **salvaged partial text** (`partialText()` on `RunHandle`). Projections (`packages/subagents/src/projections.ts`) carry `result` through `ChildRunProjection` unchanged. |
| Reducers | `packages/contracts/src/agents.ts:84` | `"identity" | "research-digest" | "review-findings" | "verification"` — ids only; the reduction itself is the parse code above. |

Design-relevant conclusions from the code:

1. There is already a de-facto extraction convention: **the entire final
   message is the deliverable**, with an optional machine block (last JSON
   fence) and a mechanical trailer line (`VERDICT:`). v2 should formalize
   this, not replace it.
2. Salvage tiers already exist everywhere (RPC → transcript → placeholder;
   JSON fence → bullet heuristic; partial text on watchdog stop). v2 must
   keep them — they are why crashed/stopped agents still contribute.
3. Contracts are declared but not enforced. v2's main new work is the
   **validator + retry loop**, not the schema prose.
4. The codebase convention is hand-rolled `validateX(value): string[]`
   validators in `@vegardx/pi-contracts` (see `validateStructuredFinding`,
   `validateResolvedAgentAssignment`) — no zod. Stay with that.

---

## 1. The common envelope

Every contract result is the same two-layer object: an **agent-authored
envelope** (what the model wrote) wrapped in a **harness-authored result**
(provenance, extraction facts, mechanically derived fields). Models never
author the outer layer; the harness never invents the inner one.

```ts
// packages/contracts/src/contracts.ts (new module)

export const CONTRACT_IDS = [
  "summary-and-diff", // worker
  "findings",         // reviewer
  "report",           // explorer
  "verdict",          // callers: command-auditor, verify-findings, verify-delivery
  "bounded-report",   // plan→auto gate
] as const;
export type ContractId = (typeof CONTRACT_IDS)[number];

/** What the agent writes inside its fenced block. */
export interface ContractEnvelope<Id extends ContractId, P> {
  readonly contract: Id;
  /** Schema version of this contract id (see §5). */
  readonly v: number;
  /** "complete" normally; "partial" when wrapping up under a watchdog steer. */
  readonly status: "complete" | "partial";
  readonly payload: P;
}

export type ExtractionTier =
  | "block"          // sentinel fence parsed and validated
  | "retry-block"    // ditto, after ≥1 corrective steer
  | "salvage-parse"  // harness heuristics over free text (legacy parsers)
  | "fallback";      // harness-authored minimal payload; agent contributed nothing parseable

/** What the harness persists on the plan ledger for the node. */
export interface ContractResult<Id extends ContractId = ContractId, P = unknown> {
  readonly envelope: ContractEnvelope<Id, P> | null; // null only when tier = "fallback"
  readonly extraction: ExtractionTier;
  readonly attempts: number;            // 1..3
  /** Full final-message text (prose + block) — HUD/humans read this. */
  readonly raw: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly model: string;               // resolved model that produced it
  readonly completedAt: string;         // ISO
  /** Validation errors that were overridden by salvage, for explain output. */
  readonly diagnostics?: readonly string[];
}
```

Design points:

- **Prose stays primary for humans.** The final message remains a readable
  report; the fenced block is its machine appendix. `raw` is what the HUD
  shows and what `# Findings from Earlier Review` seeds quote; the payload
  is what gates and projections branch on. This preserves today's "your
  entire final message is the report" texture.
- **`status: "partial"` is agent-authored honesty**, produced when the
  watchdog wrap-up steer fires (the existing `wrapUpSteer` text gains one
  sentence: "emit your contract block with `status: partial`"). It is
  distinct from `extraction: "salvage-parse"`, which is harness-diagnosed.
- **Mechanical facts are harness-derived, never model-asserted.** The
  worker's diff stat, branch, and SHAs come from git at collection time
  (§4); the reviewer's verdict is a projection of severities (§2.2). An
  agent cannot claim a diff that git does not show.

---

## 2. The five contracts

### 2.1 `summary-and-diff` (worker)

The worker asserts judgment (what it did, task states, follow-ups); the
harness attaches the git facts. This split is the "trust the worker, verify
with git" line the cutover review already settled for findings.

```ts
export interface SummaryAndDiffPayload {
  /** Markdown completion summary; truncated to SUMMARY_TOKEN_BUDGET on store. */
  readonly summary: string;
  readonly outcome: "done" | "partial" | "blocked";
  /** One entry per task the node carried, in task order. */
  readonly tasks: readonly {
    readonly id: string;                       // plan task id
    readonly state: "done" | "partial" | "not-done";
    readonly note?: string;                    // required when state !== "done"
  }[];
  /** Commands the worker ran to validate (tests, typecheck, lint). */
  readonly validation?: readonly {
    readonly command: string;
    readonly result: "pass" | "fail" | "not-run";
    readonly note?: string;
  }[];
  /** Work discovered but deliberately not done. */
  readonly followUps?: readonly string[];
  /** Required when outcome === "blocked". */
  readonly blockedReason?: string;
}

/** Harness-derived at collection time; stored alongside the envelope. */
export interface DiffFact {
  readonly diff: DiffPayload;
  readonly stat: { readonly files: number; readonly insertions: number; readonly deletions: number };
  /** True when the worktree still had uncommitted changes at collection. */
  readonly dirty: boolean;
}

export type DiffPayload =
  | { readonly kind: "ref"; readonly branch: string; readonly baseSha: string; readonly headSha: string }
  | { readonly kind: "patch"; readonly baseSha: string; readonly text: string }
  | { readonly kind: "none"; readonly reason: "scratch-node" | "no-changes" };

/** The persisted worker result = judgment + facts. */
export interface WorkerResult extends ContractResult<"summary-and-diff", SummaryAndDiffPayload> {
  readonly diffFact: DiffFact;   // present even when extraction === "fallback"
}
```

Example (agent block + harness fact):

```json
{
  "contract": "summary-and-diff", "v": 1, "status": "complete",
  "payload": {
    "summary": "Implemented token rotation per docs/auth.md. Rotation runs on a 15m timer with jittered refresh; expiry races are handled by the double-read guard in TokenStore.refresh(). Chose the event-driven variant from candidate B (cleaner shutdown) over my own draft.",
    "outcome": "done",
    "tasks": [
      { "id": "t1", "state": "done" },
      { "id": "t2", "state": "partial", "note": "Rotation behavior covered; revocation path has no test — no fake clock seam in TokenStore yet." }
    ],
    "validation": [
      { "command": "bun test packages/auth", "result": "pass" },
      { "command": "bun run typecheck", "result": "pass" }
    ],
    "followUps": ["Add a fake-clock seam to TokenStore so revocation expiry is testable."]
  }
}
```

```json
{
  "diff": { "kind": "ref", "branch": "feat/auth", "baseSha": "9f31c2e", "headSha": "4b7d0aa" },
  "stat": { "files": 7, "insertions": 412, "deletions": 38 },
  "dirty": false
}
```

The `diff` question itself is settled in §4.

### 2.2 `findings` (reviewer)

Reuses `StructuredFinding` from `packages/contracts/src/plan.ts:89`
**verbatim** — it is already the shared vocabulary of the panel ledger,
`/verify`, and the findings parsers.

```ts
export interface FindingsPayload {
  readonly findings: readonly StructuredFinding[];   // empty array = clean review
  /** What was actually examined — scope honesty, feeds the verifier. */
  readonly scope: {
    readonly reviewed: string;                       // e.g. "feat/auth diff 9f31c2e..4b7d0aa + surrounding auth package"
    readonly notReviewed?: readonly string[];
  };
  /** Short prose wrap-up (≤ ~150 words); the long form lives in `raw`. */
  readonly summary: string;
}

/** Verdict is a PROJECTION, not a payload field. */
export function findingsVerdict(p: FindingsPayload): "approve" | "request-changes" {
  return computedVerdict(p.findings);  // existing fn: blocks iff any non-minor finding
}
```

The deliberate change from v1: **no agent-asserted verdict field.** Today a
reviewer can write `VERDICT: PASS` above a `major` finding and the two
disagree; `computedVerdict` already exists to resolve it. v2 removes the
disagreement class: severity is the only lever, the verdict is mechanical
(matching the v1 prompt rule "block if and only if a critical or major
finding remains" — now enforced by construction). Salvage tier still reads
`VERDICT:` lines from legacy-shaped output (§3).

Example:

```json
{
  "contract": "findings", "v": 1, "status": "complete",
  "payload": {
    "findings": [
      { "id": "F1", "severity": "major", "category": "security",
        "file": "packages/auth/src/rotate.ts", "line": 88,
        "claim": "refresh tokens are single-use",
        "actual": "The old refresh token stays valid until TTL: rotate() persists the new token before revoking the old one and the revoke result is unchecked.",
        "evidence": ["rotate.ts:88 fire-and-forget revoke()", "no test asserts old-token rejection"] },
      { "id": "F2", "severity": "minor", "category": "maintainability",
        "file": "packages/auth/src/rotate.ts", "line": 30,
        "actual": "Jitter constant 0.15 is unexplained; name it and cite the herd-avoidance rationale." }
    ],
    "scope": { "reviewed": "feat/auth 9f31c2e..4b7d0aa plus packages/auth", "notReviewed": ["gateway config changes"] },
    "summary": "Rotation logic is sound overall; one real security gap in revocation ordering (F1) must be fixed before ship."
  }
}
```

Consumption is unchanged in spirit: `renderFinding()` one-liners under
`# Findings from Earlier Review` in the next agent's seed (`seeds.ts`), full
`StructuredFinding`s to the verifier and the panel ledger.

### 2.3 `report` (explorer)

Merges v1's `bounded-report` (700-word body) and `research-digest`
(`## Digest` ≤ 6 lines / 500 chars) into one shape — the digest becomes the
`answer` field, the body stays prose in `raw`, and evidence becomes typed.

```ts
export type EvidenceRef =
  | { readonly kind: "file"; readonly path: string; readonly line?: number; readonly note?: string }
  | { readonly kind: "url"; readonly url: string; readonly title?: string; readonly accessed?: string }
  | { readonly kind: "command"; readonly command: string; readonly observation: string };

export interface ReportPayload {
  /** The dense self-sufficient answer — today's Digest. ≤ 600 chars. */
  readonly answer: string;
  /** Load-bearing facts, each independently checkable. */
  readonly facts: readonly { readonly text: string; readonly evidence: readonly EvidenceRef[] }[];
  /** What could not be determined — explicit, may be empty. */
  readonly unknowns: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}
```

Example:

```json
{
  "contract": "report", "v": 1, "status": "complete",
  "payload": {
    "answer": "Session files are JSONL appended in place; resuming one is cache-hot by construction. Fork-from-knowledge-base happens only on fresh spawns (buildAgentSessionFile); resumes skip seeding entirely.",
    "facts": [
      { "text": "Resume path skips seed and session assembly.",
        "evidence": [{ "kind": "file", "path": "packages/modes/src/exec/execution-adapter.ts", "line": 512 }] },
      { "text": "Fresh spawns fork the plan's frozen knowledge session when present.",
        "evidence": [{ "kind": "file", "path": "packages/modes/src/exec/execution-adapter.ts", "line": 577 }] }
    ],
    "unknowns": ["Whether the gateway preserves cache across model switches — not testable read-only."],
    "confidence": "high"
  }
}
```

### 2.4 `verdict` (callers: command-auditor; verify duties)

The smallest contract, with two profiles under one shape: the hot-path
command-auditor emits the minimal form; verify duties (`verify-findings`,
`verify-delivery`) add per-claim checks. Keeps v1's binary decision and its
scope-lock texture.

```ts
export interface VerdictPayload {
  readonly verdict: "pass" | "block";
  /** One sentence, always — a bare verdict is not reviewable. */
  readonly reason: string;
  /** Verify duties: one entry per claim/finding/task, scope-locked. */
  readonly checks?: readonly {
    readonly ref: string;                       // finding id, task id, or claim text
    readonly state: "verified" | "still-open" | "not-checkable";
    readonly evidence?: string;
  }[];
}
```

Rules: `verdict` must equal `"block"` iff any check is `still-open`
(mechanically enforced, same philosophy as §2.2 — when `checks` is present
the harness recomputes and the recomputation wins, with a diagnostic on
mismatch). `not-checkable` does not block but is surfaced. The
command-auditor form (`tool:bash` rows) is just `{ verdict, reason }` —
one fast-tier model turn, no fence retry loop (§3, hot-path note).

Example (verify-findings):

```json
{
  "contract": "verdict", "v": 1, "status": "complete",
  "payload": {
    "verdict": "block",
    "reason": "F1 is fixed and tested; F3's fix does not cover the concurrent-refresh path it claimed to.",
    "checks": [
      { "ref": "F1", "state": "verified", "evidence": "rotate.ts:91 now awaits revoke(); test 'rejects revoked refresh token' added" },
      { "ref": "F3", "state": "still-open", "evidence": "claimed mutex in refresh(); only the timer path takes it — refreshNow() bypasses it" }
    ]
  }
}
```

Example (command-auditor, hot path):

```json
{ "contract": "verdict", "v": 1, "status": "complete",
  "payload": { "verdict": "block", "reason": "curl piping a remote script to sh from a depth-2 worker; not derivable from any task." } }
```

### 2.5 `bounded-report` (plan→auto gate)

The gate persona is specialized for ambiguity; its output must be
**act-on-able**: every finding names a plan location and carries a concrete
rewrite. "Bounded" survives as a hard size cap so the gate's report can be
shown whole at the mode edge.

```ts
export interface PlanGateFinding {
  readonly id: string;
  readonly severity: "blocking" | "advisory";
  /** Plan location: node id, and task index within it when task-scoped. */
  readonly node?: string;
  readonly task?: number;
  readonly kind:
    | "ambiguity"          // double readings, vague verbs, unstated targets
    | "delegation"         // fan-out wanted but not stated (or vice versa)
    | "dependency"         // after/children don't match what tasks assume
    | "branch-ownership"   // branch facts don't match the shipping story
    | "envelope"           // fan-out/depth implied beyond caps
    | "advisory-nudge";    // e.g. branch-owning node without shipping-conventions
  /** The two-readings statement / what is unclear, concretely. */
  readonly problem: string;
  /** Concrete replacement text (task text, `after:` value, etc.). Required for blocking findings. */
  readonly rewrite?: string;
}

export interface BoundedReportPayload {
  readonly verdict: "proceed" | "revise";           // revise iff any blocking finding
  readonly findings: readonly PlanGateFinding[];
  /** ≤ 200 words; whole-report cap enforced on `raw` at 700 words. */
  readonly summary: string;
}
```

`verdict` here is again recomputed from severities; the field exists for the
salvage tier and readability. Example:

```json
{
  "contract": "bounded-report", "v": 1, "status": "complete",
  "payload": {
    "verdict": "revise",
    "findings": [
      { "id": "P1", "severity": "blocking", "node": "build-auth", "task": 0, "kind": "ambiguity",
        "problem": "\"use multi-model candidates\" does not say how many or which tier; the coder persona could read 2-from-normal or 5-from-heavy — 5x cost difference.",
        "rewrite": "Implement token rotation per docs/auth.md — spawn three coder candidates on distinct normal-tier families and integrate the strongest approach." },
      { "id": "P2", "severity": "advisory", "node": "docs-pass", "kind": "advisory-nudge",
        "problem": "Branch-owning node without shipping-conventions; PR prose will not match repo release conventions.",
        "rewrite": "skills: [repo-conventions, shipping-conventions]" }
    ],
    "summary": "One real double reading in build-auth's fan-out instruction; everything else is act-on-able. Fix P1 and proceed."
  }
}
```

Naming note: v1 already uses the id `bounded-report` for the generic
"final message ≤700 words" contract on general/research kinds. The plan
cutover is a clean cut (spike 3: no backwards compatibility), so reusing the
id at `v: 1` of the v2 registry is safe — but if any window exists where
both registries are live, rename the gate contract `plan-gate-report` to
avoid a same-id/different-shape collision. Decide in the cutover spike;
schema above is unaffected.

---

## 3. Extraction mechanism

### Recommendation: (a) sentinel-fenced JSON block, with (c) as the salvage tier. Not (b).

**The mechanism**: the agent's final message ends with one fenced block
tagged `pi-contract`:

    ```pi-contract
    { "contract": "findings", "v": 1, "status": "complete", "payload": { ... } }
    ```

Extraction = take the **last** ` ```pi-contract ` fence in the **last
assistant message**, `JSON.parse`, validate against the (id, v) validator.
Prose above the fence is the human report (`raw`); a dedicated fence tag
(not ` ```json `) means illustrative JSON in the prose can never shadow the
envelope — a real hazard `parseJsonFindings`'s last-` ```json `-block
heuristic lives with today.

**Why not (b) forced tool call / StructuredOutput**: pi-maestro's agents are
not API loops the harness owns — they are full `pi` processes reached over
tmux or RPC (`packages/subagents` transports: `host | tmux | headless`;
`execution-adapter` talks to workers via an RPC router). A forced tool call
requires controlling the model request (tool_choice) inside the child's own
loop, which the maestro cannot do across process boundaries; it would need a
protocol feature in every transport plus pi itself. Worse, the three cases
the prompt calls out all break it:

- **Resumed sessions**: a resume continues an existing JSONL; there is no
  guaranteed "final API call" the harness mediates to force the tool on.
- **Crashed/watchdog-stopped agents**: there is no tool call at all — but
  there *is* a transcript, and text-tier salvage works on transcripts
  (`lastAssistantFromTranscript`, `partialText()` already do exactly this).
- **tmux workers**: the maestro reads the session file; a tool-call result
  is just another transcript entry — no advantage over a fenced block, at
  the cost of tool plumbing in the child.

The fence degrades gracefully to bytes-on-disk in every one of these; a
forced tool call degrades to nothing.

**Why not (c) alone**: pure free-text parsing is what v1 does, and it is the
source of the tolerant-parser sprawl (`parseVerdict`, `parseJsonFindings`,
bullet-promotion heuristics) and of undetectable omissions — a reviewer that
forgets `VERDICT:` silently becomes `"none"` = non-blocking today. Free-text
stays as the salvage tier, where its tolerance is a feature, but it should
not be the happy path for a system that gates mode transitions on these
payloads.

**Where extraction hooks in, per transport** (all existing seams):

- **RPC workers**: `requestSummary`'s `summarize` RPC becomes
  `requestContract` — same request/timeout machinery
  (`execution-adapter.ts:846`), the preamble says "reply with your
  `pi-contract` block for consumer X". Reply content → extractor.
- **tmux/headless one-shots**: `RunResult.summary` (the final text) →
  extractor. No transport change.
- **Resumed sessions**: on resume-completion the same path applies; if the
  pre-crash transcript already contains a valid block (agent finished,
  harness died), extraction from `lastAssistantFromTranscript` recovers it
  without re-running the agent.
- **Crashed/stopped agents**: `partialText()` / transcript walk →
  salvage tier directly (no retries — there is nobody to steer).

**Prompting**: the contract's block requirement lives in the agent-type
prompt (harness-owned, like today's kind prompts) plus one line in the
watchdog `wrapUpSteer` ("emit the block with `status: partial`"). Personas
never restate the envelope — persona frontmatter's `contract:` is the join,
the harness renders the block instruction from the contract definition
(single source of truth, like `VERDICT_INSTRUCTION` today).

**Hot-path exception**: `tool:` policy rows (command-auditor) are single
model turns on a fast tier with the harness driving the API call directly —
*there*, forced structured output (option b) is trivially available and
right. Callers are harness components; they are not extracted from
transcripts at all. So: **fence for spawned agents, structured output for
inline callers.** The `verdict` contract shape is shared either way.

---

## 4. The diff payload for `summary-and-diff`

**Recommendation: `kind: "ref"` is the contract's promise; `"patch"` is a
derived materialization the harness may attach; the agent authors neither.**

```ts
export type DiffPayload =
  | { kind: "ref";   branch: string; baseSha: string; headSha: string }
  | { kind: "patch"; baseSha: string; text: string }
  | { kind: "none";  reason: "scratch-node" | "no-changes" };
```

Contract-side reasoning (transport mechanics belong to the ensemble spike):

1. **The schema promises reachability, not bytes.** A `ref` promise is:
   "commits `baseSha..headSha` exist on `branch` in this repo's object
   store at collection time, and `headSha` is what the summary describes."
   The harness *verifies* this when composing `DiffFact` (rev-parse both
   SHAs, `diff --numstat` for `stat`, `status --porcelain` for `dirty`).
   A patch promise can't be verified against anything — it *is* the claim.
2. **Model-authored patch text is the worst channel**: it burns output
   tokens, gets truncated by summary budgets (`truncateSummary` would
   corrupt it), and can silently diverge from the worktree. The existing
   `/verify` code already treats git as the evidence source and clips diffs
   only for *prompt display* (`DIFF_CLIP = 50_000` in `verify.ts`) — same
   philosophy.
3. **One writer per worktree + reaping (design invariant) fits `ref`**:
   candidate worktrees are reaped *after their diff is consumed* — the
   consuming step is precisely "harness materializes `baseSha..headSha`"
   (as a patch handed to the integrating parent, per whatever the ensemble
   spike picks). The contract stays stable regardless of that choice: if
   ensembles decide patches travel inline to the integrator, the harness
   converts `ref → patch` at hand-off and the `"patch"` variant is the
   wire shape it uses. Both variants therefore stay in the union, with
   authorship rules: agents' envelopes carry **no diff field at all**
   (§2.1 — it lives in the harness-side `DiffFact`); `"patch"` appears
   only in harness-materialized hand-offs.
4. **`"none"` is explicit**, because scratch nodes ("summary and side
   effects are the deliverable") and legitimately-empty outcomes must be
   distinguishable from a collection failure. Collection failure is not a
   `DiffPayload` — it is a fail-visible error on the node, same class as
   model-resolution failure.
5. **SHAs, not just branch names**: branches move (stacked docs-pass on
   feat/auth in the design example). `baseSha` pins the branch point the
   worktree was cut from — the resume/revalidation story (§5) re-verifies
   the range, and the diversity of "who advanced the branch" is auditable.

---

## 5. Validation + retry

Registry entry per contract:

```ts
export interface ContractDefinition<P> {
  readonly id: ContractId;
  readonly latest: number;
  /** Rendered into agent-type prompts and retry steers. Single source of truth. */
  readonly instruction: string;
  /** Hard caps checked on raw (words) and payload fields (chars). */
  readonly bounds?: { readonly maxRawWords?: number; readonly maxSummaryChars?: number };
  /** validate(payload, v): errors; [] = valid. Hand-rolled, contracts-package style. */
  readonly validate: (value: unknown, v: number) => string[];
  /** Free-text salvage (tier 3): today's tolerant parsers, per contract. */
  readonly salvage: (raw: string) => P | null;
  /** vN → vN+1 migration chain (§6). */
  readonly migrations: ReadonlyArray<(payload: unknown) => unknown>;
}
```

**The cadence** (per completed agent, before the node is marked done):

1. **Attempt 1** — extract fence from final message; validate. Valid →
   `extraction: "block"`, done.
2. **Steer-and-retry, at most 2 corrective steers** (3 attempts total).
   The steer is generated from the validator errors, specific and short:
   "Your final message must end with a ```` ```pi-contract ```` block for
   contract `findings` v1. Problems: payload.findings[0].severity is
   'sev-high' (must be one of critical|major|minor); payload.scope is
   missing. Re-emit only the corrected block." Each attempt reuses the
   existing request/timeout machinery (120s, `requestSummary` pattern).
   Two retries matches the cost bar: a fence fix is one cheap turn; an
   agent that fails twice at JSON syntax will not succeed on attempt 5.
3. **Salvage** (agent alive but incorrigible, or dead/crashed/stopped —
   dead agents skip straight here): `salvage(raw)` runs the legacy
   parsers — `parseVerdict` wire-words for `verdict`, `parseJsonFindings`
   + bullet promotion for `findings`, `## Digest` extraction for `report`,
   plain-summary wrap for `summary-and-diff`. Success →
   `extraction: "salvage-parse"`, `status` forced to `"partial"`,
   validator errors preserved in `diagnostics`.
4. **Fallback** (nothing parseable): `envelope: null`,
   `extraction: "fallback"`, `raw` = whatever text exists (possibly the
   `"(agent produced no summary)"` placeholder). Per-contract mechanical
   defaults, all fail-visible, never fail-open:
   - `summary-and-diff`: node completes only if `DiffFact` shows work
     *and* every gating task was toggled; otherwise the node fails with
     the fallback surfaced (mirrors today's `/verify` "mechanical evidence
     contradicts claimed status").
   - `findings`: **no verdict is synthesized.** A gate that requires
     findings treats fallback as `inconclusive` → escalate to the
     supervisor/human, exactly like `verify.ts`'s `"inconclusive"` today.
     (Never default a missing review to approve.)
   - `verdict`: `inconclusive` → escalate. For the command-auditor hot
     path specifically, inconclusive = the gated tool call is **held**,
     not allowed.
   - `report`: the raw text stands in as the report, flagged; explorer
     output is advisory so this degrades softly.
   - `bounded-report`: gate does not open; the mode edge surfaces the
     failure to the human (a human is in the loop at plan→auto anyway).
5. Every result — all four tiers — is persisted on the plan ledger with
   `attempts`, `extraction`, `diagnostics`. Explain output shows tier
   counts; a plan whose reviews all landed via salvage is visibly degraded.

Bounds (`maxRawWords`, `maxSummaryChars`) are **enforced** in the validator
(v1 declared them and never checked — the single biggest "declared vs real"
gap found in this spike). Overruns are validator errors on attempts 1–3 and
mere diagnostics at salvage tier (a long salvaged report beats no report).

---

## 6. Versioning

Contracts are harness-owned ids (invariant 8). Proposal:

1. **Envelope carries `v`** (integer per contract id). The registry knows
   `latest` and keeps validators for **all** historical versions (they are
   small hand-rolled functions; retaining them is cheap and makes old
   ledgers permanently readable).
2. **Migrate-on-read, never on-disk rewrite.** Persisted `ContractResult`s
   keep their authored `v` forever (the plan ledger is append-only —
   invariant 7). Readers call `upgrade(payload, fromV)` through the
   `migrations` chain to get the latest shape in memory. This is the same
   reusable migration component the settings follow-up wants — build it
   once in `@vegardx/pi-contracts`, share it.
3. **Additive optional fields do not bump `v`.** Validators ignore unknown
   fields (forward tolerance) and never require fields added later. Bump
   `v` only for renames, semantic changes, or new *required* fields.
4. **Resumed agents may emit stale versions legally.** A worker seeded
   before an upgrade has the old instruction in its cached prefix; on
   resume the harness does not re-prompt (cache stability). Its `v: N-1`
   block validates against the retained N-1 validator and upgrades on
   read. The resume-revalidation step (the same one that revalidates model
   assignments) additionally *warns* when a live agent's expected contract
   version is older than latest — visible, not fatal.
5. **Ids are never reused with incompatible meaning** across registries in
   the same process generation (the `bounded-report` v1/v2 note in §2.5 is
   the one clean-cut exception, resolved by the cutover being total).
   Retiring a contract removes its policy consumers first (lintable, like
   duty rows), then the id; validators for retired ids stay for ledger
   reads.
6. **Salvage parsers are version-free** — they map free text to the
   *latest* payload shape directly, since they encode no envelope at all.

---

## 7. Mapping table: v1 shapes → v2 contracts

| v1 shape | Where | v2 contract | Reusable verbatim | Changes |
| --- | --- | --- | --- | --- |
| `VERIFY_CONTRACT` ("scoped-verification": VERDICT: PASS/BLOCK + per-claim verified/still-open) | `registry.ts:112`, `verify.ts`, verifier/delivery-verifier kinds | `verdict` (checks profile) | `parseVerdict` wire-word tolerance (pass/block/approve/request-changes) as the salvage parser; `verify.ts` evidence-gathering (facts/problems/diff clip); the `"inconclusive"` outcome class | Checks become typed `{ ref, state, evidence }`; verdict recomputed from checks; envelope replaces the trailer line |
| Reviewer verdict trailer (`VERDICT_INSTRUCTION`, `parseVerdict`) | `verdicts.ts` | `findings` (verdict = projection) | `parseVerdict` verbatim as salvage; `VERDICT_INSTRUCTION` pattern becomes the rendered `instruction` | Agent-asserted verdict field **removed**; `computedVerdict` (`findings.ts`) becomes the only verdict source |
| Review findings format (`structured-review`, `parseJsonFindings`, `StructuredFinding`, `computedVerdict`, `renderFinding`) | `findings.ts`, `contracts/src/plan.ts:89` | `findings` | **`StructuredFinding` type verbatim** (incl. `FINDING_SEVERITIES`, `validateStructuredFinding`); `computedVerdict`/`isBlockingSeverity`; `renderFinding` for seed one-liners; `parseStructuredFindings` as salvage | New `scope` + `summary` fields; fence tag `pi-contract` instead of last-```json``` heuristic |
| `bounded-report` (700-word final message) + `research-digest` (`## Digest`) | `registry.ts:94-105`, research kinds | `report` | `maxWords` bound (now enforced); Digest concept → `answer` field; `RESEARCH_BASE` evidence rules (file:line / URLs / dates) → `EvidenceRef` | Digest/body split becomes `answer` + typed `facts[]`; unknowns become a required array |
| Worker completion summary (summarize RPC → transcript fallback → placeholder; `truncateSummary`) | `execution-adapter.ts:846-871,1950`, `deliverable-executor.ts` | `summary-and-diff` | The **entire delivery pipeline verbatim**: RPC request w/ consumer+preamble+budget+120s, `lastAssistantFromTranscript`, `truncateSummary`, `RunHandle.partialText()` salvage | Reply becomes an envelope; `DiffFact` (git-derived) attached harness-side; task states typed instead of prose-only |
| v1 `bounded-report` on worker kind | `registry.ts:173` | `summary-and-diff` | — (was a placeholder; workers never emitted a 700-word report through it) | Superseded |
| Plan-review kind (research-digest output) | `registry.ts:227` | `bounded-report` (plan gate) | `RESEARCH_BASE` stance prose feeds the gate persona | Findings become `PlanGateFinding` with node/task addressing + required rewrites |
| Seed framing (`# Prior Work`, `# Findings from Earlier Review`) | `seeds.ts` | consumer of `summary-and-diff` + `findings` | `buildSeed` framing verbatim (byte-stable, cache-safe); feed it `payload.summary` and `renderFinding` lines instead of raw transcripts | None structural |
| `AgentOutputContract` `{ id, description, requiredMarkers, maxWords }` | `contracts/src/agents.ts:90` | `ContractDefinition` | id/description/bounds concepts | `requiredMarkers` dies (the fence replaces it); bounds become enforced; validator/salvage/migrations added |
| Reducer ids (`identity`/`research-digest`/`review-findings`/`verification`) | `agents.ts:84` | subsumed | The projection *code* they name (this table's rows) | The id enum dies: the contract id **is** the reduction — one field instead of two parallel enums |
| `RunResult.summary` + `ChildRunProjection.result` | `runs.ts:181`, `projections.ts` | carrier of `raw` | Verbatim; projections/usage plumbing untouched | `ChildRunProjection` gains optional `contractResult?: ContractResult` |

**Net-new code**: the `pi-contract` fence extractor, the
`ContractDefinition` registry with per-version validators, the
steer-and-retry loop, `DiffFact` collection, and the migration helper.
Everything else is today's parsers and delivery plumbing re-homed as
salvage tiers and transport.
