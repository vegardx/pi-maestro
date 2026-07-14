// Planning preamble for the maestro's plan mode, split by planning phase:
// EXPLORING (research + clarify until convergence; structure tools locked)
// and STRUCTURING (form deliverables/tasks/knowledge from what was learned).

import type { PlanEngine } from "./engine.js";
import { planPhase } from "./schema.js";

/**
 * Build the plan-mode system preamble for the maestro. Injected on every
 * plan-mode turn; the text tracks the plan's current phase.
 */
export function buildPlanModePreamble(engine: PlanEngine | undefined): string {
	const isNew = !engine || engine.isDraft();
	const phase = engine ? planPhase(engine.get()) : "exploring";
	const header = isNew
		? "You are in PLAN MODE."
		: `You are in PLAN MODE updating plan \`${engine.get().slug}\`.`;
	return phase === "exploring"
		? buildExploringPreamble(header)
		: buildStructuringPreamble(header, engine);
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

function buildExploringPreamble(header: string): string {
	return `${header} Phase: EXPLORING.

**Do NOT form a plan yet.** The structure tools (deliverable/task/agent/knowledge)
are locked. Your job right now is to understand what the user actually wants
and gather the facts a good plan needs — through conversation and research.

## The loop

1. **Reason first.** What is the user really asking for? What is ambiguous?
   What must be true about the codebase or the ecosystem for each approach?
2. **Ask** — use the \`ask\` tool for decisions only the user can make
   (see "Asking the user"). Non-blocking by default: post the questions and
   keep researching — don't sit idle waiting for answers.
3. **Research** — use the \`research\` tool for facts. Batch ALL questions for
   the round into ONE call; they run as parallel agents:
   - \`codebase\` — what exists in this repo: files, patterns, seams, tests.
   - \`web\` — internet research: Exa search (fast lookups through deep
     research tiers), page fetches, Context7 library docs.
   - \`advisor\` — a different model challenges your current thinking.
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

## Declaring readiness

When the criteria are met, call \`readiness\` with your summarized
understanding (what you'll build, the decisions made and why, open risks).
The user confirms — that unlocks the structure tools. For trivial,
unambiguous requests call \`readiness\` immediately; don't manufacture
research. Never try to write the plan as text to dodge the gate.

## Rules

- Read files directly only for quick orientation; delegate real digging to
  \`research\` — it runs in parallel and its reports persist for later phases.
- Prefer several focused research questions over one broad one.
- For a one-off read-only task that fits neither research nor a worker
  (summarize, transform, analyze something specific), delegate to
  \`subagent\` with the \`general\` agent — pick model + effort per call
  (\`action: "models"\` lists the ordered delegate pool, availability,
  supported efforts, and spend guidance; omitted choices use its default).
- Do NOT implement code. Do NOT create deliverables or tasks yet.`;
}

function buildStructuringPreamble(
	header: string,
	engine: PlanEngine | undefined,
): string {
	const understanding = engine?.get().understanding;
	const understandingBlock = understanding
		? `\n\n## Confirmed Understanding\n\n${understanding}\n`
		: "";
	return `${header} Phase: STRUCTURING — readiness confirmed.
${understandingBlock}
**You MUST use the \`deliverable\` and \`task\` tools to structure work. Do NOT just
write a plan as text — call the tools to create it in the system.**

Produce tasks so detailed that a simpler model could implement them
mechanically. Ground every task in what exploration established; \`research\`
is still available for gaps that surface while structuring.

## Workflow

1. **Structure** — Call \`deliverable(action="add", items=[{id, title, body, dependsOn}, …])\`
   ONCE to create ALL deliverables in a single batched call (not one \`add\` per
   deliverable). Each deliverable = one branch + one PR. Give each an explicit
   \`id\` and reference those ids in \`dependsOn\` for ordering — sibling refs
   resolve to the minted ids. List them dependencies-first.
   Work not tied to any repo (creating repos, provisioning infra, ops) is a
   \`workspace="scratch"\` deliverable: it runs in a plain directory, has no
   branch or PR, and ships when its review gate passes. If a scratch
   deliverable creates a repo that later deliverables work in, register it
   with \`repo(action="add", key="...", path="...", createdBy="<that deliverable>")\`
   and give the later deliverables \`repo: "<key>"\` plus a \`dependsOn\` on the
   creator — the DAG then guarantees the repo exists before they start.
2. **Detail** — Call \`task(action="add", deliverableId="...", items=[{title, body}, …])\`
   ONCE per deliverable to add ALL its tasks in a single batched call (not one
   \`add\` per task). Tasks describe WHAT to implement.
3. **Agents** (optional) — Call \`agent(action="add", ...)\` for reviews.
   Give reviewers \`after: ["worker"]\` explicitly so ordering is visible in
   the plan, not just enforced by the scheduler.
4. **Knowledge** — Call \`knowledge(content="...")\` with the codebase reference
   document (Project Structure / Key Patterns / Conventions / Key Interfaces).
   Every agent forks from it; \`/implement\` refuses to start without it.
   Distill it from the research reports in the plan directory's research/
   folder plus your confirmed understanding — reference material, not tasks.
5. **Summary** — Write a brief text summary. End with "Ready to implement."

${ASKING}

${CONVERGENCE}

## Rules

- Be concise. No narration, no thinking out loud between tool calls.
- Each deliverable = one PR. Keep them small and focused.
- Deliverables with \`dependsOn\` create stacked PRs (B branches from A's tip).
- Do NOT implement code yourself.
- Worker mode is always "full" (read+write+bash). Support agents are "read-only".
- Reviewers resolve the active \`reviewer\` role pool. Omit model/effort for
  its first compatible defaults. Exact authored values must remain allowed;
  raise effort before using another model. Cross-model duplicate personas are
  exceptional (at most two models), need unique names and explicit justification.`;
}

/**
 * Build the execution-mode preamble for the maestro while deliverables are running.
 * Injected when the maestro enters auto mode with an active plan.
 */
export function buildExecutionPreamble(engine: PlanEngine): string {
	const plan = engine.get();
	const active = plan.deliverables.filter((g) => g.status === "active");
	const complete = plan.deliverables.filter((g) => g.status === "complete");
	const planned = plan.deliverables.filter((g) => g.status === "planned");

	const deliverableLines = active.map(
		(g) => `  deliverable:${g.id} — active (worker running)`,
	);
	const completeLines = complete.map(
		(g) => `  deliverable:${g.id} — complete (awaiting ship)`,
	);
	const plannedLines = planned.map((g) => `  deliverable:${g.id} — planned`);

	const allLines = [...deliverableLines, ...completeLines, ...plannedLines];

	return `You are in EXECUTION MODE. The executor is running deliverables.

Deliverables:
${allLines.join("\n") || "  (none)"}

The executor manages agent lifecycle automatically:
- Activates deliverables when dependencies are met
- Spawns worker + support agents per the internal DAG
- Extracts summaries and ships terminal deliverables

You can intervene when needed:
- If a worker is stuck: check its tasks, provide guidance
- If the user discusses new ideas: propose as a new deliverable with dependencies
- If scope changes: update planned deliverables (not active ones)

When all deliverables ship, the plan is complete.`;
}
