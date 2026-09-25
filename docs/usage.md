# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Reload Pi after installation. `@vegardx/pi-subagent` is a required peer and is
configured separately: without a session that loads it, the plan check says so and
the hand-off continues. Workflow and web extensions are intentionally not bundled.

## Modes

| Mode | Direct file tools | Bash classifier | Intended use |
| --- | --- | --- | --- |
| `plan` | blocked | reads allowed; writes/code/uncertain refused | discuss and author plans |
| `auto` | available | effect-aware with ambiguity audit | ordinary direct seat work |
| `hack` | available | reduced configurable policy | explicit direct work |

Switch posture with:

```text
/mode plan
/mode auto
/mode hack
```

Auto and hack have no OS filesystem boundary. They are explicit choices to let
the interactive seat use host-backed `write`, `edit`, `delete`, and `bash` tools.
Bash accepts an optional `intent` hint and audits unresolved plan/auto commands;
validated help/version probes let the auditor inspect unfamiliar PATH commands
without granting it a general shell. Most substantial implementation work should
be delegated to isolated subagents.

**A mode is a permission dial and nothing else.** No mode says how a plan is
executed. What a mode bounds, besides the seat's own tools, is every **delegated
launch** in the process — the `subagent` tool's, and a workflow run's — through
one **ceiling** stated in pi-subagent's own vocabulary: `plan` allows a read-only
workspace, `auto` allows read-only or a worktree, and `hack` sets no bound at all.
A ceiling never widens an agent definition; the effective allowance is the
definition's own declaration intersected with it.

A run is still not the model's to start in plan mode, and it is pi-workflow that
says so: it refuses a start whose definition needs more than the ceiling allows,
naming both the need and the bound, wherever that start came from. This used to be
a tool allowlist in this seat — `workflow_run` and `workflow_propose` refused by
name — and the rule was right while the enforcement was in the wrong place: a list
of tool names said nothing about the launches those tools make, and had to be kept
in step with whatever the runtimes happened to register. Publication is never
inside a ceiling: pushing is this seat's own act, under its own classified Bash
policy and a durable human decision.

## Planning

Planning remains a conversation, and **the plan lives in it**: the model writes it
and revises it as an ordinary message. The complete plan *document* is formed on
the way out of plan mode, by the harness — it asks the session's own model for it
directly — once requirements, repositories, dependencies, implementation work and
review intent are understood.

Plans are validated and stored per project, under the cwd encoded the way Pi
encodes its own sessions directory (`/Users/x/src/proj` → `--Users-x-src-proj--`):

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
```

`/plan list` and `/plan show` read only the project you are standing in, and the
stored envelope records the session and cwd that authored the plan.

Storing a plan is not running one. `/plan run <slug> [cheap|standard|deep]`
builds the workflow input, writes it beside the plan and starts `plan-to-ship`
through the workflow runtime's service seam, under the ceiling of the mode you are
standing in; standalone `@vegardx/pi-workflow` owns compilation, execution,
recovery, and the receipt from there.
This package's responsibility ends at a validated document and a started run —
and picks up again at publication, which is pi-maestro's own audited Bash work
and never the runtime's. See
[Authored plans](workflow-plans.md#publishing-what-a-run-produced).

## The hand-off

**The plan lives in the conversation.** In plan mode the model writes it and
revises it as an ordinary message. Switching out of `plan` mode is the trigger,
and everything between that and a run is **one flow**, inside the `/mode` call.
The two things only the model can write — the description and the v5 document
formed from the plan as written — are requested by the harness directly, as
ordinary completions outside Pi's agent loop, with the session's own history as
context and **no tools offered at all**. It used to be a steer and a tool call
each; four by-hand passes failed at that, because a steer is a request a model may
interpret.

1. **The effort dial.** How much the run may spend. That is the only dial asked:
   gates take their default, publication and the base branch are derived from the
   repository, and review lenses are the plan's own. **The mode does not change.**
2. **The description and the document**, requested and validated. Three attempts
   each; a retry carries the previous answer and the validator's own sentences.
   The agreed description is what the plan check reads the plan against, which is
   why it exists before the document does. The answers from step 1 are not the
   model's to write — the harness attaches them as the plan's `policy`, so the
   choices are part of the document that gets validated and digested without the
   author transcribing them.
3. **The plan check.** The stored document is read in a fresh context by a
   one-shot subagent: the plan and the description, read-only tools, no workspace,
   and none of this conversation. **The harness acts on the findings itself** — a
   blocking finding goes back to the plan's author with the reviewer's direction,
   the document is rewritten and checked again, silently, twice at most. You are
   asked once, and only for a finding the reviewer said needs a person, or for a
   bound spent with something still blocking.
4. **One confirmation.** The description in full, the plan (each deliverable with
   its tasks, its edges and who reads its work), the effort, the gates, where
   publication goes and why, and what the check said — all on screen, once.
   *Start the run* is first and starting it **is** the approval: the harness starts
   `plan-to-ship` itself through the runtime's allowlisted service seam, with the
   ceiling of the posture you asked for, and only then does the mode change.
   *Edit the description* comes back to the same confirmation. *Just switch, keep
   the plan stored* switches and starts nothing. *Keep planning* is what escape
   takes.
5. **Then the session narrates the run.** Each task completion is one line posted
   into the conversation. A review synthesis, a fix report, a failure, the ship
   gate arriving and a run that ends without a gate each give the model a turn to
   tell you what it means — and for the gate, that a decision is waiting and how
   to make it.

**Leaving plan mode with nothing planned is never a hang.** The model is still
asked, because the harness cannot know what is in a conversation until it does;
when the answer is empty or refused, you get the posture you typed with one
sentence saying why there is no plan behind it. Above **80%** of the model's
context window the hand-off stops before asking at all, and says to `/compact` and
leave plan mode again.

**What reaches the conversation.** One message when the plan is stored, one per
rewrite the check asked for, and one more when the run starts or the hand-off goes
back: the slug, its digest, the deliverable count, the outcome. Nothing else — no
steers, no retries, none of the check's findings. Every request is on the record
in `authoring.json` beside the plan.

Escape is always an answer, and it is always the **safe** one — never the
first-listed one, which is a different thing: the first option is what you most
likely want, and escape is what commits to nothing. Escaping the effort dial takes
`standard`, which is reversible; escaping the check's dialog keeps planning; and
escaping the confirmation starts no run. Every ending but the run and *Just
switch* leaves you in plan mode with `/plan run <slug>` and `/mode auto` both
named. The dialog tables, with a column for each of the two, are in the
[command reference](commands.md#the-hand-off).

## Questions and delegation

- `ask_user_question` is provided by
  `@juicesharp/rpiv-ask-user-question`.
- `subagent` is provided independently by `@vegardx/pi-subagent`.
- workflow tools are provided independently by `@vegardx/pi-workflow`; web
  tools are unavailable until their owned replacement is built.
- the `repository-lifecycle` skill guides direct commits, pushes, pull requests,
  checks, and checked rebase merges. Shipping downstream of a plan run belongs
  to pi-maestro's own audited Bash authority, not to model-selected Bash: the
  workflow runtime never pushes, merges, or publishes (its own
  `docs/authority.md` says so), and publication happens here, after the run's
  ship gate, under the mode's confirmation policy. `/plan ship <slug>` performs
  it: branch, cherry-pick, the repository's check on the host, one confirmation,
  push, and a pull request when the plan's policy asked for one. Publishing a
  handoff by hand, when one of those steps stops, is `git` and `gh` work under
  this skill.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
