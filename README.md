# pi-maestro

A [Pi](https://pi.dev/) package for interactive planning, mode posture, prompt
assistance, structured questions, compact summaries, and a curated skill catalog.

Pi-maestro intentionally does not own delegated execution, workflow scheduling,
or web research:

- delegated work is provided independently by `@vegardx/pi-subagent`;
- workflow execution is provided independently by `@vegardx/pi-workflow`, which
  runs a stored plan through its `plan-to-ship` workflow;
- web tooling is unavailable until the owned replacement is built.

## Seat

The interactive seat can inspect, plan, and make direct changes when requested:

A posture is three facts — working-tree access, safeguards, and what happens at
the end of a plan run started from it — and the four names are the only coherent
combinations:

```text
plan  write/edit/delete are blocked; recognized Bash reads run, while writes,
      code execution, and unresolved effects are refused. Forms no run

ask   direct host tools are available; ordinary workspace work runs while
      consequential or unresolved Bash effects may require confirmation.
      A plan run parks at its ship decision and this session asks you

auto  the same permissions as ask, to the letter. A plan run has no ship gate:
      it completes and the pull request is published

hack  direct host tools are available under a reduced, configurable policy.
      Forms no run: leaving plan mode to hack only switches
```

Bash uses deterministic effect assessment followed, when needed, by a bounded
fast-model audit. The auditor can inspect host-installed CLI help through
validated direct-argv probes; it never authorizes execution or removes known
effects. This is steering and confirmation, not an OS sandbox.

Most implementation work should be delegated to isolated subagents. Ask, auto and
hack remain available for quick direct work where delegation would be overhead.
The bundled `repository-lifecycle` skill guides explicit commits, feature-branch
pushes, pull requests, checks, and checked rebase merges.

## Commands

```text
/mode [plan|ask|auto|hack]
```

The plan lives in the conversation. **Leaving plan mode is Go**, and the mode you
leave to decides the end of the run: the session's own model forms the plan into a
document, a one-shot subagent reads it in a fresh context, and one confirmation
offers the run. The run executes in the background and the session narrates it.
From `ask` it parks at its ship decision and this session asks you in a dialog with
the gate's inputs rendered; from `auto` the pull request is published when the run
is done and its link lands in the conversation. A failure mid-run is offered as
retry, stop, or re-plan. Tools: `bash`, `delete`, `plan_ship_dialog`.

See [commands](docs/commands.md), [usage](docs/usage.md), and
[architecture](docs/architecture.md).

## Development

```bash
npm install
npm run check
```

The repository has no end-to-end or live acceptance suite while its execution
model and testing claims are reassessed.
