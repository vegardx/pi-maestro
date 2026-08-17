---
name: adversarial-review
description: >
  Use for a focused, read-only adversarial review of source code, workflows,
  distributed behavior, recovery logic, trust assumptions, or a proposed
  change. Construct concrete counterexamples using hostile inputs, surprising
  ordering, partial failure, restart, and cross-boundary interactions, then
  report neutral, evidence-backed claims. Do not use for implementation,
  remediation, verification, or unconstrained speculative brainstorming.
license: MIT
---

# Adversarial Review

Perform one independent, read-only review. Try to falsify the behavior the
system appears to promise without assuming a particular solution.

## Review Method

- State the relevant invariant, then search for the smallest concrete execution
  that violates it.
- Vary input shape, size, encoding, identity, ordering, duplication, timing, and
  origin. Cross boundaries that normal-path tests keep separate.
- Interrupt operations before and after each durable side effect. Consider
  retries, concurrent actors, stale readers, restarts, lease loss, partial
  publication, and dependency failure.
- Challenge assumptions carried through environment variables, current working
  directories, mutable files, caches, clocks, process inheritance, remote state,
  and string-linked capabilities.
- Follow authority and data across process, repository, network, and persistence
  boundaries. Check whether the enforcement point observes the same identity and
  state as the decision point.
- Ground every counterexample in a reachable path and specific observations.
  Omit hypothetical failures that the inspected code already excludes.

## Findings Contract

Return only independently supportable findings. Each finding contains exactly:

- `claim`: a neutral statement of the counterexample and the condition or event
  ordering that exposes it.
- `evidence`: one or more precise repository locations and observations that
  establish the claim.

Use the caller's control schema when supplied. Otherwise use this shape:

```json
[
  {
    "claim": "Two seats can both publish the same run when they acquire different lock files derived from relative and absolute repository paths.",
    "evidence": [
      {
        "repository": "orchestrator",
        "path": "src/shipping.ts",
        "line": 64,
        "observation": "The lock key hashes the caller-provided path without canonicalizing it."
      }
    ]
  }
]
```

Use repository-relative paths and the repository key supplied by the caller.
Do not add fields beyond the active schema. Do not assign severity or priority,
tally agreement, vote, give a verdict, prescribe a change, or describe a
preferred solution. If no claim is supported, return an empty findings array
rather than silence.
