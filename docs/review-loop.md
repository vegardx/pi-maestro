# Review

> Historical rollback-path design. Workflow-native review is the flat,
> one-round lens/model cohort described in [workflow-plans.md](workflow-plans.md).
> It does not use personas, nested fan-out, or a verifier.

There is no review subsystem, and no review command. A worker hands its own
diff to a reviewer and acts on what comes back **before** it reports.

That is the whole design, and it is deliberate: a review nobody acts on is a
review that did not happen. The system this replaced had typed assignments, a
stage DAG, canonical findings, duplicate membership, scope-locked verification
and provenance in the PR body — and a live drive found six real findings,
including a genuine silent-pass assertion, reaching a pull request whose body
read `(agent produced no summary)`. The machinery was elaborate and the output
was discarded.

## How it works now

A deliverable's work can name a reader:

```
tasks: [
  { id: "build",  title: "Write the module" },
  { id: "review", title: "Have the diff reviewed",
    by: { persona: "code-review" } },
  { id: "act",    title: "Act on the findings" },
]
```

The worker calls `subagent`, which spawns a read-only agent, blocks until it
answers, and returns what it said. The worker then fixes what it found and
commits before calling `finish`.

Findings reach the worker **neutral** — no severity, no attribution, no count.
The worker decides what to do about them, because it is the one that has to
live with the code.

## Fanning out

`subagent` takes `fanOut`, which puts the question to one reviewer **per model
family** — through a lead, never straight at the caller.

The tool starts a single subagent: the lead, on the caller's own model. The
lead inherits because it is the caller's reasoning surface extended — keeping
member noise out of the caller's context window is its whole job, and routing
that job to a model the caller never chose would defeat it. Its brief is the
same persona prose everyone else gets, plus a fan-out block whose family list
is resolved by code. The lead then starts one member per family with its own
`subagent` tool, passing `{persona, family, question}` — the `family`
parameter resolves that family's model through the caller's roster, and an
unknown family is refused naming the families that exist.

Members are blind. Each gets the material — the diff, the contract, the
question — and its persona prose, never the caller's intent and never another
member's answer: tell a reviewer the intent and you have handed it a
hypothesis to confirm. And nobody grades. A finding says where it is, what
makes it go wrong, and what it costs — not how severe someone felt it was.

Before it returns, the lead aggregates: duplicates merged, wording
normalized, every model and family name removed, noise dropped. The caller
reads clean findings — no model names, no severity grades, no count of
reviewers. Attribution passed upstream invites a caller to inherit the
verdicts of a model it recognizes as itself, and raw unaggregated findings
flood the one context window whose clarity the exercise exists to protect.

Coverage honesty lives in the harness, not in the caller's context. What the
spread resolved goes into the tool result's `details`, where the harness can
read "reached one family, not three"; the findings text never mentions it. A
spread that reaches at most one family degrades to a plain single start and
records the shortfall the same way.

The persona is orthogonal. Lead and members run the same persona; being the
lead comes from the brief, not from a special persona — there is no
`review-lead`, deliberately. The lead stays held like any subagent, so the
caller can ask it a follow-up in the conversation it kept.

## Who reviews what

Personas are the single prose system; `PersonaCatalogue.declare` refuses prose
that names a declared tool, so a persona says what to look for and never what to
call. The reader's tool list is generated from what it was actually launched
with.

Read-only agents hold a shell of their own — gated so write-effect commands
are refused, confined by the OS so a classifier miss still cannot write the
tree — and a `subagent` tool, so a reviewer can consult another reader when
that is the honest way to answer. Depth bounds the recursion, not a rule about
who may ask. What has not changed: a reviewer's caller is blocked on it, so
there is no channel back — one that cannot answer says so in its report
rather than pretending it could.

## Shipping

The maestro ships: push, open or update the pull request, record the result,
then release the worker. A worker never pushes, and there is no ship tool for an
agent to reach for.
