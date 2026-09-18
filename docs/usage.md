# Usage

## Install

```bash
pi install git:github.com/vegardx/pi-maestro
```

Reload Pi after installation. Configure `@vegardx/pi-subagent` separately when
delegated execution is wanted. Workflow and web extensions are intentionally not
bundled.

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

**A run is safe from `plan` mode, and the model still may not start one there.**
A run mutates neither the working tree nor the host: its implementation work
happens in a sandboxed subagent attempt against a worktree of its own, its
output is a handoff commit in the repository's object store, and nothing reaches
a branch or a remote until publication — a separate step, decided by a human,
outside the run. Safe was never the question. Plan mode is a conversation, and
starting a run is the seat acting, so the seat refuses `workflow_run` and
`workflow_propose` in plan mode by name. Every workflow read — listing,
validating, inspecting, waiting, logs, status — stays open, because reading a
run is planning.

**Two ways a run starts from plan mode, and both are yours.** You start any run
you want with pi-workflow's own `/workflow run <ref>`, and the plan-mode exit
below starts the plan's own run at its last question. This began as guidance and
a model reviewed its own plan with a `deep-review` run from plan mode twice
anyway, which is exactly the reading a blind review exists to prevent — so it is
a refusal now. The plan is checked by the blind reviewer in the exit, on the
compiled document, never by the author of the plan.

## Planning

Planning remains a conversation. The complete plan document is written on the
way out of plan mode, by the harness — it asks the session's own model for it
directly — once requirements, repositories, dependencies, implementation work
and review intent are understood.

Plans are validated and stored per project, under the cwd encoded the way Pi
encodes its own sessions directory (`/Users/x/src/proj` → `--Users-x-src-proj--`):

```text
<agentDir>/maestro/plans/<encoded cwd>/<slug>/plan.json
```

`/plan list` and `/plan show` read only the project you are standing in, and the
stored envelope records the session and cwd that authored the plan.

Storing a plan is not running one. `/plan run <slug> [cheap|standard|deep]`
builds the workflow input, writes it beside the plan and starts `plan-to-ship`
through the workflow runtime's service seam; standalone `@vegardx/pi-workflow`
owns compilation, approval, execution, recovery, and the receipt from there.
This package's responsibility ends at a validated document and a started run —
and picks up again at publication, which is pi-maestro's own audited Bash work
and never the runtime's. See
[Authored plans](workflow-plans.md#publishing-what-a-run-produced).

## Leaving plan mode with a run

Switching out of `plan` mode when there is a conversation but no plan runs the
exit. It is **one flow**, inside the `/mode` call: the two things only the model
can write — the description and the document — are requested by the harness
directly, as ordinary completions outside Pi's agent loop, with the session's
own history as context and **no tools offered at all**. It used to be a steer
and a tool call each; four by-hand passes failed at that, because a steer is a
request a model may interpret.

1. **Two dialogs.** Compile the conversation into a workflow run, just switch,
   or keep planning; then how much effort the run may spend. That is all that is
   asked. Gates take their default, and publication and the base branch are
   derived from the repository and announced. **The mode does not change.**
2. **The description.** The harness asks the model for two or three sentences
   saying what we are doing and why. One dialog agrees, edits, or sends you back
   to the conversation. The agreed text is what the blind reviewer checks the
   plan against, which is why it exists before the document does.
3. **The document.** The harness asks for the whole plan as one JSON object: the
   deliverables, the `tasks` that are the work, and the `reviews` that read that
   work. The answers from step 1 are not the model's to write — the harness
   attaches them as the plan's `policy`, so the choices are part of the document
   that gets validated, digested and reviewed without the author transcribing
   them.
4. **The rest of the exit.** Readiness on every repository the plan names; every
   heavy review gets `diverse: true` written into the stored plan so both
   compilers agree; compilation with a budget projection; an optional blind
   review of the compiled graph, with an editor behind it for changing
   reviewers; the findings walk; and one confirmation. That last *yes* is what
   starts the run: the harness starts `plan-to-ship` itself, through the
   runtime's allowlisted service seam, and only then does the posture become the
   one asked for in step 1. The model is not asked to start it — it is not in
   that loop at all — and the run id is named in the transcript, so nothing
   happens behind the session's back. A runtime that refuses leaves you in plan
   mode with the plan stored and the reason on screen.
5. **Revising, when the reviewer brought prose rather than a patch.** *Revise
   with the model* appends the whole review — every finding and the notes,
   verbatim — to the same mini-conversation the document came from, and the
   rewritten plan re-enters at step 4. Three blind reviews per exit, counting
   the one an accepted patch buys; after that the findings are printed and the
   conversation continues here.

**The bounds.** Each request gets **three attempts**; a retry carries the
previous answer and the validator's own sentences. When they run out, or the
provider fails, or the session is replaced, the exit ends exactly like *Back to
the conversation*: nothing changed, still in plan mode, problems printed. Above
**80%** of the model's context window the exit stops before asking at all, and
says to `/compact` and leave plan mode again.

**What reaches the conversation.** One message when the plan is stored, and one
more when the run starts or the exit goes back: the slug, its digest, the
deliverable count, the outcome. Nothing else — no steers, no retries. Every
request is on the record in `authoring.json` beside the plan.

Escape is always an answer, and it is always the **safe** one — never the
first-listed one, which is a different thing: the first option is what you most
likely want, and escape is what commits to nothing. Escaping the start keeps
planning, escaping the description dialog goes back to the conversation rather
than agreeing on your behalf, escaping the compiled document starts no reviewer
and no run, and declining the last confirmation stores the plan and runs
nothing. Every ending but the run leaves you in plan mode with `/plan run
<slug>` and `/mode auto` both named. The dialog tables, with a column for each
of the two, are in the
[command reference](commands.md#leaving-plan-mode).

### Readiness is not preflight

**Readiness** is this harness step: each repository the plan names exists, is a
working-tree root, is clean, has the base branch the policy asked for, and has
`gh` on PATH when a pull request was requested. Creating a missing repository is
confirmed, and every command it runs goes through the same audited Bash
classifier as anything else the seat does.

**Preflight** is not a pi-maestro word. It belongs to `@vegardx/pi-subagent`,
where it names the launch-plan compile for a delegated attempt. The two steps
answer different questions in different processes, so this repository calls its
own step readiness everywhere and leaves preflight alone.

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
