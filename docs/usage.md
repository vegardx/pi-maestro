# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Pi loads the workspace TypeScript directly. Worker observation requires `tmux`; shipping requires `gh`.

## Modes and entry gates

- **Recon** is the initial read-only research posture. `/recon` re-enters it.
- **Plan** owns research, questions, and plan structure. `/plan [slug]` opens it.
- **Auto** runs the structured plan. `/auto` or Shift+Tab requests entry.
- **Hack** is explicit unrestricted work. `/hack` requests entry.
- **Agent** is internal to workers.

Shift+Tab cycles Plan ⇄ Auto; Recon and Hack exit into Plan. Plan → Auto/Hack never changes mode immediately: Maestro runs the plan-review gate, presents a final ruling, and revalidates the reviewed plan fingerprint. **Stay in plan** records a cancelled ruling and starts nothing.

## Plan

A new plan begins in **exploring**. Use `research` for parallel codebase/web questions and `dig(ref)` for a full persisted report. When understanding is sufficient, `readiness` asks whether to form the plan and records the summary. Structural tools then become available:

- `deliverable` defines atomic deliveries and their dependency DAG;
- `task` defines gating work, follow-ups, questions, and manual checkpoints;
- `workflow` lists exact model options and atomically stores immutable assignments plus explicit stages;
- `plan` renders markdown, a worker seed, or JSON.

Each workflow stage names its predecessor stages, assignment ids, immutable `inputRevision`, contracts, and barrier. Independent members share a stage and run concurrently. Every assignment stores semantic kind, exact model/effort, runtime policy, focus, rationale, contracts, and provenance. Maestro never silently substitutes a persisted exact choice.

A repo delivery maps to one branch, worktree, and PR. `dependsOn` controls activation; dependencies stack by default. Scratch deliveries use a plain directory and no PR. Multi-repo plans register exact repo paths; cross-repo dependencies order work but do not stack branches.

## Execute

`/start [deliverable-id]` activates only ready `planned` work. Omitting the id starts all ready planned deliveries. It does not restart failed or stopped work.

Workers run in persistent tmux sessions, commit locally, and toggle tasks. Typed workflow review assignments inspect immutable revisions and report structured findings. Critical and major findings must have a recorded resolution; fixed claims receive scope-locked verification. Final assessment checks exact SHAs and complete reports mechanically.

### Observe and control

The editor HUD has Agents, Plan, and Questions tabs. Tab enters it only from an empty prompt. Rows show status words and elapsed time; wider terminals add model, effort, tokens, and cache hit rate. Terminal duration freezes. Worker-owned child agents reconnect into their owner row through durable generation-fenced projections.

- `/agents` focuses Agents (or prints a headless summary).
- `/watch` toggles worker panes.
- `/view <target>` opens a read-only tmux split.
- `/steer <target> <guidance>` continues a worker with guidance.
- `/interrupt [target] [--children|--tree|--all]` aborts a turn/run; propagation is explicit.
- `/answer` opens pending questions; `/recap` summarizes completed agents.

Use exact `worker:<deliverable/agent>` or `run:<id>` targets when aliases could collide. `I` in the HUD interrupts. `K` performs a bounded shutdown of the owning delivery and records a recoverable failure only after the process is proved gone.

### Stop, restart, recover

- `/stop` freezes scheduling, requests cooperative preparation, and escalates remaining sessions at one bounded fleet deadline.
- `/restart [deliverable-id]` resumes a clean stop or replaces an already-started worker. It never activates unrelated planned work.
- `/kill <deliverable-id>` proves shutdown and marks that delivery failed/recoverable.
- `/recover [deliverable-id]` audits worktree, branch, session, and PR reality. A target recovers only that delivery; global recovery presents candidates instead of clearing every hold.
- `/debug [symptom]` collects bounded facts, asks for one recovery action, records the exact result, then offers a redacted issue draft.

Resume keeps the JSONL. Fresh restart creates a new JSONL, retains bounded prior-session paths, and reuses the validated worktree/branch. Stale process generations cannot complete tasks, reconcile children, update usage, or control a replacement.

## Review and ship

Reviews are workflow assignments, not an independent panel configuration. See [Review workflows](review-loop.md). The delivery stores canonical findings, duplicate membership, resolution, verification, assignment usage, and reviewed SHAs.

Maestro owns remote effects:

- `/ship` pushes and creates/updates the next shippable PR;
- `/sync` retargets stacked PRs after predecessor merges;
- `/commit` creates a local conventional commit.

Generated PR evidence is marker-bounded: user text outside Maestro markers is preserved. Canonical findings are never silently dropped to meet a size budget; optional detail truncates first. Secrets and raw transcripts are not projected.

## Continuity

`/distill` curates in-place compaction. `/handoff` closes the arc and seeds a new planning session; it refuses while workers are live. `/verify [deliverable-id]` performs deep read-only verification of started work.

## Command reference

| Command | Effect |
|---|---|
| `/plan [slug]` | Open/create a plan and enter Plan |
| `/recon`, `/auto`, `/hack` | Request a mode transition |
| `/start [id]` | Activate ready planned deliveries |
| `/stop` | Bounded fleet stop |
| `/restart [id]` | Resume/replace started work only |
| `/recover [id]` | Audit and recover targeted or selected work |
| `/kill <id>` | Prove shutdown, then fail recoverably |
| `/agents`, `/watch`, `/view <target>` | Inspect agents |
| `/steer <target> <text>` | Guide a worker without interruption |
| `/interrupt [target] [scope]` | Abort current turn/run |
| `/answer`, `/recap` | Handle questions and summaries |
| `/verify [id]`, `/debug [symptom]` | Verify or diagnose/recover |
| `/ship`, `/sync`, `/commit` | Delivery/GitHub operations |
| `/distill`, `/handoff` | Session continuity |
| `/maestro` | Exact models, runtime policies, gates, scalar settings |
| `/modes-status` | Current mode, plan, and execution state |

## Development and dogfood

```bash
npm test
npm run typecheck
npm run boundaries
npm run docs
npm run check
```

Deterministic scenario tests are normal Vitest files and write complete artifacts inside test-owned temporary directories. Real-process validation likewise owns its temporary repository, socket, and child processes. Real-provider and disposable-GitHub validation are opt-in host/Maestro activities; workers do not invoke providers, create remote repositories, or answer approval prompts.
