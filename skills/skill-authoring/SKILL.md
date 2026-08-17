---
name: skill-authoring
description: Design, write, review, evaluate, and retire predictable Agent Skills.
license: MIT
disable-model-invocation: true
---

# Skill Authoring

A skill makes a stochastic agent's **process** more predictable; it does not need
to make every output identical. Every instruction, split, and reference should
serve that predictability.

This is user-invoked only. The human chooses when to run `/skill-authoring`; do
not design its description for automatic routing.

Use the references selectively:

- Before drafting or changing a skill's role, classify it with
  [references/taxonomy.md](references/taxonomy.md).
- When deciding what belongs in `SKILL.md`, another file, or another skill, read
  [references/structure.md](references/structure.md).
- When adding or reviewing behavior tests, read
  [references/evaluation.md](references/evaluation.md). Starter cases for this
  skill are in [evals/cases.json](evals/cases.json).

## Classify the Skill

Record these independent dimensions before drafting:

```text
Operator: agents-we-use | agents-we-build
Purpose: capability | preference | mixed
Invocation: model-invoked | user-invoked-only
Execution: judgment | deterministic-script | skill-plus-script
Behavioral delta: <what changes because the skill exists>
Owner/source of truth: <who keeps it current>
Retirement signal: <evidence that permits removal>
```

- **Agents we use** have informed operators who can invoke a named workflow or
  recover from a routing miss. **Agents we build** serve users who normally do
  not know the skill catalog, so ordinary-language routing is part of the
  product.
- A **capability skill** fills a current model or harness gap. Ablate it
  regularly and retire it when the baseline catches up.
- A **preference skill** encodes deliberate local policy. Evaluate preference
  compliance and retain it while that policy remains intentional.
- Separate mixed content when its triggers, owners, evals, or lifecycles differ.
- Put invariant mechanics in a script. Keep a skill only for judgment, context,
  constraints, invocation, or interpreting results.

Do not create a skill without a meaningful behavioral delta.

## Choose Invocation Deliberately

Invocation trades model context against human memory:

- **Model-invoked:** the description is always-visible routing context. Use it
  when the model must discover the skill from an ordinary request or another
  skill must reach it.
- **User-invoked only:** the human remembers and selects the skill. Use it for
  deliberate modes and named workflows where automatic loading adds surprise or
  irrelevant context.

For model-invoked skills, write the description as compact routing code:

```yaml
description: >
  Use when <task verbs and trigger context>, including <artifacts, extensions,
  tools, and distinct branches>. Covers <behavior>. Do not use for <neighbors>.
```

Use one trigger per genuinely different branch; synonyms for the same branch are
duplication. For user-invoked-only skills, write a one-line human-facing summary
and disable implicit invocation in every supported harness.

If user-invoked skills become hard to remember, consider one user-invoked router
that explains which command fits each situation. Do not add a router for a list
small enough to scan directly.

## Build an Information Hierarchy

Skills contain two kinds of content: **steps** the agent performs and
**reference** it consults. Either kind may stand alone.

Arrange them by immediacy:

1. Put ordered actions in `SKILL.md`. End each meaningful step with a checkable
   completion criterion so the agent knows when it is genuinely done.
2. Keep rules and facts needed by every run in `SKILL.md`, co-located with their
   caveats.
3. Move branch-specific reference behind a conditional pointer to a directly
   linked file.

Inline what every branch needs. Disclose what only some branches need. The
pointer must say **when** to load the target; “see references” is not enough.
Keep critical safety constraints in the main file, avoid chains of references,
and maintain one source of truth for each rule.

Split into another skill only when the content needs independent invocation or a
long visible sequence causes the agent to rush earlier work. Do not split merely
because another file looks tidy: every model-invoked split adds context load,
and every user-invoked split adds something the human must remember.

## Write for Behavior

- Use directives, goals, constraints, and stopping conditions instead of essays.
- Preserve agent freedom where several approaches can satisfy the contract.
- Prefer positive target behavior. Keep a prohibition only for a hard guardrail,
  and pair it with what the agent should do instead.
- Use examples to distinguish decisions, not to repeat prose.
- Mark opinionated defaults as opinions rather than universal facts.
- Use compact domain terms consistently when they sharpen both invocation and
  execution; define unfamiliar terms once.

## Prune Aggressively

Review sentence by sentence:

- **No-op:** remove guidance the base model already follows, such as “write
  high-quality code,” unless an eval proves it changes behavior.
- **Duplication:** keep each meaning in one authoritative place.
- **Sediment:** remove stale guidance instead of continually adding exceptions.
- **Sprawl:** disclose branch-specific reference or split a genuinely independent
  branch; keep the main file comfortably below 500 lines.
- **Negation:** replace attention-grabbing bans with the positive target when
  possible.

## Evaluate the Contract

Start with 10–20 cases and run 3–6 isolated trials per case.

For model-invoked skills, measure routing and outcomes separately. Include at
least five positive prompts, five neighboring negative prompts, and short or
ambiguous real-world wording. For user-invoked-only skills, invoke them
explicitly and verify as a policy check that implicit invocation is disabled.

- Prefer parsers, tests, commands, structured checks, and narrow regex before an
  LLM judge.
- Judge task outcomes rather than requiring one internal path.
- Compare skill-enabled and skill-disabled runs.
- Test the models and harnesses used in practice.
- Add every production failure that changes the skill as a regression case.
- Report success, repeated-trial reliability, selection-policy compliance, and
  cost rather than saying only that the skill was tested.

A capability skill must improve the no-skill baseline. A preference skill may
remain valuable with equal raw task success when it measurably improves policy
compliance.

## Finish

Before publishing, confirm:

- Classification, invocation metadata, description, and evals agree.
- The common contract is understandable from `SKILL.md` alone.
- Every disclosed file has a direct conditional pointer.
- Every step has a meaningful completion criterion.
- No required constraint is hidden and no rule has two sources of truth.
- Links, frontmatter, scripts, examples, and eval data validate.

In this repository, run:

```bash
gh skill publish --dry-run
```

Retain evals after retiring a capability skill so a future regression can justify
bringing it back.
