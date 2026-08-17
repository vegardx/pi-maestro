# Skill Evaluation

Use this reference to design evals for routing, invocation policy, task outcomes,
and retirement.

## Match the Invocation Mode

For a **model-invoked** skill, evaluate:

- Positive routing recall.
- Neighboring-negative routing specificity.
- Task outcomes after selection.

For a **user-invoked-only** skill, explicitly invoke it in every behavior case
and add policy checks that implicit invocation is disabled in each supported
harness. Ordinary uninvoked prompts are not negative routing cases for that
skill.

## Start Small

Begin with 10–20 prompts:

| Group | Suggested count | Purpose |
| --- | ---: | --- |
| Clear positive routing | 5 | Model-invoked skills only |
| Neighboring negative routing | 5 | Detect topic collisions |
| Short or ambiguous | 2–5 | Exercise realistic wording |
| Outcome regressions | 2–5 | Protect the behavioral delta |

For user-invoked-only skills, replace routing groups with varied explicit uses
and harness policy checks. Add sanitized production traces as they become
available.

## Case Shape

A harness-neutral JSON case can look like:

```json
{
  "id": "positive-001",
  "category": "positive-routing",
  "prompt": "Review this SKILL.md description for false positives.",
  "should_trigger": true,
  "expected_outcomes": [
    "Identifies neighboring requests that should not trigger",
    "Proposes negative routing cases"
  ]
}
```

Useful optional fields include `workspace`, `startup`, `model`, `harness`,
`validators`, `forbidden_outcomes`, and `source`. Never store secrets or
unsanitized customer traces in fixtures.

## Validate Outcomes Cheaply

Prefer the cheapest validator that measures the contract:

1. Parse or compile the artifact.
2. Run focused tests or policy checks.
3. Check required structured fields.
4. Check forbidden legacy or unsafe patterns.
5. Use narrow regex for textual invariants.
6. Use an LLM judge only for semantic quality the earlier checks cannot measure.

An LLM judge needs observable criteria, structured output, and calibration
against human-labeled examples. Inspect both its passes and failures.

## Isolate and Repeat

- Start each trial in a fresh workspace and conversation.
- Expose only the skills intended for that condition.
- Prevent access to previous outputs and hidden answer files.
- Keep fixtures and tool permissions equal across conditions.
- Run 3–6 trials per case; increase this near a release threshold.
- Preserve raw outputs and validator evidence.
- Test the models and harnesses used in practice.

## Run Ablations

At minimum compare:

| Condition | Purpose |
| --- | --- |
| Candidate skill enabled | Measure current behavior |
| Skill disabled | Establish the model and harness baseline |

For important changes, also compare the previous released skill. Separate
routing changes from body changes when diagnosing regressions.

Report:

- Task success by condition.
- Routing recall and specificity, or explicit-invocation policy compliance.
- Per-case repeated-trial reliability.
- Regressions and improvements.
- Token, latency, or tool-call changes where available.
- Model and harness versions.

Define risk-appropriate thresholds before running the suite rather than choosing
a threshold after seeing results.

## Evolve and Retire

For each behavior change:

1. Add or identify a case demonstrating the problem.
2. Run it with and without the skill before editing.
3. Make the smallest change supported by the trace.
4. Run the complete repeated suite.
5. Merge only with explained improvements and accepted regressions.

Capability skills should be ablated periodically. Retire one when the no-skill
condition matches it reliably across required models and harnesses. Keep its
evals as regression tests. Preference and safety skills may remain when raw task
success is equal if they still improve compliance with their explicit contract.
