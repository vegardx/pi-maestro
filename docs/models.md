# Models & settings

## The tier model

Every background agent resolves its model through one of four **tiers**,
named by intent:

```
plan   — the maestro reasons and plans here. ALWAYS the session model (/model).
work   — workers implement here.
review — reviewers + advisor run here (cross-model second opinion).
fast   — cheap mechanical subagents (classify, scout, quick research).
```

Role → tier is a fixed table:

| Role | Tier |
|---|---|
| maestro | plan |
| worker | work |
| analyze | work |
| reviewer, advisor | review |
| research, classifier, summarizer | fast |

The planner never picks models — it picks personas, `required` flags, and
effort. Which model a tier means is the profile's business.

## Profiles

A **profile** owns a set of `/model` targets and pins the `work` / `review`
/ `fast` tiers (`plan` is implicit — whichever target is live):

```jsonc
// settings.json → models
{
  "profiles": {
    "opus": {
      "targets": ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-7"],
      "work":   {},                                                    // {} = track plan
      "review": { "model": "openai/gpt-5.5", "effort": "high" },
      "fast":   { "model": "anthropic/claude-haiku-4-5", "effort": "low" }
    }
  }
}
```

- **Activation is derived, not stored.** The active profile is the one
  whose `targets` include the current session model. There is no `active`
  key — `/model` *is* the switch.
- **Targets are an exclusive partition.** Each model belongs to at most one
  profile.
- **`{}` means "track plan".** A tier without a pinned model uses the live
  session model. A profile with every tier `{}` is identical to having no
  profile at all — that's the zero-config default.
- **Effort is a per-tier dial.** For adaptive models it's a steer; for
  fixed-thinking models it's a budget.

Edit all of this interactively with `/maestro`, which seeds a default
profile (single target = your session model, all tiers tracking plan) on
first open.

## Escape hatches

Resolution priority per role: explicit override → environment → per-role
settings → tier via the active profile → session model.

- Per-role pin (the `/maestro` menu does not write these):
  `extensionConfig.modes.models.<role>.{model, effort}` for roles `agent`,
  `analyze`, `classifier`; `extensionConfig.smart-compact.models.summarizer.*`.
- Environment: `MAESTRO_AGENT_MODEL` / `MAESTRO_AGENT_THINKING`,
  `MAESTRO_ANALYZE_MODEL` / `MAESTRO_ANALYZE_THINKING`,
  `MAESTRO_CLASSIFIER_MODEL` / `MAESTRO_CLASSIFIER_THINKING`.

## Settings reference

All keys live under `extensionConfig.<extension>` in layered settings
(project overrides global; read fresh, no restart needed).

### `modes.distill` — the context-fill ladder {#distill}

| Key | Default | Meaning |
|---|---|---|
| `nudgeAt` | `0.3` | Context fill fraction where a non-blocking question suggests `/distill` |
| `forceAt` | `0.5` | Fraction where a self-curated distill runs automatically (with a divergence check that suggests `/handoff` instead when the session has drifted); `0` disables the force |

### `modes.compaction` — work-continuity compaction

| Key | Default | Meaning |
|---|---|---|
| `phaseTokens` | `10000` | Max output tokens per new raw-slice summary section |
| `workingTokens` | `150000` | Budget for the working bucket; drives the trigger |
| `summaryTokens` | `100000` | Soft warning threshold for the stable summary burden |
| `timeoutMs` | `90000` | Deadline for a modes-triggered compaction |
| `planMaxContextTokens` | unset | Context-window size for the plan-mode footer display |

These are independent of pi's native `compaction.*` and of
`extensionConfig.smart-compact.*`.

### Feature flags (environment)

- `PI_EXT_<NAME>=on|off` — enable/disable a whole extension
  (e.g. `PI_EXT_MODES=off`, `PI_EXT_SMART_COMPACT=off`).
- `PI_DISABLE="a.b,c.d"` / `PI_ENABLE="a.b"` — flip single feature paths;
  the kill switch (`PI_DISABLE`) wins.

### Debugging (environment)

- `MAESTRO_UI_TRACE=1` (or a file path) — append timestamped overlay/widget
  lifecycle events to a log (`1` → `$TMPDIR/maestro-ui-trace.log`). Use when
  chasing UI flicker: a healthy session shows sparse mounts/unmounts; a bug
  shows the same key cycling many times per second.

<!-- verified against 83bfcbe -->
