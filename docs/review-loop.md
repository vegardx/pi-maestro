# Review

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
    by: { agent: "reviewer", persona: "code-review" } },
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

`subagent` takes `fanOut`, which asks one reader **per model family** and
returns every answer, attributed by family and **not reconciled**.

Reconciling would mean this layer deciding which reviewer was right, which is
the caller's judgement — and flattening several opinions into one is exactly how
six findings once became a sentence saying nothing.

With no roster configured it reaches one family and says so, rather than
claiming a diversity it did not get.

## Who reviews what

Personas are the single prose system; `PersonaCatalogue.declare` refuses prose
that names a declared tool, so a persona says what to look for and never what to
call. The reader's tool list is generated from what it was actually launched
with.

Read-only agents hold no shell and no `subagent` tool of their own. A reviewer that
cannot answer says so in its report rather than recruiting help — its caller is
blocked on it, so there is no channel back.

## Shipping

The maestro ships: push, open or update the pull request, record the result,
then release the worker. A worker never pushes, and there is no ship tool for an
agent to reach for.
