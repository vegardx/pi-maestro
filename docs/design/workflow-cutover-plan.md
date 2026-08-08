# Workflow cutover plan

**Status:** Accepted implementation plan; W0 capability spike in progress.

This plan replaces pi-maestro's custom plan, worker, review, and question
orchestration with an opinionated integration around:

- `@agwab/pi-workflow`
- `@agwab/pi-subagent`
- `pi-web-access`
- `@juicesharp/rpiv-ask-user-question`
- the separately installed `vegardx/agent-toolkit` Pi package

The target is a smaller maestro that owns modes, approval, multi-repository
workspace preparation, private review provenance, accounting, presentation,
and publication. `pi-workflow` owns durable orchestration and `pi-subagent`
owns child execution.

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
10. Reviewer provenance is withheld from the implementer and retained by
    maestro. It may be disclosed in the PR only after the decision stage closes.
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

## Target architecture

```text
Pi seat / pi-maestro
  modes · workflow approval · workspace · private provenance
  footer/HUD · usage ledger · local lineage · push/PR
                 |
                 v
@agwab/pi-workflow
  topology · artifacts · profiles · lifecycle · resume
                 |
                 v
@agwab/pi-subagent
  agent execution · model routing · hierarchy · ambient skills

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
  private/              seat-only artifacts, outside every child-readable cwd
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
- publishing and review-disclosure policy; and
- pinned `agent-toolkit` package revision.

Ambient skill selection is runtime model behavior. The digest records the
toolkit revision but does not claim which skill will be selected.

No worktree or child agent may be created before approval. Mode transition
requests are serialized so concurrent gestures produce one approval and one
launch. A mode change during execution applies to the next request and does not
implicitly cancel the current run.

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

There is no nested DAG, loop, verifier, retry review, or model-written PR
provenance report.

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

Normalization deterministically validates, deduplicates, and assigns stable
content-derived IDs. It emits two projections:

```text
sanitized findings -> implementer
private provenance -> maestro only
```

The implementer projection contains no model identity, reviewer identity,
agreement count, severity, required resolution, or recommended fix.

Private provenance must be outside the implementer's readable filesystem and
absent from its prompt and artifact manifest. If the dependency runtime cannot
provide the necessary read boundary, maestro must retain a small private
artifact capability; prompt-only de-attribution is insufficient.

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
2. the seat plus every workflow task and nested subagent rooted in that session.

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
                      -> nested consultations
```

The footer shows compact current and fleet totals, cache-hit rates, mode, model,
and context. Narrow layouts drop fleet details before current-session context.

## Publication

Publication starts only after approval, review decisions, lineage, provenance,
and final checks pass for every repository.

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

PR review disclosure is configurable as `none`, `lenses`, `models`, or `full`.
The default is `models`. Deterministic PR rendering joins private provenance to
decisions only after the implementer stage closes. It reports which reviewers
flagged addressed or considered findings without severity or voting language.

## Implementation work packages

### W0 - Capability spike (blocking)

**Owner:** one subagent. **Dependencies:** none. **No production deletion.**

Prove with a disposable multi-repository fixture:

1. Programmatic workflow launch from the maestro extension.
2. `single -> foreach cohorts -> support -> single -> support` execution.
3. Different top-level cohorts resolve different concrete models.
4. Pi starts from a non-Git directory containing several child repositories.
5. Maestro creates and resumes one worktree per selected repository under one
   coordinated run workspace.
6. Implementer stages share the coordinated worktrees and create initial and
   follow-up local commits.
7. Reviewer stages inspect exact immutable ranges across one or more repos.
8. Reviewer write, commit, push, and PR attempts are denied by tools and OS
   policy.
9. Implementer push and PR attempts are denied.
10. Global `agent-toolkit` skills are discoverable; the old `--no-skills`
    behavior is absent.
11. Runtime-resolved model IDs and leaf token/cache usage are observable.
12. Workflow/stage/foreach hierarchy is observable.
13. Private provenance is unreadable to the implementer.
14. Child processes do not inherit stale maestro socket, token, or agent ID.
15. Stop/restart/resume preserves worktrees and does not duplicate commits.

Deliver a written compatibility report, fixture, and tests. Shared worktree,
private artifact, commit, authority, skill, or telemetry failures block the
cutover and must be solved at the dependency/adapter boundary first.

The initial source/API spike is recorded in
[`spikes/workflow-runtime-capabilities.md`](spikes/workflow-runtime-capabilities.md).
It validates the flat DAG, same-lens multi-model routing, ambient-skill launch
shape, terminal usage records, and run-qualified multi-repository worktree
mechanics. It does not yet prove cross-repository workflow scheduling, process
recovery, or resume-safe usage replay. W0 is not cleared: reviewer OS-level
write/read isolation, replacement child environments, a least-authority
workflow commit route, and the split bundled/root `pi-web-access` versions still
require retained adapters, upstream support, or explicit compatibility proof
plus the live acceptance drive.

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

- Add raw, sanitized, provenance, decision, coverage, and publish-report types.
- Add stable finding IDs and deterministic deduplication.
- Add private contributor membership.
- Add exact decision coverage.
- Add deterministic PR report rendering.
- Test duplicate, unique, malformed, missing, duplicate-decision, unknown-ID,
  changed, and no-change cases.

This package stays pure and independent of the workflow runner.

### W3 - Multi-repository workspace and Git lineage

**Owner:** one subagent. **Dependencies:** W0.

- Generalize `workspace.ts` from one deliverable to a repository registry.
- Discover and validate selected Git roots.
- Create/resume one worktree and branch per selected repository.
- Preserve path-scoped Git identity.
- Retain the explicit-path local commit tool.
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
- Ensure the decision stage receives only sanitized findings.
- Add fixtures for one repo, multiple repos, one lens/many models, and multiple
  lenses/model cohorts.

### W5 - Workflow runner and projection

**Owner:** one subagent; integrate serially. **Dependencies:** W2-W4.

- Add planner, manifest, runner, artifact, and projection adapters.
- Select or form and validate workflows.
- Resolve concrete profile models.
- Bind workflows to coordinated workspaces.
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
- Integrate `rpiv-ask-user-question` if it has a callable extension API;
  otherwise use seat UI confirmation for approval and retain the package for
  pre-plan model questions.
- Ensure workflow agents receive no question tool.

### W7 - Usage, footer, and recursive agent tree

**Owner:** one subagent. **Dependencies:** W0 telemetry and W5 projection.

- Add revisioned usage ledger and telemetry adapters.
- Capture seat and leaf workflow/subagent usage.
- Restore the footer with correct cache arithmetic.
- Add recursive workflow/repository/stage/task hierarchy.
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
- Render per-repository and cross-repository review provenance.
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
- implementation checkpoints and follow-up commit lineage;
- finding normalization and private provenance membership;
- exact decision coverage;
- deterministic PR rendering and existing PR updates;
- root-only publication;
- recursive workflow/agent tree projection;
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
8. Overlapping findings normalize to one de-attributed finding.
9. The implementer cannot access contributor identity.
10. Every finding has a decision.
11. Accepted findings create repository-qualified follow-up commits.
12. Coverage and lineage pass before publication.
13. Only depth 0 mutates remotes.
14. PRs are created or updated and cross-linked.
15. Current and fleet usage do not double-count replay.
16. The workflow emits no question.

Also test rejection, stale manifests, missing decisions, bogus commit refs,
dirty worktrees, tampered provenance, reviewer mutation attempts, implementer
push attempts, and partial publication resume.

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
- no-change-only decisions;
- reviewer write/commit/push denial;
- implementer push/PR denial;
- skill activation;
- runtime model provenance disclosed only after decisions;
- accurate cache accounting;
- SIGKILL after implementation checkpoints;
- SIGKILL after follow-up commits but before publication;
- partial multi-repository publication recovery;
- existing PR body refresh;
- path-scoped Git identities across repositories; and
- tampered digest/provenance publication refusal.

## Cutover definition of done

- A plan is a validated workflow.
- Plan to Auto requires one approval and runs the approved digest.
- Auto plans and approves before autonomous work.
- Hack remains direct.
- Single- and multi-repository changes use the same workspace model.
- Cross-repository dependencies and artifact reads are explicit.
- Implementers create visible initial and review-response commits.
- Review happens once against immutable commit ranges.
- A lens can run on several models.
- The implementer receives de-attributed findings only.
- Every finding has a recorded decision and valid lineage.
- Maestro retains private provenance and renders it deterministically in PRs.
- Only depth 0 pushes and creates or updates PRs.
- Agent-toolkit skills are globally discoverable in workflow children.
- Footer and HUD show current and fleet usage, cache rates, and recursive agent
  hierarchy.
- Resume is idempotent for workflows, commits, usage, branches, and PRs.
- The old custom workflow, worker protocol, ask chain, and research stack are
  removed.
- Unit, hermetic e2e, production live drive, and recovery live drive pass.
