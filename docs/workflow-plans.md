# Workflow-native plans

An authored plan describes repositories, deliverables, dependency edges, and
review intent. It does not choose a persona or encode runtime state. A delegated
task names a review lens, an optional ambient skill request, and a concrete
model. Repeating the same lens in separate tasks is how the author asks
independent models to apply it.

The compiler produces three separately launched flat `@agwab/pi-workflow`
artifact graphs with seat-owned boundaries between them:

```text
deliverable implementation
  -> seat commits every implementation repository
  -> parallel read-only review stages
  -> seat: normalizeRawReviewFindings + PrivateArtifactStore
  -> one decision stage receives sanitized findings only
  -> seat commits agreed changes
  -> seat: ReviewDecisionLedgerStore lineage gate
  -> seat-only shipping
```

There are no nested subagents, verifier stage, or repeated review rounds. Each
reviewer reports claims and evidence without prescribing a resolution. The
implementer decides every normalized finding exactly once as `changed` or
`no_change`, with reasoning. Decision output has no commit-reference field.
After the seat commits agreed changes, it enriches changed decisions with those
commit SHAs; the production decision ledger is the completion gate and
validates them against Git history after the initial implementation checkpoints.

## Dependency preservation

For each deliverable, `after` orders its implementation after predecessor
implementation stages, and implementation stages sharing one repository are
serialized. `reads` remains an explicit prompt contract identifying the
handoffs the task should consume. Every package launches at the coordinated
umbrella cwd because package stage-level cwd is not an isolation boundary; each
prompt names the exact approved repository/worktree path for file operations.

## Approval view

Compilation produces a deterministic approval summary containing:

- every repository and path;
- the deliverable DAG, including separate `after` and `reads` edges;
- every lens, optional skill request, and approved concrete model; runtime model
  identity must match it exactly before findings are accepted;
- authority: implementers edit without Git authority, reviewers are read-only,
  and only the seat commits and ships;
- disclosure: the implementer sees sanitized findings, reviewer attribution
  remains seat-private, and pull requests contain intent, rationale, and the
  resulting changes rather than review provenance.

The compiler emits reviewer registry intents keyed by stage. Once the package
has assigned task IDs and reported resolved models, `bindReviewerRegistry`
fails closed on any model mismatch, joins trusted runtime metadata to the
authored lens, and produces the exact shape accepted by
`normalizeRawReviewFindings`. Runtime task output supplies findings; reviewer
identity never does. After the decision workflow completes,
`decisionGateInput` constructs the exact input accepted by
`ReviewDecisionLedgerStore` once the seat has the initial and final commit
boundaries.

The structured review/decision schema paths are workflow bundle contracts. The
production phase launcher materializes and seals them with the compiled specs,
resolved models, repository roots, toolkit snapshot, and phase authority. The
Plan → Auto command route invokes that production runner after durable human
approval; `/run <slug>` uses the same path for explicit launch and recovery.
