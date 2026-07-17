# Review workflows

Review is part of the immutable agent workflow, not a separate reviewer subsystem. The plan records typed assignments and stage topology; each run reports against an exact commit target.

## Assignments and stages

Built-in review kinds are `plan-review`, `practical-review`, `adversarial-review`, `correctness-review`, `security-review`, `test-review`, and `simplification-review`. `verifier` is the scope-locked verification kind.

A review assignment stores:

- stable assignment id and semantic kind;
- exact preset/set/option/model/effort;
- read-only runtime policy;
- focus and rationale;
- input/output contracts; and
- resolution provenance.

Every member of a stage receives the same immutable `inputRevision`. Independent reviewers belong in the same stage and run concurrently. Downstream stages declare `after` dependencies and may consume only contracts produced by ancestors. A stage report publishes only after all members settle.

Duplicate semantic kinds are valid when assignment ids and rationale are distinct. This allows independent model checks without inventing pseudo-kinds.

## Findings

Reports produce structured source-addressable findings:

```text
id · severity (critical|major|minor) · category
file/line or task/claim · evidence · actual behavior · provenance
```

The host preserves raw assertions, then canonicalizes duplicates. A canonical entry names its primary finding/reviewer and `duplicateIds`; severity uses the strongest assertion. This is one finding set, not a second ledger.

## Resolution

Each open finding receives one explicit status:

- `fixed` — note plus immutable fix commit;
- `duplicateOf` — points to the canonical id;
- `disputed` — code-referencing rationale for a blocking finding;
- `wont-fix` — minors only.

Critical and major findings block until settled. A fixed claim is verified against the original reviewed SHA, named finding id, fix commit, and resulting range. Verification is scope-locked: it checks that claim and regressions caused by the fix, not a new open-ended review. A still-open result returns the claim for another fix; missing reviewer runs may be repaired without rerunning successful assignments.

## Final assessment

Completion is mechanical. Maestro requires:

1. the current head matches the frozen workflow revision being assessed;
2. every assigned review produced a valid report;
3. every critical/major canonical finding is resolved and, when fixed, verified; and
4. final verification records the exact assessed SHA.

Model-authored PASS/BLOCK prose is not independently authoritative. Human waivers, when allowed by the transition contract, are explicit durable gate evidence.

## Provenance and PRs

The delivery's workflow analytics records stage/assignment status, input/output SHAs, run ids, bounded evidence, cumulative usage, raw and canonical findings, resolution/verification, and final verification. PR projection includes canonical findings even when optional details exceed its budget. Assignment detail folds truncate first.

The generated section is enclosed by `<!-- maestro:provenance:start -->` and `<!-- maestro:provenance:end -->`; arbitrary user text outside those markers survives updates. Evidence is bounded and redacted. Prompts, private reasoning, transcripts, credentials, and raw tool logs are never published.
