---
name: drive-maestro-e2e
description: Run the pi-maestro workflow-cutover drive through the production plan runner, coordinator, supervisor, pi-workflow, pi-subagent, linked worktrees, seat-owned commits, and seat-only shipping.
---

# Drive the workflow architecture end to end

The acceptance drive follows the workflow architecture and enters at
`createProductionWorkflowPlanRunner`.

## Run it

The deterministic cross-process drive is part of the hermetic e2e suite:

```sh
npm run test:e2e:workflow
```

Run the whole repository gate before handoff:

```sh
npm run check
npm run test:e2e
```

There is no live-drive command yet. Do not substitute a unit or hermetic result
for real-provider evidence.

## Scenario

The drive creates two real Git repositories, local bare remotes, and linked
worktrees below one coordinated run root:

1. The production runner previews the exact multi-repository worktrees and asks
   one blocking human approval question. Refusal creates no branch, worktree,
   commit, model runtime, push, or pull request.
2. After approval, production repository preparation creates the linked
   worktrees. A flat implementation workflow updates `contracts`, then updates
   `api` after consuming contract v2. Model stages have no Git authority.
3. The production runner creates ordinary seat-owned initial commits in both
   repositories.
4. A separate flat read-only cohort runs concurrently: security on Opus 5,
   Fable 5, and Grok 4.5, plus correctness and simplification lenses.
5. The runner passes all reviewer outputs and trusted task identities through the
   production findings normalizer. It stores private contributor provenance in
   `PrivateArtifactStore` and creates the de-attributed projection.
6. A third package run gives the implementer only that projection.
   The implementer chooses the resolution of every finding, records
   `changed`/`no_change` plus reasoning. The runner creates the seat-owned
   follow-up commit for its accepted change.
7. The production `ReviewDecisionLedgerStore` refuses the shipping gate unless
   every finding has exactly one decision and every changed path and commit is
   valid in the post-review Git lineage.
8. All three package runs persist aggregate task usage and cache-read tokens.
9. Only after the private join and decision-ledger seal pass does the real
   shipping adapter use injected local-remote/PR boundary operations. Its
   durable validation and journal remain production code.

## Happy-path acceptance

Green means all of these observations hold:

- exactly one human approval covers the compiled repositories, DAG,
  lenses/models, authority, and disclosure policy before Git mutation;
- the approved execution manifest binds the exact workflow bundle, runtime,
  toolkit tree, repositories, workflow state, and writable roots;
- `WorkflowPlanRunner` and the production phase launcher drive the real
  depth-zero coordinator, supervisor, and
  `@agwab/pi-workflow`, which launches
  every model task through real `@agwab/pi-subagent`;
- implementation/review/decision use separate sealed phase runtimes with their
  exact approved provider sets;
- the API task starts only after the contract task and reads contract v2;
- the three security launches select three distinct models and overlap in
  time;
- the implementer prompt contains all sanitized finding IDs and contains no
  reviewer stage/model identity;
- the decision sandbox denies all ten exact reviewer `raw.md`/`control.json`
  files while package run metadata and the sanitized prompt remain available;
- the private post-decision join restores all three contributors to the
  overlapping security finding only at the seat;
- the contract history has one seat-owned checkpoint and the API history has an
  initial checkpoint followed by an accepted-finding fix;
- reviewer stages cannot commit and no workflow descendant publishes;
- usage totals cover every model-backed task, including cache-read tokens;
- bare remotes have no workflow branches before production shipping starts,
  then match the worktree heads afterwards;
- the refusal case does not cross the approval-to-mutation boundary.

## What it does not prove yet

The cross-process drive deliberately enters at the production runner API. A
separate deterministic extension test enters through interactive Plan → Auto,
uses the real production runner and approval gate, and proves that mode changes
only inside the approved launch. That routing test injects the post-approval
phase adapters, while the cross-process drive exercises the real adapters from
the runner downward. No single test yet spans an installed interactive Pi
extension through the complete cross-process provider drive.

The test uses a deterministic fake Pi executable below the real
`pi-workflow -> pi-subagent` boundary. It proves model/provider routing and
usage accounting structurally, not provider quality. It uses local bare remotes
and injected GitHub/PR operations below the real production shipping adapter;
it does not create a hosted pull request.

No workflow descendant receives commit capability. `WorkflowPlanRunner` invokes
the durable seat checkpointer only after implementation and decision. The
superseded commit-broker design is not part of this path.

The recovery case intentionally fails the decision task once, constructs a new
production runner, and lets its durable journal launch the decision supervisor
with `continue`. It proves the implementation, reviewers, and initial
checkpoints are not replayed. Abrupt
SIGKILL/process-orphan containment still needs a live sandbox drive at this
same seam.

## Reading a failure

Start with the supervisor stderr attached to the failed assertion. For retained
fixtures inspect, in order:

1. `<run>/runtime/.pi/workflows/workflow_cutover_e2e_{implementation,review,decision}/run.json`
   for package state and per-task usage;
2. `<seat-state>/workflow-plan-runs/workflow_cutover_e2e.json` for the durable
   production-runner phase journal;
3. `<run>/runtime/workflow-bundles/<phase-run>/authority-policy.json` for
   write/read/write and exact deny-read bindings;
4. `<temp>/trace.ndjson` for stage/model launch order and compiled prompts;
5. `git log --oneline --all` in each source/worktree and bare remote.

The test removes its temporary root on completion. During investigation,
temporarily retain the path in the test rather than weakening an assertion or
conditionally skipping the scenario.
