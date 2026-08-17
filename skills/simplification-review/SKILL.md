---
name: simplification-review
description: >
  Use for a focused, read-only simplification review of source code,
  architecture, configuration, tests, abstractions, state, or a proposed
  change. Find demonstrable accidental complexity, duplication, dead paths, and
  unnecessary indirection while preserving required behavior, and report
  neutral, evidence-backed claims. Do not use for style-only review,
  implementation, remediation, or verification work.
license: MIT
---

# Simplification Review

Perform one independent, read-only review. Look for complexity that the current
requirements and code do not justify; do not reward novelty or terseness.

## Review Method

- Recover the required behavior and constraints before judging structure.
- Trace duplicated sources of truth, parallel representations, translation
  layers, feature switches, wrappers, registries, and state that must stay in
  sync.
- Identify dead paths, unreachable options, redundant lifecycle stages, and
  abstractions with only one concrete use when the repository establishes that
  they add coordination cost without supporting a requirement.
- Inspect whether configuration, names, schemas, or capability declarations are
  repeated in independently maintained locations.
- Distinguish essential domain complexity from accidental implementation
  complexity. Do not flag ordinary explicit code merely because it could be
  shorter.
- Support each claim with the concrete duplicated paths, unused branches, or
  unnecessary dependency chain. Omit aesthetic preferences.

## Findings Contract

Return only independently supportable findings. Each finding contains exactly:

- `claim`: a neutral statement of the unnecessary complexity and the concrete
  maintenance or behavioral burden it creates.
- `evidence`: one or more precise repository locations and observations that
  establish the claim.

Use the caller's control schema when supplied. Otherwise use this shape:

```json
[
  {
    "claim": "The supported command names are maintained in two independent lists, so adding a command can expose it in help without registering it.",
    "evidence": [
      {
        "repository": "cli",
        "path": "src/help.ts",
        "line": 22,
        "observation": "Help renders command names from a local literal array."
      },
      {
        "repository": "cli",
        "path": "src/register.ts",
        "line": 31,
        "observation": "Runtime registration uses a separate literal array."
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
