# Models and exact presets

Maestro resolves every agent assignment to one immutable model/effort pair before execution. There are no broad role pools or runtime substitution paths.

## Configuration

Use the `workflow` tool to compose immutable typed assignments and explicit parallel stage DAGs.

```json
{
  "models": {
    "modelSets": {
      "workers": {
        "options": [
          { "id": "primary", "model": "anthropic/claude-sonnet-4-5", "effort": "high", "summary": "Primary implementation model" }
        ]
      },
      "reviews": {
        "options": [
          { "id": "deep", "model": "openai/gpt-5.5", "effort": "high", "summary": "Independent review" }
        ]
      }
    },
    "presets": {
      "default": {
        "targets": ["anthropic/claude-sonnet-4-5"],
        "modelSets": {
          "worker": "workers",
          "correctness-review": "reviews",
          "plan-review": "reviews"
        }
      }
    }
  }
}
```

Configured sets never gain an implicit fallback. A persisted assignment must still match its preset, set, option, model, effort, registry entry, authentication, and supported effort; otherwise execution fails visibly. An installation with no preset uses the current session model as its explicit built-in option.

Use `/maestro show`, `/maestro explain <role>`, and exact domain keys under `models.modelSets.*` and `models.presets.*`. Old `models.profiles` configuration is unsupported and fails with a cutover error.
