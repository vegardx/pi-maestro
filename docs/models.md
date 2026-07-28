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
| **Allowances** | Which tiers an agent type may request, and how wide it may fan out | `allowances.<agent>: { tiers, spread? }` |

**Family** is the diversity axis. Two aliases of the same family are not a second
opinion, which is why a multi-model review picks one slot *per distinct family*.

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
      "worker": { "tiers": ["standard", "heavy"] },
      "explorer": { "tiers": ["light", "standard"] },
      "reviewer": { "tiers": ["heavy", "standard"], "spread": 3 },
      "advisor": { "tiers": ["heavy", "standard"], "spread": 2 }
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
   authored order, bounded by the agent's allowance. Each `Family/Alias` ref
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

## Fanning out across families

A review authored as multi-modal resolves **N distinct families**, where N is the
agent allowance's `spread` (capped by `MAX_SPREAD`). The plan says only *that*
it wants breadth — never a model, never a count.

Resolution returns one slot per distinct family and **returns fewer rather than
padding**: five requested against a two-family tier yields two slots, and if
everything is struck it yields a single seat fallback, not five copies of it.

## Inspect and edit

```text
/maestro                                    # interactive editor
/maestro get models.rosters.default
/maestro set --project models.rosters.default.heavy ["Anthropic/Opus 4.8"]
/maestro set --project models.allowances.reviewer {"tiers":["heavy"],"spread":3}
/maestro reset --project models.region
```

Domain edits are JSON, validated before an atomic settings replacement. Global
and project layers merge per key.

`models.presets` and `models.modelSets` were the v1 surface and are **rejected**,
not silently accepted — they were validated and written long after the resolver
stopped reading them, so a write appeared to succeed and did nothing.
