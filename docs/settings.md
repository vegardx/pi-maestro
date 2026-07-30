# Maestro settings

`/maestro` combines exact agent-domain configuration with extension-declared scalar settings. Interactive and scripted surfaces read the same normalized values and write through atomic file replacement.

The interactive menu edits model families and aliases, rosters and their tiers, seat bindings, per-agent allowances, the region list, the policy table, and declared scalar settings.

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

The current `/model` selects the seat; a binding maps that seat to a roster. Configure:

- `models.families.<Family>.aliases.<Alias>` — ordered `attach` list of exact `provider/model` refs, plus effort and notes;
- `models.rosters.<id>.<light|standard|heavy>` — ordered `"Family/Alias"` refs per tier;
- `models.bindings.<id>` — `{ roster, targets? }`; a binding without `targets` is the default seat;
- `models.allowances.<agent>` — which tiers that agent type may request, and `spread` for multi-model fan-out;
- `models.region` — `{ active, lists }`; the one hard filter, applied before any other reasoning.

**Declared but read by nothing.** `agents.kinds.<kind>.runtimePolicy`,
`agents.runtimePolicies.<id>` and `transitionGates.<id>` still exist in the
settings domain and can still be set — and setting them does nothing. Their only
reader was `packages/modes`, which is deleted; grep finds them today in the
settings UI and a type declaration, nowhere else. They are listed here because a
key you can set and validate but which has no effect is worse undocumented than
documented, and they should be removed from the domain.

Domain writes require valid JSON and validate references before persistence. Unsafe runtime combinations, unknown tiers, malformed alias refs, unknown contracts, and invalid transition edges fail closed. See [Models](models.md).

## Execution policy

The Execution policy screen exposes:

- preset: Guided, Strict, or Permissive;
- mode-aware tool guidance and mode routes;
- Lightweight, Strong, or None isolation;
- dedicated delivery actions;
- consequential-action confirmation;
- privileged remote and GitHub-read behavior;
- unknown-command routing.

Two rows are declared and read by nothing: `delivery` and `fallback`. The
classifier never consults either. `modes.execution.stopGraceMs` is documented in
older copies of this file and does not exist at all — it is not one of the keys
`readExecutionPolicySettings` accepts, so setting it did nothing, silently.

Setting an individual row makes the effective presentation Custom while preserving preset defaults for unspecified rows. Invalid persisted choices never broaden access.

Isolation outcome:

**Confinement is ambient, not a destination.** Every route that runs at all runs
through the actor's write profile, enforced by the OS. `lightweight` is not a
place a command is sent — it is the confinement everything already gets. Only
`strong` is a separate mechanism (its own filesystem and network), and with no
backend for it a command routed there is refused rather than run.

A refusal never falls back to an unconfined shell, including when the sandbox
cannot start because its own dependencies are missing — it says what to install
instead. `MAESTRO_SANDBOX=off` disables enforcement, and
`MAESTRO_SANDBOX_SHADOW=<file>` logs what would have been confined without
confining it.

Agents are non-interactive: a command needing a human is refused with the
reason, because prompting into a void is how a fleet hangs.

## Worktrees and lifecycle

`maestro.worktree.*` controls provisioning:

- `copy` — exact ignored relative paths copied into a worker checkout;
- `link` — explicit shared paths (shared mutable state);
- `setup` — executable plus arguments after provisioning, not shell syntax.

No setting implicitly copies every ignored file or links dependency directories.

Other scalar groups include distill thresholds, compaction timeout, and research stall/soft/hard watchdog deadlines. Use `/maestro show` and the interactive group list for current declarations.

## Cutover

Only current keys are accepted; there is no migration path. `models.presets` and `models.modelSets` — the v1 surface — are **rejected** rather than silently accepted, because they were validated and persisted long after the resolver stopped reading them, so a write appeared to succeed and did nothing. Archive the old settings file, remove unsupported keys, and author families/rosters/bindings instead. Plan/run/session schemas likewise require explicit archive or reset; see [Plan state](commands.md#plan-state).
