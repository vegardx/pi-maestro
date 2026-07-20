# Maestro settings

`/maestro` combines exact agent-domain configuration with extension-declared scalar settings. Interactive and scripted surfaces read the same normalized values and write through atomic file replacement.

The interactive menu shows the v2 sections only: profiles and catalogs, agent tiers, the policy table, and residency. The v1 preset/model-set screens are removed — the v1→v2 migration derives catalogs/profiles automatically, and a one-line pointer says so when legacy keys are still present. The v1 keys themselves stay readable and scriptable (`/maestro get|set|reset models.presets.… models.modelSets.…`) because fallback resolution still reads them.

## Scopes

Precedence is **session → project → global → declared default**.

- Session overrides are process-local and reset at `session_start`/`session_shutdown`.
- Project values live in `.pi/settings.json`.
- Global values live in the pi agent settings file.
- Arrays replace lower-scope arrays; they do not merge.

Scripted commands default to session scope:

```text
/maestro show
/maestro get modes.execution.isolation
/maestro set --project modes.execution.preset strict
/maestro reset --project modes.execution.isolation
/maestro explain correctness-review
/maestro validate
```

## Agent-domain configuration

The current `/model` activates an exact preset. Configure:

- `models.modelSets.<id>` — ordered exact model/effort options;
- `models.presets.<id>.targets` — exact `/model` ids, unique across presets;
- `models.presets.<id>.modelSets` — model-role → set id;
- `agents.kinds.<kind>.modelSet|option|runtimePolicy` — optional kind binding;
- `agents.runtimePolicies.<id>` — permission/session/transport composition;
- `transitionGates.<id>` — exact edges, agent kind, output contract, enabled flag.

Domain writes require valid JSON and validate references before persistence. Unsafe runtime combinations, unknown model sets/options/contracts, overlapping targets, and invalid transition edges fail closed. See [Models and exact presets](models.md).

## Execution policy

The Execution policy screen exposes:

- preset: Guided, Strict, or Permissive;
- mode-aware tool guidance and mode routes;
- Lightweight, Strong, or None isolation;
- dedicated delivery actions;
- consequential-action confirmation;
- privileged remote and GitHub-read behavior;
- unknown-command routing;
- unavailable-isolation fallback; and
- the fleet-wide cooperative stop grace (`modes.execution.stopGraceMs`, default 5000 ms).

Setting an individual row makes the effective presentation Custom while preserving preset defaults for unspecified rows. Invalid persisted choices never broaden access.

Isolation outcome:

- **Lightweight** uses an installed process-policy backend and private research workspace.
- **Strong** uses the installed VM/container backend.
- **None** has no sandbox boundary; Hack remains the explicit direct posture.

A protected Bash route never silently falls back. For the maestro, a configured `confirm` fallback can present a downgrade decision. Workers/reviewers are non-interactive: backend or approval failure returns a bounded `BashRoutingError` with retry guidance and never calls `ui.select` or `ui.confirm`.

## Worktrees and lifecycle

`maestro.worktree.*` controls provisioning:

- `copy` — exact ignored relative paths copied into a worker checkout;
- `link` — explicit shared paths (shared mutable state);
- `setup` — executable plus arguments after provisioning, not shell syntax.

No setting implicitly copies every ignored file or links dependency directories.

Other scalar groups include distill thresholds, compaction timeout, and research stall/soft/hard watchdog deadlines. Use `/maestro show` and the interactive group list for current declarations.

## Cutover

Only current keys are accepted. `models.profiles`, broad role configuration, and removed runtime review configuration are not migrated. Archive the old settings file, remove unsupported keys, and author exact model sets/presets. Plan/run/session schemas likewise require explicit archive or reset; see [Reset and archive](commands.md#reset-and-archive).
