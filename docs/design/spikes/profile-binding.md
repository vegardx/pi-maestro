# Spike: profile binding — by-name vs gate-time snapshot

Status: investigated 2026-07-20 against main (d4b92b1). Verdict up front:
**bind by name, validated**. No scenario needs a binding snapshot. One cheap
addition: an *informational* gate-time stamp of the resolved catalog contents,
purely to power explain-output diffs. Plus one hard requirement v2 already
states but v1 does not fully implement: **persist every resolution, not just
authored ones** — the only silent-drift case found today is the unpinned
resume re-roll, and it is closed by persist-always, not by snapshotting.

---

## How config reads actually flow today

### Reads are live, per-resolution, uncached

`resolveExactModelSelection` (packages/models/src/exact-selection.ts:269) calls
`readModelsConfig(ctx.cwd)` (line 275) **at the top of every resolution**.
`readModelsConfig` (packages/models/src/profiles.ts:221) constructs a fresh
`SettingsManager` and re-reads global + project settings files each call. There
is no process-lifetime cache anywhere in the resolution path. Every consumer —
worker spawn (`resolveSpawnModelSafe`, packages/modes/src/spawn-model.ts),
subagent spawn (packages/subagents/src/index.ts:527), summariser
(packages/modes/src/summarise.ts:46), debug reviser, smart-compact, command
surfaces — resolves against the file on disk *at that moment*.

The only caches are **display** caches: the footer's residency label is cached
for 3s (packages/modes/src/runtime/dashboard.ts:21–35, "settings reads are
file I/O, and render runs per keystroke — cache with a short TTL so toggles
show up promptly"). This is the repo's existing answer to "live config, hot
read path": short TTL for display, fresh read for decisions.

So today's system **is already bind-by-name end to end.** The spike question is
really: does anything about that hurt, and does the persisted-assignment layer
cover the gaps?

### What a live /maestro edit mutates

`writeDomainValue` (packages/settings/src/domain.ts:736) writes `models.*` keys
straight into the global/project settings file via `updateSettingsFile` +
`setObjectPath`. Effects are immediate for every subsequent resolution.
Notably, `domainImpact` (domain.ts:662) already *documents* the intended
semantics in the UI:

- model set edit → "Changes exact options for <bindings>" (future resolutions)
- kind binding edit → "Affects future runs only; **persisted assignments are
  unchanged**"
- runtime policy edit → "Future runs resolve this policy before spawn; **live
  assignments remain immutable**"
- gate edit → "in-flight rulings keep their persisted contract"

The by-name-plus-persisted-assignment contract is already the product's stated
behavior; v2 would be *changing* semantics by snapshotting, not preserving them.

Writes are validated before landing (`validateDomainEdit`): target overlap,
unknown-set references, unsafe policy combos are rejected at edit time. A
hand-edit bypassing this path can still poison the config (`readModelsConfig`
throws on invalid shapes / overlapping targets) — that failure is returned as a
selection error and, under v2 rule 4, becomes session-fallback + notice rather
than a wedge.

### Persisted assignments: revalidated, never substituted, never re-rolled

`resolveExactModelSelection` with `opts.assignment`
(exact-selection.ts:311–387) enforces, in order:

1. `presetId`/`modelSetId` must equal the *currently active* pair, else
   `explicit-assignment-mismatch` ("Persisted assignment A/B does not match
   active C/D") — catches preset retargeting, set rebinding, **renames**.
2. `optionId` must still exist in the set, else `explicit-option-not-found` —
   catches option removal.
3. The option's current `modelId` and effort must equal the persisted ones,
   else `explicit-assignment-mismatch` ("no longer matches option X") —
   catches in-place edits to an option under the same id.
4. The option must be *available* (registry ∩ auth ∩ effort support ∩
   **residency**, checked in `checkOption`, exact-selection.ts:121–217), else
   `explicit-option-unavailable` ("…is unavailable and **will not be
   substituted**").

Substitution is structurally impossible on the assignment path. Residency is
enforced inside `checkOption` with the session sentinel exempt — exactly the
v2 rule ("residency is the only hard filter; the seat is exempt").

### What failure does today (fail-visible, recoverable)

- Initial activation: `activateDeliverable` catches everything
  (packages/modes/src/deliverable-executor.ts:571–583) → deliverable parked
  `blocked: "activation failed: <msg> — fix the cause, then /start <id>"`.
- Restart/resume: every failure funnels through `failWorkerRestart`
  (packages/modes/src/exec/execution-adapter.ts:1104–1114) → persisted
  `restartState: "blocked"` + retryable executor state + `/recover` hint.

v2 softens this to "session model + one deduped notice" (design §Model
resolution rule 4) — same visibility, less wedging.

### The concrete traced scenario

*User removes model M from a set while a worker pinned to M is mid-flight,
then the worker resumes.*

1. **Mid-flight: nothing happens.** The model was passed on the tmux spawn
   command line; the running pi process keeps it until exit. No config read
   touches a live process. (Plans run hours–days across maestro restarts —
   the whole hydration/`/recover` apparatus, deliverable-executor.ts:194–206,
   exists because deliverables outlive processes — so mid-run edits are
   normal, not exotic.)
2. **Resume with an authored pin** (`deliverable.worker.model`,
   packages/modes/src/schema.ts:93 "persisted across resume"):
   execution-adapter.ts:598–617 re-resolves with the authored model;
   `resolveSpawnModel` finds no matching available candidate → throws
   `SpawnModelResolutionError` ("No configured option matches M @ …") →
   `failWorkerRestart` → blocked + `/recover` hint. **Fail-visible. Correct.**
3. **Resume without a pin — today's real gap.** The executor passes only the
   authored `spec.model` (deliverable-executor.ts:723); the *resolved* model is
   never written back to the plan (it lives only in the in-memory
   `agentModelMeta`, execution-adapter.ts:633). So an unpinned resume
   re-resolves first-available from the *edited* set, and the adapter
   **forcibly overrides** the session-file model with the fresh resolution
   (execution-adapter.ts:621–630: "Always pass the freshly resolved model on
   resume"). The worker silently switches models mid-conversation.

Case 3 is the only silent drift in the system, and note what causes it: **a
missing persist, not a missing snapshot.** The v2 design already prescribes the
fix ("persists the resolution on the ledger, and revalidates on resume", §Model
resolution rule 2). Once every resolution — authored or auto — is persisted,
case 3 collapses into case 2's fail-visible behavior.

---

## 1. What bind-by-name + persisted assignments already gives, and the remaining drift scenarios

Stability guarantee as-built: *a node's model is chosen once, at its spawn,
against live config; the choice is stamped exact (preset, set, option, model,
effort, provenance, resolvedAt — `resolveAgentAssignment`,
exact-selection.ts:469); every later resume revalidates the stamp and refuses
to substitute.* Config edits therefore affect only **future resolutions**.

Remaining drift scenarios, enumerated:

| # | Scenario | What happens under by-name |
|---|---|---|
| D1 | Tier edit mid-ensemble: candidate 1 resolved model X; user edits tier; candidate 3 resolves model Y | Each spawn is a fresh resolution, honestly recorded on the ledger with `resolvedAt`. Family-diversity is an *edge* check (child vs parent), not a roster check — unaffected. |
| D2 | Unpinned worker resumes after a set edit → silent model switch | Today's only silent drift (traced above). Closed by v2 persist-always, not by snapshot. |
| D3 | Catalog rename / profile deletion mid-run (`profile: fable` → catalog gone) | Next fresh resolution: unknown-catalog error (today `model-set-not-found`, exact-selection.ts:295) → v2: session fallback + deduped notice. Persisted assignments: `explicit-assignment-mismatch` on resume. Loud, recoverable. |
| D4 | Residency flip mid-run (off → EEA, or list edit) | Live processes unaffected. Next spawn/resume: struck models fail availability → pinned: `explicit-option-unavailable`; unpinned: next allowed option; duty callers pick it up on their next call (config read per call). Seat exempt. |
| D5 | In-place option edit under the same id (model or effort changed) | `explicit-assignment-mismatch` ("no longer matches option") on resume — the stamp stores modelId+effort, not just the name. |
| D6 | Config made unreadable by a hand-edit (overlap, bad shape) | `readModelsConfig` throws → selection error on every resolution → v2: session fallback + notice. The validated write path (`validateDomainEdit`) already prevents this from /maestro; migrations must use the same path. |
| D7 | Notes/tier-prose edits | Affect the *next* persona reasoning pass only. Intended live behavior — this is the A/B knob the profile concept exists for. |

## 2. Per scenario: snapshot needed, or is fail-visible + persisted-assignment right?

- **D1 — no snapshot.** The user edited the tier *deliberately*; freezing would
  make the running plan ignore an intentional correction (e.g. "stop using the
  model that's melting down"). The ledger records each resolution with
  provenance and timestamp; explain output can show the split. Snapshot would
  trade an honest, visible mid-ensemble seam for a hidden divergence between
  config-on-disk and config-in-use.
- **D2 — no snapshot; persist-always.** Already in the design text; the spike's
  contribution is confirming v1 does *not* do it for auto-resolutions and v2
  must (the plan-schema cutover should carry the resolved-models record on the
  node ledger).
- **D3 — no snapshot; add an alias.** A snapshot would keep the run driving on
  ghost config that exists nowhere the user can inspect or edit — strictly
  worse than a loud "catalog fable not found" with a fix path. See §5 for the
  migration alias that turns renames into non-events.
- **D4 — snapshot is actively wrong.** Residency is a compliance filter; it
  MUST be live. Any snapshot regime would have to carve residency out, leaving
  two binding semantics in one system. This is the strongest single argument
  for by-name.
- **D5, D6, D7 — no snapshot.** D5/D6 are exactly what fail-visible +
  revalidation exists for; D7 is desired behavior.

## 3. Does anything genuinely need freezing?

No **binding** freeze anywhere. One **informational** freeze earns its place:

> At the plan→auto gate, stamp the resolved profile view into the plan ledger —
> catalog name, active residency, and the post-residency tier contents — as a
> record, never an input.

Cost: one append-only ledger entry written once, at a moment when the gate is
already reading all of this to validate the plan. Benefit: every drift case in
§1 becomes *explainable by diff* ("tier normal at gate: [a,b,c]; now:
[a,c,d]") instead of requiring settings-file archaeology. It also gives the
gate reviewer (the heavy plan-review spawn) the exact pool the plan will start
with.

## 4. Recommendation and spec

**Bind by name.** The lean is validated: today's system is by-name everywhere,
its one silent-drift case is a persistence bug v2 already plans to fix, and
the two loud-drift cases (rename, residency) are ones a snapshot would handle
*worse*.

Field/behavior spec:

1. `profile: fable` is resolved by name at every resolution point. No caching
   beyond short display TTLs (keep the 3s footer pattern for HUD surfaces).
2. **Persist every resolution** on the node's ledger entry at spawn:
   ```yaml
   resolved: { catalog: fable, tier: normal, entry: gpt-x,
               model: openai/gpt-x, family: gpt, effort: high,
               source: tier|inherit|session-fallback, resolvedAt: <iso> }
   ```
   Revalidate exactly on resume (catalog name, entry present, model+effort
   equal, availability incl. residency). Never substitute. Failure → session
   model + one deduped notice per agent (v2 rule 4), with the node marked so
   explain shows the fallback.
3. **Gate-time informational stamp**, appended once at plan→auto:
   ```yaml
   profileAtGate:            # informational — never read by resolution
     profile: fable
     catalog: fable
     residency: EEA
     tiers: { fast: [...], normal: [...], heavy: [...] }   # post-residency
     stampedAt: <iso>
   ```
   Invariant: no code path consults `profileAtGate` to pick a model. It feeds
   explain/HUD only. (This keeps the plan ledger "complete truthful record"
   without creating a second source of resolution truth.)
4. **Explain output per drift case** (diff against `profileAtGate` + the node's
   `resolved` stamp):
   - No drift: `catalog fable — unchanged since gate`.
   - Tier edit (D1): `tier normal drifted since gate: +modelD, −modelB; this
     node resolved 14:02 → modelX (persisted; resume keeps it)`.
   - Rename/missing (D3): `catalog fable not found (present at gate 09:14).
     Renamed or removed — check /maestro settings history. Node fell back to
     session model <id>` (+ alias line when §5 lands: `fable → fable-eu,
     renamed 2026-07-21; following alias`).
   - Residency flip (D4): `model M struck by residency EEA (activated after
     this node resolved); resume fell back to session model — waiting workers
     unaffected until respawn`.
   - In-place edit (D5): side-by-side persisted-vs-current entry, with the
     mismatch field named.
   - `inherit`/session-fallback labeled as such and exempt from tier-allowlist
     validation (design rule 5), but always visible.

## 5. Interaction with the settings-migration follow-up

- **Renames become migration events, not drift events.** The reusable
  migration component (project-settings-migrations follow-up) should write an
  alias record when a catalog is renamed:
  `models.catalogAliases: { fable: { to: fable-eu, at: <iso> } }`.
  Resolution follows one alias hop with a recorded notice; explain shows the
  hop (D3 output above). This upgrade is *only possible* in the by-name
  regime — a snapshot would pin pre-migration contents and shapes that
  post-migration code may not even parse.
- **Migrations must use the single validated write path** (`writeDomainValue`
  → `updateSettingsFile`). The 2026-07-19 null-poisoning incident
  (domain.ts:702 comment; profiles.ts:146 null-skip guard) shows what a
  non-validated writer does to a live session: one bad entry made the whole
  models config unreadable. Under v2 rule 4 an unreadable config degrades to
  session-fallback-everywhere with notices — survivable, but a migration
  should never trigger it.
- In-flight plans are per-plan-dir files a settings migration cannot rewrite;
  the alias + revalidation + explain-diff triad is the correct contract for
  them: the plan keeps naming `fable`, the config says where `fable` went, and
  every divergence is visible at the node that hit it.

## Key files

- packages/models/src/exact-selection.ts — resolution, revalidation, the four
  error codes (295, 311–331, 344–387, 392–414)
- packages/models/src/profiles.ts — `readModelsConfig` fresh-per-call (221)
- packages/settings/src/domain.ts — validated write path (736), impact copy
  documenting live-assignment immutability (662–700), explain (628)
- packages/modes/src/exec/execution-adapter.ts — spawn/resume resolution
  (598–638), forced model override on resume (621–630), restart failure
  funnel (1104)
- packages/modes/src/deliverable-executor.ts — authored-only model passthrough
  (723), activation blocking (571–583), hydration-blocked recovery (194–206)
- packages/modes/src/runtime/dashboard.ts — the 3s display-TTL pattern (21–35)
- packages/modes/src/spawn-model.ts — `SpawnModelResolutionError`, 5s timeout
