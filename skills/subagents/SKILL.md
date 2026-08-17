---
name: subagents
description: >
  Safely delegates work through the Pi subagent tool. Use whenever launching,
  running in parallel, waiting for, inspecting, interrupting, reconciling, or
  diagnosing subagents, including independent reviews, background work,
  sandboxes, visible workers, and worktree isolation. Do not use for dependent
  multi-stage work that belongs in a pi-workflow workflow.
license: MIT
---

# Subagents

Use a subagent when delegation provides independent verification, useful
parallelism, isolation, or background execution. Perform small sequential work
in the current agent. Use a workflow when later work depends on earlier outputs
or the process needs durable multi-stage orchestration.

## Launch

- Preserve the user's task, paths, constraints, and requested depth.
- Use a provider-qualified model id when selecting a model, such as
  `github-copilot/gpt-5.6-sol`.
- Omit `backend` and let the runtime select it. Set `visible: true` only when the
  user explicitly wants a visible tmux worker.
- Grant only the tools needed by the task. A read-only prompt is not an
  authority boundary when mutation tools remain available.
- Omit `skills` to retain ambient skill discovery. Pass `skills: []` only for an
  intentionally hermetic child.
- Use `agentScope: "global"` when repository-controlled project agents must not
  participate.

## Choose Isolation

Use the shared workspace for a single read-only task. Use a managed worktree for
parallel or mutating tasks:

```json
{
  "worktree": true,
  "task": "Implement the requested change and run its focused checks."
}
```

Never run concurrent mutating agents in the same checkout. An explicit
worktree request must fail rather than silently fall back to shared state.

Treat an OS sandbox as a security boundary:

- `sandbox: true` denies all network access and is suitable only for offline
  work.
- A model-backed sandbox must allow its provider endpoint and every additional
  domain the task requires.
- Confirm the sandboxed child can access its selected model credential before
  relying on it.
- Do not silently retry without a sandbox after an explicitly sandboxed run
  fails.
- Prefer an unsandboxed worktree-isolated worker for open-ended network research
  whose domains cannot be enumerated safely.

## Parallel Work

Use parallel fan-out for independent tasks, especially read-only review lenses.
Set a bounded `concurrency`. If tasks depend on one another, sequence them in the
parent or use a workflow instead.

For synchronous fail-fast work, use `failFast: true`. Add
`cancelSiblingsOnFailure: true` only when already-running siblings should also
be interrupted.

## Choose Lifecycle

Use synchronous execution when the next action needs the result. Use async only
when work can overlap or continue independently.

For an async run:

1. Retain the returned `runId`.
2. Mark whether it is `needed-before-final` or `background`.
3. Continue only work that does not depend on its result.
4. Use the subagent `wait` action once when the result becomes necessary.
5. Inspect the terminal run status; a completed wait does not imply a successful
   child run.

Use lifecycle actions instead of polling artifact files:

```json
{ "action": "status", "runId": "run_..." }
{ "action": "logs", "runId": "run_..." }
{ "action": "wait", "runId": "run_...", "timeoutMs": 300000 }
{ "action": "reconcile", "runId": "run_..." }
```

A wait timeout ends only the wait. It does not stop the run. Interrupt only when
cancellation is intended, and verify the returned interruption status rather
than assuming the process stopped.

## Preserve Evidence

Run records under `.pi/agent/runs/` are authoritative lifecycle evidence. Do
not delete or clean `.pi` while a run is active. Removing a run record does not
terminate its process and can turn an ordinary child failure into an
unresolvable `not-found` result.

Failed or cancelled worktrees are retained for diagnosis. Inspect their status
and diff artifacts before cleanup.

## Diagnose Before Retrying

- **Validation:** Correct incompatible backend, visibility, sandbox, workspace,
  or tool settings. No worker may have launched.
- **Ambiguous model:** Qualify the model with its provider and retry once.
- **Sandbox or credential denial:** Report the denied capability. Do not weaken
  isolation automatically.
- **Wait timeout:** The run may still be active. Use status or wait again only
  when more waiting is justified.
- **Not found:** Check whether state was deleted, moved, or resolved from the
  wrong legacy root. Do not claim the process is gone without proof.
- **Child failure:** Read the bounded result and stderr artifacts, then report
  the actual task or model failure rather than calling it an infrastructure
  failure.

## Finish

Before relying on a result, verify the terminal status, selected provider/model,
expected tool authority, workspace evidence, and repository changes. Report the
run id, outcome, validation performed, and remaining uncertainty.
