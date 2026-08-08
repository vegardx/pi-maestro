# Workflow runtime capability spike

Date: 2026-08-08

Packages inspected:

- `@agwab/pi-workflow@0.11.0`
- `@agwab/pi-subagent@0.4.8`

The root also pins `pi-web-access@0.18.0`, while the published workflow package
explicitly launches its bundled `pi-web-access@0.10.7`. That split is recorded
below and must be resolved or compatibility-tested before cutover.

This is a source-surface audit of the exact published npm packages. It answers
whether the proposed maestro implement/review workflow can rely on each runtime
property. It does not treat documentation claims or TypeScript types as proof of
cross-process behavior; those cases are explicitly marked **requires live
proof**.

## Decision legend

- **Supported**: the public API and implementation contain the required
  behavior, without a maestro fork.
- **Unsupported**: the package implementation does not provide the required
  security or authority boundary. A maestro adapter or upstream change is
  required.
- **Requires live proof**: the source has the necessary data or mechanism, but
  correctness depends on the real Pi child-process/provider seam or on a
  composition that the packages do not test as one contract.

## Executive result

W0 is **not cleared without adapters**. The workflow package can schedule a
flat implement/review/decision DAG in one externally prepared worktree, apply
per-agent tool ceilings, discover ambient skills, record resolved model and
usage metadata, and resume a non-loop workflow. It cannot, by itself:

1. make a reviewer OS-level read-only while that reviewer sees the shared
   worktree;
2. prevent an implementer from reading private reviewer artifacts stored below
   that worktree;
3. launch children from a clean, allowlisted environment; or
4. give an implementer a narrow local-commit capability without also granting
   a general shell route to Git.

Those are authority boundaries, not prompt-design issues. Maestro should retain
small adapters for them, or wait for equivalent upstream features.

The spike adapters added with this report define private-storage and clean-env
contracts, but they are not wired runtime boundaries yet. In particular, a
private second copy cannot hide raw artifacts already persisted by workflow in
the shared cwd, and an allowlisted environment object cannot be passed as a
merge overlay to subagent.

## Requirement matrix

| W0 requirement | Status | Evidence and consequence |
| --- | --- | --- |
| Bind the run to a maestro-created external cwd | **Supported** | `runWorkflowSpec(specPath, cwd, options)` and `runWorkflow(..., cwd, ...)` accept a run-level cwd (`@agwab/pi-workflow/dist/engine.d.ts`). Compiled tasks receive `options.cwd` (`dist/compiler.js`, task construction). |
| Honor a stage-level `cwd` value | **Unsupported** | The schema accepts stage/default `cwd`, but the compiler only derives `explicitCwd: stage.cwd !== undefined`; task `cwd` still comes from `options.cwd` (`dist/artifact-graph-schema.js`, `dist/compiler.js`). Do not depend on stage cwd in 0.11.0. |
| Disable workflow worktrees and share the external worktree | **Supported** | Workflow policy is `"auto" | "on" | "off"`; `classifySafety` makes `requiresWorktree` false for `off`, and `ensureManagedWorktree` returns without creating one (`dist/compiler.js`, `dist/worktree.js`). The backend then deliberately calls subagent with `workspace: "shared"`, `worktreePolicy: "never"` (`dist/subagent-backend.js`). |
| Preserve mutations and commits through implement -> reviews -> decisions in that cwd | **Requires live proof** | Source wiring uses the same task cwd, but the real detached-process/Git seam, stage ordering, crash behavior, and commit visibility need a live test. |
| Enforce a stage/persona tool ceiling | **Supported** | Workflow `validateToolSubset` rejects tools beyond an agent definition and `filterDelegationTools` removes delegation tools (`dist/compiler.js`). Subagent independently rejects call-level expansion of a named agent's tools (`@agwab/pi-subagent/src/orchestrate/run.ts`) and emits `--tools`/`--no-tools` plus `--exclude-tools subagent` (`src/runners/headless-model.ts`). |
| Enforce OS-level read-only review access | **Unsupported** | Workflow `readOnly` is tool classification only; its own diagnostic says it does not prevent mutating tools from writing (`dist/compiler.js`). Workflow does not pass a subagent sandbox. Subagent's sandbox default explicitly allows writes to cwd (`src/sandbox/srt.ts`, `defaultConfig`). |
| Load normal globally/project-installed skills in child agents | **Supported** | Omitting `skills` preserves Pi ambient discovery; only explicit `skills: []` emits `--no-skills` (`@agwab/pi-subagent/src/runners/headless-model.ts`; `docs/usage.md`). Workflow omits `subagentOptions.skills` (`@agwab/pi-workflow/dist/subagent-backend.js`). |
| Reliably trigger the intended discoverable reviewer skill from the persona prompt | **Requires live proof** | Ambient loading is supported, but model selection of a discoverable skill is behavioral. Test each target model against the installed `agent-toolkit` Pi package. |
| Record the provider/model actually resolved at runtime | **Supported** | Subagent parses assistant `provider` and `model` from Pi JSON events and persists them in `ResultMetadata` (`src/runners/headless-model.ts`, `src/artifacts/result.ts`). Workflow copies attempt observations into task runtime/usage records (`dist/subagent-backend.js`, `dist/types.d.ts`). |
| Report the exact intended model for every configured provider/model alias | **Requires live proof** | The field path exists, but the provider event must populate it accurately. Exercise Opus, Fable, and Grok configurations and compare planned versus observed identities. |
| Persist token and cache-usage totals | **Supported** | Workflow usage values include input, output, total, cached-input, cache-creation, cache-read, reasoning tokens, and cost (`dist/types.d.ts`). `recordTaskUsageObservation` normalizes and aggregates attempt data (`dist/subagent-backend.js`). Parent usage is persisted separately (`dist/workflow-parent-usage.js`). |
| Emit a reliable live usage stream for the footer | **Requires live proof** | The packages expose durable task/run snapshots, not a documented public subscription contract. Maestro must poll/refresh records or bridge Pi events, then prove retry/resume deduplication and provider cache-field normalization. |
| Keep reviewer identity/provenance private from the implementer while maestro retains it | **Unsupported** | Workflow artifact projections govern dependency injection, not filesystem access. Raw stage artifacts live under `.pi/workflows/<run-id>` in the shared cwd and a child with ordinary read/search tools can address them directly (`dist/artifacts.js`, workflow artifact readers, `docs/usage.md`). |
| Launch children with a clean/allowlisted environment | **Unsupported** | Headless execution uses `{ ...process.env, ...attemptEnv }`, or normal child inheritance when no override is supplied (`@agwab/pi-subagent/src/runners/headless-model.ts`). Tmux similarly starts from `{ ...process.env }` and only removes `TMUX` (`src/runners/tmux.ts`). |
| Let implementers commit locally through least authority | **Unsupported** | Neither package exposes a narrow commit operation. Granting `bash` permits direct Git commands; denying it removes that route. This conflicts with retaining maestro's Git-reference sandbox and remote/push gate. |
| Resume a flat, non-loop workflow | **Supported** | Workflow exports `resumeRun`/`resumeSupervisors` (`dist/engine.d.ts`) and preserves completed tasks while resetting retryable terminal states. Loop workflow resume is explicitly unsupported (`docs/usage.md`). |
| Resume the proposed workflow after a process crash without losing/duplicating external-worktree commits or usage | **Requires live proof** | Generic DAG resume exists, but the precise external-cwd, multi-commit, decision-artifact, and parent/footer-usage composition crosses process and Git seams. |
| Use one compatible `pi-web-access` implementation throughout the stack | **Unsupported by the installed graph** | Workflow 0.11.0 deliberately resolves its bundled 0.10.7 extension, while maestro pins 0.18.0. Loading or testing only the root package does not establish child behavior. Align upstream, or test both exact extension surfaces and prevent duplicate registration. |

## Detailed evidence

### 1. Cwd binding and worktree ownership

The workflow API has the correct ownership shape: maestro can create one durable
worktree and pass its absolute path to `runWorkflowSpec`. In
`@agwab/pi-workflow/dist/compiler.js`, effective workflow worktree policy is:

```text
stage.worktreePolicy
  ?? spec.defaults?.worktreePolicy
  ?? spec.worktreePolicy
  ?? "auto"
```

`classifySafety` only requests a managed worktree when the policy is `on`, or
when it is `auto` and the task is not classified shared-cwd-safe.
`ensureManagedWorktree` in `dist/worktree.js` is a no-op when
`compiledTask.safety.requiresWorktree` is false. Thus a workflow/default policy
of `off` leaves maestro's cwd in place.

The two packages use different policy vocabulary. Workflow exposes
`auto/on/off`; subagent exposes `auto/required/never`. Workflow owns the first
decision, then `dist/subagent-backend.js` launches every compiled task with:

```text
cwd: task.cwd
workspace: "shared"
worktreePolicy: "never"
```

That translation is deliberate and prevents nested subagent worktrees.

The accepted stage-level `cwd` schema is misleading in this release. Searches
of the compiled implementation find the value used to set an `explicitCwd`
boolean, but not used as the actual task cwd. Minimum response: bind cwd once at
run launch and do not emit stage cwd. Upstream should either implement
stage/default cwd or reject it in the schema.

### 2. Tool ceilings versus filesystem isolation

Tool authority is well structured. An agent markdown definition can declare its
maximum tools; workflow rejects any stage tool request beyond that set.
Subagent repeats this invariant at its own boundary. Call-site tools can narrow,
not widen, a named agent. Delegation tools are filtered, and headless children
are explicitly passed `--exclude-tools subagent`.

This is enough for a reviewer persona whose usable tools are only known
read-only Pi tools such as read/search/list. It is not an operating-system
boundary. Workflow's compiler diagnostic explicitly warns that `readOnly`
“only filters tools” and that potentially mutating tools remain able to mutate.
In particular, a reviewer with `bash` is not read-only.

Subagent's optional sandbox does not repair this composition. Its
`src/sandbox/srt.ts:defaultConfig` adds cwd and `writablePaths` to
`filesystem.allowWrite`; workflow's subagent backend does not request sandbox
configuration anyway. The minimum safe adapter is either:

- retain maestro's gated read-only shell and current OS profile for reviewers;
  or
- add an upstream subagent filesystem policy/read-only mode that denies writes
  to cwd while permitting a separate scratch path, then make workflow pass the
  stage policy through.

After either change, prove it on every supported OS by attempting writes via
shell, edit tools, redirects, Git, symlinks, and subprocesses.

### 3. Ambient skills and reviewer personas

Subagent documents normal ambient Pi extension and skill loading as the default.
`src/runners/headless-model.ts:buildPiArgv` emits `--no-skills` only when the
caller explicitly supplies an empty skill list. Workflow does not supply one,
so globally installed and project-visible skills remain discoverable.

Workflow agent metadata parses an `inheritSkills` field, but no corresponding
use was found in its backend launch path. Do not rely on that field in 0.11.0;
the relevant behavior is the omission of `skills` from subagent options.

The intended packaging is therefore viable: install `agent-toolkit` as a Pi
package and write focused reviewer personas whose prompts naturally name the
security/correctness/simplification/adversarial task. Do not hard-code skill
paths into every workflow. A live behavioral test must still show that each
configured model discovers and reads the expected skill rather than merely
having it present in the child session.

### 4. Resolved-model and usage telemetry

Subagent's `parsePiJsonLine` captures provider, model, and raw usage on terminal
assistant events. The headless runner avoids double-counting paired
`message_end` and `turn_end` events and deep-sums numeric usage fields across
requests. `src/artifacts/result.ts:ResultMetadata` persists the observation.

Workflow's `recordTaskUsageObservation` carries attempt observations into the
run record. `dist/types.d.ts` distinguishes planned and resolved runtime model
data and defines these normalized usage fields:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cachedInputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`
- `reasoningTokens`
- `costUsd`

It also maintains attempt-keyed task and run rollups. Parent/seat usage is kept
in a separate resumable sidecar by `dist/workflow-parent-usage.js`, including
cache metrics.

This is sufficient source data for the footer, but not a public live event
contract. The minimum maestro adapter should consume immutable run snapshots
(or bridge native Pi message events for the current seat), calculate:

- current seat totals;
- all workflow-agent totals for the active maestro session; and
- cache-hit ratios from the normalized read/cached and input fields.

It must key aggregation by run/task/attempt so polling and resume cannot double
count. A live matrix must verify the raw event shapes for every provider used by
Opus, Fable, and Grok model configurations.

### 5. Artifact confidentiality

Workflow's artifact graph is a data-flow convenience, not a confidentiality
system. `from`, `sourceProjection`, and `inputPolicy.artifactAccess` control
what the workflow injects or exposes through its artifact helper. Each stage
still writes `control.json`, `analysis.md`, `refs.json`, and `raw.md` below
`.pi/workflows/<run-id>` in the run cwd. Because the proposed stages share that
cwd, a child with a read/find/search tool can bypass the projection and inspect
the files by pathname.

This matters for the non-poisoning design. The implementer should receive a
sanitized list of findings without reviewer identities, while maestro should
retain the mapping needed to mention reviewer attribution in the PR. The
minimum adapter is to store the private mapping outside the child-visible
worktree in maestro-owned state, and generate a public findings artifact that
contains only stable finding IDs and reviewer text. Do not place identities in
workflow raw output and assume projections hide them.

That store is necessary but not sufficient with workflow 0.11.0: reviewer
`raw.md`, control output, compiled model routing, and task records are first
written below the shared `.pi/workflows` directory. The executable probe
deliberately asserts that resolved reviewer models are visible there. The
runtime must either keep that directory outside every implementer read
allowlist, sanitize or move outputs before the implementer can run, or gain
access-controlled artifact storage upstream.

An upstream alternative is task-private artifact labels backed by filesystem
read isolation. A negative live test must have the implementer deliberately try
to enumerate and read raw review/provenance paths and demonstrate that it
cannot.

### 6. Child environment inheritance

Subagent children are not clean-room processes. The headless runner merges
attempt variables over `process.env`; absent an explicit environment, normal
child-process inheritance applies. The tmux runner copies `process.env` and
only removes `TMUX`. Overrides therefore add or replace keys but do not remove
unmentioned maestro variables.

This is unsafe for identity and control variables such as maestro socket,
token, depth, agent identity, or stale workflow role. The minimum upstream API
is an `envPolicy: "clean"` mode with an explicit allowlist and explicit unset
keys. If implemented in maestro first, use a child-launch wrapper that constructs
the environment rather than temporarily mutating the long-lived seat's global
`process.env`. Live proof should dump the child's environment and assert that
all maestro-only variables are absent while required Pi/provider credentials
remain available.

### 7. Local commits

With shared cwd and write/shell tools, an implementer can technically execute
`git commit`. That is not the required contract. It grants a general shell path
to Git, and it conflicts with maestro's existing policy of denying direct
`.git/refs` mutation and controlling remote operations.

Retain maestro's narrow in-process commit tool as an extension available to
implementer stages, include it in the implementer agent ceiling, and keep it
out of all reviewer ceilings. The tool should commit only the active external
worktree and should have no push or remote-management operation. The workflow
then records this intended history:

1. implementer creates the initial implementation commit;
2. reviewers produce findings without mutation;
3. implementer records a decision for every finding and creates one or more
   follow-up commits for accepted changes; and
4. maestro alone pushes and creates/updates the PR.

Live proof must show that reviewers cannot commit, the implementer cannot push,
and maestro can ship the final branch.

### 8. Resume

Workflow exports `resumeRun` and `resumeSupervisors`. Its documented DAG resume
model preserves completed tasks and resets failed/interrupted/resumable blocked
tasks; dependency invalidation can be configured. Loop workflow resume is
explicitly unsupported, which is acceptable because the proposed design is one
flat pass, not an iterative review loop.

Generic support does not prove the desired Git semantics. A recovery drive must
kill the seat at each boundary: before initial commit, after initial commit,
during parallel reviews, after findings aggregation, during decisions, after a
follow-up commit, and before shipping. On restart it must retain completed
review artifacts and commits, avoid duplicate commits and usage, require a
decision for every finding, and leave push/PR ownership with maestro.

## Minimum adapter and upstream-change set

Keep the integration small and explicit:

1. **External-worktree launcher**: maestro creates/owns the branch worktree,
   invokes the whole workflow with that cwd, and fixes workflow policy to
   `off`. No stage-level cwd and no package-managed worktrees.
2. **Reviewer isolation adapter**: retain gated read-only tools and OS policy.
   Upstream request: stage sandbox passthrough plus a truly read-only cwd mode.
3. **Private findings store**: keep reviewer-to-finding provenance outside the
   worktree; publish only sanitized findings to the decision stage. Upstream
   request: access-controlled artifacts plus filesystem enforcement.
4. **Clean child launcher**: allowlist environment variables and explicitly
   remove maestro identity/control variables. Upstream request: replacement,
   not merge-only, environment semantics.
5. **Commit tool**: retain a local-only maestro commit tool for implementers;
   keep push/PR tools at depth zero only.
6. **Footer bridge**: adapt durable task/run usage snapshots and parent Pi
   events into current-seat and all-agent totals, keyed to avoid retry/resume
   duplication.
7. **Model audit**: persist both configured and observed provider/model for
   every reviewer attempt; fail the drive if they do not match the requested
   lens/model matrix.

## W0 live acceptance suite

W0 should be considered cleared only when a real-process drive demonstrates:

1. one maestro-created worktree is used by every stage, with no nested
   worktrees;
2. the initial implementation commit is visible to every reviewer and accepted
   fixes create later commits on the same branch;
3. security, correctness, simplification, and adversarial lenses can each run
   under multiple explicitly configured models, with the observed provider and
   model recorded;
4. reviewers cannot write or commit by any available tool or shell path;
5. implementers cannot discover reviewer identity/provenance, even by directly
   probing workflow-state paths;
6. implementers cannot finish until every public finding ID has a recorded
   decision, without a verifier or a second review round;
7. child environments omit all maestro-only identity/control variables;
8. footer current-seat and all-agent token/cache totals agree with persisted
   attempt records before and after resume;
9. crash recovery at every stage boundary produces no duplicate work, commit,
   decision, or usage record; and
10. only the depth-zero maestro can push and create/update the PR.

## Recommendation

Use `@agwab/pi-workflow@0.11.0` as the DAG scheduler and
`@agwab/pi-subagent@0.4.8` as the model worker runtime, but do not delegate
security boundaries to either package. The desired design does not need a
nested DAG or a loop profile: a flat fan-out/fan-in workflow is sufficient.
Proceed only with the four narrow retained boundaries—reviewer OS isolation,
private provenance, clean child environment, and local commit authority—and
make the live acceptance suite the gate for deleting their current
counterparts.
