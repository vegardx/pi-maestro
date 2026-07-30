# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Pi loads the workspace TypeScript directly. Shipping requires `gh`.

## Modes

Two properties — whether the working tree is writable, and whether safeguards
are on — giving three coherent combinations.

| Mode | Working tree | Safeguards |
| --- | --- | --- |
| `plan` | read-only | on |
| `auto` | writable | on |
| `hack` | writable | off |

`/mode` with no argument reports where you are; `/mode auto` switches.

A read-only seat cannot run a plan, because every deliverable produces a worker
that writes. Safeguards do **not** propagate: a worker is never in hack,
whatever the seat is in.

## Planning

Planning is a conversation. You converge on what to build and why, and the
maestro authors the plan when you have. There is no separate forming command —
it calls the `plan` tool, which takes the **whole document** in one go and
answers with every error at once rather than the first.

A plan is deliverables in a graph. Each has an ordered list of work, `after` for
ordering, and `reads` for data flow — what it actually inherits from a
predecessor, which must be a subset of what it waits for. Waiting for something
does not mean paying for its hand-off in context.

Plans are stored under `<agentDir>/maestro/plans/<slug>/` as `plan.json` (what
was authored) and `run.json` (what happened). Two files because they have two
lifetimes.

## Running

`/run` with no argument lists what is stored; `/run <slug>` starts one.

Each deliverable gets its own worktree and branch. The maestro creates them —
deterministic code, not a model turn — then launches a worker, which does the
work, commits, and reports. The maestro ships the branch, opens the pull
request, records the result, and only then releases the worker. A worker never
pushes.

`/run` is also how a plan resumes. There is no separate verb: a run whose
maestro died leaves records the next `/run` picks up, and a plan that cannot go
any further says why rather than sitting silent.

`/stop [why]` halts the run and ends its workers. A halted deliverable becomes
unstarted again and keeps its worktree, so running the plan again re-enters the
tree it was already using rather than starting the work over.

## Questions

A worker that gets stuck can `ask`. The question travels to the maestro, which
reasons about it in the plan context it already has and answers with `respond` —
or, if it genuinely cannot, asks you and passes on what you say. The worker is
blocked the whole time, and the answer records who decided, so it can tell your
ruling from the maestro's guess.

You are not expected to be watching. A question reaching you means the maestro
could not answer it.

## Review

There is no review command. A worker hands its own diff to a reviewer and acts
on what comes back before it reports — which is the point, since a review nobody
acts on is a review that did not happen.

`delegate` can fan out: one reader per model family, every answer returned
**unreconciled**. Flattening several opinions into one is how findings get lost.

## Safeguards

Every shell command is classified before it runs and runs confined to the
agent's own tree, enforced by the OS. Some commands are refused with a reason
and something to do instead — committing goes to the `commit` tool, deleting to
`delete`, fetching a URL to `webfetch`. A refusal is an answer, not a failure to
work around.

`/maestro` (from the settings extension) inspects and edits configuration:

```text
/maestro show
/maestro get <key>
/maestro set [--session|--project|--global] <key> <JSON-value>
```

See [commands.md](commands.md) for the full command and tool reference, and
[settings.md](settings.md) for the configuration keys.
