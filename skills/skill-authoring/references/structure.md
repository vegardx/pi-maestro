# Skill Structure

Use this reference when deciding what belongs in metadata, `SKILL.md`, a sibling
file, a script, an asset, or another skill.

## Content Types

A skill contains two kinds of content:

- **Steps:** ordered actions the agent performs. They are primary when present.
- **Reference:** rules, facts, definitions, examples, and conditional guidance the
  agent consults. A skill may be all reference, all steps, or both.

Do not force a reference skill into an artificial process, and do not bury a real
process beneath reference material.

## Information Hierarchy

Rank content by how immediately the agent needs it:

1. **In-skill steps** in `SKILL.md`.
2. **In-skill reference** needed by every branch.
3. **Disclosed reference** in a sibling file, reached through a conditional
   pointer only by relevant branches.

This is progressive disclosure. It protects the agent's attention, not just the
token budget.

- Inline what every branch needs.
- Disclose what only some branches need.
- Keep universal safety and correctness constraints inline.
- Keep a concept's rule, definition, and caveats together.
- Give every disclosed file one source-of-truth responsibility.
- Link directly from `SKILL.md`; avoid chains of required references.

A context pointer must encode its selection condition:

```markdown
Read `references/aws.md` only when the deployment target is AWS.
```

“See references for more information” is not a reliable pointer. If required
material is missed, sharpen the pointer first; inline it only if selective
loading remains unreliable.

## Steps and Completion Criteria

Every meaningful step ends with a completion criterion: a checkable condition
that tells the agent when the step is done.

Prefer:

- “Continue until every modified module is accounted for.”
- “Stop when the parser accepts the output and the focused tests pass.”

Avoid vague endings such as “understand the code” or “produce a good review.” A
vague criterion lets the agent move to later steps too early.

If later visible steps repeatedly cause premature completion, first sharpen the
criterion. Split the sequence only when the bound cannot be made clear and the
failure is observed in evals.

## Directory Shape

Use only the directories the skill needs:

```text
skills/<skill-name>/
  SKILL.md
  agents/
    openai.yaml
  references/
    <branch-or-domain>.md
  scripts/
    <deterministic-operation>
  assets/
    <template-or-static-input>
  evals/
    cases.json
    fixtures/
```

- `agents/` contains harness metadata, including invocation policy.
- `references/` contains selectively loaded knowledge.
- `scripts/` contains repeatable mechanics with explicit inputs, outputs, and
  failure behavior.
- `assets/` contains templates, schemas, and static production inputs.
- `evals/` contains behavior cases and fixtures.

Do not create empty directories or placeholder files.

## What Belongs in `SKILL.md`

The main file should provide:

- The skill's behavioral contract.
- Invocation rules that affect execution.
- Ordered steps, if the skill has a process.
- Common decisions, constraints, and stopping conditions.
- Conditional pointers to disclosed reference.
- Validation or completion criteria.

Order by runtime importance rather than as a tutorial. A concise main file is a
map and operating contract, not a warehouse for everything known about the
subject.

## Script, Asset, Reference, or Skill?

Choose in this order:

1. Same ordered mechanics every time: **script**.
2. Static material copied or transformed into output: **asset**.
3. Optional knowledge serving the same contract: **reference**.
4. Independently invocable behavior or a distinct contract: **skill**.

A provider branch usually remains a reference when all providers serve one
outcome. Split it when its invocation, contract, owner, or lifecycle is
independent.

## The Cost of Splitting

Each split spends one of two loads:

- A new **model-invoked** skill adds a description to the model's standing
  context. Split only when autonomous reach is worth that context load.
- A new **user-invoked-only** skill adds a command the human must remember. Split
  only when the clearer control is worth that cognitive load.

A user-invoked router can reduce cognitive load once the command set is genuinely
hard to remember. It is not needed for a small list.

## Structural Review

Before publishing, verify:

- Metadata and invocation policy agree across supported harnesses.
- The common contract and path are understandable from `SKILL.md` alone.
- Every disclosed file has a direct, conditional pointer.
- Every step has a checkable completion criterion.
- Universal constraints are not hidden on demand.
- No meaning has multiple sources of truth.
- Deterministic mechanics are scripts rather than prose simulation.
- The main file remains comfortably below 500 lines.
- Evals cover reference selection when progressive disclosure affects behavior.
