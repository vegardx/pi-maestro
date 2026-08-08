# End-to-end testing

Use the lowest tier that can observe the boundary being changed, but do not
call process launch, Git identity/signing, or shipping work complete without
the live workflow drive.

| Tier | Command | What it proves |
| --- | --- | --- |
| Unit/integration | `npm run check` | schemas, manifests, ledgers, recovery logic, extension smoke |
| Hermetic workflow E2E | `npm run test:e2e:workflow` | real supervisor, pi-workflow, pi-subagent, worktrees, phase sandbox, seat commits and shipping adapter with deterministic fake models |
| Full hermetic suite | `npm run test:e2e` | workflow cases plus the explicitly disabled legacy rollback drive |
| Live workflow | not yet wired | real provider/model processes, ambient skill activation, Git identity/signing, and production shipping |

## Hermetic workflow drive

`test/e2e/maestro/workflow-drive.e2e.test.ts` has three scenarios:

1. happy path across two repositories, an implementation dependency, five
   concurrent reviewers, a de-attributed decision handoff, seat checkpoints,
   usage/cache accounting, and shipping;
2. human refusal before any branch, worktree, runtime, commit, push, or PR;
3. decision-task failure followed by a new production runner using `continue`,
   without replaying implementation, review, or prior commits.

The fake Pi executable sits below the real
`supervisor -> pi-workflow -> pi-subagent` boundary. It makes model output
deterministic while retaining process, environment, state, and scheduling
behavior. A separate extension test crosses Plan → Auto through the real
approval gate and production runner factory.

The old `test/e2e/maestro/drive.e2e.test.ts` explicitly sets
`PI_DISABLE=maestro.workflowCutover`. Its green result proves only that the
temporary rollback path still works; it is never workflow-cutover evidence.

## Live workflow drive

The new workflow live script is still an open acceptance item. It must create
disposable repositories, linked worktrees, a private Pi home, and local bare
remotes; run the production workflow path with real configured providers while
leaving global Pi settings and auth unchanged; and retain enough state to
inspect phase stderr and model sessions on failure.

`npm run e2e:live` remains an alias for `e2e:live:legacy`; label it as legacy
if diagnosing the rollback executor. It is not a substitute for the workflow
drive.

## Why live remains required

Unit and hermetic tests cannot fully observe environment inheritance between
detached processes, provider credential refresh, real skill selection, path-
scoped Git identity, GPG/SSH signing, or remote tooling. Those seams have
previously failed under a completely green deterministic suite.

The same rule applies to the OS sandbox. A useful test distinguishes:

1. unsupported platform, where workflow launch must refuse;
2. supported and enforceable, where a real forbidden write is denied;
3. nominally supported but missing runtime dependencies, where launch must
   refuse rather than silently run unconfined.

Conditional skips must assert and report which precondition selected them.
