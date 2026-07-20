# PR-7 flip — working notes (delete this file in PR-8)

Branch: `feat/v2-flip`. Goal: swap the runtime onto PlanEngineV2/NodeExecutor/
NodeExecutionAdapter, delete v1 plan machinery, keep `npm run check` green at
the END (WIP commits on this branch may be red; push with --no-verify for
backup). MERGE GATE: a green dogfood drive via the e2e driver ON THIS BRANCH
(`start --live --sit-models --local-remote --seed-plan`), per risk R2.

## Slices

- [x] S1 projectPlanView walks v2 `nodes` (roots ≡ deliverables; real depth)
- [x] S2.5 engine/schema runtime surface (draft, phase, gates, repos, task
      CRUD, updateNode, analytics, body, question answers)
- [x] S2 driver seed-plan.ts seeds a v2 plan (drives S1 through assertions)
- [x] S3 tools.ts (workflow tool deleted; agents→children)
- [x] S4 commands.ts + debug-command (applyTaskRepair ported for real)
- [x] S5a ExecutionHandle surface on NodeExecutionAdapter: steer, interrupt,
      capture, stop(+prove-gone), forceFailWorker, preview/restartWorker,
      prepareStop (freeze + cooperative stop + block for /recover), snapshot
      (tokens via RPC tokens msgs; model/effort from resolutions), question
      queue (questions handler + drop-on-disconnect + onQuestionsReceived),
      resolveSessionName, getWorkerSessions, markAgentDone, isWorkerDone.
      DEFERRED: projected child runs (ChildProjectionStore) — optional handle
      methods, HUD loses worker-child visibility until a follow-up; debug
      proposal handler route.
- [x] S5b context.ts — engine/store/adapter construction, boot legacy-archive,
      recovery wiring, worker-question channel, exec/index.ts handle rewire
      (ALSO: small-consumer PORT AGENT in flight on ui/preambles/hooks/
      planning-preamble/policy/research/pr-provenance/shipping/
      transition-gates/debug/carry-forward/compaction/deliverable-recap/
      agent-lifecycle)
- [x] S6 exec ports (shipper→shipNode wired into the seam; verify/recovery/
      workspace-validation v2): shipper (ship pipeline incl.
      gh), recovery (/recover audit), verify (/verify), workspace-validation
- [x] S7 small consumers sweep: ui, preambles, hooks, planning-preamble,
      policy, research, pr-provenance, shipping, transition-gates, debug,
      knowledge, compaction, carry-forward, deliverable-recap, agent-lifecycle
- [x] S8 DELETE: schema.ts, engine.ts, deliverable-executor.ts,
      exec/execution-adapter.ts, exec/stage-runtime.ts (+ move surviving
      helpers: slugify, derivePlanName, SUMMARY_TOKEN_BUDGET, canTransition,
      boundedPreviousSessionPaths, PRE/POSTFLIGHT ids → plan/schema.ts)
- [x] S9 boot auto-archive notice (session_start; archiveLegacyPlans)
- [x] S10 test sweep (~29 files): delete v1-semantics suites (schema/engine/
      executor/adapter unit tests — v2 twins exist), port the seed/driver/
      scenario suites, e2e lifecycle+dirty already twinned (delete v1 copies)
- [x] S11 `npm run check` green (936 tests)
- [x] S12 dogfood drive GREEN 2026-07-20: all 3 deliverables shipped, PRs,
      files, modelPinned, baseOk; reviewer child complete (findings)

## Decisions taken
- RPC stays protocol v6 for the flip: `planMutate.deliverableId` carries the
  node id (adapter already reads it so). v7 (`nodeId` + `spawnChild`) is a
  follow-up — keeps the flip mechanical.
- Personas load at spawn via personaSeedHead (seed head); system-prompt
  injection revisited when pi CLI supports it.

## S5b landed details (for S8/S12)
- context.ts fully v2: PlanEngineV2 + createPlanStoreV2; live spawn via
  exec/live-spawn.ts (persona seed head + knowledge fork + crash capture +
  stale-session reaping); resolveModel = resolveNodeModel with session-model
  inherit; adapter lifecycle callbacks restored (onEvent/onAllSettled/
  onAgentStateChanged → agent cards, back-to-plan, usage ledger).
- Deliberate flip losses (follow-ups): worktreeSetup env-provisioning hook not
  wired into provisionBranchWorktree; stopGraceMs setting unused (adapter
  default); projected child runs (HUD worker-child visibility); debug proposal
  handler is typed but unwired on the v2 adapter; adapter requestSummary does
  not truncateSummary.
- /recover: workspace audit message simplified; recoverInterrupted revalidates
  per-node session state (full auditPlan port rides S6 recovery).
- engine: applyTaskRepair ported (PlanRepairOperation now lives in
  plan/engine.ts); mutate() skips store.save while draft (v1 discipline).

## Drive findings (fixed on this branch / follow-ups)
- FIXED: seed task lines now carry (taskId: ...) and AGENT_OPERATIONS_BRIEF is
  inlined for every agent — a worker guessed lifecycle ids and wedged.
- FIXED: personas.v1 capability (boundary-clean persona lookup).
- FIXED: planFingerprintV2 excludes repairAudit/transitionGates (gate
  settlement self-tripped otherwise).
- FIXED: run.sessionId pruned on completion (worker panes auto-close).
- FOLLOW-UP: baseSha not stamped on v2 nodes (assert's baseOk reads shim log).
- FOLLOW-UP: worker asked about git identity despite repo-level config —
  consider stamping identity at worktree provisioning.
- FOLLOW-UP: repo-local skill discovery for workers (keep global suppressed).
