# Command and tool reference

The surface is small on purpose. Most of what the old system exposed as a
command is now either a tool the maestro calls while you talk to it, or
something it does without being asked.

## Commands

| Command | What it does |
| --- | --- |
| `/mode [plan\|auto\|hack]` | Switch posture. No argument reports the current one |
| `/run [slug]` | Run a stored plan. No argument lists what is stored |
| `/stop [why]` | Halt the running plan and end its workers |

`/run` is also how a plan resumes. There is no separate verb: a run whose
maestro died leaves records the next `/run` reclaims — in-flight deliverables
become unstarted again, any worker still executing with nobody to report to is
ended, and the work restarts in the worktree it was already using. `/stop`
leaves a plan in exactly the same state, so stopping and resuming are one
mechanism rather than two.

## Modes

Two properties, three coherent combinations. Safeguards do **not** propagate: a
worker is never in hack, whatever the seat is in.

| Mode | Working tree | Safeguards |
| --- | --- | --- |
| `plan` | read-only | on |
| `auto` | writable | on |
| `hack` | writable | off |

A read-only seat cannot run a plan, because every deliverable produces a writer.

## Tools

Held by the maestro:

- `plan` — author or replace the whole plan document in one call. Rejections
  come back with every error at once, not the first.
- `flight` — carry out the plan's own preflight/postflight prose.
- `respond` — answer a worker's blocked question, or escalate it to you.
- `bash` — the gated shell, confined to the repository.
- `subagent` — start a read-only subagent with a persona and wait for its
  answer. The subagent stays held afterwards: `{id, question}` asks it a
  follow-up in the conversation it kept, and calling with no arguments lists
  what is held. "One-shot" is just a caller choosing not to ask twice.
  `fanOut` reviews across model families: one lead on the caller's own model
  consults a blind member per family and returns a single aggregated,
  de-attributed answer. `family` starts a subagent on a named family's model,
  resolved through the roster — an unknown family is refused naming the ones
  that exist.

Held by a worker:

- `commit` — record work on its deliverable's branch. The maestro pushes and
  opens the pull request; a worker never does.
- `bash` — the gated shell, confined to its worktree.
- `subagent` — as above. This is how a worker gets its own diff reviewed.
- `finish` — report the outcome and hand off. It then waits: the maestro ships
  and records the result before releasing it.

A read-only agent holds two of these: `bash` — gated read-only, so
write-effect commands are refused with the reason, and confined by the OS
besides — and `subagent`, because a reader consulting another reader is
ordinary and depth is the cap. The rest of its surface is the allowlist it
was launched with: `read`, `grep`, `find`, `ls`, `websearch`, `webfetch`. It
never holds `edit` or `write`, which write in-process where the sandbox
cannot see them, and never `commit` or `finish` — a reader answers its
caller, and changes nothing worth recording.

`ask` is not in these lists because it belongs to `packages/ask`. What differs
by position is not the tool but the transport behind it: a worker's questions
route to its maestro, and a maestro with no transport falls back to its local
UI, which is you.

Nothing here is a list to keep in step with the implementation. Grants are
derived from one declaration, and a tool declared without an implementation
fails at construction.

## `/maestro` scripting

`/maestro` comes from the settings extension, not from maestro itself:

```text
/maestro show
/maestro get <key>
/maestro set [--session|--project|--global] <key> <JSON-value>
/maestro reset [--session|--project|--global] <key>
/maestro explain <model-role>
/maestro validate
```

## Plan state

Plans live at `<agentDir>/maestro/plans/<slug>/`, as `plan.json` (what was
authored) and `run.json` (what happened). They are separate files because they
have separate lifetimes — a plan is rewritten when it is amended, a run on
every transition.

Nothing derivable is stored. A deliverable no dependent can reach is
*stranded*, but that is a fact about the plan's shape plus the set of failures,
so it is computed rather than written down. To discard a plan, remove its
directory; the runtime never silently migrates or deletes these records.
