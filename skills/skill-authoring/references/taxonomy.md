# Skill Taxonomy

Classify a skill along independent dimensions. The classification determines its
invocation, evals, owner, and retirement criteria.

## Operator Context

### Agents We Use

Coding and productivity agents are operated by people who know skills exist. The
operator can notice a miss, retry, or invoke a named workflow.

Implications:

- User invocation is practical for deliberate workflows.
- A routing miss is visible and recoverable.
- Balance model context load against commands the operator must remember.

### Agents We Build

Product agents serve customers who do not know the internal skill catalog. A
customer asks for a refund, not for the `refund` skill.

Implications:

- The model normally selects capabilities from ordinary language.
- Description quality is product behavior.
- Routing evals need shallow, ambiguous, realistic customer prompts.
- Do not expect users to repair routing with a skill command.

This dimension describes who operates the agent, not what the skill teaches.

## Purpose

### Capability Skill

A capability skill compensates for something the current model or harness cannot
do consistently, such as a newly released API or unfamiliar artifact format.

- Measure task success against the no-skill baseline.
- Check obsolete APIs and forbidden legacy patterns.
- Re-evaluate after model, tool, and platform updates.
- Retire it when the baseline catches up.

Keep changing, version-specific facts in selective references and link current
primary sources where freshness matters.

### Preference Skill

A preference skill encodes conventions the model cannot infer because they
belong to a team, company, product, or domain.

- Evaluate compliance, not just raw task validity.
- Name the owner or source of truth.
- Distinguish requirements from opinionated defaults.
- Retain it while the preference remains intentional.

A model becoming better at the task is not, by itself, a reason to retire local
policy.

### Mixed Skill

A skill may combine missing capability and local preference. Classify and
evaluate the parts separately. Split them when triggers, owners, or retirement
lifecycles differ; otherwise label the boundary so retiring temporary capability
scaffolding cannot remove durable policy accidentally.

## Invocation

### Model-Invoked

The model can select the skill from an ordinary request and its metadata; the
human can still invoke it explicitly. This means model-and-user reachable, not
model-only.

Use it when:

- Users cannot reasonably know the skill exists.
- Observable task context predicts the need.
- Another skill must reach it.

The description is always-visible routing context. Name distinct trigger
branches, artifacts, tools, task verbs, and neighboring negative cases. Evaluate
routing separately from task success.

### User-Invoked Only

Only the human deliberately selects the named skill or command.

Use it when:

- The operator knows and controls the workflow.
- The skill represents a deliberate mode or review.
- Automatic loading would be surprising or waste context.

Use a concise human-facing description. Disable implicit invocation in every
supported harness. Evaluate explicit use and the invocation policy rather than
ordinary prompt routing.

## Execution

### Judgment

Use a skill when the agent must interpret context, select among valid paths,
apply reusable constraints, or combine domain guidance with the task. Define
outcomes and bounds while preserving appropriate freedom.

### Deterministic Mechanics

Use a script when the same ordered operation should run every time. A thin skill
may still decide when to run it, collect inputs, enforce safety boundaries, and
interpret results.

## Classification Card

```text
Operator: agents-we-use | agents-we-build
Purpose: capability | preference | mixed
Invocation: model-invoked | user-invoked-only
Execution: judgment | deterministic-script | skill-plus-script
Behavioral delta: <what changes because this exists>
Owner/source of truth: <who keeps it current>
Retirement signal: <what evidence permits removal>
```

Examples:

| Skill | Operator | Purpose | Invocation | Execution |
| --- | --- | --- | --- | --- |
| New API guidance in a customer agent | Build | Capability | Model-invoked | Judgment |
| Internal Terraform conventions | Use | Preference | Model-invoked | Judgment |
| Prepare a PR using team policy | Use | Preference | User-invoked only | Skill plus script |
| Run twelve invariant release commands | Use | Not a skill by itself | User starts a script | Deterministic script |

## Review

Verify that:

- Operator context explains whether users can recover from routing misses.
- Capability and preference content have distinct success criteria.
- Invocation mode is represented consistently across harnesses.
- Evals match the invocation mode.
- Deterministic mechanics are not prose simulations.
- Capability guidance has an ablation and retirement plan.
- Preference guidance has an owner or source of truth.
