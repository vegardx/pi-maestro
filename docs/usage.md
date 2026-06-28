# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The root package is the pi bundle manifest. Pi loads the TypeScript extension
entries directly through jiti; there is no build step.

## Commands

- `/plan [title-or-slug]`: create or open a plan and enter plan mode.
- `/implement [--ask] [--fanout]`: start execution of the active plan.
- `/ship [deliverableId]`: ship the next shippable deliverable, or the supplied
  deliverable, through `commit.v1`.
- `/sync`: reconcile merged/closed deliverable PRs back into plan state.
- `/park`: create GitHub tracking issues for the active plan.
- `/hack`, `/ask`, `/auto`: switch permission mode.
- `/modes-status`: show current mode and active plan.
- `Alt+M`: cycle `hack → plan → ask → auto`.

## Plan tools

The modes extension registers three LLM tools when enabled:

- `deliverable`: create/update/remove/reorder deliverables.
- `task`: create/update/toggle/remove/move work items.
- `plan`: render the active plan as markdown, deterministic seed, or JSON.

Plan-level loose items can be `followup`, `question`, or `manual`; gating
`task` items must belong to a deliverable.

## Multi-repo plans

A plan targets one repo by default (`plan.repoPath`, key `default`). To span
more repos, register them and assign deliverables to a repo by key:

- `deliverable register-repo` with `repo` (key), `repoPath`, and optional
  `repoDefaultBranch`.
- `deliverable add`/`update` with `repo: <key>` targets that repo; `repo:
  "default"` clears the assignment back to the plan default.
- `deliverable unregister-repo` removes a repo (rejected while a deliverable
  still targets it).

Each deliverable's worktree, branch, ship cwd, sync PR-state lookup, and park
issue are routed to its own repo. The repo guard is per-deliverable: a
sequential `/implement` or `/ship` aborts if the session cwd isn't the targeted
repo. Fanout is unguarded (each worker uses its own per-repo worktree), and
`/sync` is gh-only so it runs from any cwd.

`dependsOn` across repos is **ordering-only**: there is no shared git base, so
the child bases off its own repo's default branch (no branch stacking, no
cross-repo PR base), while sync still keeps the child blocked until the parent
ships. See [Multi-repo plans (design)](multi-repo-plans.md).

## Modes

- `hack`: unrestricted pi default behaviour.
- `plan`: read-only shell policy; only planning tools, read tools, and `ask` are
  active.
- `ask`: implementation with prompts/checkpoints routed through UI questions.
- `auto`: autonomous implementation mode.

Mode and active-plan state is persisted into the session so reloads/resumes keep
the current workflow.

## Shipping

`/ship` uses `commit.v1` rather than importing the commit extension. Modes owns
which deliverable is being shipped; commit owns staging, message generation,
push, and PR creation/update. Successful shipping records PR metadata on the
plan and emits `maestro.ship.completed`.

`/sync` uses GitHub PR state to move merged PRs to `shipped` and closed PRs to
`needs-attention`.

## Compaction

`smart-compact` replaces pi's default auto-compaction summary with a single
work-continuity-focused LLM call: it identifies the active task and writes a
summary optimised for continuing it. Compaction is append-only — the previous
summary is reused byte-for-byte as the prefix and only a new section is added,
so the cached prompt prefix stays stable across compactions. Any failure (no
model/auth, empty summary, timeout, error) falls back to pi's default
compaction, so a session is never blocked.

Settings live under `extensionConfig.smart-compact`:

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | background `normal` tier → session model | `provider/id` override for the summariser. |
| `compactAt` | unset | Context-token count at which to proactively compact at turn end. Unset relies on pi's native `compaction.reserveTokens` threshold. |
| `maxSummaryTokens` | `8192` | Max tokens the summary may emit. |
| `maxFileListEntries` | `50` | Cap on entries per read/modified file list. |
| `timeoutMs` | `60000` | Deadline for model resolution + the summary call. |

These are independent of pi's native `compaction.*` settings
(`reserveTokens`, `keepRecentTokens`), which still govern when pi triggers
compaction; `smart-compact` only changes how the summary is produced (and,
with `compactAt`, can trigger earlier).

### Generic vs. Maestro-owned compaction

Two extensions register a compaction handler. They cooperate through a marker
in `customInstructions`:

- **Generic** (`smart-compact`): manual `/compact`, pi's native threshold, and
  the optional `compactAt` trigger. Produces the work-continuity summary above.
- **Maestro-owned deliverable slices** (`modes`): while `modes` drives ask/auto
  execution of an active deliverable, it triggers its own compaction tagged
  with the marker `maestro:modes-deliverable-slice <nonce>`. `smart-compact`
  declines marked compactions, and `modes` — loaded last, so it has final say —
  produces a dependency-aware slice that names the active deliverable, its
  dependency chain, and downstream dependents.

`modes` only ever owns a compaction it triggered (matched by nonce); for every
other compaction it returns `undefined` so the generic path wins. If `modes`
sets the marker but cannot produce a summary it cancels the compaction rather
than leaking the marker into pi's default prompt. Both paths are append-only:
a generic compaction after a modes slice (or vice versa) reuses the prior
summary byte-for-byte and appends a new section, so the cached prefix stays
stable across mixed chains.

### Working-budget trigger

While executing a deliverable in ask/auto, `modes` triggers a slice compaction
when the **working budget** — `sys + hotTail` (system prompt + live tail), not
the stable `seed + rollingSummary` summary burden — crosses `workingTokens`.
Driving the trigger from the working bucket means a growing rolling summary or
carry-forward seed never self-triggers compaction. After a successful slice,
`modes` resumes the auto loop exactly once (guarded by the trigger nonce and
by mode/stage/deliverable drift checks). Skipped resumes surface a one-line
reason (e.g. `gate: deliverable-drifted`) so a stalled run is observable.

Settings live under `extensionConfig.modes.compaction`:

| Key | Default | Meaning |
| --- | --- | --- |
| `phaseTokens` | `10000` | Max output tokens for each new raw-slice summary section. |
| `workingTokens` | `150000` | Working-budget threshold (`sys + hotTail`) that fires a slice compaction. |
| `summaryTokens` | `100000` | Soft warning threshold for the stable summary burden (`seed + rollingSummary`). |
| `timeoutMs` | `90000` | Deadline for a modes-triggered compaction before it is abandoned (with a cooldown before retrying). |

During active modes execution, `smart-compact`'s proactive `compactAt` trigger
defers to the modes working-budget trigger in the same session (queried via the
`modes` capability). Manual `/compact` and pi-native threshold compaction still
work and stay generic.

### Fanout and cross-session isolation

Each session's `modes` instance acts only on its own `ctx`. A fanout
deliverable worker runs `modes` in auto with its own active deliverable, so it
owns plan-aware compaction and resume **inside its own session** — desirable.
The parent/orchestrator session stays idle and never triggers compaction on,
or sends resume follow-ups into, a worker session (and workers never drive the
parent). The parent still records each deliverable's `RunResult.summary`.

### Carry-forward summaries across deliverables

The append-only rolling summary above is the live prompt prefix for a
deliverable's OWN session — byte-stable and never re-summarised. It is never
injected into other deliverables. Separately, when a deliverable ships,
`modes` distils a **one-time, forward-looking** `Deliverable.summary` and
carries it into the execution seed of deliverables that depend on it.

- **Written once at `/ship`.** The summary is built from the deliverable's own
  session (its rolling summary plus the raw tail since the last compaction) in
  a single distillation call. It is idempotent — re-shipping never regenerates
  or overwrites an existing summary — and soft-fails (ships without a summary)
  on no model/auth, an empty or wrong session, or a summariser error. This is
  the only place a rolling summary is re-read; the result never feeds back into
  any live rolling prefix, so per-session cache stability is preserved.
- **Forward-looking, not a work log.** The prompt asks for what downstream
  deliverables need but the plan does not make obvious: discoveries, changed
  assumptions, hidden constraints, exact files/APIs/schemas/identifiers to
  reuse, decisions and their rationale, and pitfalls. With no dependents it
  asks for a short archival note.
- **Dependency-scoped seeding.** A deliverable's seed carries the distilled
  summaries of its direct and transitive dependencies, verbatim, under a
  `## Carry-forward from dependencies` heading. Independent parallel branches
  never inherit each other's summaries, and the plan-document section in seeds
  omits per-deliverable summaries so nothing leaks in through it. Secrets are
  redacted before the summary is persisted.
- **Correct session only.** Ship-time summarisation reads the deliverable's own
  execution session (matched against `Deliverable.sessionPath`); if `/ship`
  runs from a different session it soft-fails rather than summarising the wrong
  transcript.
- **Budget warning.** When the dependency summaries carried into an active
  deliverable's seed exceed `compaction.summaryTokens`, `modes` warns once per
  session — it never silently drops older dependency summaries.
- **In-flight limitation (first pass).** Carry-forward affects future sessions
  only. A dependent deliverable whose session is already active/seeded before
  an upstream summary is written is not mutated and receives no follow-up; this
  keeps the cache stable and avoids cross-session writes. In stacked PR flows,
  start a dependent after its dependencies ship to pick up their summaries.


## Feature flags

Disable a whole extension:

```bash
PI_EXT_MODES=off pi
```

Disable a specific feature path:

```bash
PI_DISABLE="modes.plan-tools" pi
```

Re-enable with `PI_ENABLE` when a project/global setting disables something.
Environment kill switches take precedence.
