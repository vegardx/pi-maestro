---
name: drive-maestro-e2e
description: Drive a real pi-maestro end to end from outside — boot the harness in RPC mode, send the plan, answer its questions, and assert on real shipped outcomes. Use when validating that the maestro harness actually works after a change, or when a human asks to "run the e2e" / "drive a full test".
---

# Drive the pi-maestro end-to-end test

You are the **driver**. A separate, real `pi --mode rpc` process runs the full
maestro extension stack (real workers, real RPC, real ship). You control it
through a tiny CLI that talks to a background daemon over a unix socket. Your job
is to push a canned plan all the way to **shipped**, answering every question the
maestro raises, then assert the outcome.

This is the pi-native version of an external agent driving a coding harness: pi
already exposes the control channel (`--mode rpc` + the `extension_ui_request`
dialog sub-protocol), so *you answering a question* is just the driver doing its
job — no MCP, no bespoke protocol.

## The control CLI

Run everything from the pi-maestro repo root. Prefix each call with the runner:

```
node_modules/.bin/jiti test/e2e/driver/cli.ts <subcommand>
```

| Subcommand | What it does |
| --- | --- |
| `start [--live \| --ci] [--local-remote] [--keep] [--model <pat>]` | Boot the SUT + sandbox. **Run this in the background.** Prints a `ready` JSON line with `repoDir`, `piHome`, and `planPrompt`. |
| `state` | The maestro's pi state (`isStreaming`, model) + the plan's deliverables and their statuses. |
| `poll` | New events since the last poll **and** `pending[]` — questions parked waiting for your answer. |
| `prompt "<text>" [--steer \| --follow-up]` | Send a prompt/command. Auto-queues as a follow-up if the agent is mid-stream. |
| `answer <id> "<value>"` | Answer a parked question. `<id>` comes from `poll`'s `pending[]`. For a select, `<value>` is the chosen option string; for a confirm, `true`/`false`. |
| `assert` | White-box assertions: every deliverable shipped, produced a PR, and its files are in git history. |
| `stop` | Tear down the SUT, the sandbox repo, and (live) the disposable GitHub repo. Always run this at the end. |

## The loop

1. **Start** (background):
   `node_modules/.bin/jiti test/e2e/driver/cli.ts start --live` — real models +
   a disposable private GitHub repo. Use `--live --local-remote` to skip GitHub
   (a local bare remote instead), or `--ci` for the deterministic mock-provider
   profile. Wait for the `ready` line; note the `planPrompt`.

2. **Enter plan mode, then describe the plan.** Send `prompt "/plan"`, then
   `prompt "<the planPrompt from the ready line>"`. (The planPrompt is the canned
   `sandbox-features` plan.)

3. **Drive to execution.** Send `prompt "/start"` to leave plan mode. The maestro
   will spawn workers.

4. **Poll and answer, repeatedly.** Every few seconds:
   `poll`. For each entry in `pending[]`, decide the answer that advances the
   work toward shipped and send `answer <id> "<value>"`. Watch `state` — keep
   going until every deliverable status is `shipped` (or `failed`).
   - You are a capable agent: read the question and answer it sensibly. Prefer
     options that move execution forward (e.g. "Enter execution", "Ship").
   - Workers may take minutes. Poll patiently; don't spam prompts.

5. **Assert.** Run `assert`. `ok: true` means every expected deliverable shipped
   with a PR and files in history. If `ok: false`, read `result.checks` and
   `result.summary` to see which deliverable stalled and why.

6. **Stop.** Always finish with `stop`, even on failure, so the disposable repo
   and temp dirs are cleaned up.

## Notes

- **Never edit the harness to make the test pass.** The whole point is to run the
  real code unmodified and see whether it works.
- If `state` shows `plan.found: false` after you sent the plan, the plan wasn't
  created — re-read the events from `poll` to see what the maestro said.
- The scripted, deterministic version of this same flow is
  `test/e2e/real.e2e.test.ts` (run with `npm run test:e2e:full`); it uses the
  same driver core but a fixed prompt sequence and rule-based answers.
- Full reference: `docs/e2e-testing.md`.
