# pi-maestro

A [Pi](https://pi.dev/) composition package for planning implementation work,
running it through public workflow/subagent extensions, and publishing the
result from the interactive seat.

Pi-maestro bundles:

- `@agwab/pi-workflow` for workflow scheduling and artifacts;
- `@agwab/pi-subagent` for delegated model runs;
- `@juicesharp/rpiv-ask-user-question` for structured model-authored questions;
- `pi-web-access` for web research tools;
- a curated skill catalog;
- small local extensions for modes, planning, the footer, guarded shell access,
  and deterministic pull-request publication.

It does not implement a second worker, socket, question, web, or recovery stack.

## Workflow

```text
conversation in plan mode
  → Maestro stores a repository-qualified plan
  → /mode auto or /run <slug> previews one compiled pi-workflow workflow
  → human approves
  → implementers edit, validate, and commit locally
  → reviewers inspect commits and suggest changes without modifying files
  → fixers apply justified findings, validate, and create follow-up commits
  → workflow ends with clean committed feature branches
  → /publish <slug> pushes and creates or updates pull requests
```

Pi-workflow owns run status and resume behavior. Pi-maestro does not mirror its
scheduler or maintain a parallel recovery journal.

## Commands

```text
/mode [plan|auto|hack]
/run [slug]
/publish <slug>
/maestro
```

See [commands](docs/commands.md), [usage](docs/usage.md), and
[architecture](docs/architecture.md).

## Development

```bash
npm install
npm run check
```

The repository has no end-to-end or live acceptance suite while its execution
model and testing claims are reassessed.
