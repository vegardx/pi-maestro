# Models & settings

Maestro has one model policy: **profile-scoped, ordered role pools**. The old
`plan/work/review/fast` tier abstraction and the separate
`backgroundModels.primary|secondary` system are removed. Runtime paths resolve a
named role directly, which makes cost and fallback policy visible instead of
routing through hidden tier mappings.

## Roles

| Role | Consumers |
|---|---|
| `worker` | Deliverable workers and support agents |
| `reviewer` | Review panel personas and the scope-locked fix verifier |
| `research` | Codebase and web research questions |
| `advisor` | Advisor and consult research questions |
| `classifier` | Bash intent classification |
| `plan-summarizer` | Modes compaction, forward summaries, and handoff analysis |
| `compact-summarizer` | Smart compact |
| `verifier` | User-invoked `/verify` agents |
| `delegate` | General ad-hoc subagents |

The fix verifier intentionally uses `reviewer`; `/verify` intentionally uses
`verifier`. Modes summaries and smart compact likewise remain separate roles.

## Ordered pools

Each role has two independent ordered allowlists:

- `models`: exact `provider/model` IDs;
- `efforts`: `off|minimal|low|medium|high|xhigh`.

The first available model is the default. The first configured effort supported
by that model is the default effort. Later values are allowed alternates, not
anonymous slots. Plans and tool calls persist exact values—never indexes—so
reordering a profile cannot silently change an authored choice.

An explicit model must be in the active role's effective model pool and must be
available/authenticated. An explicit effort must be in the effort pool and
supported by the selected model. Invalid authored choices fail visibly; Maestro
does not clamp, downgrade, or substitute them. When a choice is omitted,
resolution walks the ordered configured models and then may use the live session
model when policy-compatible.

```jsonc
{
  "models": {
    "profiles": {
      "opus": {
        "targets": ["anthropic/claude-opus-4-8"],
        "roles": {
          "worker": {
            "models": [
              "anthropic/claude-sonnet-4-6",
              "openai/gpt-5.5"
            ],
            "efforts": ["high", "medium"]
          },
          "reviewer": {
            "models": [
              "openai/gpt-5.5",
              "anthropic/claude-opus-4-8"
            ],
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

A one-item array is a fixed allowlist. Reset a scope to inherit; do not author an
empty array.

## Profiles and activation

A profile owns exclusive exact `/model` targets and its role pools. Activation is
derived: the live session model selects the profile whose `targets` contains its
`provider/model` ID. No `active` value is persisted. Assigning a target to a new
profile removes it from its previous owner.

A missing role or leaf ultimately falls back to the live session model/provider
default. This is intentional inheritance, not a hidden role-to-role fallback:
`advisor` does not inherit `reviewer`, and `classifier` does not inherit
`research`.

## Scope precedence

For each `models` and `efforts` leaf independently:

```text
session → project → global → live session fallback
```

Higher-scope arrays **replace** lower-scope arrays. Arrays never concatenate or
identity-merge. For example, a project `models` array replaces global models
while still inheriting global `efforts` if the project does not author that
leaf.

- Global and project values are atomic `settings.json` writes that preserve
  unrelated settings.
- Session role overrides are typed process-local values consumed directly by
  runtime resolution. They last for the host session and are cleared on session
  start/shutdown; they are never written to disk or inherited by a later pi
  session.
- Explicit selections are resolved once and passed exactly to child processes.

## `/maestro`

`/maestro` opens the hierarchical core `SettingsList` UI with standard search,
keybindings, scrolling, and submenus:

- session model and active profile;
- one-screen pool editors for every active role;
- Profiles → targets and per-role pool editors;
- Child extensions;
- Advanced capability-declared settings.

Selecting a role opens a single-screen ordered pool editor: the checked,
numbered head of the list is the pool (row 1 is the default), followed by the
remaining candidates. Keys: `space` toggles membership (on appends to the pool
end), `+`/`-` (or `K`/`J`) move the selected checked row up/down, `g` switches
the write scope between global and project, `e` cycles the default effort
through the default model's supported levels, and enter/esc finishes. Every
mutation writes immediately at the shown scope.

Candidates are authenticated registry models plus any model id already
referenced in config (any profile's targets or role models leaves, both
scopes); referenced-but-unauthenticated entries are labeled
`needs authentication` and stay selectable as dormant targets. Model IDs are
exact even when friendly registry names are displayed. Child extensions are
global infrastructure passthroughs for isolated children; Maestro itself and
vanished candidates are excluded.

### Role one-liners

Role subcommands operate on the active profile at the models leaf's
effective-source scope (global when the leaf is unset):

```bash
/maestro worker                # or `worker list`: ordered pool, default effort, scope
/maestro worker add openai/gpt-5.5
/maestro worker remove openai/gpt-5.5
/maestro worker default anthropic/claude-haiku-4-5   # move to front; adds if absent
/maestro worker effort high    # validated against the default model's support
```

Unknown model ids get "did you mean" suggestions from the registry; removing
the last model resets the leaf to session fallback. Completions cover role
names, verbs, candidate model ids, and supported effort levels.

### Scripting

The text command uses the same normalized paths:

```bash
/maestro show
/maestro profiles
/maestro get models.profiles.opus.roles.reviewer.models
/maestro set --global models.profiles.opus.roles.research.models '["anthropic/claude-haiku-4-5"]'
/maestro set --project models.profiles.opus.roles.research.efforts '["low","minimal"]'
/maestro set --session models.profiles.opus.roles.worker.models '["openai/gpt-5.5"]'
/maestro reset --session models.profiles.opus.roles.worker.models
/maestro reset --project models.profiles.opus.roles.research.efforts
```

`--project` is the default. Role models, efforts, and profile targets require a
non-empty JSON string array — `set …roles.<role>.efforts` remains the escape
hatch for authoring a full effort allowlist. Profile targets support persistent
global/project scope; role leaves and advanced declared settings also support
session scope.

## Review spend guardrails

Multi-model review is exceptional. First raise the review effort. Add a second
model only when model diversity buys a meaningful independent perspective—for
example security-sensitive code, provider-specific behavior, or a disputed
architectural judgment. By default:

- one persona uses one model;
- at most two distinct models may run the same persona;
- duplicate persona instances need unique names;
- a cross-model duplicate needs an explicit `modelJustification`;
- resolved exact model metadata remains auditable in the plan/run surfaces.

## Migration from tiers

Legacy `plan/work/review/fast` and background primary/secondary settings no
longer participate in runtime resolution. Migrate each old consumer to the role
inventory above. When an old tier fanned out to several consumers, copy its
model/effort into each corresponding role, then tune independently:

- old work → `worker` (and usually `delegate` if that shared the policy);
- old review → `reviewer` and, only if desired, `verifier`;
- old fast → `research`, `classifier`, and summarizer roles as appropriate;
- advisor/consult → `advisor`;
- legacy background normal summaries → `plan-summarizer`;
- smart compact → `compact-summarizer`.

Direct role entries win. Keep old keys only long enough to roll back an older
Maestro build; current code ignores them.

## Extension settings reference

### `modes.distill` — context-fill ladder {#distill}

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

<!-- verified against eb4ef95ff0cf -->
