# pi-maestro

A structured [pi](https://github.com/badlogic/pi-mono) coding-agent extension
stack: permission modes, plan/deliverable execution, subagents,
questionnaires, prompt assistance, and commit/ship workflow.

The repo root is the pi bundle manifest. Pi loads TypeScript extension entries
through jiti; there is no build step.

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

## What is included

- `/plan`, `/implement`, `/ship`, `/sync`, `/park`, and mode switching.
- `ask.v1`, `subagents.v1`, `commit.v1`, `modes.v1`, and
  `prompt-assist.v1` capabilities.
- Work-continuity compaction (`smart-compact`): replaces pi's default
  compaction summary with a work-focused one, with safe fallback.
- Library packages for contracts, core runtime, settings, models, UI, git, and
  GitHub seams.

## Docs

- [Usage](docs/usage.md)
- [Architecture](docs/architecture.md)

## Development

```bash
npm install
npm run check
```
