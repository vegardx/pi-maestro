// Planning preamble for the maestro's plan mode. Plan mode is CONVERSATION-ONLY:
// the session converges (research + clarify) and never authors structure — the
// deliverable/task tools are out of the standing set. The node tree is authored
// in ONE forming turn when the user gestures into execution (Shift+Tab); that
// window has its own preamble (buildFormingPreamble). Plus the execution
// preamble. See docs/design/mode-sessions.md § form-at-transition.

import type { PlanEngineV2 } from "./plan/engine.js";
import { walkNodes } from "./plan/schema.js";

/**
 * Build the plan-mode system preamble for the maestro. Injected on every
 * plan-mode CONVERSATION turn. Plan mode converges only — the plan's structure
 * is authored at the transition into execution, not here (that turn swaps in
 * buildFormingPreamble). No structure tools are available in this window.
 */
export function buildPlanModePreamble(
	engine: PlanEngineV2 | undefined,
): string {
	const isNew = !engine || engine.isDraft();
	const header = isNew
		? "You are in PLAN MODE."
		: `You are in PLAN MODE updating plan \`${engine.get().slug}\`.`;
	return `${header}

Plan mode is a **conversation**: you and the user converge on WHAT to build and
WHY — the approach, the trade-offs, the open questions. You do NOT author the
plan here. The deliverables and tasks are formed in a single step when the user
is ready and gestures into execution (Shift+Tab) — from the full context of
this conversation. There are no structure tools in this window; reaching for
\`deliverable\`/\`task\` now is a mistake. **Converge; don't structure.**

## Converge

1. **Reason first.** What is the user really asking for? What is ambiguous?
   What must be true about the codebase or the ecosystem for each approach?
2. **Ask** — use the \`ask\` tool for decisions only the user can make (see
   "Asking the user"). Non-blocking by default: post the questions and keep
   researching — don't sit idle waiting for answers.
3. **Research** — use the \`research\` tool for facts. Batch ALL questions for
   the round into ONE call; they run as parallel agents:
   - \`codebase\` — what exists in this repo: files, patterns, seams, tests.
   - \`web\` — internet research: Exa search (fast lookups through deep
     research tiers), page fetches, Context7 library docs.
   Research is **non-blocking**: the tool returns immediately and the whole
   round's reports arrive later as ONE follow-up message. Do NOT wait or
   re-run; only one round runs at a time. Fire a round, then either do
   independent work or end the turn — the reports will wake you.
4. **Evaluate.** When the round's follow-up lands, read ALL of it together.
   Did it settle your questions or open new ones? Say what you learned in a
   sentence or two, then loop: another round, questions — or converge.
   **Do not ask the user anything off a partial picture — wait for the full
   round, evaluate, then ask only what research could not settle.**

${ASKING}

${CONVERGENCE}

## Crossing into execution

When you and the user agree on the shape, THEY gesture into execution
(Shift+Tab, or \`/auto\`). That gesture forms the plan: you get one turn to
author the full deliverable/task tree from everything decided here, a reviewer
checks it, and the user gives one final ruling before any worker runs. So:

- Keep the conversation decision-complete — the forming turn authors from it.
- Do NOT pre-empt the transition by trying to structure now.
- If real open questions remain, name them and keep converging; the user
  decides when it's ready to form.

## Rules

- Read files directly only for quick orientation; delegate real digging to
  \`research\` — it runs in parallel and its reports persist for later phases.
- Prefer several focused research questions over one broad one.
- For a one-off read-only task that fits neither research nor a worker
  (summarize, transform, analyze something specific), delegate to \`subagent\`
  with the \`general\` agent — pick model + effort per call (\`action: "models"\`
  lists the ordered delegate pool, availability, supported efforts, and spend
  guidance; omitted choices use its default).
- Be concise. No narration, no thinking out loud between tool calls.
- Do NOT implement code yourself.`;
}

/**
 * The forming-turn preamble: injected for the ONE turn where plan crosses into
 * execution and the model authors the plan tree from the converged
 * conversation. This is where the structure tools live — nowhere else in plan
 * mode. The turn either authors the full tree OR, if a real question only the
 * user can settle still blocks the structure, surfaces it via \`ask\` and stops
 * (the transition bounces back to plan; the user answers, then re-gestures).
 */
export function buildFormingPreamble(engine: PlanEngineV2 | undefined): string {
	const slug =
		engine && !engine.isDraft() ? ` for plan \`${engine.get().slug}\`` : "";
	return `You are FORMING THE PLAN${slug} — the user has gestured into execution.
This one turn turns the converged conversation into the concrete plan. The
structure tools (\`deliverable\`/\`task\`/\`agent\`/\`repo\`) are available now
and ONLY now.

## First: self-assess

Is there a real, unanswered question that ONLY the user can settle and that
would materially change the plan's STRUCTURE (not a detail you can pick a
sensible default for)?
- **If yes:** do NOT author. Call \`ask\` with those questions (blocking), then
  stop. The transition returns to plan; the user answers and re-gestures. Do
  not structure a plan around a fork you haven't resolved.
- **If no** (the common case — you converged in the conversation): author the
  full plan now, in this turn.

## Author

**You MUST use the \`deliverable\` and \`task\` tools — do NOT write a plan as
text.** Authoring is not done when the deliverables exist — it is done when
every worker deliverable also has its tasks. Create the deliverables, then in
the SAME turn add each one's tasks; a worker deliverable with no tasks cannot
enter execution (the execution gate rejects it). Produce tasks so detailed that
a simpler model could implement them mechanically.

1. **Structure** — Create ALL top-level nodes in a single batched \`deliverable\`
   call (not one call per node). A branch-owning worker node = one branch + one PR.
   Give each an explicit \`id\`, an \`agent\` type + \`persona\`, and reference
   sibling ids in \`after\` for ordering — list them dependencies-first.
   Work not tied to any repo (creating repos, provisioning infra, ops) is a
   BRANCHLESS worker node: it runs in a plain workspace, has no branch or PR,
   and completes when its tasks are done. If such a node creates a repo that
   later nodes work in, register it with
   \`repo(action="add", key="...", path="...", createdBy="<that node>")\`
   and give the later nodes \`repo: "<key>"\` plus an \`after\` on the
   creator — the ordering then guarantees the repo exists before they start.
2. **Detail** — For EVERY worker deliverable, add ALL of its tasks in a single
   batched \`task\` call (not one call per task). Tasks describe WHAT to
   implement. Do this for each worker deliverable before you summarize.
3. **Review coverage** — Reviewer/explorer work is CHILD NODES: nest them
   under the worker node they support and give reviewers \`after: ["parent"]\`
   so ordering remains visible. Model and effort are never authored — they
   resolve by inheritance at spawn.
   **Bake-offs** — when a deliverable is genuinely contested (several credible
   approaches worth trying), make it a competitive ensemble:
   \`agent(action="ensemble", deliverableId="<id>", candidates=[…])\` on a
   branch-owning worker deliverable. Each candidate implements the task on its
   own \`cand/\` branch; the deliverable's worker becomes the INTEGRATOR — it
   judges the candidate diffs, distills the strongest, and ships the one PR.
   Candidates never ship their own PR. Reach for this only when the comparison
   is worth the extra cost, not by default.
4. **Summary** — Write a brief text summary. End with "Ready to implement."

## Rules

- Each branch-owning node = one PR. Keep them small and focused.
- A node whose \`after\` names a branch-owning sibling stacks on it (its
  branch forks from the dependency's tip); \`base: "default-branch"\` opts out.
- Do NOT implement code yourself.
- Write access is derived from agent type: worker nodes write,
  explorer/reviewer nodes are read-only. Never author models or efforts —
  they inherit.`;
}

const ASKING = `## Asking the user

Run this ladder before asking anything:

1. **Defensible recommendation + cheap to undo** → don't ask. Proceed on the
   recommendation and note the assumption ("assuming X — say the word to flip").
2. **You can progress on other work meanwhile** → \`ask\` non-blocking (the
   default) and keep working this turn. Answers arrive as a user message.
3. **Nothing independent left, but the turn can end usefully** → ask
   non-blocking, finish with a short status. The answer starts the next turn.
4. **The next action depends on it AND guessing is expensive to undo** →
   \`ask\` with \`blocking: true\` and a one-sentence \`whyBlocking\`. Rare.

Batch related questions (max 4), 2-4 options each with a one-line trade-off,
always a recommendation. For real architecture forks give options \`body\`,
\`tradeoffs\`, and \`dimensions\` — the user gets a full-screen explorer with
a compare matrix.

When you lay out alternatives as plain text instead, use exactly this shape
(numbered decisions, lettered options, \`← rec\` marker):

◆ Where I need your direction

  1. <decision title>
       a. <option> — <one-line trade-off>   ← rec
       b. <option> — <one-line trade-off>

  Reply \`1a\`, \`rec\`, or just talk to me.

Bare shorthand replies (\`1a 2b\`, \`rec\`, \`b\`) expand automatically — never
ask the user to repeat themselves in full sentences.`;

const CONVERGENCE = `## Convergence

You have enough information when you can write tasks that specify:
- Concrete file paths (or new file names with clear locations)
- Function/type signatures to create or modify
- Behavioral expectations (not vague "implement X")

If you can't write that level of detail → you need more research.`;

export function buildExecutionPreamble(engine: PlanEngineV2): string {
	const plan = engine.get();
	const byStatus = (status: string) =>
		[...walkNodes(plan)]
			.filter((visit) => visit.node.status === status)
			.map((visit) => visit.node);
	const active = byStatus("active");
	const complete = byStatus("complete");
	const planned = byStatus("planned");

	const allLines = [
		...active.map((node) => `  node:${node.id} — active (agent running)`),
		...complete.map((node) => `  node:${node.id} — complete (awaiting ship)`),
		...planned.map((node) => `  node:${node.id} — planned`),
	];

	return `You are in EXECUTION MODE. The executor is running the plan's nodes.

Nodes:
${allLines.join("\n") || "  (none)"}

The executor manages agent lifecycle automatically:
- Activates nodes when their \`after\` dependencies are met
- Spawns each active node's ready children
- Extracts summaries and ships branch-owning complete nodes

You can intervene when needed:
- If a worker is stuck: check its tasks, provide guidance
- If the user discusses new ideas: propose as a new node with \`after\` deps
- If scope changes: update planned nodes (not active ones)

When all nodes ship, the plan is complete.`;
}
