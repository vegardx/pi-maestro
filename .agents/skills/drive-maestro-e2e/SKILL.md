---
name: drive-maestro-e2e
description: Run the pi-maestro live drive — real models, real worktrees, real commits, all the way to shipped. Use when validating that the maestro actually works after a change, or when a human asks to "run the e2e" / "drive a full test".
---

# Drive pi-maestro end to end

This skill used to describe a control CLI and background daemon that an agent
drove subcommand by subcommand. That CLI is deleted along with the system it
drove. The drive is now one command that runs itself.

## Run it

From the repo root:

```
npm run e2e:live
```

| Flag | What it does |
| --- | --- |
| `--recover` | SIGKILL the maestro while a worker is in flight, then start a new one over the same store. The interesting one. |
| `--prod-models` | Use the prod profile instead of SIT. |
| `--keep` | Leave the sandbox on disk for inspection. |

It prints the disposable repo and the isolated pi home it created, then a line
each time a deliverable changes standing, then a result block with hand-offs
and PR numbers. A run takes minutes; do not interrupt it to check progress —
read `run.json` (below) instead.

## What it proves

A seeded two-deliverable plan. The first builds a small module, hands the diff
to a **reviewer**, acts on the findings, and only then reports. The second reads
the first's hand-off. Green is:

```
stats=shipped  summary=shipped
```

with real commits on `deliverable/stats` and `deliverable/summary`. A worker
spawning a review and acting on it *before* shipping is the acceptance bar — it
never once happened in the previous system.

`--recover` additionally proves a maestro can be killed mid-flight and replaced:
the new one reclaims the in-flight deliverable, kills any orphan worker still
running with nobody to report to, and relaunches into the same worktree.

## Reading a failure

**Read the `failure:` text in the result block first.** The worker writes it and
it is usually exact — one run said it could not commit because the shell refused
it and named a tool that was not in its tool set, which was the entire bug in one
sentence.

Then, in order:

1. `<piHome>/.pi/agent/maestro/plans/live-drive/run.json` — what state each
   deliverable reached, and why.
2. `<piHome>/events.jsonl` — the RPC transcript. `[maestro] …` lines are what
   the seat narrated.
3. `git -C <repo> log --oneline --all` — what actually got committed.

## Clean up

Without `--keep` the drive removes its own sandbox. After an interrupted run,
remove by hand: the repo at `~/src/github.com/pi-e2e-repo-*`, its sibling
`~/src/github.com/worktrees/<same-name>/`, and the `pi-e2e-{home,gh,remote}-*`
directories under the system temp dir. Remove worktrees with
`git worktree remove --force`, not `rm` alone, or the repo keeps metadata
pointing at paths that no longer exist.

## Model profiles

`live.ts` reaches two: **SIT** (default, `driver/sit-profile.ts`) and **prod**
(`--prod-models`, `driver/prod-profile.ts`).

A **Copilot** profile also exists (`driver/copilot-profile.ts`,
`driver/copilot-auth.ts`) and is *not currently wired into `live.ts`* — the flag
that selected it belonged to the deleted CLI. The code is intact, so reaching it
again is a small change rather than a rewrite. Two things learned the hard way
and worth keeping if you do:

- Copilot refreshes its token **during** a run, because pi resolves
  `github-copilot` natively. Nothing is frozen into a `models.json`, so a long
  drive cannot outlive its credential — which SIT drives have done.
- The device code lives about fifteen minutes and needs a human at a browser.
  **Do not mint one on a timer while nobody is there.** Two lapsed that way in a
  single session. Mint it when the human says they are ready, and hand it over
  immediately.

## When to reach for this

Whenever a change touches the shell gate, the spawn path, git identity, or
shipping. Unit and hermetic tests cannot see the seam between processes, and
every serious bug in this system has lived exactly there — four in one day, each
under a fully green suite. **No CI job runs this**; e2e cannot run on GitHub
today, so it happens only if you do it.
