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
| `auth copilot [--domain <host>]` | One-time device-code login for the Copilot drive (default `dnb.ghe.com`). Prints a URL + code for a **human** to approve; stores the credential beside the driver. |
| `auth login \| status \| logout` | The same for the radicalai-sit gateway (browser PKCE). |
| `start [--live \| --ci] [--copilot-models \| --multi-model \| --sit-models] [--seed-plan] [--local-remote] [--keep] [--model <pat>]` | Boot the SUT + sandbox. **Run this in the background.** Prints a `ready` JSON line with `repoDir`, `piHome`, and `planPrompt` (plus `seededPlan` when seeded). |
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

   **Or skip authoring entirely with `--seed-plan`** (recommended for
   execution-focused drives, and required with weak local models — plan
   authoring is the most model-sensitive step): the daemon pre-writes the
   canned plan into the isolated store; send `prompt "/plan sandbox-features"`
   to open it ready-made, then go straight to step 3. Do NOT re-describe the
   plan or author deliverables in this mode.

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

## Multi-model drive (`--multi-model`)

`start --live --multi-model` boots against a **local ollama** profile that routes
maestro roles across distinct models instead of one session default — the real
test of the model-set machinery:

- **planner / session** → `gemma4:31b-mlx` · **normal** (worker/verify/
  research) → `qwen3.6:35b-a3b-coding-mxfp8` (MoE, fast decode) → `session` ·
  **fast** (classify/summarize/general) → `gpt-oss:20b` → `session` ·
  **reviewers** → `gpt-oss:20b → session` (both non-qwen vs the qwen workers).
- Requires the ollama service with those three models pulled (`ollama list`);
  models load on demand (5-min keepalive). All three ≈ 68 GB together.

Two extra checks worth running in this mode:

1. **Per-role routing.** `prompt "/models"` prints the full role→model table;
   `prompt "/models <role>"` (e.g. `worker`, `classifier`, `correctness-review`)
   details that role's candidate options and which was picked — confirm each
   resolves to the intended model above, proof that routing lands on different
   providers, not just the session default.
2. **Availability fallback.** With work idle, `ollama stop gpt-oss:20b`,
   then `prompt "/models correctness-review"` — it should now resolve to
   `gemma4:31b-mlx` (the session sentinel at the back of the pool). Restart
   the model after. This exercises the live version of the availability path.

The routing correctness itself is pinned deterministically (no ollama) in
`test/e2e/driver/multi-model-profile.test.ts`; this drive confirms ollama really
serves it end to end.

## Copilot drive (`--copilot-models`) — the preferred live profile

`start --copilot-models` runs on **GitHub Copilot** with a credential the driver
owns. Prefer this over `--sit-models`: pi resolves `github-copilot` natively, so
it refreshes the token **during** the run — nothing is frozen into a
`models.json`, and a long drive cannot outlive its credential.

**Login once** (needs a human at a browser — there is no way around it for the
authorization-code/device grants; the gateway advertises `client_credentials`,
which would be zero-touch, but needs a confidential client somebody with gateway
admin must provision):

```
npm run e2e:driver -- auth copilot        # prints a URL + code, waits, stores
```

The code lives ~15 minutes. **Do not mint codes on a timer while nobody is
there** — two lapsed in one session that way. Mint one when the human says they
are ready, and hand it over immediately.

Model layout, in **v2 shape** (catalogs / profiles / agent tier allowlists —
NOT the retired v1 `presets`+`modelSets`):

- seat `claude-opus-4.8` · `fast` `mai-code-1-flash-picker` ·
  `normal` `gpt-5.5` · `heavy` `claude-opus-4.8`
- allowlists: worker `[fast, normal, heavy]`, explorer `[fast, normal]`,
  reviewer `[normal, heavy]`

Traps this profile has already hit, all confirmed by experiment:

- **`404` from `dnb.ghe.com/login/device/code` means a missing content-type.**
  Node's `fetch` sends `text/plain` for a *string* body and GitHub Enterprise
  answers **404, not 415** — indistinguishable from a wrong URL. Pass
  `URLSearchParams` directly. The Copilot editor headers are NOT the cause
  (they were blamed first and are harmless).
- **The endpoint shown in `state` is a lie.** `pi.model.baseUrl` reports the
  static catalog default (`api.individual.githubcopilot.com`); real routing is
  derived per request by `toAuth` from the credential's `enterpriseUrl`. To
  check which seat is really in use, mint a token and `GET /models` against
  both hosts — the DNB seat returns 200 from `copilot-api.dnb.ghe.com` and is
  **rejected** by the individual endpoint (`unknown stamp`).
- pi's own login calls `enableAllGitHubCopilotModels`; Claude/Grok models must
  be enabled on the account before use. A fresh account may need that.

## Hosted multi-model drive (`--sit-models`)

`start --live --sit-models` is the hosted twin: real radicalai-sit gateway
models via a generated `models.json` (no provider extension). Uses the
**driver's own** gateway credential (`auth login`), refreshed automatically
before each drive. Burns real tokens; combine with `--local-remote` to ship
offline against a bare remote via the CI `gh` shim.

Caveat this profile has and Copilot does not: the access token is baked into
`models.json` at launch and lives ~1h, so a drive outliving it loses auth
mid-flight. Never refresh using the developer's pi credential — the gateway
**rotates** the refresh token, so that silently invalidates pi's copy (it
already happened once).

## Narrate the drive as it happens

A drive is not a pass/fail check — the point is to watch the machine think. Tell
the human what is happening at each **pivotal** beat, in your own words, not a
transcript dump:

- **Plan formed** — how many deliverables, what shape, and any decision the
  planner made that was not in the prompt (e.g. it discovered the sandbox has no
  scaffolding and folded a TS+vitest bootstrap into deliverable #1).
- **Plan review** — what the reviewer objected to and what changed as a result.
- **The gate ruling** and what you answered.
- **Each deliverable starting**, and on what branch/base.
- **Reviewers running** — their verdict and whether the worker acted on it.
- **What the parent agent decided** in ensemble runs.
- **Anywhere it got confused** — this is the most valuable output of the whole
  exercise. Record the confusion, do not paper over it.

Read reasoning from `<piHome>/events.jsonl` (thinking + tool_use blocks); `poll`
only carries UI requests and coarse events.

## What a drive is expected to exercise

Keep this list honest — if a drive stops covering one of these, say so:

1. **Plan authoring** from prose (the most model-sensitive step) → the gate.
2. **Model routing**: seat inheritance for plan nodes; tiers for duty rows and
   subagents. NOTE: plan nodes currently **inherit the session model** —
   `resolveModel` passes no tier, so there is no per-node routing yet, despite
   the call-site comment promising "Phase 4 adds tier routing".
3. **Parallel + dependent deliverables**, with the dependent one **stacking** on
   a sibling's branch (`stacked` + `baseSha` are stamped at provisioning; the
   scenario declares `stacked: true` so the check cannot pass vacuously).
4. **A review agent** running against a worker's diff.
5. **Real ship**: branch → PR via real `gh` (drop `--local-remote`).
6. **Teardown**: disposable repo deleted, isolated home and worktrees removed.

Known gaps a drive keeps surfacing (report if they recur, do not "fix" mid-run):

- A **v2-only config cannot drive subagent model selection**: `agents.run`
  validates a requested model against *authored options* from the v1 model-set
  vocabulary, so a v2 tier override is rejected and the review runs on the
  runner's own pick. Visible as the notice "tier override … was rejected by the
  agent runner; running with its own selection instead."
- The **real-GitHub path does not seed the sandbox repo** — `--add-readme` only,
  no `package.json`, unlike the `--local-remote` path which calls `seedRepo()`.
  The planner has to invent scaffolding, so the two live paths are not
  comparable runs.

## Notes

- **Never edit the harness to make the test pass.** The whole point is to run the
  real code unmodified and see whether it works.
- **Never commit with `--no-gpg-sign`.** Signing is on via `config-github`; if
  the key is locked, ask the human rather than bypassing it.
- If `state` shows `plan.found: false` after you sent the plan, the plan wasn't
  created — re-read the events from `poll` to see what the maestro said.
- The scripted, deterministic version of this same flow is
  `test/e2e/real.e2e.test.ts` (run with `npm run test:e2e:full`); it uses the
  same driver core but a fixed prompt sequence and rule-based answers.
- Full reference: `docs/e2e-testing.md`.
