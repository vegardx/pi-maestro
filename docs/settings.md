# Maestro settings

`/maestro` provides first-class **Execution policy** and **Worker worktrees** screens. Only settings consumed by the current runtime are exposed. Every setting follows the same precedence: session, project, global, then the declared default. Higher-scope arrays replace lower arrays rather than merging.

## Execution policy

The default **Guided** preset uses mode-aware tool guidance, Lightweight isolation, confirmation for consequential actions, dedicated delivery tools, broad apparent GitHub reads, isolated unknown commands, and fail-closed fallback. **Strict** protects Recon/Plan with Strong isolation and confirms more mutations. **Permissive** reduces advisory friction. Setting any individual policy row makes the presentation **Custom** while retaining the preset for unspecified rows.

Isolation choices describe outcomes:

- **Lightweight**: native process-policy isolation when a backend is installed.
- **Strong**: a VM/container route when a backend is installed.
- **None**: no isolation boundary; Hack remains the explicit direct-execution mode.

Invalid persisted choices never broaden policy; readers use the selected preset's validated default instead.

## Worker worktrees

The Worker worktrees screen exposes the currently implemented provisioning controls: post-setup and explicit copy/link paths.

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

Until a selected isolation backend is available, protected Bash routes fail closed with an actionable diagnostic; they never silently execute on the host.
