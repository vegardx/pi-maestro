# Models and exact presets

Maestro resolves every assignment to one immutable model/effort pair before execution. Semantic kind says **what** the agent does; runtime policy says **how** it runs; the model preset says **which exact option** it uses.

## Unconfigured fallback

With no applicable preset/model-set binding, a role has exactly one built-in option:

```text
presetId=session · modelSetId=session · optionId=session
model=<current /model selection> · effort=medium
```

No live session model means resolution fails. This fallback keeps a fresh install usable; it is not appended to a configured set.

## Configuration

Global and project settings use `models.modelSets` and `models.presets`:

```json
{
  "models": {
    "modelSets": {
      "workers": {
        "options": [
          {
            "id": "primary",
            "model": "anthropic/claude-sonnet-4-5",
            "effort": "high",
            "summary": "Primary implementation model"
          }
        ]
      },
      "reviews": {
        "options": [
          {
            "id": "deep",
            "model": "openai/gpt-5.5",
            "effort": "high",
            "summary": "Independent review"
          }
        ]
      }
    },
    "presets": {
      "release": {
        "targets": ["anthropic/claude-sonnet-4-5"],
        "modelSets": {
          "worker": "workers",
          "plan-review": "reviews",
          "correctness-review": "reviews",
          "security-review": "reviews",
          "verifier": "reviews"
        }
      }
    }
  }
}
```

The current `/model` id activates the unique preset whose `targets` contains it. Target overlap is invalid. Global and project presets layer by preset id; project targets replace global targets when present, and model-set role bindings override individually. Model sets are replaced by id.

An option is one exact `provider/model` (or the `session` sentinel), one effort, stable option id, and human summary. Order is policy: the first registered, authenticated, effort-compatible option is the default. Candidate facts expose registry, authentication, supported-effort, availability, and rejection reason.

## Persistence and no substitution

`workflow` resolves assignments while planning and persists:

- `presetId`, `modelSetId`, `optionId`;
- concrete `modelId` and effort;
- source (`preset`, `explicit`, or `session`) and timestamp;
- semantic kind, runtime policy, focus/rationale, and contracts.

At spawn/resume, Maestro validates that exact assignment against the active preset, authored option, registry, authentication, and supported effort. If any part changed or became unavailable, execution fails visibly. It never falls through to a different option.

Duplicate semantic kinds are allowed: two correctness reviewers, for example, have unique assignment ids and may select independent exact models. Duplicate assertions later merge into one canonical finding while preserving provenance.

## Roles

Stable model policy keys include worker, classifier, plan/compact summarizer, verifier, general, codebase/web research, plan review, and practical/adversarial/correctness/security/test/simplification review. A preset may bind any subset; an unbound role uses the session fallback described above.

## Inspect and edit

```text
/maestro show
/maestro explain security-review
/maestro get models.presets.release.targets
/maestro set --project models.modelSets.reviews {"options":[...]}
/maestro set --project models.presets.release.modelSets {"security-review":"reviews"}
/maestro reset --project models.presets.release.modelSets
/maestro validate
```

`explain` reports the active preset/set, candidates, and exact selected option. Domain edits are JSON and are validated before atomic settings replacement. The old `models.profiles` key and broad role-pool configuration are unsupported; load fails with a cutover error rather than translating them.
