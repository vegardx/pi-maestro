# Usage

The lifecycle of a maestro session: plan → implement → watch/steer/answer →
review gate → ship → distill or handoff. This page follows that arc; the
[command reference](#command-reference) at the end lists everything.

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

The root package is the pi bundle manifest; pi loads the TypeScript entries
directly through jiti — no build step. Requirements beyond pi itself:
`tmux` (workers run in tmux sessions) and the `gh` CLI (shipping opens PRs).

## Modes

- `recon` — the default on session start: a read-only research posture with
  the `research`/`dig` loop and no plan surface at all. Shift+Tab exits it
  one-way into plan (the first plan turn orients: summary + open questions);
  `/recon` re-enters it later. It is never part of the Shift+Tab cycle.
- `hack` — unrestricted pi default behaviour. `/hack` only — also outside
  the cycle; Shift+Tab from hack exits back to plan.
- `plan` — read-only shell policy; planning tools and `ask` active. `/plan`
- `auto` — autonomous implementation; execution tools unlocked. `/auto`

Shift+Tab cycles plan ⇄ auto (from plan it asks auto vs hack). A fifth mode,
`agent`, is internal: workers run in it with a dedicated tool policy and
preamble. You never switch to it yourself.

## Planning

`/plan [title-or-slug]` opens (or creates) a plan and enters plan mode. A new
plan starts in an **exploring** phase: the maestro researches until it can
write tasks with file paths and signatures — the plan *is* the research
output. Structuring unlocks when the readiness gate passes (or `/ready`
skips it).

Research runs through two tools:

- `research` — fans out parallel read-only subagents (codebase and web;
  web agents can search, fetch pages, and pull library docs). All questions
  for a round go in one call; you get a bounded digest per question. Full
  reports persist to the plan directory's `research/` folder.
- `dig` — expands a digest to its full report via the `[ref: …]` printed
  beside it. Execution agents have it too: the knowledge base ends with an
  auto-appended **Research Index** of every report, and reports that land
  after the base froze ride each later worker's seed — so agents pull a
  deep-dive on demand instead of every fork carrying every report.

The plan is shaped with three flat tools (plus `plan` to render the active
plan as markdown, seed text, or JSON):

- `deliverable` — create/update/remove deliverables, manage the repo
  registry, and wire dependencies. Add many at once with
  `items: [{id, title, dependsOn}, …]` (one batched call; sibling `dependsOn`
  refs resolve to the minted ids).
- `task` — work items within a deliverable: file paths, signatures, edge
  cases. Tasks are the worker's instructions. Add many at once with
  `items: [{title, body}, …]` (one batched call per deliverable).
- `agent` — support agents within a deliverable: reviewers (a `persona`
  from the [palette](review-loop.md#the-panel), an exact optional `model` from
  the reviewer role pool, an `effort` allowlist choice, a `focus`
  specialization) and helpers, ordered by an `after` graph. Prefer raising
  effort before adding a second model; cross-model duplicate personas require
  unique names and explicit justification.

### Deliverables

A deliverable is the atomic unit of work — one branch, one PR. It carries
tasks, a worker, and its review panel. States:

```
planned → active → complete → shipped | superseded | abandoned
```

Deliverables order themselves with `dependsOn`. Dependent deliverables
create **stacked PRs** by default (branch from the predecessor's tip);
`stacked: false` branches from the default branch instead.

### Multi-repo plans

A plan lives in one repo by default, but can register more: the
`deliverable` tool manages a repo registry (key → path), and each
deliverable may target a registry key. Worktrees, branches, and PRs route
to the deliverable's repo. Cross-repo `dependsOn` is ordering-only — no
branch stacking across repos.

## Execution

`/implement` starts the active plan. The executor activates deliverables
whose dependencies are met, creates a worktree per deliverable, and spawns
a worker in each — a full pi session on tmux, seeded with upstream
summaries and its tasks. Workers implement, commit locally (never push),
toggle tasks, and run their own review panel before completing.

While the fleet runs, the maestro session stays yours:

### The HUD

The HUD lives in the input box itself: the input's top border is a tab
bar —
`──[ Input ]─── Agents 4 ─── Plan 5/9 ─── Questions 2 · 1 blocking ── tab ──`
— so the box always reads tab bar / input text / bottom border. The
bracketed member is the one holding the keys; counts are live (omitted at
zero) and a blocking ask accents the Questions label. Collapsed — the
default, with **Input** focused — the HUD costs zero extra lines.

**Tab** walks the ring. On an empty input it enters the panel at Agents;
each further Tab moves Agents → Plan → Questions; one more wraps focus back
to **Input** while *pinning* the panel open on the last tab. A draft keeps
Tab for autocomplete (the trailing `tab` hint dims to say so) — the ring is
only ever entered from an empty input.

The panel expands *above* the tab bar (at most 10 lines, capped by its own
plain rule; rows beyond the cap scroll behind an overflow rule with
`↑/↓ N more` counts). Its tabs:

- **Agents** — workers at root with their one-shot review/verify/research
  runs nested under tree connectors; maestro-direct spawns at root. Each row
  shows `name · slug`, a status word (starting/running/done/blocked/
  stopped/failed), elapsed time, and the model or a context note. A worker
  auto-expands only while a child is running; done/blocked workers collapse
  to one line with an `N subagents` suffix; manual folds are sticky.
- **Plan** — deliverables as checkboxes (`[x]` shipped/complete, `[~]`
  active, `[ ]` queued) with the assigned worker named on active rows; the
  active deliverable auto-expands its tasks.
- **Questions** — every pending ask: blocking first (accented), asker
  (`maestro` or `worker · slug`) plus the question text.

While a panel tab is focused the panel is bright, its last row lists the
keys, and the input text below dims: up/down move the selection, Tab (or
`[`/`]`) switches tabs, left/right/space fold/unfold, **Enter** is the
context action (Agents: attach a read-only tmux split; Plan:
expand/collapse; Questions: answer), `s` prefills an addressed `/steer`,
`i` interrupts after a confirm.

**Pinned** — after Tab wraps back to Input — the panel stays open as a
passive monitor: every row muted, no selection, no hint row. You type
normally while it live-updates. **Esc** collapses: from a panel tab it
focuses the input *and* collapses; from the input it folds a pinned panel
away; with no panel open it keeps its usual editor meaning.

### Questions and answer mode

Worker questions pend quietly — they surface only as the Questions tab and
its count. A blocking maestro ask badges the tab bar (`1 blocking`) and the
footer ("maestro waiting on you"); if the editor is empty it opens **answer
mode** immediately, and if you have a draft it never steals the input.
Answer mode replaces the input line: the question and numbered options
render above it, digits 1–9 pick an option, typed text is a custom answer,
Enter submits, Esc defers a blocking question (the maestro unblocks and
carries on) or returns to the list. Multi-question sets step `1/N → 2/N`
in place. Shorthand replies (`2`, `1a 2b`, `rec`) typed at the normal
prompt still settle pending questions directly, and a normal prompt sent
while the maestro is blocked simply queues (you are told once).

### Fleet commands

- `/agents` — expand and focus the HUD on the Agents tab (headless sessions
  get a text overview instead).
- `/watch` — toggle stacked tmux panes showing all active workers (large review
  panels are intentionally not tiled automatically).
- `/view <target>` — read-only split for any tmux-backed worker or run. Exact
  IDs (`worker:<deliverable/agent>`, `run:<id>`) are preferred; ambiguous
  display names are rejected.
- `/steer <name> <guidance>` — inject guidance into a running worker. Steering
  continues the turn and is not interruption or shutdown.
- `/interrupt [target] [--children|--tree|--all]` — abort the selected current
  turn. With no target it affects only the current host turn. Workers preserve
  their process, transcript, and worktree after acknowledged RPC abort;
  one-shot runs salvage partial text, settle stopped, and clean up. Descendant,
  tree, and all-agent propagation are explicit only.
- `/answer` — answer questions workers have raised.
- `/recap` — summary of completed agent work.

Workers that hit something outside their deliverable escalate to the
maestro over the supervisor channel; the maestro decides, consults, or
raises a question to you.

## The review gate

A worker cannot complete while its ledger has open blocking findings. The
short version: the panel runs **once**, findings get canonical ids, the
worker resolves each one (fix / wont-fix for minors / dispute with
rationale), and a scope-locked verifier checks exactly those claims — with
a bounded fix-cycle budget, maestro triage on the first block, and a human
question only on repeat blocks. The full design is in
[review-loop.md](review-loop.md).

## Verification and recovery

- `/verify [deliverable-id]` — deep verification of started deliverables:
  read-only subagents read each deliverable's actual diff and judge whether
  its tasks were genuinely accomplished.
- `/debug [symptom]` — collect bounded current-session diagnostics and present
  one mutually exclusive recovery decision. A recommendation is preselected,
  but no steering, retry, restart, or repair runs until you submit it. Recovery
  runs at most once; afterward, the issue review offers **Create issue** /
  **Revise draft** / **Cancel**. Revisions take a conditional free-text
  instruction and may repeat without a cap because each iteration is
  user-driven. Cancel/defer posts nothing and deletes transient state.
- `/retry <deliverable-id>` — clear a blocked deliverable and re-attempt it.
- `/recover` — after an interruption: audit the plan against reality
  (worktrees, branches, PRs) and resume interrupted workers from their
  saved sessions.

### Debug recovery and issue review

Recovery labels describe their exact effect:

- **Steer current worker** preserves process, JSONL session, and workspace.
- **Retry activation** clears only a retryable activation block and ticks the
  scheduler; it does not promise a process restart.
- **Restart and resume** replaces the process after a lifecycle barrier and
  appends to the same JSONL.
- **Restart fresh** replaces the process and JSONL, preserves the validated
  existing worktree/branch, and retains the old session path as history. It
  never creates a second worktree merely to get fresh model context.
- **Plan repair** is atomic and fingerprint-pinned. It may add a corrective
  task, clarify untouched task text, add a manual checkpoint, or idempotently
  reopen an erroneously completed task, and only for a stopped affected
  deliverable. Dependencies/lifecycle, agents, panels, review ledger and
  waivers, repository/workspace/branch/session/PR metadata remain manual.

A worker may inspect its own bounded transcript/workspace and propose a
fingerprint- and generation-bound diagnosis. The maestro alone validates the
proposal, asks for consent, mutates plans/workers/workspaces, and posts issues.
A stale or mismatched proposal fails closed.

Example recovery question:

```text
Recovery (recommended option is preselected; submission is consent)
  Steer current worker       process preserved · session preserved
  Restart and resume session process replaced  · same JSONL
  Restart with fresh session process replaced  · new JSONL · workspace reused
  No recovery                no mutation
```

Recovery success or failure does not block issue review. Its attempted action,
timestamp, exact outcome, and error are inserted mechanically, so the changed
issue is displayed for a separate final confirmation. Issue Markdown always
contains Summary, Steps to reproduce, Expected behavior, Actual behavior,
Observed facts, optional Likely cause, Recovery/workaround, mechanically sourced
Runtime context, and Suggested fix. For example:

```markdown
# Debug: worker process exited unexpectedly

## Summary
Worker process exited unexpectedly.

## Observed facts
- deliverable=docs, generation=4

## Recovery / workaround
- Attempted action: `restart-fresh`
- Exact outcome: **failed** — worker shutdown timed out

## Runtime context
- Mode: `auto` _(source: runtime)_
- Worker generation: `4` _(source: executor)_
```

Only bounded structured evidence is accepted—never raw transcript,
environment, source-tree, or log attachments. The complete title/body is
redacted at final assembly, displayed, frozen, and sent byte-for-byte via
stdin to `github.com/vegardx/pi-maestro` only after **Create issue** is
submitted. Posting failure never rolls back recovery and is never silently
retried when the external result may be uncertain. Active review state and
bounded revision history survive compaction; recovery is not repeated after
rehydration.

## Shipping

The maestro owns shipping; workers only commit locally.

- During execution, the executor ships deliverables automatically once they
  complete and the gate is satisfied.
- `/ship` ships the next shippable deliverable (push + open/update PR). The
  PR body is assembled from the deliverable body, task checklist, and agent
  summaries.
- `/sync` reconciles shipped deliverables' PRs — retargets stacked PRs
  whose base has merged.
- `/park` creates GitHub tracking issues for the active plan.
- `/commit` stages and commits with a conventional-commit message (works in
  any mode, plan or no plan).

When every deliverable is delivered, the maestro returns to plan mode —
the arc is over, and the natural next step is one of the two commands
below.

## Session continuity

Long sessions rot: context fills, attention degrades, threads get dropped.
Two commands, one curation flow:

- `/distill` — curated in-place compaction. The maestro inventories the
  session (plan state, open questions, live threads), proposes topics, and
  asks you (multi-select) what carries forward. The curated document
  *replaces* the compaction summary — same plan, same session, keep
  working.
- `/handoff` — close the arc. A transcript archaeologist hunts unanswered
  questions, unimplemented promises, and orphaned threads; you curate; the
  session ends and a **new planning session** opens — no active plan. You
  arrive to a card ("continuing from a handoff · N threads carried") and a
  one-paragraph orientation; the full seed document rides the model's
  context invisibly until a real plan is formed, and stays on disk under
  the old plan's `handoffs/`. Refuses while workers are mid-flight.

A threshold ladder watches context fill: at 30% you're nudged to `/distill`;
at 50% a self-curated distill runs automatically (with a divergence check
that suggests `/handoff` when the session has drifted from its original
goal). Both thresholds are tunable — see [models.md](models.md#distill).

## Command reference

| Command | What it does |
|---|---|
| `/plan [title-or-slug]` | Open or create a plan; enter plan mode |
| `/ready` | Unlock plan structuring (skip the readiness gate) |
| `/implement` | Start executing the active plan |
| `/agents` | Expand + focus the HUD on the Agents tab (text overview when headless) |
| `/watch` | Toggle stacked tmux panes for all active workers |
| `/view <target>` | View any tmux-backed worker/run read-only; exact opaque IDs win |
| `/steer <name> <guidance>` | Steer a running worker without aborting it |
| `/interrupt [target] [--children\|--tree\|--all]` | Abort current turn/run; preserve persistent sessions, settle one-shots |
| `/answer` | Answer pending agent questions |
| `/recap` | Summary of completed agent work |
| `/verify [deliverable-id]` | Deep-verify started deliverables against their diffs |
| `/debug [symptom]` | Diagnose, run one explicitly selected recovery, then review/revise/cancel an exact GitHub issue draft |
| `/retry <deliverable-id>` | Clear a blocked deliverable and re-attempt |
| `/recover` | Audit plan vs reality; resume interrupted workers |
| `/ship` | Ship the next shippable deliverable (push + PR) |
| `/sync` | Retarget stacked PRs whose base merged |
| `/park` | Create GitHub tracking issues for the active plan |
| `/commit` | Conventional commit of current changes |
| `/distill` | Curated in-place compaction; keep working |
| `/handoff` | End the arc; seed a new planning session |
| `/recon`, `/hack`, `/auto` | Switch mode |
| `/maestro` | Hierarchical settings: profiles, ordered role pools, child extensions, advanced scopes |
| `/modes-status` | Show mode and active plan status |

`/maestro` uses standard searchable pi settings lists. Profile activation is
derived from `/model`; role model/effort arrays are ordered (first item is the
default) and layer session → project → global. An unset efforts leaf shows as
`auto` — the spawner picks an effort per task. Selecting a role opens a
one-screen ordered pool editor (space toggles, `+`/`-` reorder, `g` scope,
`e` default effort, cycling past the last level back to `auto`). Role
one-liners edit the active profile directly:
`/maestro <role> [list|add|remove|default|effort]` — `effort auto` clears the
leaf. Use
`/maestro show|get|set|reset|profiles` for scripts; JSON arrays are required
for role leaves. See [Models & settings](models.md) for exact paths, session
lifetime, and migration from legacy tier keys.

## Feature flags

Disable a whole extension:

```bash
PI_EXT_MODES=off pi
```

Disable or force a specific feature path (kill switch wins):

```bash
PI_DISABLE="modes.plan-tools" pi
PI_ENABLE="modes.some-flag" pi
```

<!-- verified against eb4ef95ff0cf -->
