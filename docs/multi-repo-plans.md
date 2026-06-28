# Multi-repo plans (design)

Status: **implemented** — the model below ships in the modes extension
(`Plan.repos`, `Deliverable.repo`, `repoFor`, per-deliverable routing/guard,
cross-repo ordering-only deps). This document is retained as the design record;
see [Usage → Multi-repo plans](usage.md#multi-repo-plans) for how to use it.
Validated against the `maestro-sandbox-{lib,service,docs}` repos.

## Problem

Today a plan is single-repo:

- `Plan.repoPath: string` is the one and only repo (`schema.ts`).
- `Deliverable` has no repo field — it inherits the plan's repo implicitly.
- Every repo-touching seam keys off `engine.get().repoPath`:
  - worktrees: `worktreePathFor(plan.repoPath, d.id)` →
    `<parent>/worktrees/<repo-name>/<deliverable-id>`,
  - sequential checkout / fanout base: `detectDefaultBranch(repoPath)`,
  - ship cwd: `d.worktreePath ?? plan.repoPath`,
  - sync/park gh calls: `engine.get().repoPath`,
  - the mismatch guard: `gitToplevel(repoPath)` vs `gitToplevel(ctx.cwd)`.

A deliverable therefore cannot target a different repo than its plan.

## Decisions

### 1. Repo identity: a plan-level repo registry

Add a registry to the plan and let deliverables reference a repo by key:

```ts
interface PlanRepo {
	key: string;        // "lib", "service", "docs"
	path: string;       // absolute repo path
	defaultBranch?: string; // cached; else detect at use
}

interface Plan {
	// ...
	repoPath: string;          // retained = default repo (key "default")
	repos?: PlanRepo[];        // optional; absent ⇒ single-repo plan
}

interface Deliverable {
	// ...
	repo?: string;             // registry key; absent ⇒ plan default repo
}
```

Rationale over a per-deliverable `repoPath`:

- One place resolves paths + default branches (no duplication across siblings).
- The guard and UI can enumerate the plan's repos.
- Backward compatible: `repos` absent and `repo` absent ⇒ today's behavior, with
  `repoPath` as the implicit default.

Resolver: `repoFor(plan, d) → PlanRepo` returns the registry entry for
`d.repo`, falling back to a synthetic `{key:"default", path: plan.repoPath}`.

### 2. Worktree / branch namespacing — already safe

`worktreesRoot(repoPath)` namespaces by the repo's own name
(`<parent>/worktrees/<repo-name>/`). Resolving the worktree against each
deliverable's repo path yields disjoint trees per repo automatically — no
collision work needed. Base-branch detection runs per the deliverable's repo
(`detectDefaultBranch(repoFor(plan,d).path)`).

### 3. Ship / sync / park routing — extend the existing cwd thread

The cwd threading already added to commit (`ShipDeliverableInput.cwd`) is the
hook. Change the resolution from `d.worktreePath ?? plan.repoPath` to
`d.worktreePath ?? repoFor(plan, d).path`. sync/park gh calls switch from
`engine.get().repoPath` to `repoFor(plan, d).path` per deliverable.

### 4. Guard becomes per-deliverable, not per-plan

`assertPlanRepo(ctx)` today asserts the session sits in the plan's single repo.
With multiple repos:

- **Sequential `/implement` / `/ship`:** assert the session cwd resolves to the
  *active deliverable's* repo (`repoFor(plan, d)`), since sequential work edits
  the session's own checkout. Wrong repo ⇒ warn + abort.
- **Fanout `/implement`:** each worker runs in its deliverable's worktree under
  that deliverable's repo, so the per-session guard does not apply; the
  worktree is created against the resolved repo path directly.
- **`/sync`:** no cwd requirement — it only makes gh calls per deliverable's
  repo, so it should *not* be gated by the session repo at all (today it is).

New shape: `assertDeliverableRepo(ctx, d)` replacing the plan-wide check;
`/sync` drops the guard.

### 5. Cross-repo `dependsOn` is ordering-only

`dependsOn` is the stacking edge: `pickBaseBranch` returns the parent
deliverable's branch so stacked PRs build on each other. That assumes a shared
git history. **Across repos there is no shared base**, so:

- When parent and child are in the **same** repo → unchanged (branch stacking).
- When they are in **different** repos → the edge is **ordering-only**: the
  child's base is its own repo's default branch; no branch stacking, no
  cross-repo PR base. Sync still blocks the child until the parent ships.

`pickBaseBranch` gains a repo check: only stack when `repoFor(parent) ==
repoFor(child)`.

### 6. Migration / compatibility

- `repos` and `repo` are optional. Existing plans (no registry, no per-deliverable
  repo) behave exactly as today; `repoPath` remains the default repo.
- `/plan` seeds `repoPath = ctx.cwd` as today; a multi-repo plan adds registry
  entries explicitly (a future `repo` tool action or `/plan --repo key=path`).

## Worked example — lib → service → docs

```
Plan repos:
  default → maestro-sandbox-lib       (dev)
  service → maestro-sandbox-service   (dev)
  docs    → maestro-sandbox-docs      (dev)

D1  implement lib `clamp`        repo=default
D2  implement service clampedTotal  repo=service  dependsOn D1   (cross-repo ⇒ ordering-only)
D3  document the API             repo=docs     dependsOn D1,D2 (cross-repo ⇒ ordering-only)
```

- D1 worktree: `worktrees/maestro-sandbox-lib/D1`, base `dev`, PR vs lib `dev`.
- D2 worktree: `worktrees/maestro-sandbox-service/D2`, base service `dev` (NOT
  D1's branch — different repo), PR vs service `dev`. Sync gates D2 on D1 shipping.
- D3 worktree: `worktrees/maestro-sandbox-docs/D3`, base docs `dev`.
- Guard: a sequential `/ship` of D2 requires the session cwd to be the service
  repo; running it from lib warns + aborts.

Validate with `make dogfood-sandbox SANDBOX_REPO=<repo>` and the cross-repo
scenarios (7/9/10) in `maestro-sandbox-lib/SCENARIOS.md`.

## Follow-on implementation deliverables (sized, ordered)

1. **Schema + resolver** — add `Plan.repos`, `Deliverable.repo`, `PlanRepo`;
   `repoFor(plan, d)` helper; engine validation (repo key must exist). Pure,
   fully unit-testable. *(small)*
2. **Repo registry tool surface** — `deliverable`/`plan` tool action to register
   repos and assign a deliverable's repo; `/plan` keeps seeding the default.
   *(small)*
3. **Route worktree/branch/ship through `repoFor`** — swap `plan.repoPath` for
   `repoFor(plan, d).path` in `prepareWorktree`, `prepareSequentialBranch`,
   `shipDeliverableFromPlan`; per-repo `detectDefaultBranch`. *(medium)*
4. **Per-deliverable guard + sync ungating** — replace `assertPlanRepo` with
   `assertDeliverableRepo(ctx, d)`; drop the guard from `/sync`; route sync/park
   gh calls per deliverable repo. *(medium)*
5. **Cross-repo dependsOn = ordering-only** — `pickBaseBranch` only stacks within
   the same repo; cross-repo edges resolve to the child repo's default branch;
   sync still gates ordering. *(small)*
6. **Docs + scenarios** — update usage docs; add a multi-repo plan scenario to
   the sandbox. *(small)*

Dependency order: 1 → 2 → 3 → 4 → 5 → 6 (3 and 4 may overlap once 1 lands).
