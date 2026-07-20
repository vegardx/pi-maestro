# Spike: Ensemble mechanics (v2 primitives, open item 2)

Design spike, 2026-07-20. Read-only investigation of the existing machinery +
concrete proposal. Canonical context: `docs/design/v2-primitives.md`
("Ensembles" bullet under Plans; invariant 3).

The scenario: a parent worker (persona says "use multi-model candidates")
spawns 2–3 candidate workers on the same task, each in its own worktree
branched from the parent's branch point. Each candidate returns its work as a
diff (contract output). The parent — which implemented nothing — judges,
integrates the strongest approach into its own worktree, and the candidate
worktrees are reaped. One writer per worktree, always.

---

## 0. The load-bearing observation

**All worktrees of a repo share one object store.** Candidate worktrees are
`git worktree add`s of the same repo the parent's worktree belongs to
(`packages/git/src/worktree.ts` already builds exactly this layout). The
moment a candidate commits, its commits are visible to the parent via plain
`git diff <base>..<candBranch>` *from the parent's own worktree* — no bytes
ever need to travel through the contract at all. The contract's job is
therefore **judgment metadata + a pointer**, not transport. Everything below
follows from this.

---

## 1. Diff transport

### Options compared

**(a) Inline patch text in the contract result.**
- Pro: self-contained; works even if the worktree is gone.
- Con: a medium task diff is 2–20k tokens; a big one 50–200k. Three of those
  land in the parent's context *before it has decided anything* — the judge
  drowns before judging. Patches are also lossy (binary files, mode changes,
  renames degrade), and provenance dies: the parent re-applies text, so the
  final commits say nothing about which candidate authored what.
- Existing precedent against: `commit-target.ts` exists precisely because
  reviewers "never inspect a moving branch or an uncommitted working tree" —
  the codebase's idiom is *frozen refs*, not payloads.

**(b) Candidate commits to its own branch; returns `{branch, baseSha, headSha}`.**
- Pro: zero-copy (shared object store); exact; provenance intact (candidate's
  commits survive); partial adoption is native git (`git checkout <br> -- f`,
  `git diff <base>..<br> -- f`); parent pulls only what it needs, when it
  needs it.
- Con: parent must spend turns running git to see anything; a lazy parent
  might adopt on diffstat alone.

**(c) Hybrid: ref + size-capped inline preview + candidate summary.**
- (b) plus enough inline material that the *first* judgment turn is informed
  without any tool calls.

### Recommendation: (c), with the ref as the source of truth

Contract result for the `worker` agent's `summary + diff` contract, candidate
flavor (feeds spike 1, contract shapes):

```jsonc
{
  "kind": "candidate-diff",
  "branch": "cand/build-auth/c1",
  "baseSha": "<40-hex>",          // frozen, commit-target style
  "headSha": "<40-hex>",          // frozen at candidate completion
  "stat": "<git diff --stat baseSha..headSha>",   // always inline, tiny
  "summary": "<candidate's reasoning summary>",   // 5000-token budget, reused
  "preview": "<git diff, deterministically truncated to ~8k tokens>",
  "empty": false                   // headSha == baseSha
}
```

- `baseSha`/`headSha` validated with `isImmutableCommit` and rendered into
  the parent's context with `renderCommitTarget` (`exec/commit-target.ts`) —
  both reusable verbatim.
- `summary` uses the existing summarize RPC (`requestSummary` in
  `execution-adapter.ts` ~line 846: live-agent request, 120s timeout,
  transcript fallback, `truncateSummary` to `SUMMARY_TOKEN_BUDGET = 5000`).
  The consumer string tells the candidate who reads it: "a judge who did not
  implement this will compare your approach against alternatives — explain
  your key decisions, tradeoffs you rejected, and where your version is
  strong/fragile." That framing is the single highest-leverage prompt in the
  whole feature.
- `preview` truncation reuses the `truncateSummary` mechanism (paragraph-
  boundary cut + fixed marker) so identical inputs give identical bytes —
  same cache-stability discipline as `seeds.ts`.

**What the parent needs to judge:** diffstat + summary first (cheap triage
across all candidates in one screen), then *targeted* `git diff` / `git show`
per file where candidates disagree. The judge persona should be written to
diff-the-diffs: `git diff cand/x/c1..cand/x/c2 -- path` is legal and cheap
since everything shares the object store. A 150k-token diff never enters
context unless the parent deliberately pages through it.

**Partial adoption** falls out of (b)/(c) for free: `git checkout
cand/x/c2 -- src/rotate.ts` takes candidate B's version of one file;
provenance is recorded in the integration commit trailer (§3), not lost.

## 2. Worktree lifecycle

### Creation point

**Branch from the parent worktree's HEAD, which must be clean.** Sequence at
ensemble fan-out (harness-side, in the node executor):

1. Parent asks to spawn candidates (dynamic children appended to the plan
   ledger *before spawn*, `authored-by: <node>` — per the settled design).
2. Harness checks `workingTreeClean(parentWorktree)`. Dirty → do NOT spawn;
   steer the parent: "commit your staged context first — candidates branch
   from your HEAD and uncommitted work would be invisible to them." This is
   the exact shape of the dirty-worktree completion hold
   (`workerMayComplete`, `execution-adapter.ts` ~1666): steer on a cadence,
   escalate after a budget. Reuse the pattern; the spawn attempt is simply a
   second gate on the same predicate.
   - Note the parent "implements nothing", so in the common case its
     worktree is clean at fan-out (it just got provisioned). The gate matters
     for re-runs and for parents that wrote scaffolding/notes first.
3. `base = headSha(parentWorktree)` — frozen once, shared by all candidates
   of this ensemble round (a la `captureCommitCheckpoint`). Recorded on the
   ledger. This also fixes a latent wart: today's `createWorktree` closure
   captures `headSha(repoPath)` — the *main checkout's* HEAD — as `baseSha`,
   which is wrong for stacked branches; candidates must use the parent
   worktree's HEAD, full stop.
4. Per candidate: create branch `cand/<parentNodeId>/<childId>` at `base`,
   `addWorktree(...)`, `provisionEnvironment(...)`.

If the parent's node owns branch `feat/auth`, candidates branch from
wherever `feat/auth` currently points — stacked bases compose with no extra
machinery because the parent's worktree already sits on the stacked branch
(`resolveBaseBranch` / `pickBaseBranch` did that work at node provision).

### Naming / location

Follow the reserved-segment scheme already in `worktree.ts`
(`agentWorktreePath` reserves `_agents/<runId>`; currently exported but
unconsumed — this feature is its natural customer, generalized):

- Path: `<parent-of-repo>/worktrees/<repo>/_candidates/<parentNodeId>/<childId>`
- Branch: `cand/<parentNodeId>/<childId>` (e.g. `cand/build-auth/c1`)

The underscore segment keeps candidates out of the deliverable namespace, so
`cleanupWorktrees`' DAG logic and `findCheckoutOf` reuse never confuse a
candidate tree with a deliverable tree. The `cand/` branch prefix makes the
final `git branch --list 'cand/*'` sweep trivially safe.

### Ensuring the diff exists: reuse the completion hold

Candidates get the dirty-worktree completion hold **verbatim in behavior**:
all tasks toggled + dirty tree → steer to commit (cadenced,
`DIRTY_HOLD_RESTEER_MS` / `DIRTY_HOLD_MAX_STEERS`) → escalate on budget
exhaustion. Today the hold is gated on `agentNamePart === "worker"`
(~line 1645); in v2 the gate becomes "agent type owns a worktree", which is
exactly the invariant "worktree exists iff write tools". A candidate that
completes clean has, by construction, a committed `headSha` — the diff
exists before the contract result is assembled. Escalation for a candidate
is softer than for a deliverable worker: mark the *candidate* failed
(§4), never block the parent node.

### Reap timing — two-phase

- **Phase 1 — worktree, after consumption.** When the parent's integration
  is committed (parent signals adoption in its own contract flow; harness
  verifies `headSha(parentWorktree)` moved past the fan-out base, or the
  parent explicitly reports per-candidate disposition), remove each
  candidate worktree: `removeWorktree(repo, path)` — non-forced works
  because the completion hold guaranteed a clean tree; fall back to
  `force: true` only for candidates that *failed* (their half-work is
  disposable by definition, and the plan ledger records that disposition).
  Directory `_candidates/<parentNodeId>/` removed when empty.
- **Phase 2 — branches, at node terminal + shipped.** `removeWorktree` never
  deletes branches (by design). Keep `cand/*` branches until the parent
  node reaches a terminal status and its PR is shipped, then delete them in
  the same pass as `cleanupWorktrees` (extend it with a candidate sweep
  keyed off the plan ledger). Rationale: between integration and ship, a
  reviewer child ("review the auth diff") or a human may want to compare
  the adopted approach against the losers; branches are free, worktrees
  cost disk and `git worktree list` noise.

Why not reap at plan end only: a long plan with several ensembles would
accumulate 2–3 worktrees × N nodes of APFS-cloned node_modules. Phase 1
keeps steady-state disk at "one ensemble in flight".

### Crash / abandon cleanup

The plan ledger is append-only and every candidate is written into it
*before spawn* — so unlike orphaned tmux sessions, orphaned candidate
worktrees are always enumerable from one source of truth. Tie-ins:

- `recovery.ts` (state-vs-reality reconciliation) learns one more check:
  for each ledger candidate not marked consumed/reaped, does
  `_candidates/<node>/<child>` exist, does `cand/<node>/<child>` resolve,
  is the tree dirty. Same `✓/✗/⚠` note style.
- The session-start legacy sweep (`subagents/src/index.ts` ~430: archive old
  run records, *list* leftover worktrees, never auto-delete) extends
  naturally: candidate worktrees whose parent node is terminal are safe to
  auto-remove (clean ones silently, dirty ones listed for the human —
  matching `removeWorktree`'s refusal semantics). Candidate worktrees whose
  plan directory no longer exists are orphans: list them with the existing
  "remove with `git worktree remove` if orphaned" notice.
- Never auto-force-delete a dirty candidate tree during crash recovery: a
  crashed candidate's uncommitted work is the only copy. Cheap insurance,
  consistent with the codebase's "never force, surface the reason" posture.

## 3. Integration method for the parent

### Default: cherry-pick the winner

`git cherry-pick <base>..cand/<node>/<winner>` in the parent's worktree.

- All candidates branched from the parent's *current* HEAD, and the parent
  implemented nothing while they ran (the design guarantees this — fresh
  eyes, no self-preference), so the picks land on the exact commit they were
  built on: **conflict-free by construction** in the wholesale-adoption case.
- Preserves the candidate's commit sequence and messages — the review child
  node ("after: [worker]") sees real history, not a squash blob.
- Cheap: no model tokens spent re-emitting code the model already wrote.

### When each method applies

| Method | When | Mechanics |
| --- | --- | --- |
| `cherry-pick` (default) | Winner adopted wholesale or nearly | `git cherry-pick base..candBranch`; then optional follow-up commits for the parent's own touches |
| `checkout -- paths` | Mixing: candidate A's core + candidate B's tests, or one file from a loser | `git checkout cand/x/c2 -- test/rotate.test.ts`; parent commits with attribution trailers |
| `apply` / `apply --3way` | Adopting a *sub-hunk* of a file, or picks stopped composing after mixed adoption moved the tree | `git diff base..cand -- file \| git apply --3way`; last-resort mechanical path |
| read-and-reimplement | No candidate is adoptable but the ideas are; or candidates disagree on architecture and the synthesis is genuinely new | Parent writes fresh code informed by the diffs; most expensive, judge persona should reach for it last |

The judge persona states this ladder explicitly: *prefer adopting real
commits; re-typing a candidate's work destroys provenance and burns tokens.*

### Provenance in the final PR

- **Winner's commits land as-is** (cherry-picked). Losers' commits do NOT
  enter the PR branch — three parallel implementations of the same task in
  one PR history is noise, and the branches remain inspectable until ship
  (§2 phase 2).
- **Trailer on every integration-phase commit**, following the
  `appendMaestroStageTrailer` pattern (`packages/commit/src/index.ts` —
  strict identifier regex, dedupe-and-append):
  `Maestro-Candidate: <childId> <family/model>` on cherry-picked commits
  (added via `cherry-pick` + `commit --amend -F -`, or `--strategy` wrapper),
  and `Maestro-Ensemble: adopted=<childId> of <n>` on the parent's own
  integration/mixing commits. Answers "who wrote what" at `git log`
  granularity forever, even after branches are deleted.
- **PR body**: the maestro provenance section (`pr-provenance.ts` — bounded
  bytes, begin/end markers, canonical-vs-details split) gains an ensemble
  block: candidates, model/family each ran, diffstat each produced,
  disposition (adopted / partially adopted / rejected / failed), and the
  parent's one-paragraph rationale. The workflow-analytics ledger already
  flows agent-level records into this section; ensemble rounds are one more
  record type.
- The plan ledger keeps the full record regardless (append-only, complete —
  invariant 7), so HUD/explain can show the ensemble even pre-ship.

## 4. Failure handling

Guiding rule (matches the design's model-resolution stance): **degrade
visibly toward the parent doing the judgment — never fail-open, never
wedge.** A candidate failing is an ensemble degradation, not a node failure.

- **One candidate fails / times out / crashes** → proceed with N−1. Mark
  the candidate failed on the ledger with reason (crash capture already
  preserves the dying screen via the `crashFile` tmux wrapper in
  `buildSpawnSpec`); force-reap its worktree; hand the parent the surviving
  results plus one line: "candidate c2 (family X) failed: <reason>". No
  respawn by default — the ensemble's value is comparison, and a straggler
  respawn doubles wall-clock; the parent can explicitly request a redo
  (dynamic child, envelope permitting) if it judges the survivors weak.
- **N−1 == 1**: still run the judgment turn. The parent evaluating a single
  candidate's diff with fresh eyes is a cheap review pass, and keeping the
  flow uniform (parent always integrates deliberately, never auto-adopts)
  preserves the invariant and the provenance trail.
- **Empty diff** (`headSha == baseSha`, clean completion): valid contract
  result with `empty: true`. Usually means the candidate concluded "no
  change needed" or gave up quietly — the summary says which. Counts as
  not-adoptable for code, but the parent may still mine the reasoning
  (e.g., a candidate that found the task is already implemented is
  information the others missed).
- **Broken diff** (cherry-pick conflicts — shouldn't occur wholesale, can
  occur after mixed adoption): mechanical fallback ladder from §3
  (`checkout -- paths` → `apply --3way` → reimplement). Never blocks; the
  parent has full tools and the candidate branch is still there.
- **All candidates fail**: steer the parent — "all candidates failed
  (<reasons>); implement directly or re-fan-out with a revised task." The
  parent *is* a worker with write tools; direct implementation is the
  universal fallback, exactly parallel to "model resolution failure →
  session model". Record `ensemble-collapsed` on the ledger. If the parent
  then also wedges, the ordinary completion/watchdog machinery
  (`markAgentFailed` → `blockDeliverable` → `/recover` hint) applies
  unchanged.
- **Candidate finishes dirty**: existing dirty-hold steer/escalate,
  candidate-scoped (§2).

## 5. Cost sketch (order of magnitude)

Assumptions (stated, medium task): a single implementation worker runs
~30–50 turns; context grows to ~40–60k tokens; with fork-and-append seeding
prefix cache hit rates run high (the adapter already tracks
`firstTurnPrefixCacheHitRate`), so effective input cost ≈ 10–20% of raw
token-passes; total output ≈ 10–20k tokens. Call the single-worker cost
**X** (≈ $1–3 on a Sonnet-class model at current public pricing).

- **Candidates: ≈ 3.0X.** Three full implementations. Caveat: diversity
  means distinct model families, so each family pays its own cache writes —
  there is no cross-family prefix sharing. Within each candidate the normal
  intra-session caching still applies, so ≈ X each holds.
- **Parent judge + integration: ≈ 0.3–0.5X.** Seed + 3 summaries (≤15k
  tokens) + 3 diffstats (~1k) + selective diff paging (10–30k tokens
  typical) + ~10–15 short integration turns (cherry-pick, build, test).
  Output is small (git commands, rationale). The hybrid transport is what
  keeps this at 0.3–0.5X instead of 1.5X — ref-only pointers with inline
  triage material, full diffs paged on demand.
- **Total: ≈ 3.3–3.6X ≈ 3–4× a single implementation** (so a $2 task
  becomes ~$7). Not 10×: the judge is cheap, and nothing is paid twice for
  transport. Wall-clock ≈ one candidate (parallel) + a judge phase
  (~20–30% overhead). Failure modes that would break the estimate: inline
  full diffs in contract results (parent context blows toward 200k → 2×
  judge cost and degraded judgment), or read-and-reimplement as the default
  integration (adds ~1X back).

## 6. Reuse inventory

### Verbatim (no changes)

| File | What |
| --- | --- |
| `packages/git/src/worktree.ts` | `worktreesRoot`, `worktreePathFor` (candidate paths are just new segments), `addWorktree` idempotence/reuse semantics, `removeWorktree` (dirty-refusal + force), `listWorktrees`, `findCheckoutOf` |
| `packages/git/src/repo.ts` | `headSha`, `workingTreeClean`, `statusPorcelain`, `mergeBase`, `isAncestor`, `refExists`, `detectDefaultBranch` |
| `packages/git/src/branch.ts` | `branchExists`, `createBranch(cwd, branch, base)` — already takes an arbitrary base ref, so `git branch cand/... <sha>` needs zero new code |
| `packages/git/src/stage.ts` | explicit-pathspec staging + `commit -F -` for the parent's attributed integration commits |
| `packages/modes/src/exec/commit-target.ts` | `captureCommitCheckpoint` / `isImmutableCommit` / `renderCommitTarget` — the candidate result freeze is literally this type (`base`, `head`) |
| `packages/modes/src/exec/provisioner.ts` | `provisionEnvironment` (APFS `cp -c` node_modules clone makes 3 worktrees cheap), `buildAgentSessionFile` (fork-and-append), `buildSpawnSpec` (incl. crash-capture wrapper), `defaultAgentDir` |
| `packages/modes/src/exec/seeds.ts` | `truncateSummary` + deterministic-bytes discipline for the preview cap; framed-section style for the judge seed |
| `packages/commit/src/index.ts` | `appendMaestroStageTrailer` as the pattern (and validation regex) for `Maestro-Candidate` / `Maestro-Ensemble` trailers |
| `execution-adapter.ts` summarize path | `requestSummary` (live RPC → transcript fallback → placeholder), `SUMMARY_TOKEN_BUDGET` |
| `packages/modes/src/exec/child-projections.ts` | HUD/cross-process visibility of candidate runs, steer/interrupt controls |

### Needs extension

| File | Change |
| --- | --- |
| `packages/git/src/worktree.ts` | `addWorktree`'s `resolveBaseRef` handles branch names only; either accept a SHA base (one `isImmutableCommit` branch) or have callers pre-create the branch via `createBranch` — recommend the latter, zero worktree.ts changes then. Add `candidateWorktreePath(repo, nodeId, childId)` beside `agentWorktreePath` |
| `packages/modes/src/exec/provisioner.ts` | `provisionWorktree` hardcodes `deliverableBranch` (`feat/<id>`) and the deliverable path segment — parameterize `{branch, pathSegments, baseRef}` (candidates pass `cand/...`, `_candidates/...`, frozen SHA) |
| `execution-adapter.ts` `createWorktree` closure (~777) | `baseSha` is captured from the *main checkout's* HEAD — candidates must freeze the **parent worktree's** HEAD; fix benefits stacked deliverables too |
| `execution-adapter.ts` dirty hold (~1645–1719) | gate is `agentNamePart === "worker"` → becomes "agent owns a worktree" (v2 invariant: worktree iff write tools); escalation branches candidate-scoped (fail candidate, never block parent node) |
| `packages/modes/src/exec/shipper.ts` `cleanupWorktrees` | add the `_candidates` sweep + `cand/*` branch deletion at node-terminal+shipped, ledger-keyed |
| `packages/modes/src/pr-provenance.ts` | ensemble block in the bounded maestro section (candidates, families, diffstats, disposition, rationale) |
| `packages/modes/src/exec/recovery.ts` | enumerate ledger candidates → worktree/branch/dirty checks |
| `subagents/src/index.ts` session-start sweep | candidate-orphan listing/removal per §2 crash cleanup |
| `packages/modes/src/exec/seeds.ts` | two new frames: candidate seed ("you are one of N; a judge who did not implement will compare…") and judge seed (renderCommitTarget blocks + summaries + stats + integration ladder) |

### New code

- `candidate-diff` contract result record + extraction/validation (joint
  with spike 1, contract shapes).
- Ensemble round orchestration in the node executor: clean-parent gate →
  freeze base → append candidates to ledger → spawn N → collect contract
  results → build judge seed → verify integration commit(s) → phase-1 reap.
  Small state machine; every primitive it composes exists above.

## Open questions for the group

1. Does the parent's *adoption rationale* belong in the contract result
   schema (structured `disposition` per candidate) or is ledger + PR-body
   prose enough? Structured buys lintable "ensemble ran, nothing adopted"
   detection.
2. Trailer mechanics on cherry-picked commits: amending each pick to add
   `Maestro-Candidate` rewrites the sha (fine — candidate branch keeps the
   original), but costs one amend per commit. Alternative: trailer only on a
   single empty `Maestro-Ensemble` marker commit closing the round.
3. Should `maxChildrenPerNode`-style envelope count candidates and the
   review child together (current design reads yes — one envelope per node)?
