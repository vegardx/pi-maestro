# Authored plans

An authored plan describes repositories, deliverables, dependency edges, the
work each deliverable is, and who reads that work when it is done. It is intent,
not runtime state. It is stored at `schemaVersion: 7`.

**Version 7 removed the `approve-plan` gate.** The person leaving plan mode has
already agreed the description, read the plan and seen what the plan check said
before answering `Start the run?` — so the start **is** the approval, and a run
that parked seconds later to ask the same person about the same digest was asking
twice. `policy.gates` is `ship` or `every-deliverable`, there is no migration,
and a `schemaVersion: 6` envelope is refused by name.

**Version 5 moved reviews off the task and took the run's shape out of the
document.** A `tasks[]` entry is work — implementation, tests, docs, and nothing
else — and a deliverable lists its reviews once, in `reviews[]`, beside them.
`deliverables[].stages` is gone: how a deliverable runs is derived from its
tasks, its reviews and the policy. There is no migration: a stored
`schemaVersion: 4`, a task still carrying `review` or `by`, and a deliverable
still carrying `stages` are each **refused by name**.

Why: version 4 encoded "this is work" as the *absence* of `review`, and absence
is the one thing a model filling in every field will not produce. Four by-hand
passes put `review` on every task in a deliverable, leaving nobody writing the
code; the same passes filled `skill: ""` and `model: ""` throughout and wrote an
explicit `stages` block that duplicated and contradicted the task reviews it
sat beside. The document's guidance had grown to thirty-three field notes and
four kilobytes of capitalised warnings to hold that shape together. When
guidance has to shout, the shape is wrong.

## Shape

Each repository has a stable key and working-tree path. Each deliverable names:

- its repository;
- `tasks`: the work, in order, at least one;
- `reviews`: who reads that work, zero or more, absent and empty meaning the
  same thing;
- `after` dependencies that order work;
- `reads` dependencies whose outputs may be consulted.

The plan itself carries a `slug`, a `title`, an optional `body`, its `repos`,
and a `policy` the seat attaches (below).

`reads` must remain a subset of `after`. IDs are bounded workflow-safe slugs and
the graph must be acyclic.

A `reads` edge says one deliverable may consult another's output, not that its
code depends on it. The fan-out a run compiles has no per-item ordering to
express a code dependency, so a plan whose `reads` implies one is **refused by
name** rather than compiled with the edge silently dropped — a dropped ordering
edge is a run that looks correct and builds against a tree that does not exist
yet.

### Reviews

A review is not a task. A `reviews[]` entry says which independent point of view
to apply to the deliverable's finished work, and how much reviewer it is worth.
`lens` is the only required field:

- `lens` — **required**: the fan-out key, `^[a-z][a-z0-9-]{0,63}$`. A review with
  an empty or missing lens is refused, and the refusal says what to do instead:
  *a review needs a lens; a task that is not a review is simply a task, and
  belongs in `tasks` with no review entry*.
- `model` — an exact `provider/model` ID, validated only when present. Pinning
  one makes the plan run on hosts that have that model and nowhere else.
- `skill` — an ambient skill name to request explicitly in the stage prompt.
- `tier` — `light`, `standard`, or `heavy`: how much reviewer the lens is
  worth, for the host to resolve.
- `diverse` — ask for a reviewer from a different model family than the
  implementer.

A review that names neither a `model` nor a `tier` is legal; the running
workflow's effort dial then decides what the reviewer is. At most sixteen
reviews read one deliverable, which is the fan-out's own bound. The same lens
twice is not an error — it is how one point of view runs under two models — and
the compiler suffixes the duplicates `-2`, `-3` by declaration order.

#### `model` and `skill` are checked against this host

Both name something outside the document, so both are checked against the
session the plan is written in, at plan time, and refused by name when it does
not have them:

- `model` must be a model the host's registry has. The refusal lists the
  registered providers, so the author can correct it in one step.
  **Authentication is not required** — whether a provider is logged in is a
  run-time question about credentials, and a document that depended on a login
  would be valid and invalid by turns.
- `skill` must be a skill Pi has loaded in this session. The refusal names the
  loaded skills, or counts them when there are more than twenty.

Both questions reach validation through one injected port. **With no session to
ask, a pinned `model` or `skill` is refused**, never accepted unchecked: a plan
that pins what nothing could verify is exactly the case the check exists for.
The same port answers for the store and for the hand-off's own validation of the
document it obtained and of every rewrite the plan check asks for, so they cannot
disagree about one document. Version 4 asked these questions twice per review — once at
`tasks[].review` and again at the lens it seeded — which meant a rule an author
could escape by moving the field; there is one site now, and one message.

### How a deliverable runs

Derived, never authored. There is one lowering, and it is
`defaultStagesFor` — so the graph a person approves is the graph the run
executes:

```jsonc
[ { "use": "implement",      "id": "implement" },
  { "use": "verify-and-fix", "id": "verify", "maxRounds": <policy.maxFixRounds> },
  { "use": "review-fan-out", "id": "review",
    "lenses": [ /* one per `reviews` entry, tier and diverse from it or policy.reviewDefault */ ],
    "synthesis": "optional" } ]
```

The review stage is **omitted** rather than declared empty when the deliverable
lists no reviews: a fan-out over zero lenses is not a cheaper review, it is a
stage that cannot be compiled. `maxRounds` is mapped to the component's verify
rounds on the way out (`fix + 1`, so a fix is never left unchecked), and where a
run stops for a human is `policy.gates` rather than a stage of its own.

**pi-maestro does not compile this.** The lowering above is pi-workflow's, stated
here so a reader knows what a plan becomes. This seat used to derive the graph
itself and validate it against a local mirror of the runtime's closed schema, and
show it in a dialog; both are gone. What a person is shown is the plan — the
work, and who reads it — because that is what the document says and what an edit
to it could change.

### Policy

`policy` is plan-wide and is **not written by the model**: the schema has no
`policy` field. The hand-off settles it — the effort a human
chose, the gates this seat defaults to, the publication derived from the
repository — and the harness attaches it to the document it stores. A plan
written any other way carries none and the defaults below apply. It is on the
document, not only in a dialog transcript, so a reviewer can see where a run is
going and the plan digest covers it.

| Field | Values | Default |
| --- | --- | --- |
| `effort` | `cheap`, `standard`, `deep` | `standard` |
| `gates` | `ship`, `every-deliverable` | `ship` |
| `reviewDefault` | `{tier?, diverse?}` | `{tier: "standard", diverse: false}` |
| `maxFixRounds` | `0`, `1`, `2` | `0` cheap, `1` standard, `2` deep |
| `publish` | `{mode: "none"\|"branch"\|"pr", base?}` | `{mode: "none"}` |

`gates` is where the run stops for a person. `ship` is one decision after all
the work and before anything is published; `every-deliverable` adds one after
each deliverable as well. There is no "no gates" value: a publication is proven
by the `ship` checkpoint's own decided value, so a run with no ship decision is
a run nothing can be published from.

`publish` says what happens to the run's result, and publication is pi-maestro's
own audited Bash work — the workflow runtime never pushes, merges, or publishes,
and **publication is never inside a delegation ceiling**: pushing is this seat's
own act, under its own classified Bash policy and a durable human decision.
`publish.base` must be a valid ref name. Neither the remote nor `gh` is a
validation question asked of the document: the hand-off reads both off the
repository and *derives* `publish` from what it finds, so a `mode` the machine
cannot honour is not written down in the first place.

### Example

```jsonc
{
  "slug": "compose-catalogue", "title": "Component catalogue",
  "body": "Why the catalogue is worth building.",
  "repos": [{ "key": "wf", "path": "/Users/vegardx/src/github.com/vegardx/pi-workflow" }],
  "policy": { "effort": "standard", "gates": "ship",
              "maxFixRounds": 1, "publish": { "mode": "pr", "base": "main" } },
  "deliverables": [{
    "id": "catalogue", "title": "Ship the component catalogue",
    "after": [], "reads": [],
    "tasks": [{ "id": "impl", "title": "Write src/components/*.ts" },
              { "id": "tests", "title": "Cover each component" }],
    "reviews": [{ "lens": "contracts", "tier": "heavy", "diverse": true },
                { "lens": "replay", "tier": "standard" }]
  }]
}
```

### Repository paths

Each `repo.path` is validated against the filesystem: it must be an existing
Git working-tree root, so `git rev-parse --show-toplevel` run there resolves to
the path itself. A path inside a repository but below its root is refused and
the error names the real root, because the run creates worktrees from this path
and would otherwise disagree with itself about which tree it is working in.

An uncommitted change in that tree is a warning, never a refusal: authoring a
plan while the tree has edits in it is the normal case. The warning is worth
recording because every worktree a run creates branches from HEAD, so those
edits are not in the run.

## The hand-off

**Plan mode is a conversation, and the plan lives in it.** The model writes the
plan and revises it as an ordinary message — deliverables, work tasks, reviews,
dependencies — the way anybody plans anything with anybody. Nothing about plan
mode says how a plan is executed: the modes are permission dials and only that.

**Leaving plan mode is the trigger.** `/mode auto` or `/mode hack` says the
planning is over, and everything between that sentence and a run is one flow,
inside the `/mode` call, with nothing on disk between its steps. A session that
dies mid-hand-off has no hand-off.

Two things can only come from the model — the description we agree on, and the
v5 document formed from the plan as written — and **the harness asks for both
directly**: an ordinary completion outside Pi's agent loop, with the session's
own history as context, one system prompt saying what is wanted, and **no tools
offered at all**. It used to be a steer and two tool calls; four by-hand passes
failed at the same place, with the model reaching for other tools, answering in
prose, streaming one tool call for nine minutes, and repeating an identical
refusal four times. A steer is a request a model may interpret. This is not.

### What the person is asked

**Two dialogs, and at most one more.**

1. **The effort dial** — the one question a repository cannot answer. `cheap`,
   `standard` or `deep`, with `standard` first and what escape takes.
2. **One confirmation**, at the end, carrying everything that is being agreed
   to: the description in full, the plan summary (each deliverable with its
   tasks, its `after` edges and who reads its work), the effort, the gates,
   where publication goes and why, and what the plan check said. `Start the run`
   is first. `Edit the description` opens an editor and comes back to the same
   confirmation. `Just switch, keep the plan stored` switches the posture and
   starts nothing. `Keep planning` is what escape takes, because starting a run
   IS the approval and an approval obtained by not answering is not one.

The third dialog is the plan check's, and only when the check found something a
rewrite cannot answer (below).

Nothing else is asked. **Publication is derived** from the repository — an
`origin` remote and `gh` on PATH means a pull request, a remote alone means a
branch, neither means the work stays on this machine — and the sentence saying
which and why is in the confirmation, not in a dialog. Gates take `ship`. Review
lenses are the plan's and `policy.reviewDefault`'s. The
[command reference](commands.md#the-hand-off) lists every dialog, what is first
in it, and what escape takes.

### What the model is asked

Twice, in two system prompts. For the description: two or three sentences a
reader who has not seen the conversation would understand — what we set out to do
and why it is worth doing — as plain prose. It is the **plan check's yardstick**,
which is why it exists before the document does: a reader handed the plan as its
own justification can only check the plan against itself. For the document: the
field guide, the plan schema as JSON Schema, the agreed description, and the
decided policy stated in prose as *already decided, not yours to write*. The
answer is one JSON object and nothing else.

**The bounds.**

- **Three attempts each.** A retry carries the previous answer and the
  validator's own sentences, so the second request is a conversation about a
  specific document rather than the same request asked again.
- **The document's own validators**, in the document's own order:
  `authoredPlanProblems` → `withoutEmptyOptionals` → `planFrom` → `inspectPlan`
  → `savePlan`. Nothing invalid reaches disk.
- **A context guard.** Above 80% of the model's context window the hand-off stops
  before the first request, naming the usage and suggesting `/compact` and then
  leaving plan mode again. Asking a full session for a plan spends a request on a
  document that would be truncated.
- **Leaving plan mode with nothing planned is never a hang.** The model is still
  asked, because the harness cannot know what is in a conversation until it does;
  when the answer is empty or refused, the person gets the posture they typed
  with one sentence saying why there is no plan behind it, and `/mode plan` goes
  back to planning.

### The plan check

Once the document is stored it is read **in a fresh context** by a one-shot
subagent — `plan-reviewer`, shipped in `packages/maestro/agents/` and launched
through the shared `@vegardx/pi-subagent` service. It is given the plan document
and the agreed description, may read the repository the plan names, and returns
findings only. It has read-only tools, no workspace, `contextScopes: []` and
`contextMode: "fresh"`, so it has not read the conversation, `AGENTS.md`, or
anything else — a reader who inherited the conversation agrees with it. The
launch carries `ceiling: { workspaceModes: [read-only] }`, so there is no version
of it that writes, whatever posture the seat is in.

It returns `{verdict, findings, notes}`. A finding carries an `id`, a `severity`
(`blocking`, `major`, `minor`), a `where` a reader can find, a `summary`, an
optional `direction` addressed to the plan's author, and `needsPerson` with a
`question` when only a person can answer it.

**THE HARNESS ACTS ON THE FINDINGS ITSELF.** This is the part that changed. A
blocking finding used to be a dialog per finding, with a patch to accept or a
reason to type — the largest dialog surface in the seat, asking a human to
arbitrate between two models about a document neither had run yet. Now:

- **Nothing blocking** → the confirmation, with the verdict, the counts and the
  findings summarised. `major` and `minor` are read there and never asked about.
- **Blocking, and no `needsPerson`** → the findings and their directions are
  appended to the same mini-conversation the document came from, the model
  rewrites the whole document, it is validated and stored, and the check runs
  again. Silently, and **at most twice**.
- **Any `needsPerson`, or the bound spent with something still blocking** → one
  dialog with those findings and their questions: `Proceed anyway` (first) or
  `Keep planning` (what escape takes). Only the findings a rewrite cannot answer
  are asked; the rest are not put in front of a person.
- **The check could not run** — no subagent runtime, a refused launch, a timeout,
  an output this seat cannot read — → the confirmation says so and names the
  reason, sanitized. A check that could block a hand-off by being broken would be
  a worse check than none.

### What the conversation learns

One custom message when the plan is stored, one per rewrite, and one more when
the run starts or the hand-off goes back: the slug, the digest, the deliverable
count, the outcome, and — when a run started — its run id, said to be the
harness's doing rather than the conversation's. Nothing else the harness did
appears in the transcript — no steers, no tool calls, no retries, and none of the
check's findings. The requests are on the record in `authoring.json` beside the
plan:

```json
{
  "schemaVersion": 2,
  "attempts": [
    {
      "kind": "intent",
      "startedAt": "2026-09-16T12:00:01.000Z",
      "durationMs": 1000,
      "model": "anthropic/opus-5",
      "thinking": "medium",
      "ok": true,
      "problems": [],
      "responseDigest": "0f4a…"
    },
    {
      "kind": "check",
      "startedAt": "2026-09-16T12:00:09.000Z",
      "durationMs": 41000,
      "model": "anthropic/opus-5",
      "thinking": "medium",
      "ok": true,
      "problems": [],
      "responseDigest": "b711…",
      "verdict": "gaps",
      "counts": { "blocking": 0, "major": 1, "minor": 2 }
    }
  ]
}
```

`kind` is `intent`, `plan`, `revise` or `check`. `problems` are the validator's
own sentences — or, for a check that could not run, the one sanitized reason —
and never a provider error, a stack, a path or any of the answer's text;
`responseDigest` is what stands in for the answer. `verdict` and `counts` are on
a `check` attempt and nowhere else: what the reader said about the plan and how
many things of each severity it said it about. The findings themselves are not
recorded — they are prose about somebody's repository, and this file is a record
of what the harness did. The requested thinking level is the effort's
(`cheap`/`standard`/`deep` → `low`/`medium`/`high`) and never below the session's
own.

### The posture, and where it moves

**The seat stays in plan mode for the whole hand-off.** `/mode auto` used to
switch first and ask later, which left every path that ends without a run in a
posture nobody chose for what they ended up doing. `setMode` is called on exactly
three answers: the run started, *Just switch, keep the plan stored*, and the one
case where this flow has nothing to offer at all — no plan in the conversation,
so no document — which switches **with the reason shown** rather than hanging.

Everything else leaves the seat in plan mode with one notice: the plan is stored
and `/plan run <slug>` starts it, and the conversation continues right here.
`/mode plan` is never offered, because the seat never left it.

### What a delegation may do, in any posture

**The mode's ceiling travels with every delegated launch**, and no mode name
leaves this repository. `modeCeiling` states the bound in pi-subagent's own
vocabulary — workspace modes and tool names — and the seat registers one provider
for it at session start, so pi-subagent's `subagent` tool and pi-workflow's
`workflow_run` both consult it:

| Mode | Ceiling |
| --- | --- |
| `plan` | `{workspaceModes: ["read-only"]}` |
| `auto` | `{workspaceModes: ["read-only", "worktree"]}` |
| `hack` | none |

A ceiling never widens an agent definition: the effective allowance is the
definition's own declaration intersected with the ceiling. pi-workflow refuses a
start whose definition needs more than the ceiling allows, **naming both** — so
`workflow_run` in plan mode is refused where the launch happens, by a sentence
about that launch, rather than by a tool allowlist in this seat that had to be
kept in step with whatever tools the runtimes happened to register. The seat's
one remaining tool rule is that plan mode is read-only: `write`, `edit` and
`delete` are withheld there.

The hand-off passes the **target** mode's ceiling with the start, because the run
begins while the posture switches and bounding it by the plan mode being left
would refuse the worktrees the run exists to write in. `/plan run` passes the
current mode's, because that is where the person typing it is standing.

### The run, and the session that narrates it

`Start the run` starts it **here, in the harness** —
`startBuiltin("plan-to-ship", {input, effort, ceiling})` through the workflow
runtime's service seam, allowlisted to that one definition by name and validated
exactly as `workflow_run` would be — and then switches to the posture asked for
at `/mode`. The model is not asked to start it and is not in that loop at all.
**Starting it is the approval**, so the run works through the plan and stops at
its `ship` decision, and under `every-deliverable` after each deliverable as
well. A runtime that refuses or fails to start it leaves the plan stored, takes
the posture the person asked for, and prints the cause with `/plan run <slug>`
still there.

**The engine executes; the session narrates.** pi-maestro observes the runs it
started and posts what it sees into the conversation as one `maestro:progress`
message per observation batch, delivered as `nextTurn`:

```text
compose · d1 · check verify — the suite passes
compose · d1 · synthesis synthesis — two lenses disagree about the seam
```

Most of it gets **no turn**: a task implemented, a check passed, one review
filed, a refine — those are facts the next turn should have, and a turn per task
would mean the model narrating its own silence forty times. Four things get a
turn, because each is something only the model can turn into a sentence a person
can act on: a **review synthesis**, a **fix report**, a **failure** of a task or
the run, and the **ship gate arriving** — which says that a decision is waiting
and that it is made with `/workflow decide <run-prefix> ship {"ship":true}` or
through the gate's own widget. A run that ends without ever stopping at a gate
gets a final summary, with a turn, because a run that finished and asked for
nothing is exactly the case a silent seat used to leave a person guessing about.

### When a runtime is not there

`@vegardx/pi-workflow` is an optional peer. Without it the hand-off stops before
the confirmation with one warning, and the plan is stored with `/plan run <slug>`
still available. Without a reachable `@vegardx/pi-subagent` service the plan
check says so in the confirmation and the hand-off continues. Neither throws into
the session.

**Nothing here writes outside those places.** The one run this hand-off starts is
allowlisted in the runtime by name, and the plan check writes nothing at all. The
hand-off runs no shell commands: nothing that writes to a repository happens in
this tree, the run does its writing in worktrees, and reaching a branch is
publication, which is a separate decision.

## From a stored plan to a run

The hand-off validates and stores the complete document, and then starts the run
itself. Storage is still not execution: pi-maestro does not compile, drive or
resume a plan — it hands the document to pi-workflow by value and gets a run id
back. A stored plan whose run never started is intent, and `/plan run <slug>`
is how it becomes a run later.

```text
conversation
  → the model, asked directly for the document
  → validation
  → <agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
  → toWorkflowInput(plan, effort)
  → <agentDir>/maestro/plans/<encoded cwd>/<slug>/workflow-input.json
  → the plan check, in a fresh context, and the rewrites it asks for
  → startBuiltin("plan-to-ship", { input, effort, ceiling })  ← the harness, after your yes
  → a run id, working, narrated into the conversation, and stopping next at `ship`
```

**Per project, and signed by the session that wrote it.** The store's root is
`<agentDir>/maestro/plans/<encoded cwd>`, where the key is the cwd encoded
exactly as Pi encodes its own sessions directory (`/Users/x/src/proj` →
`--Users-x-src-proj--`), so a project's sessions, plans and workflow runs are
siblings under one name. The envelope is schema 7 and carries
`authoredBy: {sessionId, cwd}` — required, taken from the live session — so a
plan read back names who wrote it and where. A schema 6 envelope names the
`approve-plan` gate version 7 removed and is refused by name; there is no
migration, and plans left directly under `maestro/plans/<slug>` are not read or
listed.

**By value, with a digest.** `toWorkflowInput(plan, effort)` returns
`{plan, planDigest, effort}`: the whole authored document, the sha256 of its
canonical JSON (keys sorted, no whitespace), and one of `cheap`, `standard` or
`deep`. An effort nobody named is the plan's own `policy.effort` — a decision a
human made on the way out of plan mode, which the digest covers — and
`standard` only when the document sets none. The plan travels by value because a workflow run
validates its input against the definition's schema and binds the run's
identity to it — a run given a slug could have the document change underneath
it on resume, and would then be executing something nobody approved. The digest
names exactly which bytes were approved, so a receipt can be checked against
them afterwards.

**One approval record, and it is not here.** Starting the run is the approval,
and the run's own journal records who started it and with which digest. A plan
document therefore has no `approved` field, no approver and no approval
timestamp — a second record of the same fact is a record that can disagree with
the first, and the one a human acted on is the one that counts.

### Running a plan

`/plan run <slug> [cheap|standard|deep]` is not the normal way to start a run:
the hand-off starts one for you as soon as the plan is stored. It is the
way to start or restart a run for a stored plan whose run never started or
failed. It loads the stored document, builds `toWorkflowInput(plan, effort)`,
writes that input to
`<agentDir>/maestro/plans/<encoded cwd>/<slug>/workflow-input.json`, and starts
the run through the same seam the hand-off uses:
`startBuiltin("plan-to-ship", { input, effort, ceiling })`, with the ceiling of
the mode the person is standing in. pi-maestro still has no workflow runtime of
its own and takes no dependency on one — it finds the runtime on Pi's event bus,
and a seat without one says so and leaves the plan stored. The model is never
asked to start a plan's run, and in plan mode the ceiling is read-only, so
pi-workflow refuses `plan-to-ship` — which needs worktrees — naming both the need
and the bound.

Typing the command is itself the approval — nobody types `/plan run` for a plan
they have not decided to run — and the run then works through the plan and stops
at its `ship` decision, or after each deliverable under `every-deliverable`.
That next stop is a person, not the model, which is why `/plan run` is safe to
offer at the end of a plan write. The run is narrated into the conversation the
same way the hand-off's is.

`/plan list` and `/plan show <slug>` read the same store, and read only this
project's plans — no other project's appear, and the same slug in two projects
is two plans. `/plan show` also prints the session id and cwd that authored the
plan. `/plan rm <slug>` removes a plan after a confirmation (refused outright
when the session has no UI to confirm with). Those five verbs are the whole
surface. See the [command reference](commands.md).

### Publishing what a run produced

A run ends at a receipt: per deliverable a handoff commit in the publication
repository's own object store, its sha256 and size, and the digest of the plan
the run was given. A ship decided at the run's `ship` gate publishes by itself, and the narration
tells the person the gate is waiting and how to decide it;
`/plan ship <slug>` is the manual fallback for when that did not happen. It
turns the receipt into a branch and,
when the policy asked for one, a pull request — refusing outright when the
receipt's digest is not the stored plan's, because then it names bytes nobody
approved. Every command runs through the seat's audited Bash tool under the
session mode's policy, so `host-write`, `remote-read`, `code-execution` and
`remote-write` are each classified and, in `auto`, confirmed; the repository's
own check runs **on the host** rather than in a guest; and any failure stops
**before** the push with the branch left in place.

The ten steps, in order, and where each one stops:

| # | Step | Stops when |
| --- | --- | --- |
| 1 | `inspect(runId, {include: ["run","tasks","output"]})` — the receipt, read from the run's committed `run.output.receipt` | the run cannot be inspected, or it carries no plan digest or no handoff |
| 2 | The receipt's digest against `planDigest(stored plan)` | they differ — reported as an error, and **nothing has run yet** |
| 3 | Resolve each `refs/pi-subagent/handoffs/<run>/<attempt>`, fetching from the run's `cwd` first when it is another repository | a ref does not resolve in the publication repository |
| 4 | `git switch -c pi-maestro/<slug>/<yyyymmdd-hhmm> <policy.publish.base>` | the base does not resolve, or the branch exists |
| 5 | `git cherry-pick <handoffCommit>` per deliverable, in plan order | a conflict — the pick is aborted, the branch is left, the deliverable is named, and nothing is recorded |
| 6 | The repository's own check on the host — the gate named in `AGENTS.md`, else `npm ci && npm run check` or `npm ci && npm test` from the manifest | it exits non-zero (the tail is shown), or the repository names no check at all |
| 7 | One confirmation, naming the branch, the commits and the check result | it is declined — the branch stays, nothing is pushed |
| 8 | `git push -u origin <branch>` | the push fails |
| 9 | `gh pr create --base <base> --title <plan title> --body <receipt>`, when the policy says `pr` | `gh` fails. `gh` **absent** is not a failure: the publication degrades to `branch` with a warning, before anything is created |
| 10 | Append the receipt to `<agentDir>/maestro/plans/<encoded cwd>/<slug>/publication.json` | the file exists and is not an array of receipts — it is never overwritten |

One more thing is checked between steps 1 and 2 when the publication was
triggered by an announcement rather than by `/plan ship`: the run's own `ship`
checkpoint must carry a decided `{"ship": true}`, read from
`tasks[].checkpoint.decision.value` on the task whose `kind` is `checkpoint` and
whose `key` is `ship`. The runtime shows that value only when the durable
decision record matches the journalled digest, so it is the human's answer
rather than a report of it. A gate that is undecided, or decided otherwise, is
named — with the run id — and nothing runs. `/plan ship <slug>` does not check
it, because typing the command is itself the decision.

The pull-request body is the receipt: the plan digest, every handoff ref with
its sha256 and size, the check that ran on the host, and the review verdicts
when the inspection carried them.

`publication.json` is an **append-only array**. A second ship of the same plan
is a real event — the first publication's branch and pull request exist — so
each entry is added and no earlier one is ever rewritten. An entry records the
time, the run, the plan digest, the mode, the base, the branch, the check, every
handoff ref, and the pull-request URL when there is one.

A plan whose `policy.publish.mode` is `none` is refused by name: nothing is
branched, picked or pushed, and the message says which policy said so.

Publication has two trigger paths and one implementation. `/plan ship <slug>`
asks the runtime which completed runs carry this plan's digest and, when more
than one does, asks which. A ship decided at the run's own `ship` checkpoint
announces itself on `maestro:workflow-shipped` — from the checkpoint prompt, and
from a listener on the runtime's own run observations, so a decision made with
`/workflow decide` arrives too — and the seat runs the same publication for the
stored plan that digest matches. The announcement is not the authority and is
never treated as one: the observer announces only a run whose `ship` checkpoint
already proves `{"ship": true}`, publication proves it again from its own
inspection, the digest is still checked, and step 7 still asks. There is no
second dialog asking whether the run was shipped, because that question is now
answered from the run.

The owned `@vegardx/pi-workflow` project owns everything between the input and
that receipt: runtime graph compilation, repository and worktree authority,
implementation and review stages, artifacts and structured findings, failure,
retry, resume and recovery. This package's responsibility ends at a validated
document and the run request built from it, and resumes at the publication of
the receipt that comes back.
