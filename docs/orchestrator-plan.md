# Orchestrator-first execution — implementation plan

Status: **in progress** — picker rewrite shipped (PR #59), remaining deliverables below.

## Goal

The main session is always free during implementation. Workers (subagents)
execute deliverables. The user stays interactive — can add work, steer
workers, answer questions.

## Shipped

- **Picker rewrite** (PR #59) — options: Auto/Hack/Ask/Keep planning. Summary
  line shows "N deliverables, sequential/up to M parallel". Auto is default.

## Remaining deliverables

### 2. Always-spawn orchestrator model

When subagents available:
- Always delegate to workers (even sequential = 1 worker at a time).
- Remove `--fanout` flag; auto-detect parallelism from dependency graph.
- Main session free in all cases.
- Fallback (no subagents): current direct-execution behavior unchanged.
- Fix: `buildShipSummary` reads worker session from disk when shipping a
  deliverable implemented by a worker (sessionPath differs from current).

### 3. Orchestrator preamble

System prompt when workers are active:
- "Workers are implementing. You're free — can answer questions, add
  deliverables/tasks, steer workers."
- "Don't implement anything yourself."

### 4. Re-tick on mutation and completion

- Worker completes → `fanout.tick()` → spawn next ready deliverables → notify.
- `deliverable add` → `tick()` → spawn if ready → notify.
- "All workers finished — N deliverables ready to ship" when last completes.

### 5. Auto-steer on plan mutation

- `task add/remove/update` on active deliverable → steer worker with change.
- `deliverable update` (body) on active → steer with updated scope.
- Confirmation: "Steered worker:X with new requirement."

### 6. Progress + completion notifications

- Wire `EVENTS.runProgress` → `ctx.ui.notify` (terse).
- Worker completion → "✓ worker:X completed — ready to ship."
- Decision relay: clearly identify which worker is asking.

### 7. `/workers` command

- List active/completed runs with status, duration, activity.
- Optional: `/steer <worker> <msg>` for manual guidance.

## Follow-up (not in scope)

- Non-blocking review/simplification pipeline after worker completion.
- Unblock dependents at `in-review` status instead of `shipped`.

## Key implementation notes

- `FanoutOrchestrator.tick()` already checks `readyDeliverables` and spawns.
- `SubagentService.steer(runId, guidance)` delivers messages to workers.
- `contact_supervisor` → `needDecision` → `attachSupervisor` → human relay
  is already wired end-to-end.
- `resolveShipSummaryInput` returns `ok: false` when sessions differ — need
  to load worker session from disk instead.
- `computeMaxParallelism` (shipped in picker PR) simulates wave execution.
