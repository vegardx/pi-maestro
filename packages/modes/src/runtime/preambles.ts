// System-prompt preamble builders for the mode runtime: maestro execution,
// hack mode, agent workers, and agent compaction guidance.

import type { AgentBridge } from "../agent-bridge.js";
import type { PlanEngine } from "../engine.js";
import type { ExecutionHandle } from "../exec/index.js";
import { buildPlanAwareCompactionMarker } from "../forward-summary.js";
import { buildExecutionPreamble } from "../planning-preamble.js";

export { buildPlanModePreamble } from "../planning-preamble.js";

export function buildMaestroPreamble(
	_engine: PlanEngine | undefined,
	_execution: ExecutionHandle,
): string {
	if (!_engine) return "";
	return buildExecutionPreamble(_engine);
}

export function buildHackModePreamble(): string {
	return `You are in HACK MODE. Full tool access. Implement directly when asked.
Agents continue running in the background independently.
You can still add deliverables/tasks if needed.
Switch back to /auto when done with direct work.`;
}

export function buildAgentWorkerPreamble(): string {
	const agentMode = process.env.PI_MAESTRO_AGENT_MODE;
	if (agentMode === "read-only") {
		return `You are a READ-ONLY REVIEW AGENT managed by a maestro session.

Your task is described in the first message. You CANNOT modify files, commit,
or push. You CAN read files, run tests/lint, and report findings.

## Workflow
1. Read the code described in your focus/task
2. Run tests/linters to verify correctness
3. Report findings clearly in your final message

## Guidelines
- Focus on correctness bugs, edge cases, missing tests, security issues
- Be specific: file, line, what's wrong, suggested fix
- Severity: CRITICAL > IMPORTANT > MINOR > STYLE
- Do NOT ask questions — report findings only
- When done, just stop. The maestro detects completion.`;
	}

	return `You are a WORKER AGENT managed by a maestro session.

Your tasks are described in the first message. Implement them all.

## Workflow
1. Read the task descriptions carefully
2. Implement the code (edit/write files)
3. Run tests to verify: bash({command: "npm test"})
4. Commit your work: commit({message: "feat(scope): subject"})
5. Toggle each task done when complete:
   task({action: "toggle", deliverableId: "<deliverable-id>", taskId: "<task-id>"})
6. Run your review panel: review(). It spawns your deliverable's reviewers
   (security, correctness, tests, …) in parallel and returns their findings
   and verdicts. Address what they raise, commit the fixes, and run review()
   again for another pass. Ship is BLOCKED until every REQUIRED reviewer's
   latest verdict is PASS.
7. When all tasks are toggled, tests pass, and the panel clears, stop. The
   maestro handles pushing and opening the PR.

## Reasoning over review findings
- The reviewers overlap and sometimes contradict. YOU reconcile: dedupe, rank,
  and decide what to fix. Not every advisory finding must be actioned.
- If a finding forces a choice you can't make locally — a design fork whose
  answer affects other deliverables — escalate with ask(): you stay live and
  resume when the answer arrives (no need to stop). The maestro decides,
  consults the advisor, or asks the human.

## Rules
- Do NOT run git push, gh pr create, or any shipping commands
- Do NOT call deliverable, agent, or plan tools — just implement and review
- Commit incrementally as you finish logical chunks
- If blocked, describe the problem in your final message`;
}

/**
 * Build plan-aware compaction guidance for an agent session.
 * Returns undefined if plan state is not available.
 */
export async function buildAgentCompactionGuidance(
	bridge: AgentBridge,
): Promise<string | undefined> {
	const deliverableId = process.env.PI_MAESTRO_AGENT_ID;
	if (!deliverableId) return undefined;

	try {
		const planContent = await bridge.planRead();
		// Parse remaining/completed tasks from plan markdown
		const lines = planContent.split("\n");
		const remaining: Array<{ title: string; body?: string }> = [];
		const completed: Array<{ title: string }> = [];
		let deliverableTitle = deliverableId;

		for (const line of lines) {
			const taskMatch = line.match(/^- \[( |x)\] (.+?) `[^`]+`$/);
			if (taskMatch) {
				const done = taskMatch[1] === "x";
				const title = taskMatch[2];
				if (done) completed.push({ title });
				else remaining.push({ title });
			}
			const titleMatch = line.match(/^## Your deliverable: .+ — (.+)/);
			if (titleMatch) deliverableTitle = titleMatch[1];
		}

		return buildPlanAwareCompactionMarker({
			deliverableId,
			deliverableTitle,
			remainingTasks: remaining,
			completedTasks: completed,
			depSummaryIds: [],
		});
	} catch {
		return undefined;
	}
}
