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
plan  read-oriented; write/edit/delete are blocked and bash writes are refused
       by the command classifier

auto  direct host tools are available; bash remains classified and may ask or
      refuse according to policy, but there is no OS write boundary

hack  direct host tools are available with safeguards disabled
```

Most implementation work should be delegated to isolated subagents. Auto and
hack remain available for quick direct work where delegation would be overhead.

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
