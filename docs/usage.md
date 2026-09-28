# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Reload Pi after installation. `@vegardx/pi-subagent` is a required peer and is
configured separately: without a session that loads it, the plan check says so and
the hand-off continues. Workflow and web extensions are intentionally not bundled.

## Modes

A mode is **three facts**, and the four names are the only coherent
combinations of them: may the session touch the working tree, are the safeguards
on, and **what happens at the end of a plan run started from here**.

| Mode | Working tree | Safeguards | End of a plan run | Delegation ceiling |
| --- | --- | --- | --- | --- |
| `plan` | read | on | forms none | read-only |
| `ask` | write | on | parks at the ship decision; this session asks you | read-only or a worktree |
| `auto` | write | on | publishes the pull request when it is done | read-only or a worktree |
| `hack` | write | reduced | forms none | none |

Switch posture with:

```text
/mode plan
/mode ask
/mode auto
/mode hack
```

`ask` and `auto` are **the same permissions**. They differ in one thing: whether
the run parks at its ship gate and this session asks you, in a dialog with the
gate's inputs rendered, or publishes the pull request the moment it is done. That
is why the third fact is a column rather than a footnote — the derivation of the
gate policy, of the ceiling and of which modes a hand-off may target all read it,
and none of them writes it down a second time.

`ask`, `auto` and `hack` have no OS filesystem boundary. They are explicit choices
to let the interactive seat use host-backed `write`, `edit`, `delete`, and `bash`
tools. Bash accepts an optional `intent` hint and audits unresolved plan, ask and
auto commands; validated help/version probes let the auditor inspect unfamiliar
PATH commands without granting it a general shell. Most substantial implementation
work should be delegated to isolated subagents.

**A mode is a permission dial, and the one thing it says beyond permissions is how
a run it starts ends.** No mode says how a plan is *executed*. What a mode bounds,
besides the seat's own tools, is every **delegated launch** in the process — the
`subagent` tool's, and a workflow run's — through one **ceiling** stated in
pi-subagent's own vocabulary: `plan` allows a read-only workspace, `ask` and `auto`
allow read-only or a worktree, and `hack` sets no bound at all. A ceiling never
widens an agent definition; the effective allowance is the definition's own
declaration intersected with it.

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

Storing a plan is not running one. `/plan run <slug>` writes the gate policy of
the mode you are standing in onto the stored plan, builds the workflow input,
writes it beside the plan and starts `plan-to-ship` through the workflow runtime's
service seam, under that mode's ceiling; standalone `@vegardx/pi-workflow` owns
compilation, execution, recovery, and the receipt from there. From `plan` or
`hack` it **refuses**: neither decides how a run ends, and a run started without
an ending is a run nothing publishes. It is a fallback, not the normal way in —
leaving plan mode to `ask` or `auto` starts the run for you.
This package's responsibility ends at a validated document and a started run —
and picks up again at publication, which is pi-maestro's own audited Bash work
and never the runtime's. See
[Authored plans](workflow-plans.md#publishing-what-a-run-produced).

## The hand-off

**The plan lives in the conversation.** In plan mode the model writes it and
revises it as an ordinary message. **Leaving plan mode is Go**, and the mode you
leave to decides how the run ends; everything between that and a run is **one
flow**, inside the `/mode` call.

`/mode hack` is the exception and it is not a hand-off at all: hack is the
unrestricted in-session escape hatch, so leaving plan mode to it **only switches**.
One notice says the conversation's plan was not formed, and `/plan run <slug>`
remains for a plan already stored.
The two things only the model can write — the description and the v5 document
formed from the plan as written — are requested by the harness directly, as
ordinary completions outside Pi's agent loop, with the session's own history as
context and **no tools offered at all**. It used to be a steer and a tool call
each; four by-hand passes failed at that, because a steer is a request a model may
interpret.

1. **The gates and publication, neither of them asked.** The gates are the target
   mode's — `ask` writes `ship`, `auto` writes `none` — publication and the base
   branch are derived from the repository, and review lenses are the plan's own.
   **No dial is asked at all**, and **the mode does not change** yet. There used to
   be an effort dial here; schema 8 removed it, because one answer was standing in
   for three unrelated questions and it answered all three in the middle of a
   conversation. Implementation roles inherit the session's own model and thinking
   level; reviews keep their tiers.
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
   its tasks, its edges and who reads its work), the gates, where publication goes
   and why, what the check said, and **which ending you are starting** — all on
   screen, once. The card says it in as many words: *Ships the PR when done* for
   auto, *Stops for your ship decision* for ask. *Start the run* is first and
   starting it **is** the approval — for publication too, from auto: the harness
   starts `plan-to-ship` itself through the runtime's allowlisted service seam,
   with the ceiling of the posture you asked for, and only then does the mode
   change. *Edit the description* comes back to the same confirmation. *Just
   switch, keep the plan stored* switches and starts nothing. *Keep planning* is
   what escape takes.
5. **Then the session narrates the run, and asks what it has to ask.** Each task
   completion is one line posted into the conversation. A review synthesis, a fix
   report, a failure, the ship gate arriving and a run that ends without a gate
   each give the model a turn to tell you what it means. Three of those are
   decisions rather than news, and each one opens a dialog in this session:

   - **the ship gate** (ask) — every deliverable's summary, the normalized
     findings by severity, the fixer's answer to each of them and what is left
     over, then *Ship* / *Don't ship* / *Look first*. Saying "ship it" in the
     conversation opens the same dialog, through the `plan_ship_dialog` tool,
     which decides nothing itself;
   - **completion** (auto) — the pull request is published and its link lands in
     the conversation. A publication that fails offers *Retry publication* /
     *Leave it*;
   - **a failure**, of a task or of the run — the cause, then *Retry the task* /
     *Stop the run* / *Re-plan*, the last of which switches back to plan mode
     carrying where the run got to, so the conversation plans from there.

   **No command is ever named for a decision.** `/workflow decide` and
   `/plan ship` still work and are fallbacks only.

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
likely want, and escape is what commits to nothing. **No table lets them be the
same row**; the one that used to, the effort dial, is gone. Escaping the check's
dialog keeps planning; escaping the confirmation starts no run; escaping the ship
dialog goes to look at the run and comes straight back to it; escaping the failure
dialog re-plans, which changes nothing about the run. Every ending but the run and
*Just switch* leaves you in plan mode with `/plan run <slug>` and `/mode ask` both
named. The dialog tables, with a column for each of the two, are in the
[command reference](commands.md#the-hand-off).

## Questions and delegation

- `ask_user_question` is provided by
  `@juicesharp/rpiv-ask-user-question`.
- `subagent` is provided independently by `@vegardx/pi-subagent`.
- `plan_ship_dialog` is this seat's, and it is offered only while a run of this
  session is parked at a ship decision. It opens the dialog and decides nothing:
  the person answers it.
- workflow tools are provided independently by `@vegardx/pi-workflow`; web
  tools are unavailable until their owned replacement is built.
- the `repository-lifecycle` skill guides direct commits, pushes, pull requests,
  checks, and checked rebase merges. Shipping downstream of a plan run belongs
  to pi-maestro's own audited Bash authority, not to model-selected Bash: the
  workflow runtime never pushes, merges, or publishes (its own
  `docs/authority.md` says so), and publication happens here — after the ship
  dialog from `ask`, or on completion from `auto` — under the mode's confirmation
  policy. `/plan ship <slug>` performs it by hand: branch, cherry-pick, the
  repository's check on the host, one confirmation, push, and a pull request when
  the plan's policy asked for one. It is the **fallback** for when the automatic
  publication did not happen. Publishing a handoff by hand, when one of those steps
  stops, is `git` and `gh` work under this skill.

## Footer

The custom footer shows current context usage, model, and mode. Standalone
subagent operator state remains under `/subagents` and its attention widget.
