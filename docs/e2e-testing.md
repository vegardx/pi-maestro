# End-to-end testing

Three tiers. Pick the lowest that can catch the bug you care about — then read
the warning under tier 3 before deciding you are finished.

| Tier | Run with | What is real | Speed |
| --- | --- | --- | --- |
| Unit | `npm test` | pure logic, no I/O | seconds |
| Hermetic e2e | `npm run test:e2e` | a real seat, real worktrees, real sockets, real detached processes — scripted model | seconds |
| Live drive | `npm run e2e:live` | all of it, including the models and a real git remote | minutes |

## Hermetic e2e

`test/e2e/maestro/drive.e2e.test.ts` boots a real pi seat against
`test/e2e/maestro/scripted-model.ts` — an HTTP server speaking the Anthropic
Messages SSE API that synthesizes tool-call turns.

The mock keys on **which tools a session holds**, not on prompt wording. A
session holding `finish` is a worker; one holding `flight` is the maestro. That
matters: keying on prose meant a reworded persona silently changed which actor
the mock thought it was talking to.

Everything else is real — the socket, the worktrees, the commits, the release,
the run record. The only substitutions are the model and the network.

## Live drive

```bash
npm run e2e:live                # SIT models
npm run e2e:live -- --recover   # SIGKILL the maestro mid-flight, start a new one
npm run e2e:live -- --prod-models
npm run e2e:live -- --keep      # leave the sandbox for inspection
```

It creates a disposable repo under `~/src/github.com/`, an isolated pi home, a
local bare remote and a `gh` shim, seeds a two-deliverable plan, and drives it
to shipped. The first deliverable builds a module, hands the diff to a
reviewer, acts on the findings, and only then reports; the second reads its
hand-off.

Green looks like:

```
stats=shipped  summary=shipped
```

with real commits on `deliverable/stats` and `deliverable/summary`.

**The repo must live under `~/src/github.com/`** (or `PI_E2E_CHECKOUT_ROOT`) —
not a temp dir. The sandbox writes its own `$HOME/.gitconfig` for identity, and
the placement keeps worktrees beside the repo where they are reaped with it.

### Reading a failure

Read the `failure:` text in the result block first. The worker writes it and it
is usually exact — one run said it could not commit because the shell refused it
and named a tool that was not in its tool set, which was the entire bug in one
sentence. Then `run.json` under the printed pi home, then `events.jsonl` (lines
beginning `[maestro]` are what the seat narrated), then `git log --all`.

### Cleaning up

Without `--keep` the drive removes its own sandbox. After an interrupted run,
remove the repo at `~/src/github.com/pi-e2e-repo-*`, its sibling
`~/src/github.com/worktrees/<same-name>/`, and the `pi-e2e-{home,gh,remote}-*`
directories under the system temp dir. Use `git worktree remove --force` rather
than `rm` alone, or the repo keeps metadata pointing at paths that are gone.

## Nothing runs e2e in CI

There was a workflow. It ran only the old system's drive — against
`packages/modes`, which was being deleted — so it reported success on every PR
while the rebuilt maestro's own drive sat broken from the moment the bash
classifier was wired. A green check covering the wrong thing is worse than no
check, so it was removed rather than repaired.

**Tiers 1 and 2 cannot see the seam between processes**, and that is where every
serious bug in this system has lived. In one day the live drive found: a shell
gate that refused every commit because the tool it named was never declared; a
git identity carried as environment that overrode the developer's path-scoped
config; a restarted maestro that wedged a plan while narrating nothing; and
children inheriting env vars that had been omitted expecting absence. Every one
had a fully green suite over it.

So: **run the live drive before calling done anything that touches the shell
gate, the spawn path, git identity, or shipping.** No job will do it for you.

One consequence worth knowing: `test/realtree-sandbox-live.test.ts` — the only
test that proves the OS actually denies a write — runs on macOS only. It is the
proof that sandbox confinement works, and it has never run anywhere but a
developer's laptop.
