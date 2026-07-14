# Models & settings

## Role pools

Every model-consuming runtime resolves through a curated **role**. Each active
profile contains ordered allowlists of exact `provider/model` IDs and thinking
efforts. The first available compatible entry is the default.

Roles are: `worker`, `reviewer`, `research`, `advisor`, `classifier`,
`plan-summarizer`, `compact-summarizer`, `verifier`, and `delegate`.

- Workers and support agents use `worker`.
- Review personas and the scope-locked fix verifier use `reviewer`.
- Codebase/web research uses `research`; advisor/consult uses `advisor`.
- Bash classification, modes summaries, smart compaction, `/verify`, and general
  subagents use their corresponding roles.
- Explicit choices are exact: they must be in the active pool, available,
  authenticated, allowed by the effort pool, and supported by the model.
- Omitted choices walk configured models in order, then use the live session
  model when compatible.

## Profiles

A profile owns a set of `/model` targets and direct role pools:

```jsonc
{
  "models": {
    "profiles": {
      "opus": {
        "targets": ["anthropic/claude-opus-4-8"],
        "roles": {
          "worker": {
            "models": ["anthropic/claude-sonnet-4-6"],
            "efforts": ["high", "medium"]
          },
          "reviewer": {
            "models": ["openai/gpt-5.5", "anthropic/claude-opus-4-8"],
            "efforts": ["high", "xhigh"]
          },
          "research": {
            "models": ["anthropic/claude-haiku-4-5"],
            "efforts": ["low"]
          }
        }
      }
    }
  }
}
```

- **Activation is derived, not stored.** `/model` selects the profile whose
  `targets` contains the live exact model ID.
- **Targets are exclusive.** A model should belong to at most one profile.
- **Arrays are ordered leaf values.** Project `models` or `efforts` arrays
  replace the corresponding global array; they do not concatenate.
- **Missing role leaves inherit the live session model.**
- **Explicit model/effort selections fail visibly.** They are never silently
  substituted or downgraded.
- **Spend rule:** prefer raising effort before selecting a second model. A
  repeated review persona may use at most two distinct models and requires a
  justification for the cross-model duplicate.

Edit profiles with `/maestro`. Session-local role leaves override project and
global leaves for the active host session; resolved choices are passed exactly
to children rather than inherited through process globals.

## Settings reference

All extension settings are layered project over global and read fresh.

### `modes.distill` — the context-fill ladder {#distill}

| Key | Default | Meaning |
|---|---|---|
| `nudgeAt` | `0.3` | Context fill fraction where a non-blocking question suggests `/distill` |
| `forceAt` | `0.5` | Fraction where self-curated distillation runs; `0` disables it |

### `modes.compaction` — work-continuity compaction

| Key | Default | Meaning |
|---|---|---|
| `phaseTokens` | `10000` | Max output tokens per new raw-slice summary section |
| `workingTokens` | `150000` | Working-bucket budget that drives the trigger |
| `summaryTokens` | `100000` | Soft warning threshold for stable summary burden |
| `timeoutMs` | `90000` | Deadline for a modes-triggered compaction |
| `planMaxContextTokens` | unset | Optional context-window size for plan-mode footer display |

### Feature flags

- `PI_EXT_<NAME>=on|off` enables/disables an extension.
- `PI_DISABLE="a.b,c.d"` / `PI_ENABLE="a.b"` flips feature paths; disable wins.

### Debugging

`MAESTRO_UI_TRACE=1` (or a file path) appends overlay/widget lifecycle events.

<!-- verified against role-pool-runtime -->
