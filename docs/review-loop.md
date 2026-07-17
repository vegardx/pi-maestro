# Review workflows

Reviews are ordinary typed agent assignments in the plan workflow. Planning resolves each reviewer to an immutable semantic kind, model/effort option, runtime policy, input contracts, and output contracts.

## Stages

Assignments in one stage start together against the same immutable commit target. A stage publishes one atomic report only after every member settles. Downstream stages consume explicit contracts produced by ancestor stages.

Built-in review kinds include practical, adversarial, correctness, security, test, and simplification review. Their reports produce structured, source-addressable findings. Duplicate assertions are normalized into the canonical workflow finding set rather than maintained in a second panel ledger.

## Verification and completion

Fix verification is scope-locked to named finding ids, the original immutable target, the fix commit, and the resulting range. It does not start a fresh open-ended review.

Final assessment is mechanical: the assessed head must match the frozen workflow revision, every assigned review must have a valid report, and every critical or major canonical finding must be resolved. Model-authored verdict strings do not independently open a shipping gate.

Workflow provenance and bounded analytics are persisted on the deliverable and projected into the generated PR section. Raw prompts, private reasoning, transcripts, and secrets are never published.
