import type { ModeName } from "@vegardx/pi-contracts";
import type { PlanPhase } from "./schema.js";

export const PLAN_TOOL_NAMES = [
	"deliverable",
	"task",
	"agent",
	"panel",
	"plan",
	"repo",
	"knowledge",
] as const;

/**
 * Structure-mutating plan tools — blocked while the plan is `exploring` so
 * the maestro must converge (research + readiness) before forming the plan.
 */
export const STRUCTURE_TOOL_NAMES = [
	"deliverable",
	"task",
	"agent",
	"panel",
	"repo",
	"knowledge",
] as const;

/** Research-loop tools available throughout plan mode. */
export const RESEARCH_TOOL_NAMES = ["research", "readiness", "dig"] as const;

/**
 * Research tools available in recon mode. Deliberately NOT `readiness` — the
 * user leaving recon (Shift+Tab) is the readiness signal there; the mode has
 * no plan surface at all.
 */
export const RECON_TOOL_NAMES = ["research", "dig"] as const;

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"websearch",
	"webfetch",
	"plan",
]);

const ALWAYS_ALLOWED_TOOLS = new Set(["ask", "suggest_next_prompt"]);

const STRUCTURE_TOOLS = new Set<string>(STRUCTURE_TOOL_NAMES);

export interface ToolPolicyInput {
	readonly mode: ModeName;
	readonly availableTools: readonly string[];
	/** User/session tool set captured before modes narrows it. */
	readonly baselineTools?: readonly string[];
	/** True when running as a worker/support agent under a maestro. */
	readonly isAgent?: boolean;
	/** Planning phase; only narrows the tool set in plan mode. */
	readonly phase?: PlanPhase;
	/**
	 * A carry-forward episode (/distill or /handoff) is running: the
	 * episode-scoped `carryforward` tool becomes visible. Outside an episode
	 * it stays out of the set entirely — no standing prompt clutter, no
	 * model-initiated handoffs.
	 */
	readonly carryForwardActive?: boolean;
}

export function computeActiveTools(input: ToolPolicyInput): string[] {
	const available = new Set(input.availableTools);
	const baseline = input.baselineTools?.length
		? input.baselineTools.filter((t) => available.has(t))
		: input.availableTools;

	const withEpisode = (tools: string[]): string[] =>
		input.carryForwardActive &&
		available.has("carryforward") &&
		!tools.includes("carryforward")
			? [...tools, "carryforward"]
			: tools;

	if (input.mode === "hack") return withEpisode([...baseline]);

	// Recon: pure research posture — read-only tools + the research loop.
	// No plan surface (`plan`/`readiness`/structure tools stay out entirely);
	// bash is allowed but gated read-only by the classifier, like plan mode.
	if (input.mode === "recon") {
		const reconAllowed = new Set([
			...READ_ONLY_TOOLS,
			...RECON_TOOL_NAMES,
			...ALWAYS_ALLOWED_TOOLS,
			"bash",
		]);
		reconAllowed.delete("plan");
		return withEpisode(
			input.availableTools.filter((name) => reconAllowed.has(name)),
		);
	}

	// Agent mode: full implementation tools, no plan-structure tools
	if (input.isAgent) {
		const agentAllowed = new Set([
			...READ_ONLY_TOOLS,
			...ALWAYS_ALLOWED_TOOLS,
			"bash",
			"edit",
			"write",
			"commit",
			"task", // agents can toggle tasks
			"review", // a worker runs its own review panel
			"dig", // pull a full research report by ref (plan-dir via env)
		]);
		return input.availableTools.filter((name) => agentAllowed.has(name));
	}

	// plan + auto: read-only + plan tools + research loop + bash (gated by
	// classifier) + always-allowed. `gate` is the maestro's ship-gate triage
	// tool (send back with guidance / escalate with a recommendation) — auto
	// mode only in practice; plan mode blocks it via toolBlockedInPlanMode.
	const allowed = new Set([
		...READ_ONLY_TOOLS,
		...PLAN_TOOL_NAMES,
		...RESEARCH_TOOL_NAMES,
		...ALWAYS_ALLOWED_TOOLS,
		"bash",
		"gate",
	]);
	// Exploring phase: the readiness gate — structure tools stay locked until
	// the model declares readiness and the user confirms.
	if (input.mode === "plan" && input.phase === "exploring") {
		for (const name of STRUCTURE_TOOL_NAMES) allowed.delete(name);
	}
	return withEpisode(input.availableTools.filter((name) => allowed.has(name)));
}

export interface BashClassification {
	readonly readOnly: boolean;
	readonly reason?: string;
}

/** @deprecated Use decideBashPolicy from bash-policy.ts. */
export function classifyBash(command: string): BashClassification {
	return {
		readOnly: false,
		reason: `legacy classifier retired; classify the complete command (${command.trim().slice(0, 20) || "empty"}) with decideBashPolicy`,
	};
}

/**
 * Call-time gate for recon mode (the belt to computeActiveTools' braces —
 * some clients cache tool lists across a mode switch).
 */
export function toolBlockedInReconMode(toolName: string): string | null {
	if (toolName === "bash") return null;
	if (READ_ONLY_TOOLS.has(toolName) && toolName !== "plan") return null;
	if (RECON_TOOL_NAMES.includes(toolName as never)) return null;
	if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;
	if (toolName === "carryforward") return null;
	return (
		`tool \`${toolName}\` is disabled in recon mode — recon is a read-only ` +
		"research posture. When the user is ready to plan or build, they switch " +
		"modes themselves (Shift+Tab)."
	);
}

export function toolBlockedInPlanMode(
	toolName: string,
	phase?: PlanPhase,
): string | null {
	if (toolName === "bash") return null;
	if (phase === "exploring" && STRUCTURE_TOOLS.has(toolName)) {
		return (
			`tool \`${toolName}\` is locked — the plan is still exploring. ` +
			"Research and clarify until you meet the convergence criteria, then " +
			"call `readiness` to propose forming the plan."
		);
	}
	if (
		READ_ONLY_TOOLS.has(toolName) ||
		PLAN_TOOL_NAMES.includes(toolName as never) ||
		RESEARCH_TOOL_NAMES.includes(toolName as never)
	) {
		return null;
	}
	if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;
	// Episode-scoped: visibility is governed by computeActiveTools; when it IS
	// visible (an episode is running), plan mode must not block it — /distill
	// exists precisely to run mid-planning.
	if (toolName === "carryforward") return null;
	return `tool \`${toolName}\` is disabled in plan mode`;
}
