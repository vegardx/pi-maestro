# Workflow plans

An authored plan describes repositories, deliverables, dependency edges,
implementation tasks, and delegated reviews. It is intent, not a second runtime
state machine.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- implementation tasks;
- `after` dependencies that order work;
- `reads` dependencies whose repositories may be consulted;
- optional review tasks with `{lens, model, skill?}`.

`reads` must remain a subset of `after`.

## Compilation

The thin compiler creates one `pi-workflow` artifact graph.

```text
implementation stages
  → review stages per deliverable, in parallel
  → fixer stage per reviewed deliverable
```

Same-repository implementation stages are serialized in authored order.
Cross-repository `after` edges become workflow order edges. Prompts carry exact
repository paths because repositories may be children of a non-Git umbrella
working directory.

## Commit ownership

Implementation and fixer stages own local commits:

- implementation creates conventional implementation commits;
- fixes create new follow-up commits and never amend implementation history;
- reviewers do not modify files or commits;
- no workflow stage pushes.

The interactive seat owns publication only through `/publish <slug>`.

## Reviews

A review task selects a concrete provider/model, lens, and optional ambient
skill. The reviewer inspects committed work and returns:

- an evidence-backed claim;
- repository/path observations;
- an advisory suggested change.

The fixer evaluates suggestions independently. A suggestion is not a mandatory
resolution.

## Runtime ownership

Pi-workflow owns run IDs, scheduling, artifacts, failure state, and resume.
Pi-subagent owns model processes. Pi-maestro does not mirror either package's
state.

Compiled bundles live under `<cwd>/.pi/maestro/workflows/`; workflow run state
lives under `<cwd>/.pi/workflows/`.
