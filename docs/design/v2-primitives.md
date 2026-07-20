# v2 Primitives — model & agent configuration redesign

Status: **design settled 2026-07-20** across two design sessions. Nothing is
implemented. Five spikes are in flight (contract shapes, ensemble mechanics,
plan schema cutover, profile binding, cache economics) — see "Open items".

## Why

v1 (shipped through #247) is a routing system: a preset maps 15 model roles to
model sets; agent kinds bind roles, runtime policies, and pins; transition
gates and watchdogs are separate machinery. It works, but the center of
gravity is wrong: config prescribes and agents obey. Relational choices —
"review this work with a different model family than its author" — are
structurally unrepresentable in routing tables, and every new duty grew a new
role.

v2 inverts it: **the config supplies and constrains; agents reason.** Task
text and persona playbooks carry intent; the harness derives everything
mechanical; hard rules are reserved for the few things judgment must never
override.

## The concepts

### Modes

The session's operational state (recon / plan / auto / hack). A mode is NOT a
persona. It does exactly two jobs:

1. Sets the **root toolset ceiling** — the toolset the seat has, from which
   every descendant attenuates.
2. Owns the **transition boundary policies** — the `mode:` rows fire on mode
   edges precisely because crossing an edge is a capability change.

### Profile, catalog, residency

- **Catalog** — a named object holding three tiers with fixed meanings:
  `fast` (sweeps, gates, classification), `normal` (daily drivers, candidate
  pools), `heavy` (judging, deep review). Each entry: `model`, `family`
  (authored, never inferred — one provider can serve several families),
  `notes` (written for agents to reason with), `effort` (+ optional
  allowlist).
- **Profile** — a thin binding: `targets` (concrete session models that
  activate it; a profile without targets is the default) → `catalog` by name.
  Swapping the catalog reference A/Bs an entire pool composition under the
  same seat.
- **Residency** — the only hard filter. `active: off | <list>`; curated
  per-model lists; strikes non-members everywhere before any reasoning sees
  them; the seat is exempt; fail-closed on unknown list names.

### Agents

An agent type = **toolset (∩ parent) + return contract + allowed tiers**.
Three spawnable types; callers are harness-owned.

| Agent | Tools (∩ parent) | Workspace | Contract | Allowed tiers (default) |
| --- | --- | --- | --- | --- |
| worker | most tools | own worktree, always | summary + diff | normal, heavy |
| explorer | codebase read + websearch | caller's cwd, in place | curated report | fast, normal |
| reviewer | read-only + websearch | parent's cwd | findings | normal, heavy |
| caller | minimal/none; policy-triggered | none | verdict / label / summary | per policy row |

- Explorer and reviewer differ by **contract and stance**, not toolset:
  "how does X work" report vs "what's wrong with this work" findings.
- **Callers are harness components**: classifier, summarizer,
  command-auditor, watcher. Their prompts ship with releases, are tested with
  the harness suite, and are tuned only through policy rows (tier, enabled,
  scope). They are not spawnable from plans — `agent: caller` is
  unrepresentable. Watcher is today's watchdogs made configurable and needs a
  lifetime field (one-shot vs until-condition).
- The **seat is the root agent**: a worker running the session model, its
  toolset set by the mode. The tree is uniform from the top; "depth" is just
  distance from the root.

### Personas

A persona is a **skill file** (`skill.md`): frontmatter for the machine
(`agents:` registration, `contract:`, optional always-loaded `skills:`), body
as the system prompt. Personas are pure behavior — no tools, no models, no
workspace opinions — written in **situated voice** (the agent is already in
its worktree with its tasks in context; never narrate the environment).

The core of every persona is **reasoning with the task**:

- A direct ask ("do a code-review") is handled directly, in this context.
- If the task calls for multiple perspectives ("multi-model candidates",
  "3-model review") — or the agent's own judgment says the work warrants
  them — it spawns subagents with the **same persona**, each on a distinct
  family from a tier **named in the persona**, each with a sharply scoped
  task, then reasons across their outputs and returns one result.
- Delegation is for perspective or parallelism, never for avoiding work the
  agent can do well directly.

Strategies are persona prose bounded by hard envelopes: a persona can ask for
five candidates, but `maxChildrenPerNode` still caps it. Minimum roster:
worker → `generalist`, `coder`, `debugger`; explorer → `researcher`;
reviewer → `reviewer`. Task text supplies the focus (security, tests,
simplification, …); separate per-focus personas were deliberately rejected.
The registry permits alternates when a genuinely different playbook earns its
place. Layering: bundled → user → project, standard skill precedence.

### Knowledge skills

Same mechanism, different content: `github`, `github-cli`,
`repo-conventions`, `shipping-conventions`, … A plan node lists the skills
its agent loads at start; the persona's frontmatter `skills:` are unioned on
top. **Skills teach, they never grant** — loading `github-cli` does not
confer bash; tool attenuation is sovereign.

### Model resolution

1. **Inheritance is the rule.** Plans carry no model field. Anything spawned
   from the session runs the session model; deeper nodes run their spawner's
   model — unless a persona's fan-out instructions say otherwise.
2. **Personas name tiers** ("distinct families from the normal tier"). The
   harness resolves tier → concrete models via catalog ∩ residency ∩ the
   agent's allowed tiers, first-available in authored order, persists the
   resolution on the ledger, and revalidates on resume.
3. **Policy rows name tiers** — required, never optional — for callers.
4. **Failure → session model + one deduped notice per agent.** Empty tier,
   fully struck tier, and model-call failure are the same case: the judgment
   still happens, on the seat, visibly. Never fail-open, never wedge.
5. `inherit` and session-fallback are exempt from tier-allowlist validation
   but labeled as such in explain output.

Diversity is an **edge validation**, not plan syntax: at spawn, a child's
family is compared against its parent's; same family without a
`diversityWaiver: "<reason>"` produces a recorded warning surfaced in explain
output — soft but loud.

### Plans

A plan is the **decision ledger**: a tree of one recursive node type.

```yaml
plan: auth-rotation
profile: fable
maxDepth: 3

nodes:
  - id: prep-repos
    agent: worker
    persona: generalist
    skills: [github, github-cli, repo-conventions]
    tasks:
      - Create repos X and Y, apply branch-protection settings

  - id: build-auth
    agent: worker
    persona: coder
    branch: feat/auth              # the ONLY authored workspace fact: ships one PR
    after: [prep-repos]
    envelope: { maxChildren: 6 }
    skills: [repo-conventions, shipping-conventions]
    tasks:
      - Implement token rotation per docs/auth.md — use multi-model
        candidates and integrate the strongest approach
      - Cover rotation behavior with tests
    children:
      - id: review-security
        agent: reviewer
        persona: reviewer
        after: [worker]            # after the parent's own integration work
        tasks:
          - Review the auth diff for security — trust boundaries, token
            handling, secret exposure

  - id: docs-pass
    agent: worker
    persona: coder
    branch: feat/auth-docs         # stacked on feat/auth
    after: [build-auth]
    skills: [repo-conventions, shipping-conventions]
    tasks:
      - Document the rotation flow and failure modes
```

- **Authored**: `agent`, `persona`, `tasks`, `skills`, `after`, `branch`,
  `envelope`, waivers. Nothing else.
- **Derived**: worktrees (from agent type), toolsets (mode ceiling ∩ agent
  type ∩ parent), contracts (from agent type), models (inheritance),
  verification (reviewers/verifier read task text against the diff — no
  `check:` fields), shipping (harness lifecycle on branch-owning nodes;
  `shipping-conventions` shapes content).
- **Append-only during execution**: dynamic children (a coder's candidates,
  a researcher's fan-out) are written into the plan **before spawn**, marked
  `authored-by: <node>`. The plan never stops being the complete truthful
  record — recovery, HUD, and explain read one source.
- **Ensembles**: candidate workers get their own worktrees (branched from
  the parent's branch point) and return **diffs as contract output**; the
  parent — which implements nothing itself, keeping fresh eyes and no
  self-preference bias — integrates the strongest approach into its own
  worktree. One writer per worktree, always. Worktree ≠ shipping; only
  branch-owning nodes ship, and candidate worktrees are reaped after their
  diff is consumed.

### Enforcement texture

- **Validation (hard, authoring-time)** rejects the unrepresentable: persona
  not registered for the agent type, tier outside the agent's allowlist,
  depth beyond `maxDepth`, fan-out beyond envelope, caller nodes.
- **The plan→auto gate (judgment, one heavy spawn)** rejects the unclear:
  its persona is specialized for **ambiguity** — read every task as its
  persona will read it, name double readings, demand act-on-able specificity,
  check delegation is stated where wanted, dependencies and branch ownership
  match the tasks, advisory nudges (branch-owning node without
  shipping-conventions). Findings come with concrete rewrites.
- **Runtime limits steer, never crash**: a depth-3 agent that tries to spawn
  gets a steering message ("you're at maximum depth — handle this directly");
  envelope overruns escalate as a question to the parent's supervisor via the
  existing worker-question channel. Hard rejection is reserved for authored
  plans, where a human is in the loop to fix them.

### Policies

One table replaces bindings, transition gates, and hardcoded supervision.
Closed trigger enum, three kinds:

```jsonc
"policies": [
  { "on": "mode:plan→auto",
    "run": { "agent": "reviewer", "persona": "plan-review",
             "models": "heavy", "mode": "node", "contract": "bounded-report" } },
  { "on": "duty:classify", "run": { "models": "fast" } },
  { "on": "duty:compact",
    "run": { "strategy": "cache-aware", "warm": "self", "stale": "ask" } },
  { "on": "tool:bash", "scope": { "depth": ">=1" },
    "run": { "models": "fast", "contract": "verdict" } }
]
```

- `mode:<edge>` — boundary reviews (gates). `duty:<name>` — the closed
  harness duty enum (~6: classify, plan-summarize, compact-summarize,
  verify-findings, verify-delivery, gate edges). `tool:<name>` — tool gating
  on the supervisor bus.
- `models` (a tier) is **required** on every row; `tool:` rows are validated
  inline-on-fast (hot path); `scope` stays coarse (depth / agent type) —
  judgment lives in the caller's prompt, never in config matchers.
- A duty row with no consumers is lintable; retiring a duty deletes a row,
  not a dead role.

### Cache ledger

Runtime component; feeds `duty:compact` and keepalive.

- **Warmth** per session: last-request age vs provider TTL, corrected by
  observed `cacheRead`/`cacheWrite` deltas (already tracked in subagents
  usage plumbing). HUD shows the words `warm` / `cold` / `extended` — plain
  words, no glyphs.
- **Cache-aware compaction**: warm → compact on the agent's own model
  (prefix is cache reads, cheapest); stale → ask the human with numbers
  (context size, cost estimates for fast-model summary vs full re-read).
- **Keepalive**: seat + waiting workers; at ~TTL−60s idle, one request with
  `cache_control ttl:"1h"` buys the user an hour without a cache miss; one
  extension, then cold naturally. MUST verify the extension took (usage
  `cacheWrite1h`) — the gateway has silently dropped `ttl:"1h"` before.

## Invariants (the short list)

1. Tool attenuation: child tools = persona-relevant ⊆ parent tools; the mode
   sets the root ceiling. Unsafe states are unrepresentable, not forbidden.
2. Inheritance: no model fields in plans; variation only via persona tier
   instructions and policy rows; the seat is the universal fallback, always
   visible when used.
3. One writer per worktree; worktree exists iff write tools; only
   branch-owning nodes ship; shipping is harness lifecycle.
4. Depth ≤ maxDepth (default 3, configurable), enforced as steering at spawn
   attempt; envelope per node with escalation.
5. Residency is the only hard model filter; diversity is soft but loud
   (edge-validated, waiver + record + explain).
6. Callers are harness-owned and versioned; tuned via policy rows only.
7. The plan ledger is append-only and complete: no invisible spawns.
8. Skills teach, never grant. Contracts are harness-owned ids; persona
   frontmatter is the join between free prose and enforcement.

## v1 → v2 mapping

| v1 | v2 |
| --- | --- |
| model sets (N, ordered options) | catalog tiers (fast/normal/heavy) |
| presets: 15 role mappings + targets | profile: targets → catalog name |
| session sentinel in sets | inheritance + seat-as-root |
| auto effort / planner option choice | persona reasoning + tier notes |
| agent kinds (modelRole + policy + pins) | agents (toolset + contract + tiers) × personas |
| runtime policies (permissions/session/transport) | agent types |
| transition gates | `mode:` policy rows |
| hardcoded supervision / watchdogs | `tool:` rows + watcher caller |
| review pipeline, gating items | child nodes with contracts |
| deliverable worker + support agents | recursive nodes |
| classifier/summarizer roles | duty rows + harness callers |

Unchanged underneath: residency machinery, availability checks, assignment
persistence + revalidation, fail-visible resolution errors, the single
validated write path, `/maestro` as the editing skin.

## Open items (spikes in flight)

1. **Contract shapes** — concrete schemas for `summary-and-diff`,
   `findings`, `report`, `verdict`, `bounded-report`; extraction and
   validation mechanics.
2. **Ensemble mechanics** — how candidate diffs travel (patch payload vs
   branch refs), worktree lifecycle and reaping, integration method, failure
   handling.
3. **Plan schema cutover** — recursive node schema, consumer inventory
   (engine, adapter, HUD, RPC, recovery), clean-cut strategy (no backwards
   compatibility required).
4. **Profile binding** — by-name vs gate-time snapshot; recommendation:
   by-name unless drift proves painful.
5. **Cache economics** — TTL/pricing verification (5m vs 1h writes, live
   upgrade semantics), per-provider support, gateway `ttl:"1h"` verification
   via `cacheWrite1h`, ledger data model.
