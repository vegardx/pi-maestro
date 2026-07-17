# Design: persona-registered slash commands

Status: proposed. Captures the design agreed while reviewing the cutover.

## Motivation

`/verify` is a bespoke maestro command: it hand-rolls target selection
(`verifyTargets`), evidence gathering (`gatherEvidence`), a persisted round, and
a remediation flow — around what is essentially "spawn a read-only `verifier`
agent over a deliverable's diff." The `verifier` agent kind already exists
(`packages/contracts/src/agents.ts` `AGENT_KINDS`). Personas are already a
data-driven registry (`AgentKindDefinition` in `packages/subagents/src/registry.ts`),
so we can let a persona *optionally* expose a slash command and drive it with one
generic handler — turning `/verify` into "the verifier persona declares a
command" and generalizing the pattern to `/code-review` and others.

## The shape

Add one optional field to `AgentKindDefinition`:

```ts
command?: {
  name: string;        // the slash command, e.g. "verify", "code-review"
  description: string; // shown in /help
  // Prose that tells the maestro how to drive it, INCLUDING what a bare
  // (no-argument) invocation should do. The maestro interprets this: it can
  // offer options, pick a sensible default, or ask for a free-text brief.
  instruction: string;
}
```

One load-time loop in the modes runtime registers them:

```ts
for (const kind of registries.kinds.list())
  if (kind.command) pi.registerCommand(kind.command.name, genericPersonaHandler(kind));
```

`genericPersonaHandler(kind)` does what `/verify` hand-rolls today: read
`kind.command.instruction`, resolve the target (from the argument, or by asking
the user per the instruction), resolve the model for `role: kind.modelRole`,
`subagents.spawn` the persona with its `prompt`/`runtimePolicy`, and surface the
report into the maestro's agent view / HUD.

### "Target" = what you point it at

The argument (or the instruction's bare behavior) selects what the persona runs
against. In practice two answers cover it:

- a **deliverable** — `/verify <id>`, or `/code-review <id>` (its diff + tasks);
- **the current repo's changes** — `/code-review this repo` (working-tree diff),
  `/code-review this branch` (branch vs default).

Bare invocation is defined by the `instruction`, not a fixed rule — e.g.
`/code-review` with no argument can offer "current changes / this branch /
a specific deliverable" and then run the chosen one.

### Worked examples

- **verify** (migrate the existing command):
  `{ name: "verify", description: "Deep-verify that a deliverable's tasks were genuinely done, from its real diff.", instruction: "If no deliverable is given, list the started deliverables and let the user pick one or all; verify each against its actual diff." }`
- **code-review**:
  `{ name: "code-review", description: "Review code changes in the repo or a deliverable.", instruction: "Review code changes. If the user didn't say what to review, offer: the current changes, this branch (vs the default branch), or a specific deliverable — then review what they choose." }`

## Output posture (resolves review finding #5)

Persona-commands **surface a report**; they do not auto-remediate. `/verify`'s
current `applyRemediation` (which reopens deliverables on a `fail` verdict, keyed
on the prose `VERDICT:` line) is what made the prose-vs-structured verdict
mismatch matter. Making persona-commands report-only under the trust-the-worker
model removes that coupling and closes finding #5 in the cutover review. A human
reads the report and decides.

## Non-interference with worker-side persona use (the one guardrail)

The same persona is spawned inside a worker's `review()` panel today. That must
keep working unchanged, so:

- **The spawn/execution path must never read `command`.** It is metadata read
  only by the maestro's command-registration loop. A worker spawning
  `correctness-review` uses the kind's `prompt`/`runtimePolicy`/`contracts` and
  never looks at `command`.
- **Keep persona prompts context-supplied.** The caller provides the diff/target
  (`REVIEW_BASE` already says "inspect *the requested change*"), so a reviewer
  runs identically whether a worker panel hands it a deliverable diff or
  `/code-review` hands it the current repo. Never bake "I am a slash command" or
  "I am in a worker" into a persona prompt.
- A maestro `/code-review` is a standalone, ad-hoc spawn: it does **not** join a
  worker's review round or resolution ledger. Model resolution differs by caller
  exactly as it does today; `command` does not change it.

## Extensibility (later)

Because the kind registry supports `.register`, this naturally extends to
custom/plugin personas bringing their own commands. That is a capability surface
to gate (who may register, permissions) — treat it as a follow-up, not part of
the first cut.

## Status (implemented)

1. **Done.** `command` field on `AgentKindDefinition` + the generic registration
   loop; `correctness-review` exposes `/code-review`.
2. **Done.** `/verify` is report-only (the `applyRemediation` auto-reopen path
   was removed) and is now registered via the loop: a `delivery-verifier` kind
   (`modelRole: "verifier"`, `command.target: "deliverables"`) fans out over
   started deliverables through `runDeliveryVerification`; the bespoke
   `pi.registerCommand("verify")` is gone.

The `command.target` field (`"changes"` | `"deliverables"`) routes the generic
handler: single-spawn over the repo's current changes (default, e.g.
`/code-review`) vs. per-deliverable fan-out (`/verify`).
