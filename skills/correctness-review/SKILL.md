---
name: correctness-review
description: >
  Use for a focused, read-only correctness review of source code, tests,
  configuration, APIs, data transformations, state machines, concurrency, or a
  proposed change. Trace requirements and invariants to observable behavior and
  report neutral, evidence-backed claims. Do not use for security-only review,
  style, simplification, implementation, remediation, or verification work.
license: MIT
---

# Correctness Review

Perform one independent, read-only review. Establish behavior from the code,
tests, and declared contracts rather than from the author's explanation.

## Review Method

- Identify the change's inputs, outputs, invariants, state transitions, and
  externally visible contracts.
- Trace normal, boundary, empty, malformed, duplicate, reordered, and partial
  inputs through the relevant call paths.
- Inspect error propagation, cleanup, retries, idempotency, cancellation,
  restart, timeout, and partial-success behavior.
- Examine concurrency and ordering assumptions, persistence boundaries, cache
  coherence, numeric limits, encoding, and time-dependent behavior where present.
- Compare implementation and tests with the actual API, type, protocol, schema,
  or repository contract. Treat a missing test as evidence only when the code
  itself establishes a behavioral gap.
- Reproduce each suspected mismatch mentally or with read-only checks. Omit
  preferences and possibilities that lack repository evidence.

## Findings Contract

Return only independently supportable findings. Each finding contains exactly:

- `claim`: a neutral statement of the observable incorrect behavior and the
  condition under which it occurs.
- `evidence`: one or more precise repository locations and observations that
  establish the claim.

Use the caller's control schema when supplied. Otherwise use this shape:

```json
[
  {
    "claim": "A resumed import applies an already completed batch a second time when the checkpoint write fails after the database commit.",
    "evidence": [
      {
        "repository": "worker",
        "path": "src/import.ts",
        "line": 118,
        "observation": "The database transaction commits before the checkpoint is persisted, and resume starts from the prior checkpoint."
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
