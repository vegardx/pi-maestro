# Maestro settings

`/maestro` provides first-class **Execution policy** and **Worker worktrees** screens. Every setting follows the same precedence: session, project, global, then the declared default. Higher-scope arrays replace lower arrays rather than merging.

## Execution policy

The default **Guided** preset uses mode-aware tool guidance, Lightweight isolation, confirmation for consequential actions, dedicated delivery tools, broad apparent GitHub reads, isolated unknown commands, and fail-closed fallback. **Strict** prefers Strong isolation and more confirmation. **Permissive** reduces advisory friction. Setting any individual policy row makes the presentation **Custom** while retaining the preset for unspecified rows.

Isolation choices describe outcomes:

- **Lightweight**: native process-policy isolation.
- **Strong**: the supported VM/container backend.
- **None**: no isolation boundary; Hack remains the explicit direct-execution mode.

Invalid persisted choices never broaden policy; readers use the selected preset's validated default instead.

## Worker worktrees

The Worker worktrees screen covers dependency strategy, package manager detection, shared immutable package caches, fail-visible provisioning, post-setup, explicit ignored assets, repository overrides, and provisioning reports.

Existing keys remain compatible:

- `maestro.worktree.copy` — exact ignored paths copied into a worker checkout.
- `maestro.worktree.setup` — executable and arguments run after provisioning (not shell syntax).
- `maestro.worktree.link` — explicit shared paths; links create shared mutable state.

Defaults do not copy all ignored files or implicitly link dependency trees.

## Scripting

The same values are available to `get`, `set`, `reset`, and `show`:

```text
/maestro get modes.execution.isolation
/maestro set --project modes.execution.preset strict
/maestro set --project maestro.worktree.copy [".env.local","fixtures/cache"]
/maestro reset --project modes.execution.isolation
```

Choice values are completed from declarations. String lists round-trip as JSON arrays and display as ordered values.
