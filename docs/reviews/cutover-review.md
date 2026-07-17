# Cutover stack review — #191–#207

_Review of the 15-PR architectural cutover. Method: a green integration build
plus an 11-dimension multi-agent correctness review (23 findings raised → 19
confirmed by adversarial verification, 4 refuted) plus a hand-built end-to-end
harness. **Corrected after author clarification of the intended design** — see
"The intended model" below; two originally-CRITICAL findings were reframed._

## The intended model (corrects the original framing)

The cutover **deliberately retired** the old "nothing ships until the review
panel's blocking findings are resolved and verified" invariant — it doesn't
scale. The new model:

- **All reviewers/personas are required to run**, but the **worker owns what to
  do with their findings** — reason, fix, or escalate to human/maestro. The
  system **trusts the worker** not to be actively dishonest.
- Reviewers run **worker-side**, via the `review()` tool in the worker's live
  session (`deliverable-executor.ts:943`, `preambles.ts:130`) — not from a
  maestro-orchestrated stage runtime.
- There is **no maestro-side hard gate** blocking ship on unresolved findings.

Reviewed against *that* model, the two original criticals dissolve (details in
"Reframed" below): reviewers do run (worker-side), and the leftover
`deliverableGateSatisfied` code is stale rather than a broken invariant.

## Bottom line

**The cutover compiles and its unit suite is green (858 tests), and its review
model works as intended.** The review still surfaced real, model-independent
bugs worth fixing — concentrated in **stop/recovery and the state machine**:

- **`forceFailWorker` skips the real tmux kill** (deletes `sessionNames` before
  `stopAndProveGone`), so `/stop` / `/recover` can leave a live worker and spawn
  a second one into the same worktree.
- **`runStop` wedges the execution state machine** in `stopped`, so the next
  transition (shutdown or a second `/stop`) throws and teardown leaks.
- **Stale child-run projections** stay "live and controllable" after a worker
  dies.
- From the un-integrated stragglers: **#195 breaks `/recover` and `/restart`
  from plan mode**; **#205 does not merge** and duplicates usage accounting the
  cutover already has.
- Plus RPC UTF-8 chunk-boundary corruption and smaller items.

One piece of **cleanup** (author-confirmed): the leftover maestro ship gate
(`deliverableGateSatisfied` / `panelGate` / the `"ship gate:"` blocked reason /
old-model doc comments) is dead code to remove — it reads `workflow.assignments`
(a separate reviewer system) while reviewers live in `deliverable.agents`, so in
the normal flow it's a no-op, and it would only deadlock if the `workflow` tool
assigned reviewers.

## Build backbone (the ground truth)

- `feat/e2e-hardening` is the coherent near-complete cutover — by content it
  contains ~12 of the 15 PRs. `npm ci && npm run check` is **fully green**
  (biome, tsc, boundary linter, feature-flag contract, docs check,
  `check-cutover`, **858 tests pass / 2 skipped**, smoke). So the merged core
  genuinely builds and its unit tests pass; the failures below are logic gaps
  unit tests don't cover, not compile breaks.
- CI blind spot: `.github/workflows/ci.yml` runs only on PRs targeting `main`.
  Only #191 does — the other **14 PRs have never run `npm run check` in CI**.
  Recommended fix: trigger CI on all `pull_request` targets (or push to
  `feat/**`).

## Mergeability of the stack

The PR base-refs are misleading; actual *content* ancestry is what matters. The
cutover does **not** assemble into one tree — three leaves conflict:

| PR | Branch | Into the cutover (`feat/e2e-hardening`) |
| --- | --- | --- |
| #191 #192 #193 #194 #199 #207 #201 #202 #206 #198 #203 #204 | (the main chain) | **contained** — green |
| #200 | feat/findings-review-runtime | **conflicts** (findings.ts, assessment.ts, review-tool.ts) — carries the real gate |
| #195 | feat/transition-gates | **conflicts** (transition-gates.ts, engine.ts, schema.ts, plan.ts, +4) |
| #205 | feat/usage-accounting | **conflicts** (14 files) — duplicates already-landed accounting |

The three conflicting PRs were reviewed from their diffs; their non-mergeability
is captured as findings.

## Findings

Ordered by severity. Original verification confirmed 19 of 23; after author
clarification of the intended model, the two originally-CRITICAL findings are
**reframed** (below) and three review-semantics findings are marked
**intent-dependent**. The remaining bugs are model-independent.

## Reframed after author clarification (originally CRITICAL)

These were raised against the retired "gate blocks ship on unresolved findings"
invariant. Under the actual model they are not correctness bugs:

- **`stage-runtime.ts` / findings runtime "never wired" — RETRACTED.** The
  reviewer never runs *from the maestro's stage runtime*, but reviewers **do**
  run worker-side via `review()`. `stage-runtime.ts`, `setWorkflowAnalytics`,
  and `applyWorkflowAnalyticsEvent` are an unused alternative path, not the live
  one. (If PR-provenance rendering is meant to be populated, that's a separate,
  smaller question — it currently always renders "not recorded".)
- **`deliverableGateSatisfied` "deadlock" — REMOVED (cleanup done).** It read
  `workflow.assignments` (set only by the `workflow` planning tool) while
  reviewers are attached as `deliverable.agents`, so it was a no-op in the normal
  flow and only ever blocked if the `workflow` tool assigned reviewers. The whole
  dead gate is gone: `panelGate`/`panelGateDetail` wiring, `deliverableGateSatisfied`
  / `requiredReviewerNames` / `failingRequiredReviewers` / `deliverableGateDetail`,
  `surfaceGateBlocks`, the `"ship gate:"` blocked reason, and `onShipGateBlocked`.
  A `complete` deliverable now ships; the worker owns its findings.


## High findings

### 3. forceFailWorker deletes the sessionNames mapping before calling stopAndProveGone, which makes stopAndProveGone's generationMatches guard fail and short-circuit to {gone:true} without ever polling or killing the tmux session.
- **Where:** `packages/modes/src/exec/execution-adapter.ts:1192` · dimension: recovery/shutdown · category: correctness · verdict: CONFIRMED
- **Failure scenario:** User runs /stop (adapter.stop -> forceFailWorker) or the /recover force-fail preflight on a running, healthy worker. Line 1192 executes this.sessionNames.delete(agentKey) before stopAndProveGone(agentKey, session, reason) at line 1195. Inside stopAndProveGone, generation===currentGeneration is still true, but generationMatches (lines 1287-1296) also requires this.sessionNames.get(agentKey)===sessionId; the mapping was just deleted so it is undefined!==sessionId, so generationMatches returns false and line 1250 returns {gone:true, cooperative:false} immediately — before the prepareStop request, the hasSession poll loops, and the tmux.kill at line 1263. forceFailWorker then treats the worker as gone, calls failWorkerReplacement, logs force-fail, and returns true. The real pi process is still alive in tmux holding the worktree; /recover subsequently respawns a second worker into the same worktree, producing two concurrent workers racing the same git checkout (and a leaked, never-polled tmux session, since sessionNames no longer tracks it).
- **Suggested fix:** Call stopAndProveGone (which itself deletes the mapping on proven-gone at line 1272) BEFORE deleting sessionNames, or pass the sessionId such that the guard is not defeated. E.g. move this.sessionNames.delete(agentKey) to after a successful stopResult.gone, mirroring killSession's ordering; on !gone restore is then unnecessary.

### 4. When a worker (projection owner) disconnects, its child-run projections are never marked unconfirmed or terminal, so dead runs remain in the maestro view as live and fully controllable.
- **Where:** `packages/modes/src/exec/execution-adapter.ts:442` · dimension: child projections · category: stale-projection · verdict: CONFIRMED
- **Failure scenario:** A worker at deliverableId/worker projects two headless child runs (status "running", confirmed=true) via childRunSync; ChildProjectionStore.apply stores them confirmed. The worker's tmux session/process dies, firing onDisconnect (execution-adapter.ts:442). onDisconnect deletes connectionGenerations, idleCount, questionQueue and childControls but never touches this.childProjections and never calls markLiveUnconfirmed(). The store keeps both records confirmed=true with their last status "running". listAgentTargets (agent-targets.ts:104-114) then renders them as run: targets with capabilities.capture/steer/interrupt/shutdown all true (each gated only on `projection?.confirmed !== false`) and status "running", frozen updatedAt. A user steering/stopping them hits controlProjectedRun, whose record.confirmed is true so it proceeds, router.send fails (owner gone) and resolves "owner disconnected" — a silent no-op — while the zombie run stays in the agent list indefinitely. Only a full maestro restart runs markLiveUnconfirmed (and even then it only downgrades to unconfirmed, never removes). markLiveUnconfirmed is only ever called from ChildProjectionStore.load().
- **Suggested fix:** In onDisconnect, look up the disconnected agentId's non-terminal child projections and mark them confirmed=false (mirroring markLiveUnconfirmed's per-owner semantics) so the view degrades their capabilities until the owner reconnects and reconciles; persist the change.

### 5. The verification verdict is taken only from the prose `VERDICT:` line and never forced to fail by a blocking structured finding, so a report that says pass while carrying a critical/major finding is treated as a clean pass and the finding is silently discarded.
- **Where:** `packages/modes/src/exec/verify.ts:400` · dimension: findings/gate · category: gate-bypass · verdict: CONFIRMED
- **RESOLVED — `/verify` is now report-only.** The auto-remediation
  (`presentRemediationTriage` → `applyRemediation`, which acted on the possibly-wrong
  verdict) has been removed and `exec/remediate.ts` deleted; `/verify` surfaces the
  report and a human decides. The prose-vs-structured mismatch no longer drives any
  action, so this finding is closed. (Original analysis kept below for the record.)
- **Failure scenario:** A /verify verifier ends its report with `VERDICT: pass` (or omits/garbles the verdict word so parseVerdict yields approve) but its ```json block lists {"severity":"critical", ...}. runVerification sets entry.verdict="pass" from parseVerdict(report) at lines 399-406 and stores the critical finding in entry.structured, but does not cross-check severity. applyRemediation (remediate.ts:168) does `if (entry.verdict === "pass") continue;`, so the deliverable is never reopened and the critical finding never becomes a gating WorkItem. The already complete/shipped deliverable stays shipped with an open blocking finding — exactly the invariant the gate is supposed to prevent. computedVerdict()/isBlockingSeverity() in findings.ts:18-24 exist to reconcile verdict against blocking findings but have no callers.
- **Suggested fix:** In runVerification, after parsing, override verdict to fail when structured.some(isBlockingSeverity) (or use computedVerdict on the parsed findings) even if the prose verdict says approve, so the two channels can never silently disagree.

### 6. runStop leaves execution stage=stopped while retaining rt.execution, so the next stage transition driven by shutdown or a second /stop attempts the illegal stopped->stopping edge and throws.
- **Where:** `packages/modes/src/runtime/context.ts:692` · dimension: state machine · category: state-machine · verdict: CONFIRMED
- **Failure scenario:** User runs /start (stage=executing) then /stop. runStop transitions executing->stopping->stopped (context.ts:675,684) but never sets rt.execution=undefined (unlike runRestart:752 / shutdown:377). rt.execution stays truthy with state.execution.stage='stopped'. Now either (a) the user closes the session -> session_shutdown (hooks.ts:339) sees rt.execution truthy and calls setExecutionStage({stage:'stopping'}) at hooks.ts:341, or (b) the user runs /stop again -> runStop passes the `if(!rt.execution)` guard and calls setExecutionStage({stage:'stopping'}) at context.ts:675. Either way setExecution (state.ts:74-79) evaluates canTransitionExecutionStage('stopped','stopping') which is false (EXECUTION_STAGE_TRANSITIONS.stopped = ['idle','executing'], contracts/src/modes.ts:43) and throws `illegal execution transition: stopped -> stopping`. On the shutdown path this aborts the handler before rt.execution.prepareStop / rt.execution.destroy run (hooks.ts:348-376), so worker tmux sessions / RPC server are never torn down (leak) and the error propagates out of session_shutdown.
- **Suggested fix:** After a bounded stop settles (context.ts:684-692) treat the adapter as terminal: await rt.execution.destroy() and set rt.execution = undefined, matching the 'A stopped adapter is terminal' handling in runRestart. Then the shutdown/second-stop `if (rt.execution)` guards short-circuit and no stopped->stopping transition is attempted.

### 7. /recover invoked from plan mode throws because PR #195 makes setMode() throw on plan→auto, but the cutover's runRecover deliberately uses setMode("auto") to bypass the transition gate.
- **Where:** `packages/modes/src/runtime/context.ts:970` · dimension: #195 transition-gates · category: integration-conflict · verdict: CONFIRMED
- **Failure scenario:** User in plan mode (Shift+Tab back after a failure, or hooks.ts auto-recover prompt) runs /recover with a recoverable deliverable. Line 969-970 hits `rt.setMode("auto", ctx)` while rt.state.mode==="plan"; the new guard at context.ts:388-389 throws "Plan execution transitions must use requestMode()", so runRecover aborts before ensureExecution/worker resume — recovery is broken. The site cannot simply be switched to requestMode() either: the inline comment ("Recovery is operational, not a fresh Plan→Auto authorization") states recovery must NOT re-run the plan-review gate, which requestMode() would force. This is the merge-conflict contradiction: #195 mandates every plan→auto go through the gate, the cutover mandates recovery skip it.
- **Suggested fix:** Add a gate-exempt commit path for operational resumes (e.g. rt.enterExecutionUnchecked("auto")) that runRecover/runRestart use instead of setMode, and keep the throwing setMode strictly for accidental plan→auto misuse; reconcile the two policies rather than leaving setMode("auto") call sites that the new guard rejects.

### 8. /restart invoked from plan mode throws for the same reason as /recover: runRestart calls setMode("auto") which the new #195 guard rejects for plan→auto.
- **Where:** `packages/modes/src/runtime/context.ts:748` · dimension: #195 transition-gates · category: integration-conflict · verdict: CONFIRMED
- **Failure scenario:** User in plan mode runs /restart with a cleanly-stopped active deliverable. The guard `if (rt.state.mode !== "auto" && rt.state.mode !== "hack") rt.setMode("auto", ctx)` at 747-748 fires (mode is plan), and setMode throws "Plan execution transitions must use requestMode()" (context.ts:388-389), aborting the restart before execution.destroy()/ensureExecution/restartWorkerResume run. The explicit mode!==auto guard proves the authors expect plan/recon as an entry state, so this is reachable, not theoretical.
- **Suggested fix:** Route runRestart through the same gate-exempt operational-resume commit used for runRecover; do not leave a raw setMode("auto") that the guard converts into a thrown error.

### 9. The execution-readiness gate no longer enforces reviewer coverage: the integration stubbed suggestions to `() => []` and dropped the panelTopologyGaps check from executionReadinessValidations, while PR #195 had already deleted the pre-existing hard panel-gap confirm from runImplement — so a code-changing deliverable with no required reviewer crosses Plan→Auto ungated.
- **Where:** `packages/modes/src/transition-gates.ts:299` · dimension: #195 transition-gates · category: gate-hole · verdict: CONFIRMED
- **BY DESIGN (author-confirmed) — not a bug.** Under "all reviewers run + worker owns findings," there is intentionally no maestro-enforced reviewer-coverage gate. Retained here only for the record.
- **Failure scenario:** A plan has a `worker.mode==="full"` deliverable with zero required reviewers (the orchestra-baseline hole). Pre-#195 cutover blocked this in runImplement with a confirm defaulting to abort ("Start implementation anyway?"). PR #195 deleted that confirm (see gh pr diff 195 removing the panelTopologyGaps block) and replaced it with (a) a non-blocking level:"warning" topology validation and (b) add-required-reviewer suggestions. The integration then removed BOTH: executionReadinessValidations (transition-gates.ts:303-337) contains no panelTopologyGaps and no reviewer check, and createExecutionReadinessGate sets `suggestions: () => []` (line 299). Only shape/phase/empty-deliverable/no-work-item conditions are errors; none require a reviewer. The reviewer that could have flagged it is advisory (see below). Net: the deliverable ships to a worker with nothing gating its output — a regression of the exact protection the cutover hardened.
- **Suggested fix:** Restore reviewer-coverage enforcement in the gate: either re-add panelTopologyGaps as a level:"error" validation (hard block) or reinstate the add-required-reviewer suggestions flow; do not ship the gate with both the old confirm and the new checks removed.


## Medium findings

### 10. onDisconnect force-resolves and deletes EVERY pending child-run control across ALL owners whenever any single agent's socket closes, because childControls entries carry no owner identity and the loop applies no agentId filter.
- **Where:** `packages/modes/src/exec/execution-adapter.ts:448` · dimension: execution adapter · category: cross-agent-state-corruption · verdict: CONFIRMED
- **Failure scenario:** Fleet with two live workers A and B, each owning projected child runs. A human calls interruptProjectedRun/steer/capture/stop on one of B's child runs; controlProjectedRun (line 1541) registers a pending entry keyed by a random control id (line 1563) and awaits B's ChildRunControlResult. Independently, worker A finishes and its RPC socket closes, firing onDisconnect("dA/worker"). The onDisconnect handler loops over the entire childControls map (line 448) and resolves B's pending control with ok:false, error "owner disconnected", then deletes it — even though B is alive and processing the request. The control call spuriously reports failure/disconnected, and when B's genuine childRunControlResult finally arrives, its id has already been removed (line 368 finds no pending entry) so the real result is silently dropped.
- **Suggested fix:** Store ownerId (and ideally ownerGeneration) in each childControls entry when it is created in controlProjectedRun (line 1563), and in onDisconnect only cancel entries whose ownerId matches the agentId that disconnected: `for (const [id, pending] of this.childControls) { if (pending.ownerId !== agentId) continue; ... }`.

### 11. Reopening a previously-worked plan merges the global `maestro` (and generic `run`) checkpoints by comparing per-lineage revision counters that are not comparable across independently-persisted stores, silently discarding real accumulated usage.
- **Where:** `packages/modes/src/runtime/context.ts:407` · dimension: #205 usage-accounting · category: restart-recovery · verdict: CONFIRMED
- **Failure scenario:** The `maestro` source key is global ('maestro') yet onAccepted writes it into whichever plan's execution/usage.json is active, so each plan accumulates its own maestro checkpoint with an independent monotonic revision counter. In loadEngine (line 400-409): `existing = usageLedger.checkpoints()` captures the live session maestro checkpoint (say revision 8 / 8k tokens), then `usageLedger.restore(usageStore.load())` loads the reopened plan's persisted maestro checkpoint (say revision 30 / 30k from a prior session). restore keeps the plan's only because 30 > 8 — a comparison of unrelated counters, not recency or magnitude — so the live 8k is overwritten and lost; the subsequent `for (existing) usageStore.accept` write of revision-8 is then rejected by the store (8 <= 30), so the session's real pre-plan maestro spend vanishes from both ledger and disk. The symmetric case (reopened plan has the lower counter) instead overwrites and loses the plan's historical maestro usage. materialize() (lines 464-469) has the same defect.
- **Suggested fix:** Do not key the global maestro/generic-run sources by a per-store revision counter that is compared across stores; either scope maestro usage per-plan with its own key, or merge cross-store checkpoints additively / by updatedAt rather than by raw revision, so no lineage's cumulative total is discarded on plan switch.

### 12. A failing plan-review does not block the transition: only an infrastructure failure of the reviewer run blocks; the reviewer's substantive verdict is captured as advisory text and never gates.
- **Where:** `packages/modes/src/transition-gates.ts:131` · dimension: #195 transition-gates · category: gate-semantics · verdict: CONFIRMED
- **BY DESIGN (author-confirmed) — not a bug.** A plan-review is intentionally advisory (informs the human, doesn't hard-block), consistent with the trust-the-worker model. Retained here only for the record.
- **Failure scenario:** The plan-reviewer completes with result.status==="succeeded" but its summary says the plan is unsafe/incomplete. The coordinator only throws/blocks when result.status !== "succeeded" (line 131); on success it stores result.summary as reviewSummary (line 133) and proceeds to the human ruling. In the integrated tree that ruling is a single question offering only "Enter execution" (recommendation, default) vs "Stay in plan" — no mechanical validator inspects the review output. So the plan-review agent named in the PR title "Gate mode transitions with plan-review agents" cannot actually gate on its findings; a user clicking the recommended option crosses the execution boundary regardless of what the reviewer concluded.
- **Suggested fix:** If the review is meant to gate, parse a structured verdict from the reviewer and treat a blocking verdict as a level:"error" validation (or a required extra confirmation), rather than reducing the review to context text on an enter-by-default ruling.

### 13. In the PR #195 branch, the multi-select "which compatible plan changes to apply" returns only the first selected value, so apply-and-enter silently applies just one of several user-approved changes.
- **Where:** `packages/modes/src/transition-gates.ts:195` · dimension: #195 transition-gates · category: correctness · verdict: CONFIRMED
- **Failure scenario:** On feat/transition-gates (git show feat/transition-gates:packages/modes/src/transition-gates.ts), the ruling presents a `multiple: true` `${id}:changes` question and reads selections via `answers.filter(a => a.questionId === \`${id}:changes\`).map(a => a.value)` (branch lines ~195-196). The questionnaire component emits one Answer object per selected value with the same questionId (packages/ui/src/questionnaire.ts:151-153), but the ask engine collapses duplicates: PendingSet.settle() drops answers whose questionId no longer indexes a live entry (packages/ask/src/pending.ts:94-102) and the waiter's `collected` Map is keyed by questionId keeping only the first (packages/ask/src/engine.ts:261-274). So ask.ask() returns a single :changes answer; selecting 3 reviewer-adds applies 1, then apply-and-enter proceeds — the plan enters execution missing user-approved required reviewers with no error. The branch test passes only because it selects one option. (Note: the current integration removed this multi-select flow entirely, so the defect exists in the PR as written, not in the merged tree.)
- **Suggested fix:** Do not rely on blocking ask() to return multiple values for one questionId; either represent each suggestion as its own yes/no question, or fix the ask engine's waiter/collected to accumulate multiple answers per multi-select questionId before resolving.

### 14. The client socket reader has the same flaw: this.buffer += chunk.toString() decodes each Buffer chunk independently, corrupting any multibyte UTF-8 character that lands on a chunk boundary.
- **Where:** `packages/rpc/src/client.ts:120` · dimension: RPC protocol · category: payload-corruption · verdict: CONFIRMED
- **Failure scenario:** The maestro sends a large maestro->agent message across multiple TCP/UDS chunks (e.g. an answers payload or a planReadResponse whose content exceeds ~64KB and contains a non-ASCII character). A multibyte sequence split across two 'data' events decodes to U+FFFD on each side; the reassembled JSON line parses fine but the agent receives silently corrupted content (e.g. wrong plan text or answers) with no indication of corruption.
- **Suggested fix:** Use a StringDecoder('utf8') instance (buffer += decoder.write(chunk)) or accumulate Buffers and decode only complete newline-delimited frames, mirroring the fix on the server side.

### 15. PR #205 was written against the pre-#193 shape and does not merge into the current cutover — it conflicts across 14 files, and the cutover already reimplemented the same usage-accounting feature.
- **Where:** `packages/rpc/src/protocol.ts:24` · dimension: #205 usage-accounting · category: mergeability · verdict: CONFIRMED
- **Failure scenario:** `git merge-tree HEAD origin/feat/usage-accounting` reports CONFLICT (content) in 14 files, including the three named ones (packages/subagents/src/index.ts, packages/modes/src/exec/execution-adapter.ts, packages/rpc/src/protocol.ts) plus agent-bridge.ts, exec/index.ts, exec/verify.ts, research.ts, runtime/context.ts, runtime/dashboard.ts, runtime/index.ts, usage-ledger.ts, and three test files. The cutover HEAD already contains equivalent symbols (recordCheckpoint, usageCheckpoint event, usage-checkpoints.ts, PROTOCOL_VERSION 6, canonicalTokenSnapshot), so this PR is a divergent duplicate of a feature that already landed on the mainline. It cannot be rebase-merged as-is; the two implementations must be reconciled by hand.
- **Suggested fix:** Abandon or heavily rebase #205 onto the post-#193 unified-agent-api tree, reconciling against the usage-accounting code already present on the cutover rather than re-landing this branch's version.

### 16. The server socket reader decodes each incoming Buffer chunk independently with chunk.toString(), so a multibyte UTF-8 character split across two 'data' events is corrupted into replacement characters before line reassembly.
- **Where:** `packages/rpc/src/server.ts:125` · dimension: RPC protocol · category: payload-corruption · verdict: CONFIRMED
- **Failure scenario:** An agent sends a large message whose JSON exceeds the socket chunk size (~64KB), e.g. a childRunSync with many ChildRunProjection entries, a debugProposal, or a done summary/commits list containing a non-ASCII char (emoji/accented text). Node delivers it across multiple 'data' chunks; if a 2-4 byte UTF-8 sequence straddles a chunk boundary, chunk.toString() on each half emits U+FFFD. The reassembled line still parses as valid JSON, so the message is delivered (not dropped) but with silently mangled string content — the maestro acts on corrupted payload with no error.
- **Suggested fix:** Decode across chunk boundaries: use a node:string_decoder StringDecoder('utf8') per connection (buffer += decoder.write(chunk)), or accumulate raw Buffers and only toString('utf8') once a full newline-delimited frame is available.


## Low findings

### 17. The /park command was deleted in the cutover (its pi.registerCommand("park") registration was removed from packages/modes/src/runtime/commands.ts) but three docs still advertise it as a live user command.
- **Where:** `docs/commands.md:26` · dimension: legacy cleanup · category: legacy-cleanup-stale-reference · verdict: CONFIRMED
- **Failure scenario:** A user following docs/commands.md:26 ("| /park | Create plan tracking issues |") or docs/usage.md:71 ("/park creates tracking issues") / docs/usage.md:96 runs /park in a session. No command named "park" is registered anywhere in the current tree (only /stop's description mentions "park all active workers"), so pi responds with an unknown-command error. scripts/check-docs.mjs does not catch this because it only enforces registered-command -> documented, never documented -> registered, so the drift passes `npm run check`.
- **Suggested fix:** Remove the /park rows from docs/commands.md:26 and docs/usage.md:71,96 (or re-register a park command if the capability was meant to survive). Optionally extend check-docs.mjs to flag documented `/x` slash-commands that no code registers.

### 18. The exec-complete stage is defined with transitions (executing->exec-complete) but no code path ever sets it, so normal execution completion is never represented and its completion-metadata asymmetry is dead.
- **Where:** `packages/contracts/src/modes.ts:41` · dimension: state machine · category: unreachable-stage · verdict: CONFIRMED
- **Failure scenario:** grep across packages for `exec-complete` / `stage: "exec-complete"` finds only contracts/src/modes.ts (definition + transition table); no caller of setExecution/setExecutionStage ever produces stage='exec-complete' (the only stage setters are executing, stopping, stopped in context.ts and hooks.ts). Consequently when a fleet finishes all work successfully without /stop, execution stays in stage='executing' indefinitely rather than moving to a completed stage, and the else-branch in setExecution (state.ts:95-100) forbids exec-complete from ever carrying completedAt/stop, so even if reached it could not record a completion timestamp (unlike stopped). This is a wired-but-unreachable terminal-completion path.
- **Suggested fix:** Either drive executing->exec-complete when the executor reports all deliverables done (and give exec-complete a completedAt like stopped, if consumers need a completion timestamp), or remove exec-complete and its transitions from the contract until a producer exists.

### 19. The spawn-time state seed and the worker's first real token report both carry revision 1, so recordCheckpoint rejects the first genuine cumulative snapshot for a generation.
- **Where:** `packages/modes/src/exec/execution-adapter.ts:714` · dimension: #205 usage-accounting · category: double-count-guard-offby-one · verdict: CONFIRMED
- **Failure scenario:** At spawn, onAgentStateChanged is emitted with revision:1 and a zero snapshot, which recordCheckpoint accepts as the current entry for key agent:<id>:generation:<G>. The worker's AgentBridge.reportTokens (agent-bridge.ts:830) starts usageRevision at 0 and pre-increments, so its first real report is also revision 1; recordCheckpoint then rejects it via `checkpoint.revision <= current.checkpoint.revision` (1 <= 1). In the normal path onTurnEnd emits a superseding revision-2 report so totals recover, but if the worker process emits exactly one recordUsage and is then killed before turn_end (interrupt/crash), that generation's usage stays at the zeroed seed in the ledger and persisted usage.json — an undercount that respawn does not recover because the respawn uses a new generation key.
- **Suggested fix:** Seed the spawn-time placeholder with revision 0 (or omit it from the ledger) so the first real report at revision 1 is always accepted.
