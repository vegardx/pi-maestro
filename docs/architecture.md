# Architecture

Pi-maestro is the interactive composition layer of the Pi distribution. One Pi
process is the seat. It owns planning and posture, not delegated execution.

```text
interactive seat
  mode posture
  plan authoring/store
  classified host bash
  recoverable delete
  prompt assistance
  smart compaction
  structured questions
  curated skills

standalone packages
  @vegardx/pi-subagent   delegated execution and operator UX
  @vegardx/pi-workflow   deferred
  owned web extension    deferred
```

There is no custom worker socket, executor, workflow scheduler, publication
pipeline, question transport, web stack, or recovery layer in pi-maestro.

## Ownership

| Concern | Owner |
| --- | --- |
| Interactive mode posture | pi-maestro |
| Plan vocabulary, validation, and storage | pi-maestro |
| Direct seat bash classification | pi-maestro |
| Recoverable delete | pi-maestro |
| Delegated model execution | standalone `@vegardx/pi-subagent` |
| Workflow scheduling and publication | unavailable until `@vegardx/pi-workflow` |
| Web research tools | unavailable until the owned web extension |
| Structured model-authored questions | `@juicesharp/rpiv-ask-user-question` |
| Prompt assistance and compaction | local pi-maestro extensions |

## Seat authority

The seat supports three explicit postures:

- **plan** — direct `write`, `edit`, and `delete` calls are blocked. Bash remains
  available for inspection, but the classifier refuses write effects.
- **auto** — direct host tools are available. Bash is classified and may be
  allowed, confirmed, or refused according to execution policy. There is no OS
  filesystem boundary.
- **hack** — direct host tools are available with safeguards disabled.

The bash classifier is guidance and a refusal rail, not a sandbox claim. Built-in
`write` and `edit` are host-backed in auto and hack. The user selects those modes
when direct seat work is preferable to isolated delegation.

Most implementation work is expected to run through standalone subagents, which
own Gondolin isolation, worktrees, retry/resume, persistence, and operator
controls.

## Plans

The `plan` tool stores repository-qualified authored intent:

```text
<agentDir>/maestro/plans/<slug>/plan.json
```

A plan contains repositories, deliverables, ordering, read dependencies, tasks,
and delegated review intent. Pi-maestro validates and stores this vocabulary but
does not execute it. The future owned workflow extension will define the runtime
lowering and state model.

## Extension loading

The root package loads:

- structured ask adapter;
- prompt-assist;
- smart-compact;
- the Maestro seat extension;
- bundled skills through normal Pi discovery.

Subagent, workflow, and web extensions are not bundled. This prevents duplicate
runtime ownership and lets each standalone package carry its own release and
acceptance boundary.
