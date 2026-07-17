import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ModeName,
	ModeTransitionGate,
	ModeTransitionValidation,
} from "@vegardx/pi-contracts";
import { type PlanEngine, planFingerprint } from "./engine.js";
import { renderPlanOutline } from "./research.js";
import { type Plan, planPhase, validatePlanShape } from "./schema.js";

export type TransitionEdge = `${ModeName}->${ModeName}`;

export interface TransitionGateRequest {
	readonly from: ModeName;
	readonly to: ModeName;
	readonly ctx: ExtensionContext;
}

export interface TransitionGateDefinition {
	readonly id: string;
	readonly edges: readonly TransitionEdge[];
	validate(plan: Plan): readonly ModeTransitionValidation[];
	prompt(plan: Plan, validations: readonly ModeTransitionValidation[]): string;
	suggestions(_plan: Plan): readonly never[];
}

export interface TransitionGateCoordinatorDeps {
	readonly engine: () => PlanEngine | undefined;
	readonly currentMode: () => ModeName;
	readonly commit: (mode: ModeName, ctx: ExtensionContext) => void;
	readonly agents: () =>
		| import("@vegardx/pi-contracts").AgentsCapabilityV1
		| undefined;
	readonly ask: () =>
		| import("@vegardx/pi-contracts").AskCapabilityV1
		| undefined;
	readonly now?: () => string;
}

/** Definitions are selected by exact directed edge; duplicate ownership fails. */
export class TransitionGateRegistry {
	private readonly byEdge = new Map<TransitionEdge, TransitionGateDefinition>();

	register(definition: TransitionGateDefinition): void {
		for (const edge of definition.edges) {
			if (this.byEdge.has(edge))
				throw new Error(`transition gate already registered for ${edge}`);
			this.byEdge.set(edge, definition);
		}
	}

	get(from: ModeName, to: ModeName): TransitionGateDefinition | undefined {
		return this.byEdge.get(`${from}->${to}`);
	}
}

export class TransitionGateCoordinator {
	private inFlight: Promise<boolean> | undefined;

	constructor(
		private readonly registry: TransitionGateRegistry,
		private readonly deps: TransitionGateCoordinatorDeps,
	) {}

	request(to: ModeName, ctx: ExtensionContext): Promise<boolean> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.run(to, ctx).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async run(to: ModeName, ctx: ExtensionContext): Promise<boolean> {
		const from = this.deps.currentMode();
		if (from === to) return true;
		const definition = this.registry.get(from, to);
		if (!definition) {
			this.deps.commit(to, ctx);
			return true;
		}
		const engine = this.deps.engine();
		if (!engine) {
			ctx.ui.notify("No active plan — run /plan first.", "warning");
			return false;
		}
		const now = this.deps.now ?? (() => new Date().toISOString());
		const requestedAt = now();
		const fingerprint = planFingerprint(engine.get());
		const id = `mode-transition:${from}:${to}:${requestedAt}`;
		let validations = [...definition.validate(engine.get())];
		let state: ModeTransitionGate = {
			id,
			gate: definition.id,
			from,
			to,
			status: "checking",
			requestedAt,
			updatedAt: requestedAt,
			planFingerprint: fingerprint,
			validations,
		};
		engine.setTransitionGate(state);

		const agents = this.deps.agents();
		if (!agents) {
			state = this.block(engine, state, "agents.v1 is unavailable", now());
			ctx.ui.notify(
				"Execution readiness needs the plan-review agent; staying in plan.",
				"warning",
			);
			return false;
		}

		let reviewSummary = "";
		try {
			const run = await agents.run({
				kind: "plan-review",
				prompt: definition.prompt(engine.get(), validations),
				cwd: engine.get().repoPath,
				displayName: "plan-reviewer",
				meta: { gateId: id, edge: `${from}->${to}` },
			});
			state = {
				...state,
				assignment: run.assignment,
				runId: run.runId,
				updatedAt: now(),
			};
			engine.setTransitionGate(state);
			const result = await run.handle.result();
			if (result.status !== "succeeded")
				throw new Error(result.error ?? `plan reviewer ${result.status}`);
			reviewSummary = (result.summary ?? "").slice(0, 12_000);
		} catch (error) {
			state = this.block(
				engine,
				state,
				error instanceof Error ? error.message : String(error),
				now(),
			);
			ctx.ui.notify(
				`Plan review failed: ${state.reason}. Staying in plan.`,
				"warning",
			);
			return false;
		}

		if (planFingerprint(engine.get()) !== fingerprint) {
			this.block(
				engine,
				state,
				"plan changed while the reviewer was running",
				now(),
			);
			ctx.ui.notify(
				"Plan changed during review — request the transition again.",
				"warning",
			);
			return false;
		}

		state = {
			...state,
			status: "awaiting-ruling",
			updatedAt: now(),
			reviewSummary,
		};
		engine.setTransitionGate(state);

		const ask = this.deps.ask();
		if (!ask) {
			this.block(engine, state, "ask.v1 is unavailable", now());
			ctx.ui.notify(
				"No ruling surface is available; staying in plan.",
				"warning",
			);
			return false;
		}
		const answers = await ask.ask([
			{
				id: `${id}:ruling`,
				header: "Ruling",
				question: `Final ruling for Plan → ${to}?`,
				context: summarizeReview(reviewSummary, validations),
				options: [
					{
						label: "Enter execution",
						value: "enter-without",
						description: "Accept the reviewed plan and enter.",
					},
					{
						label: "Stay in plan",
						value: "stay-in-plan",
						description: "Do not change mode.",
					},
				],
				recommendation: "enter-without",
				blocking: true,
				whyBlocking:
					"Maestro cannot cross the execution boundary without one final user ruling.",
			},
		]);
		const selectedIds: string[] = [];
		const decision = answers.find(
			(answer) => answer.questionId === `${id}:ruling`,
		)?.value;
		const ruledAt = now();
		state = {
			...state,
			status:
				decision === "stay-in-plan" || !decision ? "cancelled" : state.status,
			updatedAt: ruledAt,
			ruling: {
				decision:
					decision === "apply-and-enter" || decision === "enter-without"
						? decision
						: "stay-in-plan",
				selectedSuggestionIds: selectedIds,
				planFingerprint: fingerprint,
				ruledAt,
			},
		};
		engine.setTransitionGate(state);
		const ruling = state.ruling;
		if (!ruling || ruling.decision === "stay-in-plan") return false;

		if (planFingerprint(engine.get()) !== fingerprint) {
			this.block(
				engine,
				state,
				"plan changed before the ruling could be applied",
				now(),
			);
			ctx.ui.notify(
				"Plan changed before settlement — staying in plan.",
				"warning",
			);
			return false;
		}
		validations = [...definition.validate(engine.get())];
		const errors = validations.filter(
			(validation) => validation.level === "error",
		);
		if (errors.length) {
			this.block(
				engine,
				{ ...state, validations },
				errors.map((error) => error.message).join("; "),
				now(),
			);
			ctx.ui.notify(
				`Mechanical revalidation failed: ${errors.map((error) => error.message).join("; ")}`,
				"warning",
			);
			return false;
		}
		state = { ...state, status: "settled", validations, updatedAt: now() };
		engine.setTransitionGate(state);
		this.deps.commit(to, ctx);
		return true;
	}

	private block(
		engine: PlanEngine,
		state: ModeTransitionGate,
		reason: string,
		at: string,
	): ModeTransitionGate {
		const blocked = {
			...state,
			status: "blocked" as const,
			reason,
			updatedAt: at,
		};
		engine.setTransitionGate(blocked);
		return blocked;
	}
}

export function createExecutionReadinessGate(): TransitionGateDefinition {
	return {
		id: "execution-readiness",
		edges: ["plan->auto", "plan->hack"],
		validate: executionReadinessValidations,
		prompt: (plan, validations) =>
			[
				"Review this canonical structured plan immediately before execution.",
				"Challenge missing work, sequencing, acceptance criteria, and review coverage.",
				"Do not mutate anything. Give concrete compatible suggestions to the host.",
				"",
				"## Mechanical validation",
				...(validations.length
					? validations.map((item) => `- ${item.level}: ${item.message}`)
					: ["- clean"]),
				"",
				"## Canonical structured plan",
				renderPlanOutline(plan),
			].join("\n"),
		suggestions: () => [],
	};
}

export function executionReadinessValidations(
	plan: Plan,
): readonly ModeTransitionValidation[] {
	const result: ModeTransitionValidation[] = validatePlanShape(plan).map(
		(message, index) => ({
			id: `shape-${index}`,
			level: "error",
			message,
		}),
	);
	if (planPhase(plan) !== "structuring")
		result.push({
			id: "phase",
			level: "error",
			message: "plan has not reached structuring",
		});
	if (!plan.deliverables.length)
		result.push({
			id: "deliverables",
			level: "error",
			message: "plan has no deliverables",
		});
	for (const deliverable of plan.deliverables) {
		if (
			deliverable.worker.mode === "full" &&
			deliverable.tasks.filter((task) => (task.kind ?? "task") !== "followup")
				.length === 0
		)
			result.push({
				id: `tasks:${deliverable.id}`,
				level: "error",
				message: `${deliverable.id} has no gating work items`,
			});
	}
	return result;
}

function summarizeReview(
	review: string,
	validations: readonly ModeTransitionValidation[],
): string {
	const mechanical = validations.length
		? validations.map((item) => `- ${item.level}: ${item.message}`).join("\n")
		: "- clean";
	return `## Mechanical checks\n${mechanical}\n\n## Plan reviewer\n${review || "No textual suggestions."}`.slice(
		0,
		14_000,
	);
}

export function createDefaultTransitionGates(): TransitionGateRegistry {
	const registry = new TransitionGateRegistry();
	registry.register(createExecutionReadinessGate());
	return registry;
}
