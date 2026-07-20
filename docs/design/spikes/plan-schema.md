# Spike: plan schema cutover — flat Deliverables → v2 recursive node tree

Status: spike report, 2026-07-20. Read-and-propose only; nothing in the repo was modified.
Canonical context: `docs/design/v2-primitives.md` (design settled 2026-07-20).
Precedent: v4→v5 was a clean cut ("Older plans are intentionally unsupported", `packages/contracts/src/plan.ts:9`); v2 is the same, sequenced so `npm run check` stays green on every PR.

---

## 1. The v2 Node schema

### 1.1 Design stance

One recursive type. Today's three-way split — `Deliverable` (persisted, full lifecycle) vs `WorkerSpec` (embedded, primary) vs `AgentSpec` (embedded, runtime state **in-memory only**) — collapses into `PlanNode`. The single biggest structural change is not the recursion, it's that **support agents become first-class ledger entries**: today a reviewer's status/session/summary lives only in `DeliverableExecutor`'s in-memory `AgentState` and dies with the process; in v2 every node persists its own status, session fields, and resolution, which is what makes the plan "the complete truthful record" for recovery/HUD/explain.

Model fields are gone from authored input (invariant 2: inheritance) but a **persisted resolution record** appears — the harness "persists the resolution on the ledger, and revalidates on resume" (design doc, Model resolution §2).

### 1.2 TypeScript schema (proposed, `packages/modes/src/plan/schema.ts` — new module)

```ts
// ─── Vocabulary (moves to packages/contracts/src/plan-v2.ts) ────────────────

export const PLAN_SCHEMA_VERSION_V2 = 6 as const;

/** Spawnable agent types. `caller` is deliberately unrepresentable. */
export const NODE_AGENT_TYPES = ["worker", "explorer", "reviewer"] as const;
export type NodeAgentType = (typeof NODE_AGENT_TYPES)[number];

/**
 * Node lifecycle. Reuses today's DeliverableStatus values + transitions
 * verbatim (contracts DELIVERABLE_TRANSITIONS): the state machine survives,
 * it just applies to every node. `shipped` is only reachable for
 * branch-owning nodes; non-branch nodes terminate at `complete` (their
 * contract output is the deliverable) and are folded into the parent's
 * completion. `superseded` stays user-driven; `abandoned` is how ledger
 * entries "go away" (append-only: no deletion after execution starts).
 */
export type NodeStatus = DeliverableStatus; // planned|active|complete|failed|shipped|superseded|abandoned

/**
 * Task kinds — WorkItemKind survives WHOLE. Rationale per kind:
 *  - "task":       gating, authored. Survives unchanged.
 *  - "followup":   non-gating agent-added notes (RPC addTask default). Survives.
 *  - "question":   planning-phase Q&A with answer/decidedAt stamping. Survives.
 *  - "manual":     human checkpoints (debug-repair addManualCheckpoint). Survives.
 *  - "preflight"/"postflight": harness-injected lifecycle pair. SURVIVES —
 *    v2 removes nothing that replaces the handoff mechanism. Injection rule
 *    generalizes: on activation of any WORKER node, preflight iff the node
 *    has `after` deps (absorb upstream handoffs), postflight iff any sibling
 *    lists it in `after` OR it owns a branch (someone consumes its handoff).
 *    Explorer/reviewer nodes get NEITHER — their contract output IS the
 *    handoff. GATING_KINDS (task|preflight|postflight) unchanged.
 */
export type NodeTaskKind = WorkItemKind;

export interface NodeTask {
  id: string;              // slug, unique within the node
  title: string;
  body: string;            // authored sugar: a bare string task → title, body ""
  done: boolean;
  kind?: NodeTaskKind;     // absent = "task" (effectiveWorkItemKind carries over)
  answer?: string;         // question kind: decision; stamps decidedAt, sets done
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Persisted model resolution (NEW — replaces authored model/effort) ──────

/**
 * Written by the harness at spawn, revalidated on resume (catalog ∩ residency
 * ∩ agent allowlist may have changed). Never authored. `source` powers the
 * explain output's "inherit / session-fallback are exempt but labeled" rule.
 */
export interface NodeResolution {
  model: string;                 // concrete model id actually used
  family: string;                // from catalog (authored, never inferred)
  tier?: "fast" | "normal" | "heavy"; // absent when source is inherit/fallback
  source: "inherit" | "persona-tier" | "session-fallback";
  /** Deduped notice recorded when source is session-fallback (fail-visible). */
  fallbackReason?: string;
  resolvedAt: string;
  generation: number;            // resolution is per session generation
}

/** Diversity edge check result — soft but loud (invariant 5). */
export interface DiversityRecord {
  parentFamily: string;
  family: string;
  sameFamily: boolean;
  waiver?: string;               // authored diversityWaiver: "<reason>"
  recordedAt: string;
}

// ─── Envelope & watch ───────────────────────────────────────────────────────

export interface NodeEnvelope {
  /** Cap on direct children (authored + dynamic). Absent → plan default. */
  maxChildren?: number;
}

/**
 * Per-node watcher OVERRIDES only. Defaults live in policy rows (the watcher
 * caller); a node states exceptions, e.g. a long-running researcher that
 * shouldn't be idle-reaped on the default cadence. Carries today's
 * IDLE_DONE_THRESHOLD / dirty-hold knobs into config instead of constants.
 */
export interface NodeWatchConfig {
  idleDoneThreshold?: number;        // today: const 2
  dirtyHoldMaxSteers?: number;       // today: const 3
  dirtyHoldResteerMs?: number;       // today: const 120_000
  lifetime?: "one-shot" | "until-condition"; // watcher-caller field (design doc)
}

// ─── The node ───────────────────────────────────────────────────────────────

export interface PlanNode {
  type: "node";
  /** Plan-UNIQUE id (uniqueness across the whole tree, not per sibling group —
   *  node ids are RPC agent keys, tmux-name seeds, and `authoredBy` refs). */
  id: string;
  agent: NodeAgentType;
  /** Persona name; validated against the registry for this agent type. */
  persona: string;
  title?: string;                 // display; falls back to id
  /** Assignment prose. Replaces Deliverable.body + AgentSpec.focus. */
  tasks: NodeTask[];
  /** Knowledge skills loaded at start (persona frontmatter skills unioned on top). */
  skills?: string[];
  /**
   * Sibling-scoped ordering deps + the reserved token "parent" (the parent
   * node's own gating tasks must be done first — the doc's `after: [worker]`
   * example; renamed since every node is uniform now; the authoring layer can
   * accept "worker" as an alias during the transition). Root nodes: plan-level
   * ordering. Empty/absent = start when the parent activates.
   */
  after?: string[];
  /** THE authored workspace fact: this node ships one PR from this branch. */
  branch?: string;
  /**
   * Base override for branch-owning nodes. Absent = derived (nearest `after`
   * dep owning a branch in the same repo, stackable status — today's
   * pickBaseBranch logic verbatim). "default-branch" = today's stacked:false.
   */
  base?: "default-branch" | string;
  /** Repo registry key (multi-repo plans). Absent = plan default repo.
   *  NOTE: a second authored workspace fact — see §1.5 open questions. */
  repo?: string;
  envelope?: NodeEnvelope;
  watch?: NodeWatchConfig;
  /** Same-family spawn waiver, recorded into DiversityRecord at the edge. */
  diversityWaiver?: string;
  /** Recursive children. Depth of the whole tree ≤ plan.maxDepth. */
  children?: PlanNode[];

  // ── Ledger provenance ──
  /**
   * "plan" for human/planner-authored nodes; a node id for dynamic children
   * appended during execution (written into the plan BEFORE spawn). The
   * append is what makes ensembles/fan-out visible: no invisible spawns.
   */
  authoredBy: "plan" | string;
  appendedAt?: string;            // set for dynamic children

  // ── Runtime state (persisted; formerly Deliverable runtime + in-memory AgentState) ──
  status: NodeStatus;
  /** Model resolution history, newest last, bounded (one per generation). */
  resolutions?: NodeResolution[];
  diversity?: DiversityRecord;
  baseSha?: string;               // 40-char immutable SHA (branch-owning only)
  lastReviewedHead?: string;
  worktreePath?: string;          // workers; cleared on completion/reap
  /** Ensemble candidates: worktree reaped after diff consumed (design doc). */
  worktreeReapedAt?: string;
  sessionPath?: string;           // durable transcript; resume ingredient
  sessionName?: string;           // tmux session; orphan cleanup on recovery
  /** Monotonic session-replacement epoch — workerSessionGeneration machinery
   *  carries over UNCHANGED in semantics, now on every node (any node can be
   *  restarted, not just the primary worker). Absent hydrates as 0. */
  sessionGeneration?: number;
  previousSessionPaths?: string[]; // bounded, MAX_PREVIOUS_SESSIONS = 5
  restartMode?: "resume" | "fresh";
  restartState?: "idle" | "restarting" | "running" | "blocked";
  /**
   * Contract output (shape per the contract-shapes spike): summary-and-diff /
   * findings / report. Reserved here as an opaque envelope so this spike
   * doesn't pre-empt that one.
   */
  result?: { contract: string; payload: unknown; recordedAt: string };
  /** Human-oriented rollup, produced at completion (requestSummary path). */
  summary?: string;
  /** Downstream handoff written via the postflight toggle. Workers only. */
  handoff?: string;
  prUrl?: string;                 // branch-owning nodes only
  prNumber?: number;
  workflowAnalytics?: WorkflowAnalyticsLedger;   // per-PR provenance, unchanged
  failure?: DeliveryFailure;      // status "failed" ⇔ failure present (rule kept)
  findings?: StructuredFinding[]; // canonical findings, unchanged
  gates?: TransitionGate[];       // durable transition evidence, unchanged
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface PlanV2 {
  schemaVersion: typeof PLAN_SCHEMA_VERSION_V2;   // 6
  slug: string;
  title: string;
  repoPath: string;
  /** Profile binding by name (per the profile-binding spike's recommendation). */
  profile?: string;
  /** Default 3; the seat is depth 0, so authored trees may nest ≤ maxDepth. */
  maxDepth?: number;
  /** Plan-wide default child cap when a node has no envelope. */
  defaultEnvelope?: NodeEnvelope;
  phase?: PlanPhase;              // exploring | structuring — carries over
  understanding?: string;
  repos?: PlanRepo[];             // multi-repo registry incl. createdBy — carries over
  /** The tree. Roots are today's top-level deliverables. */
  nodes: PlanNode[];
  parentIssueNumber?: number;
  planSessionPath?: string;
  lastSyncedAt?: string;
  repairAudit?: PlanRepairAuditEvent[];   // fingerprinted debug repairs — carries over
  transitionGates?: ModeTransitionGate[]; // gate RULINGS persist here; policy rows
                                          // decide when gates run (they replace gate
                                          // *configuration*, not gate *evidence*)
  createdAt: string;
  updatedAt: string;
}
```

### 1.3 What dies, what survives — field-by-field disposition

| v1 | v2 disposition |
| --- | --- |
| `Deliverable` | → `PlanNode` (worker node, usually branch-owning) |
| `WorkerSpec` (`mode`, `model`, `effort`, `after`) | **deleted.** `mode: full/read-only` → derived from `agent` type (worker=write, explorer/reviewer=read). `model`/`effort` → forbidden (inheritance) + `NodeResolution` ledger. `worker.after` → child-node `after: ["parent"]` inversion or sibling `after`. |
| `AgentSpec` (`name`, `focus`, …) | → child `PlanNode` (`focus` becomes the node's task text; `name` becomes `id`) |
| `dependsOn` | → root-level `after` (one vocabulary at every depth) |
| `stacked?: boolean` | → derived stacking + `base` override (`stacked:false` ≡ `base:"default-branch"`) |
| `workspace: "repo"\|"scratch"` | **deleted as authored.** Worker ⇒ worktree always (design table). A branchless worker node is today's scratch: it never ships, its worktree/plain dir is reaped after its contract output is consumed. `createScratchWorkspace` survives as the provisioning path for `repo`-less plans. |
| `WorkItem` / `WorkItemKind` | → `NodeTask` / all six kinds survive (see §1.2 rationale) |
| lifecycle pair injection (engine `injectLifecycleTasks`) | survives, generalized to worker nodes (rule in §1.2) |
| `sessionGeneration` / `workerSessionGeneration()` / epoch guards | survive verbatim, per node. The adapter's generation-vs-connection guards (`connectionGenerations`, `generationMatches`, restart barrier, `ignoreRestartingWorkers`) re-key from `deliverableId/agentName` → `nodeId`. |
| `restartMode/restartState`, `previousSessionPaths` | survive per node |
| `summary` / `handoff` | survive; `handoff` still written via postflight toggle |
| `gates`, `findings`, `workflowAnalytics`, `failure` | survive unchanged (contracts validators reused) |
| `AgentWorkflow` / `WorkflowStageSpec` / `validateWorkflowGraph` | **deleted.** The staged-assignment layer (stages, barriers, inputRevision, contracts DAG) is the v1 "review pipeline, gating items" row of the mapping table — replaced by child nodes with contracts. ~130 lines of validation go away. |
| `topologicalSort` / `immediateAgents` / `unblockedAgents` | → one sibling-group scheduler: `readyChildren(parent, completedSiblings)` (same Kahn logic, one scope instead of the worker-special-cased two) |
| `isDeliverableReady` / `shippableDeliverables` / `blockedReason` | survive re-derived over sibling groups: SATISFIED_STATUSES and ship-in-chain-order logic carry over with `dependsOn` → root `after` |
| `pickBaseBranch` | survives as the `base` derivation (same skip rules: no branch, cross-repo, non-stackable status) |
| `PLAN_PHASES`, `planPhase` | survive (planning UX is orthogonal) |
| `planFingerprint` | survives; excluded-field list updated (per-node session/process bookkeeping), now hashes the tree |
| `SUMMARY_TOKEN_BUDGET`, `boundedPreviousSessionPaths` | survive |

### 1.4 Append-only ledger semantics

The engine's `mutate()` (clone → apply → validate → save) survives as the single validated write path. What changes is **which mutations are legal when**:

- **Before execution** (`phase: structuring`, no node beyond `planned`): full CRUD — add/update/remove nodes, reorder, edit tasks. Identical editing freedom to today.
- **After execution starts** (any node beyond `planned`), the plan is append-only:
  1. **Append child** — `appendChild(parentId, nodeInput, authoredBy)`, the ONE dynamic-structure operation. Runs the spawn-side validations (§2), stamps `authoredBy` + `appendedAt`, and MUST commit to disk before the spawn is attempted (write-ahead: crash between append and spawn leaves a `planned` child that recovery can spawn or abandon — never an invisible agent).
  2. **Append tasks** (`followup`/`manual` via RPC addTask / debug repair) and task toggles/answers.
  3. **Record** resolution entries, diversity records, results, summaries, handoffs, session fields, analytics, gates, findings.
  4. **Status transitions** per the (unchanged) transition table. Removal is expressed as `abandoned`, never splice. `removeNode` throws once `hasExecutionStarted()`.
- **Repair audit** stays the only sanctioned "edit" channel post-start, same fingerprint-pinned narrow vocabulary.

This is a *policy tightening* over today (v1 allows `removeDeliverable` at any time — the cause of a class of wedges) and directly implements invariant 7.

## 2. Validation checklist — rule × where it runs

Three enforcement sites, per the design's enforcement texture: **A** = authoring-time hard reject (engine `mutate`/plan-file load — a human is in the loop), **S** = spawn-time (adapter/executor, immediately before tmux spawn; failures are visible notices or steers, never wedges), **R** = runtime steering (a live agent's spawn attempt via RPC).

| # | Rule | A | S | R | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Persona registered for the agent type | ✔ reject | ✔ revalidate | ✔ steer | Registry is layered (bundled→user→project) and can drift between authoring and spawn; spawn revalidates, missing persona at R gets a steering message naming registered alternates. |
| 2 | Tier allowlist (persona-named tier ⊆ agent's allowed tiers) | — | ✔ | ✔ | Tiers live in persona **prose**; only resolvable at resolution time. `inherit`/session-fallback exempt but labeled in explain. Policy-row tiers (required field) validate at config load. |
| 3 | `maxDepth` | ✔ reject authored trees | ✔ belt-and-braces | ✔ steer: "you're at maximum depth — handle this directly" | Hard reject only where a human can fix it. |
| 4 | Envelope (`maxChildren`) | ✔ reject authored overrun | ✔ | ✔ escalate as question to the parent's supervisor (worker-question channel) | Never hard-fail a live agent. |
| 5 | No caller nodes | type-level (enum) + ✔ for untyped YAML/JSON input | ✔ | ✔ | Unrepresentable by construction; the load-path check covers hand-edited plan files. |
| 6 | Branch uniqueness (one writer per branch) + branch⇔worker-node, branch⇔repo coherence | ✔ | ✔ (worktree provision refuses a branch already owned) | — | Also: `base` override must name a branch-owning `after`-reachable node or "default-branch". |
| 7 | `after` refs resolve (sibling scope + "parent"), no cycles per sibling group, no self-ref | ✔ | — | ✔ for dynamic children ("parent" and existing siblings only) | Same Kahn cycle check as today's `topologicalSort`, run per sibling group. |
| 8 | Diversity edge check (child family vs parent family) | — | ✔ record `DiversityRecord`; same family w/o `diversityWaiver` ⇒ recorded warning in explain | — | Soft but loud; NEVER blocks. |
| 9 | Node id uniqueness (plan-wide) + id pattern | ✔ | — | ✔ (appendChild de-dupes like `uniqueDeliverableId`) | Ids are RPC keys and ledger refs. |
| 10 | Residency strike (only hard model filter) | — | ✔ fail-closed on unknown list; empty/struck tier ⇒ session model + deduped notice | ✔ same | Machinery unchanged from v1 (mapping table: "unchanged underneath"). |
| 11 | Skills resolve to real skill files | ✔ warn (advisory — plan-gate persona also nudges: branch-owning node without shipping-conventions) | ✔ notice, load what exists | — | Skills teach, never grant → missing skill is degraded context, not a stop. |
| 12 | Structural invariants: status enum + transition legality, failed⇔failure, SHA formats, session-path dedup/bounds, generation ≥ 0, scratch/repo coherence → repo-key exists + `createdBy` transitively in `after` | ✔ every `mutate` | — | — | Today's `validatePlanShape` body, ported to a tree walk. |
| 13 | Append-only: no node removal / no authored-field edits on nodes past `planned` | ✔ every `mutate` post-start | — | — | New rule (§1.4). |
| 14 | Gating tasks exist on active worker nodes | ✔ (on activation, like today's full-mode check) | — | — | Explorer/reviewer nodes exempt: idle-done is their completion signal. |

The plan→auto **judgment gate** (one heavy reviewer spawn with the ambiguity persona) sits above all of this and is configuration (`mode:plan→auto` policy row), not schema validation — it reads task text, not structure.

## 3. Consumer inventory

Every file that touches the current schema, with what changes. All paths under `/Users/vegardx/src/github.com/vegardx/pi-maestro/`.

### Contracts (vocabulary source)

| File | What changes |
| --- | --- |
| `packages/contracts/src/plan.ts` | Gains v2 vocabulary (or sibling `plan-v2.ts`): `PLAN_SCHEMA_VERSION_V2 = 6`, `NODE_AGENT_TYPES`. `DELIVERABLE_STATUSES` + `DELIVERABLE_TRANSITIONS` + `WORK_ITEM_KINDS` + `DeliveryFailure` + findings/gates survive verbatim (rename-alias to Node* at cleanup). `DeliverableSummary`/`WorkItemSummary` cross-boundary summaries gain a node path. |
| `packages/contracts/src/agents.ts` | `ResolvedAgentAssignment` retires with the workflow layer (replaced by `NodeResolution` on the ledger). |

### Persistence

| File | What changes |
| --- | --- |
| `packages/modes/src/storage.ts` | Version gate flips 5→6. Gains `legacyPlans()` + `archiveLegacyPlans()` → `plans/_legacy/<slug>/`, cloned from the run-state pattern. `list()` skips `_`-prefixed dirs (same as RunStore). |
| `packages/subagents/src/store.ts` | **Unchanged** — it is the donor pattern (`legacy()` / `archiveLegacy()` / `_legacy` dir / per-entry swallow of `UnsupportedRunStateError` in `list()`), not a consumer. |

### Core execution (the heavy rewrites)

| File | What changes |
| --- | --- |
| `packages/modes/src/schema.ts` | **Deleted**, replaced by `plan/schema.ts` (§1). ~130 lines of `validateWorkflowGraph` go with it. |
| `packages/modes/src/engine.ts` | `PlanEngine` rewritten: node CRUD pre-execution, `appendChild` + append-only rules post-start (§1.4); `injectLifecycleTasks` generalized; `planFingerprint` hashes the tree with per-node bookkeeping excluded; `applyTaskRepair` re-keys deliverableId→nodeId. |
| `packages/modes/src/deliverable-executor.ts` | **Biggest single rewrite** → `node-executor.ts`. The worker-vs-agents special-casing (two scheduling scopes: `dependsOn` across deliverables, `after` within one) becomes one recursive rule: a node spawns when its sibling `after` (+ "parent" token) is satisfied and its parent is active; node complete = gating tasks done (workers) / idle-done (read agents) **and** all children settled; ship on branch-owning complete nodes in chain order. `AgentStatus` machine, respawn caps, `RESTART_BLOCK_PREFIX` survive keyed by nodeId. |
| `packages/modes/src/exec/execution-adapter.ts` | Survives structurally. `agentKey = "<deliverableId>/<agentName>"` → `nodeId` everywhere (sessionNames, generation guards, `ignoreRestartingWorkers`, questionQueue, dirty-hold, completion gate). Spawn path reads node fields instead of worker-vs-AgentSpec branches; `resolveWorkerModel` → tier resolution writing `NodeResolution`; restart machinery (`restartWorker*`, `forceFailWorker`, `stopAndProveGone`) applies to any node. `renderPlanForAgent` becomes subtree-scoped (§5). |
| `packages/modes/src/exec/seeds.ts` | `buildSeed(plan, deliverable, agentName)` → `buildSeed(plan, nodeId)`: Prior Work = `after`-dep handoffs/results (was `dependsOn` summaries); Findings section = completed sibling/child reviewer results; Focus section merges into tasks (AgentSpec.focus is gone). Byte-stability contract unchanged — see risk R4. |
| `packages/modes/src/exec/shipper.ts` | Ships branch-owning nodes; `pickBaseBranch` → `base` derivation; chain-order rule over root `after` edges. |
| `packages/modes/src/exec/recovery.ts` | `auditPlan` walks the tree; per-node checks extended (§5). |
| `packages/modes/src/exec/workspace-validation.ts` | Per-node; branchless-worker (ex-scratch) validation path. |
| `packages/modes/src/exec/verify.ts` | Diff resolution per branch-owning node; unchanged verification logic. |
| `packages/modes/src/exec/stage-runtime.ts` | **Deleted** with the workflow-stage layer. |
| `packages/modes/src/exec/child-projections.ts` | Narrows: worker-owned *pi subagent* runs stay projections, but ensemble candidates become real plan nodes (ensemble spike owns the boundary). |
| `packages/modes/src/exec/rpc-router.ts` | Unchanged mechanics; handler table gains `spawnChild`. |
| `packages/modes/src/exec/commit-policy.ts`, `commit-target.ts`, `knowledge.ts`, `provisioner.ts`, `assessment.ts`, `findings.ts`, `verdicts.ts`, `verify-report.ts` | Mechanical: id re-key + node-field reads; no semantic change. |

### Runtime (HUD / dashboard / commands)

| File | What changes |
| --- | --- |
| `runtime/hud-wiring.ts` | `buildPlanView` (flat `HudPlanRow{id,title,state,worker,tasks}`) → tree rows with depth/persona/collapse (§5). Kill action re-keys to nodeId. Agents tab and Plan tab converge (agents ARE nodes). |
| `runtime/dashboard.ts` | `renderAgentsOverview` per-deliverable rows + `└─ worker/agent` sub-lines → one indented tree walk; `[after: …]` shown from node `after`. |
| `runtime/context.ts` | ~2600-line wiring: `findDeliverable`/`readyDeliverables`/`activeDeliverable` → node equivalents; `/start`/`/recover` target resolution by node id; worktree/branch computation via node fields. Mechanical but wide. |
| `runtime/commands.ts` | `/start /stop /restart /kill /steer /interrupt /recover /sync /view /watch` re-target node ids; `/agents` renders the tree; persona fan-out commands (`/verify`) iterate branch-owning nodes. |
| `runtime/hooks.ts` | `planPhase` only — unchanged. |
| `runtime/agent-cards.ts`, `agent-commands.ts`, `agent-targets.ts`, `gate-decision.ts`, `gate-triage.ts`, `maestro-editor.ts`, `preambles.ts` | Id re-key + label reads; gate files keep `transitionGates` (evidence stays on the plan). |

### Other modes consumers (mechanical unless noted)

| File | What changes |
| --- | --- |
| `tools.ts` | Plan-authoring TypeBox tools: `deliverable`/`agent`/`task` tools → one `node` tool + `task` tool; status/kind literal unions regenerate from the same contracts arrays; drops `workerMode/workerModel/workerEffort` params (inheritance). |
| `ui.ts` | `renderPlanText`/`renderPlanPanel`/`renderPlanSidebar`: flat glyph list → indented tree; sidebar histogram counts nodes (or roots only — decide at implementation). |
| `agent-lifecycle.ts` | Readiness/gating over node tasks + children instead of AgentSpec graph. |
| `compaction.ts` | Terminal-status filtering over a tree walk. |
| `debug.ts` | `workerSessionGeneration` → node `sessionGeneration`; diagnosis keyed by node. |
| `shipping.ts`, `deliverable-recap.ts`, `pr-provenance.ts`, `carry-forward.ts`, `research.ts` (`renderPlanOutline`), `transition-gates.ts` (`validatePlanShape` ref), `planning-preamble.ts`, `policy.ts` | Rename/re-key sweeps. |
| `spawn-model.ts` | `resolveSpawnModelSafe(role:"worker")` → tier resolution against catalog ∩ residency ∩ agent allowlist; owns `NodeResolution` + fallback notices. |
| `workflow-analytics.ts` | `deliverableId` field → `nodeId`; otherwise intact. |
| `index.ts` | Barrel re-export swap (`export * from "./schema.js"` → plan module). |

### Cross-package

| File | What changes |
| --- | --- |
| `packages/rpc/src/protocol.ts` | Protocol v6→v7: `planMutate.deliverableId` → `nodeId`; new `spawnChild` request/response (steering rejections in-band); `helloAck` unchanged. `WorkItemKind` import survives. |
| `packages/ui/src/format.ts` | `DELIVERABLE_GLYPHS: Record<DeliverableStatus,…>` — statuses are reused, so only a type alias rename. The exhaustive Record is the tripwire if statuses ever change. |

### Tests

| File | What changes |
| --- | --- |
| `test/schema.test.ts` (1000 lines) | **Rewritten** as `test/plan-schema-v2.test.ts` alongside (PR-2), old file deleted at the flip. Workflow-graph suites die with the layer. |
| `test/engine.test.ts` | Already `describe.skip` — replace with real v2 engine suite (append-only rules deserve direct tests). |
| `test/execution-adapter.test.ts` | `renderPlanForAgent` projection tests rewritten for subtree scope. |
| `test/e2e/lifecycle.e2e.test.ts` | Rewritten: same scripted-worker-over-real-RPC pattern, plan built via `PlanEngineV2` (`addNode` + child reviewer instead of `addAgent`); agentId assertion `"ship-the-widget/worker"` → node id; keeps postflight/handoff assertions. |
| `test/e2e/dirty-completion.e2e.test.ts` | Same treatment; dirty-hold semantics unchanged. |
| `test/e2e/driver/seed-plan.ts` + `seed-plan.test.ts` | Scenario seeded as a node tree (`security-audit` AgentSpec → child reviewer node with `after:["parent"]`; `dependsOn/stacked` → root `after` + derived base). |
| `test/e2e/driver/assertions.ts`, `cli.ts` | `plan.deliverables[].{title,status,prUrl,branch}` projections → recursive `walk(nodes)` flatten; everything else (rpc-client, launch, env-profile, cassette, gh-shim) is plan-shape-free and survives. |
| `test/e2e/driver/multi-model-profile.ts/.test.ts` | Couples to v1 role-routing config, not the plan — rewritten by the profile/catalog cutover, not this one (sequencing dependency noted in §4). |
| ~40 repo-root suites importing `PlanEngine`/schema transitively | Mechanical sweep in the flip PR; the dedicated-suite rewrites above carry the real semantics. |

## 4. Cutover sequencing

**Answer to the framing question: yes — the new schema lands as a parallel module with zero consumers, layer by layer, each PR fully unit-tested but unwired; the engine/runtime switch is ONE PR at the end.** `npm run check` stays green throughout because until the flip, nothing imports the v2 modules except their own tests, and after the flip the old modules are gone in the same commit. No dual-engine flag: a flag doubles the test matrix and contradicts the clean-cut precedent (v4→v5, and `storage.ts` already hard-errors on version mismatch by design).

Ordered PR list (each = one branch + rebase-merge, per repo convention):

1. **PR-1 — projection prep (optional but recommended).** Introduce a `PlanView` projection type (rows with id/depth/state/tasks) and port `hud-wiring.buildPlanView`, `dashboard.renderAgentsOverview`, `ui.ts` renders, and the driver's `assertions.ts`/`cli.ts` plan reads onto it, built from v1 (`depth` always 0). Pure refactor, green, shrinks the flip PR by four consumer files.
2. **PR-2 — contracts vocabulary.** `contracts/src/plan-v2.ts`: `PLAN_SCHEMA_VERSION_V2 = 6`, `NODE_AGENT_TYPES`, `NodeResolution`, `DiversityRecord`, reuse/alias of statuses+kinds. No consumers → green.
3. **PR-3 — `packages/modes/src/plan/` module.** `PlanNode`/`PlanV2` schema, traversal (`walkNodes`, `findNode`, `nodeDepth`, `siblingReady`, `shippableNodes`, base derivation), `validatePlanShapeV2` implementing §2 rows A. Full unit suite (`test/plan-schema-v2.test.ts`, the successor to the 1000-line `schema.test.ts`). Unwired → green.
4. **PR-4 — `PlanEngineV2` + storage.** Mutation surface, append-only enforcement, lifecycle-pair injection, tree fingerprint; `storage.ts` grows version-keyed load + `legacyPlans()`/`archiveLegacyPlans()` (v5 gate untouched — the default store still speaks 5). Unwired → green.
5. **PR-5 — `NodeExecutor` + adapter port, unwired.** New executor over the tree; a v2-keyed copy of the adapter spawn/completion/restart path (the adapter takes the engine as a constructor arg, so the v2 variant can be instantiated only by tests). Port lifecycle/dirty-completion e2e **as unit-level twins first** (scripted worker over real RPC + FakeTmux against the v2 stack) — this is the parity gate before anything flips. Green.
6. **PR-6 — exec periphery.** seeds/shipper/recovery/verify/workspace-validation v2 variants + their tests. Green, unwired.
7. **PR-7 — THE FLIP.** `runtime/context.ts`, `commands.ts`, `hud-wiring`, `dashboard`, `tools.ts`, RPC protocol v7, `renderPlanForAgent`, e2e lifecycle/dirty/driver rewrites; **delete** `schema.ts`, `engine.ts`, `deliverable-executor.ts`, `stage-runtime.ts`, workflow validation, old tests; flip the storage default to v6 and add boot-time legacy handling (below). Big but mechanical: every semantic piece was pre-tested in PR-3…6.
8. **PR-8 — cleanup + docs.** Alias removal, `docs/modes-architecture.md` rewrite, `SUMMARY_TOKEN_BUDGET`-style re-export tidy up, delete `PLAN_SCHEMA_VERSION` (5) once nothing references it.

**In-flight plans on disk.** At maestro boot (and in `plans list`), any `plans/<slug>/plan.json` with `schemaVersion !== 6` is moved wholesale — dir and all (events.jsonl, child-projections.json, crashes/, workspaces/, base-knowledge.jsonl) — to `plans/_legacy/<slug>/`, exactly the `RunStore.legacy()`/`archiveLegacy()` pattern from `packages/subagents/src/store.ts` (`list()` already skipping `_`-prefixed names comes along). One visible notice line, never a crash: the #238/#239 stale-state incidents are the argument for auto-archive over today's hard `UnsupportedMaestroStateError`, and this is the natural first client of the planned reusable migration component (memory: settings-migrations follow-up). Worktrees on disk that a legacy plan references are NOT touched — `/recover`-style orphan cleanup only ever acts on the live plan.

**Sequencing dependency on the other spikes:** PR-5's tier resolution needs at least a stub of the catalog/profile config (profile-binding spike); land resolution behind an injectable resolver (the adapter already has `resolveWorkerModel` as an injectable seam — keep that seam, rename it) so the plan cutover does not block on catalog config shipping. Contract payload (`result` field) stays opaque until the contract-shapes spike lands.

## 5. Recovery / HUD / RPC

### HUD (today: flat deliverable rows)

- `HudPlanRow` gains `depth`, `agent`, `persona`, `authoredBy`. Render as an indented tree using the existing `DELIVERABLE_GLYPHS` (statuses unchanged, so glyphs survive: `○ ◐ ◎ ✗ ✓ ⤳ ⊘`). Roots at depth 0 read exactly like today's rows — an unnested plan is visually identical to v1.
- **Dynamic children collapse by default**: a node's `authoredBy !== "plan"` children render as one badge line (`· 3 candidates — 2 done`), expandable through the existing Tab ring / pinnable dim panel (#178 machinery). This caps runaway fan-out at `maxChildren` lines worst-case, and depth is already ≤ 3.
- The Agents tab and Plan tab **converge**: agents are nodes now, so the separate workers-plus-subagent-runs tree collapses into the plan tree, with pi-subagent child runs (ChildProjectionStore) still hanging under their owning node. This incidentally addresses part of the cross-process leaf-visibility follow-up.
- Progress counter: roots done/total (today's semantics), with a secondary all-nodes count in the sidebar histogram.
- Model/warmth chips per node come from `NodeResolution` + the cache ledger (words `warm/cold/extended`, per design doc) — data is now on the ledger, no in-memory-only lookups.

### RPC / get_state

Finding worth stating plainly: **there is no structured plan `get_state` today.** pi's built-in `get_state` returns session state (`isStreaming`); the plan reaches agents as a rendered markdown string (`planRead` → `renderPlanForAgent`) and reaches external clients (e2e driver, `cli.ts planSummary`) by reading `plan.json` off disk. That stays the architecture: **the plan file IS the state API** (invariant 7 — the ledger is complete), and v2 makes it more true, since support agents' status/session/resolution are now in the file instead of dying with the process.

- `planRead` (agent-facing): subtree-scoped render — the node's own tasks (with ids, done, kind tags — format survives for prompt-cache continuity), parent-chain titles for orientation, `after`-dep handoffs, children with status one-line each. Same auth rule as today, re-keyed: a node reads its own subtree, mutates only itself.
- `planMutate`: `deliverableId` → `nodeId`; actions `toggleTask` (postflight summary → handoff, unchanged), `addTask` (default kind `followup`), `updateTask`.
- **New `spawnChild`** (agent → maestro): `{agent, persona, tasks, skills?, envelope?, diversityWaiver?}`. The harness runs §2 spawn-time validation, **appends the child to the plan first** (write-ahead, `authoredBy: <caller>`), then spawns. Rejections come back as steering text in the response (`"you're at maximum depth — handle this directly"`), never as errors that wedge; envelope overrun goes to the parent's supervisor via the existing worker-question channel. Protocol bump v6→v7.
- Driver `get_state`: keep reading `plan.json`; `assertions.ts` projects `walk(nodes) → {id, path, status, prUrl, branch}`.

### /recover

`auditPlan` walks the tree instead of `plan.deliverables`. Checks per node:
- Branch-owning nodes: today's checks verbatim (worktree exists, branch resolves, tree clean, PR state vs status).
- **All** nodes: orphan tmux cleanup by persisted `sessionName` — a v2 win, since today only worker sessions persist and a crashed maestro cannot reap reviewer orphans.
- **Resolution revalidation** (design doc: "revalidates on resume"): each active node's persisted `NodeResolution.model` rechecked against catalog ∩ residency ∩ allowlist; stale → session-model fallback + one deduped notice, recorded as a new `resolutions[]` entry.
- **Half-appended children**: a `planned` node with `authoredBy !== "plan"` and no session fields means the maestro died between ledger append and spawn — /recover offers spawn-or-abandon per child. This is the recovery contract that makes the write-ahead append safe.
- Force-fail (`/recover` preflight) and restart preview/resume/fresh apply to any node id; `restartState`/generation barrier machinery unchanged.

## 6. Risk register — the five hairiest spots

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Executor/adapter rewrite regressions.** The completion lattice (task-gated workers vs idle-done read agents, `IDLE_DONE_THRESHOLD` re-fed by the 5s poll, dirty-hold steer cadence + escalation, crash-respawn caps, generation guards vs buffered RPC) encodes a year of incident fixes (task-toggle wedge, dirty-hold wedge, kill-mid-review hole). A recursive rewrite can silently drop any of them. | Port the state machines **verbatim keyed by nodeId**, not re-derive them. PR-5's parity gate: unit-level twins of `lifecycle.e2e` + `dirty-completion.e2e` must pass against the v2 stack *before* the flip PR opens. Grep-list every `logEvent` name and assert the v2 stack emits the same event vocabulary. |
| R2 | **The flip PR (PR-7) is huge** — context.ts (~2600 lines), commands, HUD, RPC, tools, and every e2e in one change; review fatigue is where regressions land. | PR-1 projection prep removes four consumers up front; PR-3…6 make the flip *mechanical* (only re-keying and wiring, no new semantics allowed in PR-7 by review rule). Dogfood on `staging/maestro` (the established tested-branch pattern) with a real drive before merging to main. Fallback if it stalls: a short-lived env flag — explicitly a last resort, deleted within the arc. |
| R3 | **Append-before-spawn write-ahead + persisted runtime state for every node changes crash-recovery invariants.** More ledger writes on hot paths (every dynamic spawn = clone + validate + atomic save of the whole plan), and new half-states on disk (appended-but-never-spawned children, mid-restart nodes at any depth). | Keep the single-writer `mutate()` (clone/validate/save) — callers never path-address the tree, they call `appendChild(parentId, …)`. Define the half-states exhaustively in /recover (§5) and test each with kill-injection. Plan-size guard: depth ≤ 3 and envelope caps bound the tree, so whole-file writes stay small; measure before optimizing. |
| R4 | **Seed/cache-prefix stability.** `buildSeed` is deliberately a pure, byte-stable function feeding the shared knowledge-fork prefix; the seed restructure (after-dep handoffs, focus-into-tasks) plus a third tool class (worker/explorer/reviewer vs today's full/read-only) changes cache-sharing behavior — the M5 Max local fleet and gateway cache economics both care. | Keep the framed-section architecture and fixed header strings; property-test byte-stability (same inputs ⇒ identical bytes, no timestamps/uuids). Map tool classes explicitly: explorer and reviewer share the read-only toolset ⇒ keep TWO cache classes unless toolsets actually diverge. Watch the existing `cache-miss` event during the staging dogfood. |
| R5 | **Runtime-steering surfaces are new failure modes.** Depth-cap steers, envelope escalation via the question channel, persona-missing steers, and `spawnChild` rejections all interact with live agents mid-turn — precisely the class of interaction that has wedged before (silent one-shot steers, phantom question entries). | Every rejection is (a) a structured in-band response the agent's tool call sees, (b) resteered on the poll cadence like dirty-hold (never one-shot), (c) logged to events.jsonl, (d) escalated to a visible blocked state after a bounded budget. Scripted-worker e2e cases for each: depth-capped spawn, envelope overrun, unregistered persona. |

Honorable mentions (real, but not top-5): HUD tree rendering blowing the panel budget (bounded by collapse rules + maxDepth); the `repo` field's tension with "branch is the only authored workspace fact" (needs a one-paragraph design ruling before PR-3); multi-model driver profile coupling to v1 role routing (owned by the profile/catalog cutover, must not block PR-7).

---

## Appendix: open questions for the design owner

1. **`repo` on nodes** — keep as the second authored workspace fact (recommended; multi-repo + `createdBy` late-binding is shipped, load-bearing functionality), or fold repo into branch syntax? Doc currently says branch is the *only* authored workspace fact.
2. **Reserved `after` token** — doc example uses `after: [worker]`; this spike proposes `"parent"` since every node is uniform. Pick one before PR-3; accepting both as aliases is cheap.
3. **Scratch** — this spike derives ex-scratch as "branchless worker node, ephemeral workspace, ships nothing". Confirm no scratch-specific authored knob is needed (the repo-creation prep-repos example in the doc suggests not).
4. **`transitionGates` residency** — evidence stays on the plan (proposed) while policy rows own configuration; confirm.
5. **Sidebar/progress counting** — roots-only vs all-nodes; pure UX, decide at PR-7.
