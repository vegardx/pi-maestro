# Models

Pi-maestro resolves models for two in-process support calls:

```text
classifier          fast Bash effect assessment
compact-summarizer  work-continuity compaction
```

It also answers two questions for the delegation packages, over Pi's event bus,
from the same router: which model a pi-workflow task asking for a **tier** runs
on ([the routing provider](#the-routing-provider)), and whether pi-subagent may
launch a task on an exact model at all ([the host fence](#the-host-fence)).
Standalone `@vegardx/pi-subagent` launches every delegated attempt and
standalone `@vegardx/pi-workflow` owns the run; neither imports this package.

## Configuration vocabulary

| Layer | Purpose |
| --- | --- |
| families → aliases → attachments | Group equivalent concrete `provider/model` endpoints |
| rosters → tiers | Order aliases for `fast`, `light`, `normal`, and `frontier` work |
| bindings | Select a roster from the current seat model |
| allowances | Bound the tiers a named support persona may request |
| region | Exclude concrete models outside the active residency list |

The tiers have fixed meanings:

| Tier | For |
| --- | --- |
| `fast` | Narrow mechanical checks and classification; executes, never decides |
| `light` | The default implementer and the in-package review lens |
| `normal` | A crossed boundary, a persisted format, concurrency or security, large input, validating `fast` work |
| `frontier` | Judgement only (adjudication, synthesis); never an implementer, never fanned out |

Built-in allowances, overridable per persona under `models.allowances`. The
first tier is the one a persona resolves at when the caller names none:

| Persona | Tiers | Spread |
| --- | --- | --- |
| `codebase-research` | `light`, `fast`, `normal` | |
| `code-review` | `light`, `normal` | 3 |
| `adjudication` | `frontier`, `normal` | |
| `standby` | `frontier`, `normal` | 2 |
| `deliverable-worker` | none (inherits the seat model) | |

The current harness roles map to the `codebase-research` support persona.

The Bash classifier explicitly requests `fast`. Smart compact explicitly
requests `light`. An exact classifier model may be configured under
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

A plan names a review lens's **tier**, never a model: `light` or `normal`, with
`normal` the default. The router's other two tiers are **refused on a lens by
name** — `fast` executes and never decides, and `frontier` is adjudication and
synthesis only — and the old `standard` and `heavy` are refused as unknown
tiers. pi-workflow refuses the same two tiers at start, so a plan this seat
stores is a plan the run accepts.

A lens may still pin a concrete `provider/model` in `reviews[].model`.
Pi-maestro checks at plan time that this host's registry HAS that model —
existence only, never authentication — and refuses the plan by name with the
registered providers listed when it does not.

## The routing provider

pi-workflow resolves every task that declares a `modelRole` — each review lens
(`code-review` at the lens's tier, `family: "other"` when diverse), the normalize
call and the receipt recorder (`codebase-research` at `light`), and the
adjudicator (`adjudication` at `frontier`, `family: "other"`) — through one
host-registered port, and refuses `plan-to-ship` at start, by name, when no host
registered one. The seat registers its router on
`@vegardx/pi-workflow/model-routing-provider/request/v1` at load, once for the
process (`workflow-routing-provider.ts`), with the id `pi-maestro`:

- `resolve(role)` builds the router from the live session on every call and asks
  `resolveForRole(persona, {tier, effort, family})`, with the session's own model
  and thinking level as the caller it inherits from. A role naming no effort
  prefers the seat's thinking level, clamped to the alias and the model. The
  answer's thinking level is clamped once more to the levels Pi runs the
  resolved model at, so the fence below admits it. A role the router cannot
  answer — a tier outside the persona's allowance, no roster configured — is
  refused with a `ModelRoutingError`. The answer carries the tier the router
  actually reached, the family, the alias and any `fallbackReason`, cut to
  pi-workflow's bounds (128 characters; 1024 for the reason).
- `authorized(model)` is `isAuthorized`: still registered, authenticated and in
  region. A replay that lost the model fails its task by name.

`family: "other"` walks the persona's whole allowance for a family other than the
seat's, so it may reach a different tier than the one asked; the evidence
records the tier reached. With nowhere to go it inherits the seat, with a
`fallbackReason`.

## The host fence

Every builtin pi-workflow template lists `host` in `allowedModels` and names no
model of its own, and pi-workflow sends every task's model as an exact model —
the inherited session model included. The seat registers pi-subagent's
model-admission provider at load (`registerModelAdmissionFor`), and pi-subagent
asks it whenever a requested model is not an exact `allowedModels` entry. It
admits `{provider, id, thinking}` when both hold:

1. the router's `isAuthorized("provider/id")` — the model is registered, its
   provider is authenticated, and the active region allows it; and
2. the thinking level is one Pi runs that model at (`supportedEfforts`: `off`
   alone for a model that does no reasoning). `xhigh` is also admitted where the
   model maps only `max`, because pi-subagent's ladder has no `max` and a seat at
   `max` reaches the fence as `xhigh`.

No roster or tier is consulted, so the session's own model passes by
construction whenever it is registered, authenticated and in region — which is
what every planner and implementer inherits. Anything that throws while
answering is a refusal. A seat whose provider was refused (something else
registered first) says so once per session: every builtin workflow task is then
refused before it launches unless that other provider admits its model.

### What the router needs

For a `plan-to-ship` run to route and pass the fence, the `models` settings must
give:

- a binding whose roster fills `light` and `normal` (review lenses, normalize,
  receipt) and `frontier` (adjudication);
- the seat model attached to an alias of a configured family, or `family:
  "other"` has nothing to differ from and every diverse lens and the adjudicator
  inherit the seat with a `fallbackReason`;
- a `frontier` alias (or, failing that, a `normal` one) of a family other than
  the seat's, so the adjudicator is not the implementer's family;
- the built-in allowances, or overrides that keep `code-review` ⊇ `light`,
  `normal`, `adjudication` ∋ `frontier` and `codebase-research` ∋ `light`;
- a region, when one is active, that admits the seat model — or the fence
  refuses every inherited task.

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
