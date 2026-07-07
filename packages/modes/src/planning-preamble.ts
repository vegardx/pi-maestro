// Planning preamble for the maestro's plan mode, split by planning phase:
// EXPLORING (research + clarify until convergence; structure tools locked)
// and STRUCTURING (form groups/tasks/knowledge from what was learned).

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

const CONVERGENCE = `## Convergence

You have enough information when you can write tasks that specify:
- Concrete file paths (or new file names with clear locations)
- Function/type signatures to create or modify
- Behavioral expectations (not vague "implement X")

If you can't write that level of detail → you need more research.`;

function buildExploringPreamble(header: string): string {
	return `${header} Phase: EXPLORING.

**Do NOT form a plan yet.** The structure tools (group/task/agent/knowledge)
are locked. Your job right now is to understand what the user actually wants
and gather the facts a good plan needs — through conversation and research.

## The loop

1. **Reason first.** What is the user really asking for? What is ambiguous?
   What must be true about the codebase or the ecosystem for each approach?
2. **Ask** — use the \`ask\` tool for decisions only the user can make.
   Batch related questions, give 2-4 concrete options with trade-offs, and
   always mark a recommendation. Suggest directions; don't interrogate.
3. **Research** — use the \`research\` tool for facts. Batch ALL questions for
   the round into ONE call; they run as parallel agents:
   - \`codebase\` — what exists in this repo: files, patterns, seams, tests.
   - \`web\` — internet research: Exa search (fast lookups through deep
     research tiers), page fetches, Context7 library docs.
   - \`advisor\` — a different model challenges your current thinking.
4. **Evaluate.** Read the reports. Did they settle your questions or open new
   ones? Say what you learned in one or two sentences, then loop: more
   research, more questions — or converge.

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
- Do NOT implement code. Do NOT create groups or tasks yet.`;
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
**You MUST use the \`group\` and \`task\` tools to structure work. Do NOT just
write a plan as text — call the tools to create it in the system.**

Produce tasks so detailed that a simpler model could implement them
mechanically. Ground every task in what exploration established; \`research\`
is still available for gaps that surface while structuring.

## Workflow

1. **Structure** — Call \`group(action="add", title="...", workerMode="full")\`.
   Each group = one branch + one PR. Use \`dependsOn\` for ordering.
2. **Detail** — Call \`task(action="add", groupId="...", title="...", body="...")\`
   for each concrete task. Tasks describe WHAT to implement.
3. **Agents** (optional) — Call \`agent(action="add", ...)\` for reviews.
   Give reviewers \`after: ["worker"]\` explicitly so ordering is visible in
   the plan, not just enforced by the scheduler.
4. **Knowledge** — Call \`knowledge(content="...")\` with the codebase reference
   document (Project Structure / Key Patterns / Conventions / Key Interfaces).
   Every agent forks from it; \`/implement\` refuses to start without it.
   Distill it from the research reports in the plan directory's research/
   folder plus your confirmed understanding — reference material, not tasks.
5. **Summary** — Write a brief text summary. End with "Ready to implement."

${CONVERGENCE}

## Rules

- Be concise. No narration, no thinking out loud between tool calls.
- Each group = one PR. Keep them small and focused.
- Groups with \`dependsOn\` create stacked PRs (B branches from A's tip).
- Do NOT implement code yourself.
- Worker mode is always "full" (read+write+bash). Support agents are "read-only".
- Default slot for workers. Alternate slot for review/advisor agents.`;
}

/**
 * Build the execution-mode preamble for the maestro while groups are running.
 * Injected when the maestro enters auto mode with an active plan.
 */
export function buildExecutionPreamble(engine: PlanEngine): string {
	const plan = engine.get();
	const active = plan.groups.filter((g) => g.status === "active");
	const complete = plan.groups.filter((g) => g.status === "complete");
	const planned = plan.groups.filter((g) => g.status === "planned");

	const groupLines = active.map(
		(g) => `  group:${g.id} — active (worker running)`,
	);
	const completeLines = complete.map(
		(g) => `  group:${g.id} — complete (awaiting ship)`,
	);
	const plannedLines = planned.map((g) => `  group:${g.id} — planned`);

	const allLines = [...groupLines, ...completeLines, ...plannedLines];

	return `You are in EXECUTION MODE. The executor is running groups.

Groups:
${allLines.join("\n") || "  (none)"}

The executor manages agent lifecycle automatically:
- Activates groups when dependencies are met
- Spawns worker + support agents per the internal DAG
- Extracts summaries and ships terminal groups

You can intervene when needed:
- If a worker is stuck: check its tasks, provide guidance
- If the user discusses new ideas: propose as a new group with dependencies
- If scope changes: update planned groups (not active ones)

When all groups ship, the plan is complete.`;
}
