import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ModeName,
	ModeTransitionGate,
	ModeTransitionValidation,
} from "@vegardx/pi-contracts";
import type { PlanEngineV2 } from "./plan/engine.js";
import {
	type PlanV2,
	planFingerprintV2,
	validatePlanShapeV2,
	walkNodes,
} from "./plan/schema.js";
import { planPhaseV2 } from "./planning-preamble.js";
import { renderPlanOutline } from "./research.js";

export type TransitionEdge = `${ModeName}->${ModeName}`;

export interface TransitionGateRequest {
	readonly from: ModeName;
	readonly to: ModeName;
	readonly ctx: ExtensionContext;
}

export interface TransitionGateDefinition {
	readonly id: string;
	readonly edges: readonly TransitionEdge[];
	validate(plan: PlanV2): readonly ModeTransitionValidation[];
	prompt(
		plan: PlanV2,
		validations: readonly ModeTransitionValidation[],
	): string;
	suggestions(_plan: PlanV2): readonly never[];
}

export interface TransitionGateCoordinatorDeps {
	readonly engine: () => PlanEngineV2 | undefined;
	readonly currentMode: () => ModeName;
	readonly commit: (mode: ModeName, ctx: ExtensionContext) => void;
	readonly agents: () =>
		| import("@vegardx/pi-contracts").AgentsCapabilityV1
		| undefined;
	readonly ask: () =>
		| import("@vegardx/pi-contracts").AskCapabilityV1
		| undefined;
	readonly now?: () => string;
	/** The gate's policy row (mode:<edge>), when a table is wired. */
	readonly policyRow?: (
		on: string,
		ctx: ExtensionContext,
	) => import("@vegardx/pi-contracts").PolicyRow | undefined;
	/** Resolve a row's tier to a launch model via the v2 resolver. */
	readonly resolveTierModel?: (
		tier: import("@vegardx/pi-contracts").TierId,
		ctx: ExtensionContext,
	) => Promise<
		| { model: string; effort?: import("@vegardx/pi-contracts").ThinkingLevel }
		| undefined
	>;
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
		const fingerprint = planFingerprintV2(engine.get());
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
		persistGate(engine, state);

		// The policy row tunes this boundary: tier → resolved model override,
		// persona/contract recorded, enabled:false skips the LLM review while
		// keeping mechanical validations and the human ruling.
		const row = this.deps.policyRow?.(`mode:${from}->${to}`, ctx);
		let reviewSummary = "";
		if (row?.run.enabled === false) {
			reviewSummary =
				"(plan review disabled by policy row — mechanical checks only)";
		} else {
			const agents = this.deps.agents();
			if (!agents) {
				state = this.block(engine, state, "agents.v1 is unavailable", now());
				ctx.ui.notify(
					"Execution readiness needs the plan-review agent; staying in plan.",
					"warning",
				);
				return false;
			}

			const override = row
				? await this.deps
						.resolveTierModel?.(row.run.models, ctx)
						.catch(() => undefined)
				: undefined;
			try {
				const request = (withOverride: boolean) => ({
					kind: "plan-review" as const,
					prompt: definition.prompt(engine.get(), validations),
					cwd: engine.get().repoPath,
					displayName: "plan-reviewer",
					...(withOverride && override?.model ? { model: override.model } : {}),
					...(withOverride && override?.effort
						? { effort: override.effort }
						: {}),
					meta: {
						gateId: id,
						edge: `${from}->${to}`,
						...(row
							? {
									policy: {
										models: row.run.models,
										...(row.run.persona ? { persona: row.run.persona } : {}),
										...(row.run.contract ? { contract: row.run.contract } : {}),
									},
								}
							: {}),
					},
				});
				// The row's tier override must never make the gate UNRUNNABLE:
				// the agent runner validates explicit models against its own
				// authored options and may reject the resolved tier model
				// (seen live: "No exact plan-review option matches ..."). Retry
				// once without the override — visibly degraded, never skipped.
				let run: Awaited<ReturnType<typeof agents.run>>;
				try {
					run = await agents.run(request(true));
				} catch (overrideError) {
					if (!override?.model) throw overrideError;
					ctx.ui.notify(
						`Plan-review tier override (${override.model}) was rejected by the agent runner; running with its own selection instead.`,
						"warning",
					);
					run = await agents.run(request(false));
				}
				state = {
					...state,
					assignment: run.assignment,
					runId: run.runId,
					updatedAt: now(),
				};
				persistGate(engine, state);
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
		}

		if (planFingerprintV2(engine.get()) !== fingerprint) {
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
		persistGate(engine, state);

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
		persistGate(engine, state);
		const ruling = state.ruling;
		if (!ruling || ruling.decision === "stay-in-plan") return false;

		if (planFingerprintV2(engine.get()) !== fingerprint) {
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
		persistGate(engine, state);
		this.deps.commit(to, ctx);
		return true;
	}

	private block(
		engine: PlanEngineV2,
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
		persistGate(engine, blocked);
		return blocked;
	}
}

/**
 * Persist a gate row on the v2 plan. The in-memory state machine keeps the
 * full v1 ModeTransitionGate texture; the ledger stores the looser
 * TransitionGateRuling — `ruling` collapses to the decision (or the
 * lifecycle status while undecided), `decidedAt` is the ruling/update
 * timestamp, and the complete evidence rides along via the index signature.
 */
function persistGate(engine: PlanEngineV2, state: ModeTransitionGate): void {
	engine.setTransitionGate({
		...state,
		id: state.id,
		ruling: state.ruling?.decision ?? state.status,
		decidedAt: state.ruling?.ruledAt ?? state.updatedAt,
		rulingDetail: state.ruling,
	});
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
	plan: PlanV2,
): readonly ModeTransitionValidation[] {
	const result: ModeTransitionValidation[] = validatePlanShapeV2(plan).map(
		(message, index) => ({
			id: `shape-${index}`,
			level: "error",
			message,
		}),
	);
	if (planPhaseV2(plan) !== "structuring")
		result.push({
			id: "phase",
			level: "error",
			message: "plan has not reached structuring",
		});
	if (!plan.nodes.length)
		result.push({
			id: "nodes",
			level: "error",
			message: "plan has no nodes",
		});
	// Worker nodes write (v1's full-mode check); read agents are idle-done and
	// legitimately taskless.
	for (const { node } of walkNodes(plan)) {
		if (
			node.agent === "worker" &&
			node.tasks.filter((task) => (task.kind ?? "task") !== "followup")
				.length === 0
		)
			result.push({
				id: `tasks:${node.id}`,
				level: "error",
				message: `${node.id} has no gating work items`,
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
