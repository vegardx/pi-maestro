# Model tiers redesign — presets/slots → profiles/tiers

Supersedes the preset/slot section of the execution redesign (Phase 3 presets, Phase 7
`SubAgentSpec`/palette slot fields). **Clean break** — pre-release, no config migration;
the user reseeds via the new `/maestro`.

## The model

Four **tiers**, named by intent (not cost):

```
  plan   — the maestro reasons & plans here.  ALWAYS = the session model (/model).
  work   — workers implement here.
  review — reviewers + advisor run here (cross-model second opinion).
  fast   — cheap mechanical subagents (classify, scout, quick research).
```

A **profile** owns a *set* of `/model` targets (an exclusive partition — each model
belongs to at most one profile) and pins `work`/`review`/`fast`. `plan` is implicit =
whichever target is live.

```jsonc
// settings.json → models
{
  "profiles": {
    "opus": {
      "targets": ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-7"],
      "work":   {},                                   // {} = track plan
      "review": { "model": "openai/gpt-5.5", "effort": "high" },
      "fast":   { "model": "anthropic/claude-haiku-4-5", "effort": "low" }
    }
  }
}
```

- **Activation is derived, not stored.** The active profile = the one whose `targets`
  include the current session model. No `active` key. `/model` *is* the switch.
- **Tier config = `{}` (track plan) OR `{ model, effort? }` (pinned).** A profile with
  every tier `{}` is identical to no profile (all tiers = session model). That is the
  zero-config default.
- **Effort is a per-tier dial.** For adaptive models it's a *steer*; for fixed models a
  *budget* (the menu says which).

Role → tier is a fixed table (rarely touched, hardcoded for v1):

```
  maestro → plan     worker → work
  reviewer → review  advisor → review
  research → fast     classifier → fast    analyze → work    summarizer → fast
```

Reviewers **always** resolve to `review`; the planner sets persona/required/effort,
never a model. `SubAgentSpec` loses `slot` and `model`.

## Phases

### A — Contracts (`packages/contracts/src/models.ts`)
- Replace `SLOTS`/`Slot`/`SlotConfig`/`PresetConfig`/`ModelsConfig` with:
  `TIERS = ["plan","work","review","fast"]`, `Tier`, `TierConfig { model?; effort? }`
  (absent `model` ⇒ track plan), `ProfileConfig { targets: string[]; work?; review?; fast? }`,
  `ModelsConfig { profiles: Record<string, ProfileConfig> }` (no `active`).
- `ResolvedRoleModel`: `slot?: Slot → tier?: Tier`, `preset? → profile?`.
- `ResolutionSource`: `"preset" → "profile"`.
- Drop `RoleModelConfig.slot/preset` (keep optional `model`/`effort` as a power-user
  escape hatch — but v1 stops writing them).

### B — models package (`packages/models/src`)
- `presets.ts → profiles.ts`: `readModelsConfig` returns the new shape; add
  `activeProfile(cfg, sessionModelId)` (target match) and
  `resolveTier(ctx, tier)` (plan→session; others→track-or-pinned, with auth).
- `role-resolver.ts`: new priority chain —
  1 explicit · 2 env · 3 role `models.<role>.model` (escape hatch) ·
  **4 tier via active profile** (role→tier via `opts.tier`) · 5 session.
  Add `tier?: Tier` to `RoleResolveOptions`; delete `resolveSlotModel` (replaced by
  `resolveTier`).
- Update `index.ts` exports.

### C — modes + subagents consumers
- `schema.ts`: `SubAgentSpec` → `{ name, persona, focus?, required?, effort?, kind? }`
  (drop slot/model). `AgentSpec`/`WorkerSpec`: drop `slot` (legacy support agents map to
  `work`).
- `research.ts`: advisor/consult → `review` tier; codebase/web research → `fast` tier
  (replace `ALTERNATE_MODEL_KINDS`/`resolveSlotModel`).
- `personas.ts`, `panel.ts`, `review-tool.ts`, `tools.ts`, `engine.ts`,
  `execution-adapter.ts`, `deliverable-executor.ts`, `spawn-model.ts`, `provisioner.ts`:
  reviewers resolve `review`; workers resolve `work`; drop slot plumbing + the
  multi-model "add same-persona-on-alternate" mechanism.
- `planning-preamble.ts`: teach persona/required/effort (no model/slot).

### D — settings menu (`packages/settings/src/menu.ts`)
- Rewrite the presets section into **profiles**: profile name, `targets` (multi-select,
  exclusive — checking a claimed model *moves* it), and `work`/`review`/`fast` editors
  each offering **= plan** or a pinned model+effort. Remove the slot picker. Keep the
  adaptive/fixed effort language. `ensureDefaultProfile` seeds a profile whose single
  target is the session model, all tiers `{}` (= plan), on first open.
- `plan` row shown read-only (= session model + its thinking).

### E — runtime declarations + tests + gates
- `runtime/index.ts`: drop `models.agent.slot/model`, `models.classifier.slot/model`
  declarations (role→tier is hardcoded); keep effort where still meaningful.
- Fix `test/modes-resolver.test.ts` (tier resolution, `source: "profile"`) and
  `test/lifecycle-correctness.test.ts` (`addAgent` no longer takes `slot`).
- Gates: tsc (baseline should not grow), vitest, biome, boundaries, feature-flags, smoke.

## Verification
Per phase: tsc + targeted tests. Dogfood at the end: `/model` toggles the active profile;
`/maestro` edits tiers; a reviewer runs on the `review` model.
