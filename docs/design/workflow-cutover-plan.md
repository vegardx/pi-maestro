# Workflow cutover plan

**Status:** Accepted implementation plan; W0 source/API spike complete, outer
supervisor composition awaiting live proof.

This plan replaces pi-maestro's custom plan, worker, review, and question
orchestration with an opinionated integration around:

- `@agwab/pi-workflow`
- `@agwab/pi-subagent`
- `pi-web-access`
- `@juicesharp/rpiv-ask-user-question`
- the separately installed `vegardx/agent-toolkit` Pi package

The target is a smaller maestro that owns modes, approval, multi-repository
workspace preparation, a local review ledger, accounting, presentation, and
publication. `pi-workflow` owns durable orchestration and `pi-subagent` owns
child execution.

The implementation must preserve the repository's central capability rule:
authority, implementation, agent-facing descriptions, and verification must
derive from the same declarations rather than repeat tool names independently.

## Decisions

1. A plan is a validated workflow instance. There is no second durable maestro
   plan graph beside the workflow.
2. `plan`, `auto`, and `hack` remain the user modes.
3. Plan to Auto is an explicit approval transition. Auto runs exactly the
   approved workflow digest.
4. A new request submitted while already in Auto still forms, validates, and
   presents a workflow for one approval before autonomous execution.
5. Hack remains direct seat work and does not require the workflow lifecycle.
6. An active workflow does not ask routine questions. Essential clarification
   happens at the seat before approval.
7. Implementers create local commits. Reviewers are read-only. Only deterministic
   depth-0 maestro code pushes branches and creates or updates pull requests.
8. Review happens once against immutable implementation commits. There is no
   verifier and no second review round.
9. The implementer must record a decision for every normalized finding. A
   deterministic gate checks coverage and Git lineage, not the merit of the
   decisions.
10. Reviewer provenance is withheld from the implementer and retained only in a
    local Maestro review ledger. It is not published in the PR.
11. Reviewer lenses are reusable personas backed by globally discoverable
    skills from `agent-toolkit`.
12. A lens may run on one or many models. Model cohorts are top-level workflow
    stages so execution profiles can target them directly.
13. Multi-repository workspaces are the foundational execution model. A
    single-repository change is a workspace containing one repository.
14. Maestro prepares the coordinated repository worktrees and binds the
    approved workflow to that external workspace. Workflow worktree management
    is set to `off`; stage-level `cwd` is not used because version 0.11.0 accepts
    it in the schema but does not honor it during compilation.
15. The implement-review graph is a flat DAG. Workflow stages are the complete
    agent topology for the first cutover; no stage or reviewer must spawn nested
    agents.
16. Maestro starts the workflow runtime inside one outer supervisor sandbox.
    The clean supervisor environment and OS restrictions are inherited by
    `pi-workflow`, `pi-subagent`, and their descendants, so this integration does
    not require a fork of either package. The composition remains gated on a
    live drive.
17. The threat model prevents accidental reviewer writes, accidental provenance
    exposure through prompts/artifact projections, and unauthorized publication.
    It does not claim confidentiality from a deliberately hostile process running
    as the same host user.
18. Initial and follow-up implementation commits use normal task-oriented commit
    messages. Commit messages do not encode reviewer, model, lens, or finding
    provenance.

## Non-goals

- Maestro will not implement another workflow scheduler.
- Reviewers will not grade findings, assign severity, vote, or prescribe fixes.
- The system will not merge pull requests.
- Multi-repository publication will not pretend to be atomic. It will be
  journaled, idempotent, and recoverable after partial publication.
- The first cutover will not support automatic approval or silent global
  configuration mutation.
- Workflow-level skill paths will not be introduced. Skills remain ambient and
  discoverable.
- Nested agents and nested workflow DAGs are not required for the first cutover.
- Review provenance will not be added to commits or pull requests.
- Model-written PR prose is deferred. A future globally discoverable PR-writing
  skill may advise the depth-0 seat without becoming a required workflow stage
  or receiving access to the local review ledger.

## Target architecture

```text
Pi seat / pi-maestro
  modes · workflow approval · workspace · local review ledger
  footer/HUD · usage ledger · local lineage · push/PR
                 |
                 v
outer workflow supervisor
  clean env · filesystem write boundary · no publication tools
                 |
                 v
@agwab/pi-workflow
  topology · artifacts · profiles · lifecycle · resume
                 |
                 v
@agwab/pi-subagent
  agent execution · model routing · ambient skills

pi-web-access                 @vegardx/agent-toolkit
  web research                 globally installed skills
```

### Maestro-owned modules

```text
packages/maestro/src/
  extension.ts
  mode.ts
  runtime.ts
  seat.ts
  workflow/
    planner.ts
    manifest.ts
    approval.ts
    runner.ts
    projection.ts
    artifacts.ts
    review-ledger.ts
    usage.ts
  workspace.ts
  git-lineage.ts
  commit-tool.ts
  pr-report.ts
  shipping.ts
  setup.ts
  doctor.ts
  telemetry.ts
  install-footer.ts
  hud-wiring.ts
  bash-policy.ts
  bash-gate.ts
  isolation/
```

### Workflow-owned files

```text
workflows/implement-review/
  spec.json
  helpers/
    normalize-findings.mjs
    decision-coverage.mjs
    review-checkpoint.mjs
    final-lineage.mjs
  schemas/
    review-plan.schema.json
    raw-findings.schema.json
    sanitized-findings.schema.json
    decisions.schema.json
    coverage.schema.json

agents/
  implementer.md
  peer-reviewer.md
  security-reviewer.md
  correctness-reviewer.md
  simplification-reviewer.md
  adversarial-reviewer.md
```

The workflow graph and workflow artifacts belong to `pi-workflow`. Maestro does
not mirror their lifecycle in a proprietary Plan/Run format.

## Multi-repository workspace

Pi may start in a Git repository or in a directory containing several sibling
repositories. Plan formation discovers candidate Git roots but includes only
the repositories selected by the task. Every selected repository appears in
the approval preview.

```text
<run-workspace>/
  repos/
    shared-types/       linked Git worktree
    service-api/        linked Git worktree
    deployment/         linked Git worktree
  publication/          resumable publication journal

<maestro-state>/runs/<run-id>/
  review-ledger/        local seat-only attribution and decision joins
```

Each repository has an immutable approved contract:

```ts
interface WorkflowRepository {
  key: string;
  sourcePath: string;
  worktreePath: string;
  remote: string;
  host: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
}
```

Stages declare repository authority rather than receiving the entire workspace
implicitly:

```ts
interface StageRepositoryAccess {
  read: string[];
  write: string[];
  commit: string[];
}
```

Repository names are resolved from the approved registry. Unknown names,
duplicate roots, nested aliases, repository additions after approval, and
writes outside a stage's declared set fail closed.

Git identity is resolved by Git inside each worktree. The runtime must not
propagate `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, because that overrides path-scoped
`includeIf` configuration.

## Plan and approval lifecycle

User posture and workflow execution state remain separate.

```text
PLAN / no workflow
  -> form or select workflow
  -> validate

PLAN / ready
  -> resolve profile and concrete models
  -> render repository, stage, authority, model, and publishing preview
  -> compute execution digest
  -> await approval

AWAITING APPROVAL
  -> reject: remain in Plan
  -> executable input changed: invalidate and return to Plan/ready
  -> approve matching digest: enter Auto and launch exactly once

AUTO / running
  -> complete: validate publication contract and publish
  -> failed: retain workspace and resumable workflow state

HACK
  -> direct seat work, outside the workflow approval lifecycle
```

The approval digest covers:

- workflow spec and support-helper bytes;
- persona definitions;
- resolved execution profile and concrete model IDs;
- tool and repository authority;
- selected repository roots, branches, and base SHAs;
- worktree and sandbox policy;
- publishing and provenance-free PR content policy; and
- pinned `agent-toolkit` package revision.

Ambient skill selection is runtime model behavior. The digest records the
toolkit revision but does not claim which skill will be selected.

No worktree or child agent may be created before approval. Mode transition
requests are serialized so concurrent gestures produce one approval and one
launch. A mode change during execution applies to the next request and does not
implicitly cancel the current run.

Approval uses Maestro's deterministic seat UI. Version 2.4.0 of
`rpiv-ask-user-question` is a model-facing `ask_user_question` extension, not a
programmatic approval-dialog API. It remains available to the interactive seat
for essential pre-plan clarification, but it is not the Plan-to-Auto approval
mechanism and is never exposed to autonomous workflow stages.

## Implement-review workflow

```text
implement repository tasks
        |
        v
implementation checkpoints per repository
        |
        v
review plan
        |
        +-- model/lens reviewer cohorts
        |     security x Opus
        |     security x Fable
        |     security x Grok
        |     correctness x configured models
        |     simplification x configured models
        |     adversarial x configured models
        |
        v
normalize findings
        |
        v
implement decisions and follow-up commits
        |
        v
decision coverage and per-repository lineage
        |
        v
depth-0 publication
```

There is no nested DAG, nested-agent requirement, loop, verifier, retry review,
or model-written PR report. The fan-out and fan-in are ordinary top-level
workflow stages in one flat DAG.

### Supervisor sandbox and threat model

Maestro launches the whole workflow runtime in a supervised child process with
a replacement allowlisted environment. Because `pi-subagent` merges child
overrides onto its own `process.env`, cleaning the supervisor process first
makes that inherited base safe without changing package internals.

The outer sandbox permits declared worktree writes but prevents writes to source
checkouts and unrelated filesystem roots. It is principally a write boundary:
the current profile otherwise reads broadly, apart from configured secret
deny-read paths, and its network policy is unrestricted. The production launcher
must synthesize a scratch `HOME` and minimal `PI_CODING_AGENT_DIR`, omit Git and
GitHub publication credentials, and expose no publication tools; the sandbox
alone does not prevent remote mutation.
Only depth-0 Maestro code runs outside that boundary to push branches and create
or update PRs. Reviewer personas and tool ceilings omit write, commit,
delegation, and publication tools; that is the accidental-write boundary inside
the shared workflow sandbox. The design does not claim that those tool ceilings
withstand a malicious same-user process that escapes or bypasses its declared
tools.

This arrangement uses a package-external process boundary and therefore does not
require a `pi-workflow` or `pi-subagent` fork. A live drive must still prove that
the real workflow supervisor, descendants, local commit route, provider access,
and recovery all behave under the inherited sandbox.

### Cross-repository dependencies

Workflow `from` edges carry structured outputs and ordering between repository
tasks. A dependent stage may read an upstream repository worktree only when its
approved authority declares that repository.

Examples:

```text
implement shared-types
  -> implement service-api
  -> implement deployment
```

Cross-repository review lenses include contract compatibility, rollout order,
and partial-deployment behavior in addition to the repository-local lenses.

### Review checkpoint

Before review, every changed repository must have:

- the expected workflow branch checked out;
- a clean worktree;
- at least one commit after the approved base SHA; and
- a recorded immutable implementation head.

```ts
interface RepositoryCheckpoint {
  repository: string;
  baseSha: string;
  implementationHead: string;
  reviewRange: string;
}
```

Reviewers inspect exactly these ranges. Mutation is frozen during reviewer
execution.

### Findings and provenance

Raw findings contain internal runtime provenance:

```ts
interface RawFinding {
  rawId: string;
  lens: string;
  claim: string;
  evidence: Evidence[];
  stageId: string;
  taskId: string;
  resolvedModel: string;
}
```

Normalization deterministically validates and assigns stable content-derived
IDs. It conservatively deduplicates only findings with the same normalized
claim and repository-qualified evidence locations; it does not ask a model to
judge semantic equivalence. It emits two projections:

```text
sanitized findings -> implementer
contributor mapping -> local Maestro review ledger only
```

The implementer projection has no dedicated lens, model identity, reviewer
identity, agreement count, severity, required-resolution, or recommended-fix
fields. Reviewer personas must still keep claim and observation prose factual
and non-prescriptive: the structural normalizer does not attempt to decide
whether arbitrary natural language contains an implicit recommendation.

The contributor mapping is copied into a local-only Maestro review ledger outside
the supervised workflow roots. The implementer receives only the sanitized
projection through its prompt/artifact input and is not directed to raw reviewer
artifacts. This prevents accidental attribution through workflow metadata; it
does not claim semantic poison-proofing or that file placement alone protects
secrets from a hostile process with the same OS identity. Prefer placing the
ledger below the existing agent-state deny-read root so the current secret
policy adds defense in depth, without making that stronger confidentiality
boundary a first-cutover requirement.

### Decisions and lineage gate

```ts
interface FindingCommitRef {
  repository: string;
  commit: string;
}

interface FindingDecision {
  findingId: string;
  decision: "changed" | "no_change";
  reasoning: string;
  changedPaths?: Array<{ repository: string; path: string }>;
  commitRefs?: FindingCommitRef[];
}
```

The deterministic gate requires:

- exact equality between canonical finding IDs and decision IDs;
- one decision per finding;
- no missing, duplicate, or unknown IDs;
- non-empty reasoning;
- every changed decision to reference reachable post-checkpoint commits;
- referenced commits to have non-empty diffs intersecting declared paths;
- every post-review commit to be explained by at least one changed decision;
- every implementation checkpoint to remain an ancestor of final HEAD;
- expected branches to remain checked out; and
- every repository worktree to be clean.

The gate records each final HEAD. It never judges whether a decision is good.
Initial and follow-up commits use the repository's normal commit-message style.
Finding-to-commit relationships live in decision data and the local ledger, not
in special review-response prefixes or reviewer/model trailers.

## Personas and skills

Pi-maestro owns compact personas defining the review relationship:

- blind to implementer reasoning and other reviewers;
- read-only;
- evidence-first;
- no severity, voting, or prescribed resolution; and
- workflow-defined structured output.

`agent-toolkit` owns portable review methods. It becomes a separately installed
Pi package with directory-level skill discovery:

```json
{
  "name": "@vegardx/agent-toolkit",
  "private": true,
  "keywords": ["pi-package"],
  "pi": { "skills": ["./skills"] }
}
```

The toolkit adds `security-review`, `correctness-review`,
`simplification-review`, and `adversarial-review`. Reviewer prompts are written
to trigger these ambient skills naturally. The live drive proves that expected
skills are actually read; no custom skill router or workflow skill-path field
is introduced.

## Usage and UI

The active extension currently does not install the retained footer or usage
ledger. This is a new integration, not a no-op retention.

The ledger exposes:

1. current depth-0 seat session usage; and
2. the seat plus every workflow task rooted in that session.

Provider counters remain disjoint:

```text
promptTokens = input + cacheRead + cacheWrite
totalTokens = promptTokens + output
cacheHitRate = cacheRead / promptTokens
```

Only leaf task usage is aggregated. Workflow totals are not added on top of
their tasks. Checkpoints are cumulative, revisioned, and fenced by task attempt
or generation so resume and replay do not double-count. Missing provider usage
is reported as unavailable, not zero. Provider cache usage remains distinct
from workflow artifact-cache reuse.

The UI projects package-native state:

```text
maestro seat
  -> workflow run
       -> repository
            -> stage/model cohort
                 -> foreach lens task
```

The footer shows compact current and fleet totals, cache-hit rates, mode, model,
and context. Narrow layouts drop fleet details before current-session context.

## Publication

Publication starts only after approval, review decisions, lineage, and final
checks pass for every repository.

```text
seal all final HEADs
  -> push all branches non-force
  -> create or update every PR
  -> cross-link the coordinated PR set
  -> persist publication journal
```

Publication is resumable rather than atomic. The journal records branch SHA,
push status, PR number/URL, and failure state per repository. Resume verifies
remote state and continues without duplicate branches or PRs.

Immediately before each push, maestro rechecks branch, cleanliness, checkpoint
ancestry, and `HEAD == finalHead`. Existing PRs are updated using the existing
GitHub edit capability rather than returned unchanged.

PRs contain the normal change summary, validation performed, and coordinated
repository links. They contain no reviewer, lens, model, agreement, finding, or
decision provenance. The local review ledger is never an input to PR rendering.
A future globally discoverable PR-writing skill may help the interactive
depth-0 seat draft ordinary PR prose, but Maestro remains responsible for
validation and publication and does not expose the ledger to that skill.

## Implementation work packages

### W0 - Capability spike and supervisor proof (blocking)

**Owner:** one subagent. **Dependencies:** none. **No production deletion.**

Prove with a disposable multi-repository fixture:

1. Programmatic workflow launch from the maestro extension.
2. `single -> foreach cohorts -> support -> single -> support` execution.
3. Different top-level cohorts resolve different concrete models.
4. Pi starts from a non-Git directory containing several child repositories.
5. Maestro creates and resumes one worktree per selected repository under one
   coordinated run workspace.
6. Implementer stages share the coordinated worktrees and request initial and
   follow-up local commits through a narrow depth-0 broker outside the sandbox.
7. Reviewer stages inspect exact immutable ranges across one or more repos.
8. Reviewer write and commit tools are absent, and the outer supervisor denies
   publication and writes outside the coordinated runtime roots.
9. Implementer push and PR attempts are denied.
10. Global `agent-toolkit` skills are discoverable; the old `--no-skills`
    behavior is absent.
11. Runtime-resolved model IDs and leaf token/cache usage are observable.
12. Workflow/stage/foreach hierarchy is observable.
13. The implementer prompt and artifact projection contain no contributor
    provenance; the contributor mapping remains in the local Maestro ledger.
14. The supervisor and its child processes do not inherit stale maestro socket,
    token, agent ID, depth identity, or Git author/committer overrides.
15. Stop/restart/resume preserves worktrees and does not duplicate commits.

Deliver a written compatibility report, fixture, and tests. Shared worktree,
supervisor sandbox, local commit, authority, skill, or telemetry failures block
the cutover and must be solved at the package-external adapter boundary first.

The initial source/API spike is recorded in
[`spikes/workflow-runtime-capabilities.md`](spikes/workflow-runtime-capabilities.md).
It validates the flat DAG, same-lens multi-model routing, ambient-skill launch
shape, terminal usage records, and run-qualified multi-repository worktree
mechanics. It does not yet prove cross-repository workflow scheduling, process
recovery, or resume-safe usage replay. The source/API questions are settled:
the first cutover uses a flat DAG, no nested agents, package-native model/task
execution, a package-external supervisor sandbox, a local Maestro review ledger,
and a retained local-only commit capability brokered by depth 0. No dependency
fork is planned.
W0 remains open only for live composition proof of the supervisor boundary,
shared-worktree commit/recovery behavior, real model/skill/usage telemetry, and
the bundled/root `pi-web-access` compatibility smoke test.

The first package-external supervisor adapters are now implemented behind no
production call site: a private scratch Pi runtime, filtered auth/model state,
skills-only toolkit snapshot, `--no-approve` Pi guard, transport-disabled Git
guard, non-Git umbrella workflow-state link, typed start/continue entry, and a
replacement-environment detached launcher with durable logs. Hermetic process
coverage proves the replacement environment reaches a real grandchild. This is
not the W0 live composition proof: the extension does not call the launcher yet,
the approved execution manifest still must bind the complete bundle/personas/
models/authority/roots rather than only the spec file, and real Pi skill,
project-settings, restart, commit-broker, and telemetry behavior remain open.

### W1 - Agent-toolkit Pi package

**Owner:** one subagent in `vegardx/agent-toolkit`. **Dependencies:** none.

- Add the Pi package manifest using `pi.skills: ["./skills"]`.
- Add the four portable reviewer skills.
- Add Pi installation and pinning documentation.
- Validate unique skill names and frontmatter.
- Add `gh skill publish --dry-run` to the release check.
- Release a pinned tag used by maestro tests.

### W2 - Review contracts and pure helpers

**Owner:** one subagent. **Dependencies:** W0 artifact conclusions.

- Add raw, sanitized, local-ledger, decision, and coverage types.
- Add stable finding IDs and deterministic deduplication.
- Add local contributor membership without exposing lens or identity in the
  implementer projection.
- Add exact decision coverage.
- Test duplicate, unique, malformed, missing, duplicate-decision, unknown-ID,
  changed, and no-change cases.

This package stays pure and independent of the workflow runner.

### W3 - Multi-repository workspace and Git lineage

**Owner:** one subagent. **Dependencies:** W0.

- Generalize `workspace.ts` from one deliverable to a repository registry.
- Discover and validate selected Git roots.
- Create/resume one worktree and branch per selected repository.
- Preserve path-scoped Git identity.
- Move the explicit-path local commit capability behind a narrow depth-0 broker;
  workflow stages submit repository, paths, and an ordinary repository-style
  message, while the broker validates the active run/stage/branch before signing
  the commit outside the supervisor sandbox.
- Add repository-specific implementation checkpoints.
- Add post-review reachability, path, ancestry, cleanliness, and final-head
  validation.
- Add partial-publication journal types without yet wiring remote mutation.

### W4 - Implement-review workflow and personas

**Owner:** one subagent. **Dependencies:** W0 and W2 schemas.

- Build and validate the workflow bundle.
- Add review planning, repository-local lenses, and cross-repository lenses.
- Add top-level model cohorts and execution profiles.
- Add compact personas.
- Keep the workflow a flat DAG and omit delegation tools; no stage must spawn a
  nested agent.
- Ensure the decision stage receives only sanitized findings.
- Add fixtures for one repo, multiple repos, one lens/many models, and multiple
  lenses/model cohorts.

### W5 - Workflow runner and projection

**Owner:** one subagent; integrate serially. **Dependencies:** W2-W4.

- Add planner, manifest, runner, artifact, and projection adapters.
- Select or form and validate workflows.
- Resolve concrete profile models.
- Bind workflows to coordinated workspaces.
- Launch the workflow runtime through the replacement-environment outer
  supervisor sandbox without patching dependency internals.
- Materialize a minimal scratch `HOME` and `PI_CODING_AGENT_DIR` containing the
  approved Pi configuration and packages, while omitting publication credentials.
- Set the supervisor's `PI_CODING_AGENT_SESSION_DIR`, `TMPDIR`, and
  `PI_WORKFLOW_AUTH_FILE` to scratch-local paths. Generate filtered settings,
  models, and writable provider auth rather than copying the seat's files.
- Snapshot the complete pinned `agent-toolkit` package into the scratch agent
  directory so ambient discovery works despite the real agent-directory read
  deny. Use an isolated Git config without credential helpers, disable terminal
  credential prompts, and omit GitHub tokens and SSH-agent sockets.
- Persist contributor mappings only in the local Maestro review ledger and pass
  sanitized findings into the workflow decision stage.
- Observe lifecycle and resume without mirroring a second run state machine.
- Project package-native state into maestro views.
- Keep the old executor behind a temporary cutover flag until parity passes.

### W6 - Modes and approval

**Owner:** one subagent; integrate serially. **Dependencies:** W5.

- Keep low-level `setMode` pure and internal.
- Add serialized `requestMode` transitions.
- Implement Plan formation, validation, preview, digest, approval, and launch.
- Make Auto requests follow the same one-approval lifecycle.
- Keep Hack direct.
- Refuse stale digest/model/profile approval.
- Use Maestro's deterministic seat UI for digest approval.
- Retain `rpiv-ask-user-question` for model-authored pre-plan clarification; its
  extension API does not provide the programmatic approval dialog Maestro needs.
- Ensure workflow agents receive no question tool.

### W7 - Usage, footer, and workflow task tree

**Owner:** one subagent. **Dependencies:** W0 telemetry and W5 projection.

- Add revisioned usage ledger and telemetry adapters.
- Capture seat and leaf workflow-task usage.
- Restore the footer with correct cache arithmetic.
- Add the flat workflow/repository/stage/task hierarchy.
- Remove the Questions HUD tab after ask cutover.
- Prove resume and replay do not double-count.

### W8 - Setup and doctor

**Owner:** one subagent. **Dependencies:** W1 and W4.

- Make `/maestro setup` idempotently reconcile the pinned toolkit Pi package,
  model profiles, and workflow dependencies.
- Ask before global configuration changes.
- Preserve unrelated packages and filters.
- Validate workflows and report reload requirements.
- Add read-only `/maestro doctor` checks for package versions, toolkit revision,
  skill discovery, workflow/profile validity, Git identity, remotes, GitHub
  authentication, and publication policy.

### W9 - Root-only multi-repository publishing

**Owner:** one subagent; integrate serially. **Dependencies:** W2, W3, W5.

- Make shipping consume a validated publish report.
- Revalidate every sealed repository immediately before push.
- Push explicit non-force branches.
- Create or update all PRs and then cross-link the set.
- Render ordinary per-repository and cross-repository change summaries without
  review provenance.
- Leave a future integration seam for a globally discoverable PR-writing skill
  used by the interactive seat, not by workflow stages.
- Resume safely after partial branch or PR publication.
- Never expose remote mutation as a model-facing tool.

### W10 - Cutover and deletion

**Owner:** one integration subagent. **Dependencies:** W5-W9 and hermetic parity.

- Switch the root extension manifest to the workflow stack.
- Archive old stored plans or expose a read-only migration command.
- Remove the old plan, authoring, executor, run, store, RPC, socket, detached
  worker, held-session, recursive review lead, and model-routing implementation.
- Replace `packages/ask` and `packages/research-tools`.
- Remove obsolete contracts and settings by import reachability.
- Retain bash/sandbox authority until live tests prove the replacement.
- Update architecture, usage, commands, settings, review, and e2e docs.

## Parallelization

The safe execution order is:

```text
W0 capability spike
  |
  +-- W1 agent-toolkit (may start immediately)
  +-- W2 review contracts
  +-- W3 workspace and lineage
  |
  +-- W4 workflow bundle (after W2 schemas)
  |
  v
W5 runner
  -> W6 modes/approval
  +-> W7 usage/UI
  +-> W8 setup/doctor
  -> W9 publishing
  -> W10 cutover/deletion
```

W2 and W3 can run in parallel after W0. W4 can begin once W2 freezes its
schemas. W5 and W6 overlap heavily in the composition root and should be
integrated serially. W7 and W8 can then run in parallel. W9 and W10 are final
integration work.

Every work package uses a branch and PR. Each package runs `npm run check`
before handoff. Changes to spawn, shell gates, worktrees, Git identity, or
shipping additionally require the relevant live-drive evidence before merge.

## Test plan

### Unit and component tests

Add or adapt tests for:

- workflow manifest digest stability and invalidation;
- Plan to approval to Auto transition and concurrent gesture serialization;
- concrete model drift and stale approval;
- repository discovery and authority declarations;
- multi-repository workspace resume;
- implementation checkpoints, normal commit messages, and follow-up lineage;
- finding normalization and local review-ledger membership;
- exact decision coverage;
- deterministic provenance-free PR rendering and existing PR updates;
- root-only publication;
- flat workflow task-tree projection;
- current and fleet usage with correct cache arithmetic;
- revisioned resume-safe usage checkpoints;
- setup/doctor idempotence; and
- skill discovery.

### Hermetic e2e

The scripted scenario starts Pi from a non-Git workspace containing multiple
repositories and proves:

1. Plan forms a multi-repository workflow.
2. No worktree or agent exists before approval.
3. Approval launches the exact digest.
4. Dependent repository implementation tasks execute in order.
5. Every changed repository has an initial implementation checkpoint.
6. Security runs through three model cohorts.
7. Reviewers inspect immutable repository-qualified ranges.
8. Overlapping findings normalize to one de-attributed finding without a lens.
9. The implementer prompt and artifact projection contain no contributor
   identity, while the local Maestro ledger retains the join.
10. Every finding has a decision.
11. Accepted findings create repository-qualified follow-up commits with normal
    task-oriented messages.
12. Coverage and lineage pass before publication.
13. Only depth 0 mutates remotes.
14. PRs are created or updated and cross-linked without review provenance.
15. Current and fleet usage do not double-count replay.
16. The workflow emits no question.

Also test rejection, stale manifests, missing decisions, bogus commit refs,
dirty worktrees, tampered local-ledger joins, accidental reviewer mutation,
implementer push attempts, and partial publication resume.

### Mandatory live drives

Run:

```bash
npm run check
npm run test:e2e
npm run e2e:live -- --prod-models
npm run e2e:live -- --prod-models --recover
```

The live suite must cover:

- multi-repository dependency ordering;
- Opus/Fable/Grok security review with overlapping and unique findings;
- initial and follow-up commits in the visible history;
- ordinary commit messages without reviewer/model/finding trailers;
- no-change-only decisions;
- reviewer write/commit tools absent and supervisor publication denial;
- implementer push/PR denial;
- skill activation;
- runtime model provenance retained only in the local Maestro ledger;
- accurate cache accounting;
- SIGKILL after implementation checkpoints;
- SIGKILL after follow-up commits but before publication;
- partial multi-repository publication recovery;
- existing provenance-free PR body refresh;
- path-scoped Git identities across repositories;
- replacement environment inheritance across real child processes; and
- supervisor denial of writes to source/unrelated roots and denial of
  publication access.

## Cutover definition of done

- A plan is a validated workflow.
- Plan to Auto requires one approval and runs the approved digest.
- Auto plans and approves before autonomous work.
- Hack remains direct.
- Single- and multi-repository changes use the same workspace model.
- Cross-repository dependencies and artifact reads are explicit.
- Implementers create visible initial and follow-up implementation commits with
  normal task-oriented messages.
- Review happens once against immutable commit ranges.
- A lens can run on several models.
- The implementer receives de-attributed findings only.
- Every finding has a recorded decision and valid lineage.
- Maestro retains a local-only review ledger; PRs and commit messages contain no
  review provenance.
- Only depth 0 pushes and creates or updates PRs.
- The workflow is a flat DAG and requires no nested agents.
- The workflow runtime and descendants inherit a clean outer supervisor sandbox
  without a dependency fork, proven by the live drive.
- Agent-toolkit skills are globally discoverable in workflow children.
- Footer and HUD show current and fleet usage, cache rates, and the flat workflow
  task hierarchy.
- Resume is idempotent for workflows, commits, usage, branches, and PRs.
- The old custom workflow, worker protocol, ask chain, and research stack are
  removed.
- Unit, hermetic e2e, production live drive, and recovery live drive pass.
