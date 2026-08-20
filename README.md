# pi-maestro

A [Pi](https://pi.dev/) package for interactive planning, mode posture, prompt
assistance, structured questions, compact summaries, and a curated skill catalog.

Pi-maestro intentionally does not own delegated execution, workflow scheduling,
or web research:

- delegated work is provided independently by `@vegardx/pi-subagent`;
- workflow execution is unavailable until `@vegardx/pi-workflow` is built;
- web tooling is unavailable until the owned replacement is built.

## Seat

The interactive seat can inspect, plan, and make direct changes when requested:

```text
plan  write/edit/delete are blocked; recognized Bash reads run, while writes,
      code execution, and unresolved effects are refused

auto  direct host tools are available; ordinary workspace work runs while
      consequential or unresolved Bash effects may require confirmation

hack  direct host tools are available under a reduced, configurable policy
```

Bash uses deterministic effect assessment followed, when needed, by a bounded
fast-model audit. The auditor can inspect host-installed CLI help through
validated direct-argv probes; it never authorizes execution or removes known
effects. This is steering and confirmation, not an OS sandbox.

Most implementation work should be delegated to isolated subagents. Auto and
hack remain available for quick direct work where delegation would be overhead.
The bundled `repository-lifecycle` skill guides explicit commits, feature-branch
pushes, pull requests, checks, and checked rebase merges.

## Commands

```text
/mode [plan|auto|hack]
```

The `plan` tool stores authored intent under the Pi agent directory. Stored plans
are not executable until the owned workflow extension is introduced.

See [commands](docs/commands.md), [usage](docs/usage.md), and
[architecture](docs/architecture.md).

## Development

```bash
npm install
npm run check
```

The repository has no end-to-end or live acceptance suite while its execution
model and testing claims are reassessed.
