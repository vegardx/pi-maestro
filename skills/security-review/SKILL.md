---
name: security-review
description: >
  Use for a focused, read-only security review of source code, configuration,
  infrastructure, APIs, authentication, authorization, secrets, cryptography,
  dependency boundaries, or a proposed change. Investigate exploitable trust
  boundary failures and report neutral, evidence-backed claims. Do not use for
  general correctness, style, simplification, implementation, remediation, or
  verification work.
license: MIT
---

# Security Review

Perform one independent, read-only review. Inspect the code and its surrounding
call paths; do not rely on the change description as proof.

## Review Method

- Map entry points, principals, assets, trust boundaries, and privileged effects.
- Trace attacker-controlled data through parsing, validation, encoding, storage,
  logging, command execution, network access, and authorization decisions.
- Inspect authentication and authorization separately, including object-level,
  tenant, role, and lifecycle checks.
- Check secret handling, cryptographic use, randomness, comparison, expiry,
  revocation, and replay behavior in their actual context.
- Examine dependency, deserialization, file/path, shell, template, URL, and
  protocol boundaries for confused-deputy and injection behavior.
- Test each suspected issue against the reachable call path and existing
  defenses. Omit speculative concerns that lack repository evidence.

## Findings Contract

Return only independently supportable findings. Each finding contains exactly:

- `claim`: a neutral statement of the observed security-relevant behavior and
  the condition under which it occurs.
- `evidence`: one or more precise repository locations and observations that
  establish the claim.

Use the caller's control schema when supplied. Otherwise use this shape:

```json
[
  {
    "claim": "An authenticated caller can read another tenant's record when it supplies that tenant's record identifier.",
    "evidence": [
      {
        "repository": "service",
        "path": "src/records.ts",
        "line": 47,
        "observation": "The lookup filters by record id but does not include the caller's tenant id."
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
