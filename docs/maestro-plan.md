# Maestro execution — group-based model

Status: **active** — group model implemented (PR #135).

## Goal

The main session (maestro) is always free during implementation. Workers
execute group tasks. The user stays interactive — can add work, steer
agents, answer questions.

## Model

A **group** is the atomic unit of work — one branch, one PR:
- A **worker** (primary agent, full mode, gets tasks)
- Zero or more **support agents** (with focus, mode/slot/effort, DAG via `after`)

### Tools (flat params, no nested JSON)

```
group(action="add", title, body, dependsOn?, workerMode)
task(action="add", groupId, title, body?)
agent(action="add", groupId, name, mode, slot, effort, focus, after)
```

### States

```
planned → active → complete → shipped | superseded | abandoned
```

### Shipping rule

Maestro ships when group completes AND nothing depends on it.
Groups with dependents stay `complete` until downstream resolves.

## Planning philosophy

- Research via delegates (explorer, researcher, advisor)
- Plan IS the research output — tasks so detailed a simpler model could implement
- Convergence: "can I write tasks with file paths and signatures?" = ready
- Workers follow instructions, they don't design

## Delegates

| Target | Slot | Effort | Purpose |
|--------|------|--------|---------|
| explorer | default | low | Codebase facts |
| researcher | default | low | Web docs/practices |
| advisor | alternate | high | Different model's perspective |

## Agent lifecycle

1. Maestro activates group (deps met)
2. Creates worktree on `feat/{groupId}`
3. Spawns worker → receives tasks
4. Worker commits, toggles tasks → done
5. Maestro sends summarize RPC → extracts summary
6. Spawns next agents in graph (via `after`)
7. All agents done → group complete
8. Terminal group → ship (push + PR)
9. Predecessors → superseded

## Stacked PRs (default)

Group B (dependsOn A) branches from `feat/group-a` tip.
`stacked: false` → branch from main.

## Seed ordering (cache optimization)

```
Worker:  [dep summaries] → [group body + tasks]
Agent A: [dep summaries] → [worker summary] → [A's focus]
Agent B: [dep summaries] → [worker + A summaries] → [B's focus]
```

Stable/shared prefix first → agent-specific last.
