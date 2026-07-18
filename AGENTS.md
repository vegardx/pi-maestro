# AGENTS.md

Guidance for coding agents (Claude, pi, or any harness) working in this repo.
pi-maestro is a **pi coding-agent extension stack** (`package.json` `pi.extensions`)
that turns a single `pi` into a maestro orchestrating workers over RPC + tmux.

## Build / check

- `npm run check` — the full gate: biome → tsc → boundary linter → feature-flag
  contract → docs check → cutover audit → vitest → smoke. Run it before calling
  a change done.
- `npm test` — unit tests only (fast). `npm run lint:fix` — autoformat.

## Testing tiers

There are **three** tiers; pick the lowest one that can catch the bug you care
about:

1. **Unit** (`npm test`) — pure logic, no I/O.
2. **Hermetic e2e** (`npm run test:e2e`) — boots the *real* orchestrator
   (engine + execution adapter + RPC) with fakes for tmux/pi/git. Deterministic,
   ~1s. Author new scenarios here when you touch the lifecycle. See
   `test/e2e/lifecycle.e2e.test.ts` and `docs/e2e-testing.md`.
3. **Full-stack driver** (`test/e2e/driver/`) — boots a **real `pi --mode rpc`**
   with the whole maestro stack and drives it from outside through a full
   deliverable lifecycle (plan → workers → review → ship). Two ways to run it:

   - **Scripted** (`npm run test:e2e:full`) — fixed prompt sequence + rule-based
     answers, against a mock model provider. Deterministic; for CI.
   - **LLM-driver** (you drive it) — a control CLI + daemon lets an agent boot
     the harness, observe events, **answer the maestro's questions**, and assert
     on real shipped outcomes, against real models + a disposable GitHub repo.
     Invoke the **`drive-maestro-e2e`** skill (`.agents/skills/drive-maestro-e2e/`),
     or drive `node_modules/.bin/jiti test/e2e/driver/cli.ts` directly:
     `start` (background) → `prompt` / `poll` / `answer` → `assert` → `stop`.

   Why external, not an internal `/test` command: pi already exposes the control
   surface (`--mode rpc` + the `extension_ui_request` dialog sub-protocol), so
   the harness under test stays 100% real and unmodified while an outside agent
   drives it. Answering the maestro's mid-run questions is just the driver agent
   doing its job.

## Conventions

- **Branch per change → PR to origin; merge only via rebase-merge.** Never
  commit straight to `main`.
- TypeScript throughout; imports use explicit `.js` extensions (nodenext).
  Match the surrounding file's style (tabs, double quotes).
- **Never weaken a test or the harness to make a run pass.** If the full-stack
  driver fails, that's a finding about the harness, not the test.
