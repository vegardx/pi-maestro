# Models

Pi-maestro currently resolves models for two in-process support calls:

```text
classifier          fast Bash effect assessment
compact-summarizer  work-continuity compaction
```

Delegated workers, workflow reviews, fixers, and publication do not resolve
through this package. Standalone `@vegardx/pi-subagent` owns delegated model
selection, and standalone `@vegardx/pi-workflow` binds workflow-stage models
explicitly.

## Configuration vocabulary

| Layer | Purpose |
| --- | --- |
| families → aliases → attachments | Group equivalent concrete `provider/model` endpoints |
| rosters → tiers | Order aliases for `light`, `standard`, and `heavy` work |
| bindings | Select a roster from the current seat model |
| allowances | Bound the tiers a named support persona may request |
| region | Exclude concrete models outside the active residency list |

The current harness roles map to the `codebase-research` support persona, whose
default allowance is:

```json
{
  "tiers": ["light", "standard"]
}
```

The Bash classifier explicitly requests `light`. Smart compact uses the
persona's default tier. An exact classifier model may be configured under
`extensionConfig.maestro.bash.auditor.model`.

## Resolution

For a requested tier:

1. Find the binding whose targets include the current seat model, or use the
   default binding.
2. Walk that binding's roster entries for the tier in authored order.
3. Resolve each `Family/Alias` to an available concrete attachment.
4. Prefer an attachment on the seat's provider, then fall back to attachment
   order.
5. Apply the active region list and authentication availability.
6. If no tier candidate is available, visibly fall back to the seat model.

This is why the Luna alias can contain both:

```json
{
  "attach": [
    "github-copilot/gpt-5.6-luna",
    "radicalai-sit/gpt-5.6-luna-global"
  ]
}
```

A Copilot seat prefers the Copilot attachment; a Radical AI SIT seat prefers the
SIT attachment.

Provider-aware calls execute through `ctx.modelRegistry.complete`, so providers
with refreshable authentication such as GitHub Copilot use Pi's normal runtime
rather than a cached compatibility token.

## Authored plans

Stored plans may record a concrete `provider/model` for delegated review intent.
Pi-maestro validates and stores that intent but does not resolve or execute it.
The owned workflow implementation will define how authored review models become
runtime stage bindings.

## The package boundary

Resolution lives in the standalone `@vegardx/pi-models` package
(`packages/models`), which has no dependency on Pi. Everything it needs from a
host is one injected port:

```ts
{ findModel(provider, id), isAuthenticated(provider), registeredProviders() }
```

`createModelRouter(config, port)` returns the router: `resolveForRole`,
`resolveOtherFamily`, `resolveFamily`, `resolveMany`, `explain`, and
`isAuthorized` (the revalidation a stored resolution is re-checked against, so a
persisted pick is re-used rather than re-rolled). The router is synchronous and
reads no files, so the same config, seat and port always produce the same
`ModelResolution` — which is what lets a caller hash one into a task identity.

`packages/maestro/src/model-router.ts` is the Pi adapter: it reads the merged
settings slice through `SettingsManager`, builds the port from
`ctx.modelRegistry`, and turns a resolved `provider/model` back into a registry
model plus credentials for the in-process callers that `complete()` directly.

## Settings ownership

Model settings use Pi's normal global and project `settings.json` files. Project
values override global values at the leaf. Pi-maestro has no separate model
settings command or editor.
