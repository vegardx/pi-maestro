# Models

Maestro resolves every spawn to one exact `provider/model` and effort before the
agent starts, and persists that choice. The plan never authors a model — it says
what an agent is *for*, and configuration decides which model that becomes.

## The vocabulary

Four layers, each answering one question.

| Layer | Question | Shape |
|---|---|---|
| **Families** → **aliases** → **attachments** | Which concrete models exist, grouped by who made them | `families.<Family>.aliases.<Alias>.attach: ["provider/model", …]` |
| **Rosters** → **tiers** | Which aliases are preferred, in order, at each weight | `rosters.<name>.<light\|standard\|heavy>: ["Family/Alias", …]` |
| **Bindings** | Which roster a given session seat uses | `bindings.<name>: { roster, targets? }` |
| **Allowances** | Which tiers a persona may request, how wide it may fan out, and how a direct spawn picks | `allowances.<persona>: { tiers, spread?, direct? }` |

**Family** is the diversity axis. Two aliases of the same family are not a second
opinion, which is why a multi-model review picks one slot *per distinct family*.

Allowances key by **persona** (`deliverable-worker`, `codebase-research`,
`code-review`, `standby`, or any persona you declare): `code-review` wanting a
heavy tier is a statement about the work, not about a posture. The first tier
in an allowance is the default a spawn of that persona resolves at; an empty
built-in default (the deliverable worker's) means *inherit the caller*. An
allowance for a persona nothing spawns simply never matches.

An **alias** is a stable name for "the model I mean", and its `attach` list is
ordered: the same alias can be reachable through several providers, and
resolution prefers the one matching the resolving agent's own gateway before
falling back to authored order. That is what lets a plan move between gateways
without rewriting anything.

**Tiers** are fixed and mean weight, not vendor: `light`, `standard`, `heavy`.

## Example

```json
{
  "models": {
    "families": {
      "OpenAI": {
        "aliases": {
          "GPT 5.6 Sol": {
            "attach": ["sit-openai/gpt-5.6-sol"],
            "effort": "medium",
            "notes": "Strongest implementer — the worker and utility seat."
          }
        }
      },
      "Anthropic": {
        "aliases": {
          "Opus 4.8": {
            "attach": ["sit-anthropic/claude-opus-4-8"],
            "effort": "medium",
            "notes": "Careful judge — reviews a different family's work."
          }
        }
      }
    },
    "rosters": {
      "default": {
        "light": ["OpenAI/GPT 5.6 Sol"],
        "standard": ["OpenAI/GPT 5.6 Sol"],
        "heavy": ["Anthropic/Opus 4.8", "OpenAI/GPT 5.6 Sol"]
      }
    },
    "bindings": { "default": { "roster": "default" } },
    "allowances": {
      "deliverable-worker": { "tiers": ["standard", "heavy"] },
      "codebase-research": { "tiers": ["light", "standard"] },
      "code-review": { "tiers": ["heavy", "standard"], "spread": 3, "direct": "other-family" },
      "standby": { "tiers": ["heavy", "standard"], "spread": 2 }
    },
    "region": {
      "active": "EEA",
      "lists": {
        "EEA": ["sit-anthropic/claude-opus-4-8", "sit-openai/gpt-5.6-sol"]
      }
    }
  }
}
```

A binding with no `targets` is the default for any seat. A binding *with*
`targets` claims specific session models by exact id.

## How a spawn resolves

1. **No tier requested** → inherit the caller's model. Root spawns inherit the
   session seat, so an unconfigured install still works.
2. **Tier requested** → walk the active binding's roster for that tier in
   authored order, bounded by the persona's allowance. Each `Family/Alias` ref
   resolves to a concrete attachment; the first ref yielding an *available* one
   wins.
3. **Nothing available** → fall back to the session model, recording a
   `fallbackReason`. Resolution degrades; it never hard-fails.

**Region is the only hard filter**, applied before any of the above reasoning:
a model outside the active list is struck from candidacy entirely, so it cannot
be selected by any path.

Every resolution is persisted on the node with its family, alias, tier, binding,
roster, and the candidate facts behind it — including why each rejected
candidate was rejected.

## Direct spawns and `direct`

A **direct** spawn — one agent, not a fan-out — picks its model by the
allowance's `direct` selector:

- **`inherit`** (the default): today's behavior — resolve the allowance's first
  tier, or run the caller's model when the allowance has no tiers.
- **`other-family`**: walk the allowance's tiers in order through the bound
  roster and take the first available entry whose family differs from the
  caller's. A reviewer never marks its own homework.

`other-family` with nowhere to go — the caller's family is unknown, or every
reachable entry is the caller's own family — falls back to inherit **with a
`fallbackReason`**, never silently. Falling back to a tier pick instead could
still land on the caller's family, which is the outcome the selector exists to
rule out.

## Fanning out across families

A review authored as multi-modal resolves **N distinct families**, where N is
the persona allowance's `spread` (capped by `MAX_SPREAD` = 5; higher values are
rejected). The plan says only *that* it wants breadth — never a model, never a
count. `direct` plays no part here: a fan-out gets its diversity from the
one-slot-per-family rule.

Resolution returns one slot per distinct family and **returns fewer rather than
padding**: five requested against a two-family tier yields two slots, and if
everything is struck it yields a single seat fallback, not five copies of it.

## Inspect and edit

```text
/maestro                                    # interactive editor
/maestro get models.rosters.default
/maestro set --project models.rosters.default.heavy ["Anthropic/Opus 4.8"]
/maestro set --project models.allowances.code-review {"tiers":["heavy"],"spread":3,"direct":"other-family"}
/maestro reset --project models.region
```

Domain edits are JSON, validated before an atomic settings replacement. Global
and project layers merge per key.

`models.presets` and `models.modelSets` were the v1 surface and are **rejected**,
not silently accepted — they were validated and written long after the resolver
stopped reading them, so a write appeared to succeed and did nothing.
