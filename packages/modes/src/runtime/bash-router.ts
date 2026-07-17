import type {
	BashOperations,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import {
	type BashActor,
	type BashPolicyDecision,
	decideBashPolicy,
} from "../bash-policy.js";
import {
	type IsolationBackendTier,
	IsolationUnavailableError,
} from "../isolation/backend.js";
import { readExecutionPolicySettings } from "../settings.js";
import type { RuntimeContext } from "./context.js";

export type BashOperationsFactory = (cwd: string) => BashOperations | undefined;

export interface BashRouterBackends {
	/** Direct host shell. Defaults to pi's local Bash operations. */
	readonly direct?: BashOperationsFactory;
	/** Optional narrow host-read runner; defaults to direct after policy approval. */
	readonly hostRead?: BashOperationsFactory;
	/** Optional lightweight isolation provider. Absence fails visibly and closed. */
	readonly lightweight?: BashOperationsFactory;
	/** Optional strong isolation provider. Absence fails visibly and closed. */
	readonly strong?: BashOperationsFactory;
}

/**
 * Register the last-writer-wins Bash override. Its delegated definitions keep
 * pi's schema, streaming, truncation, timeout, cancellation and rendering.
 */
export function registerBashRouter(rt: RuntimeContext): void {
	const definition = createBashToolDefinition(process.cwd());
	const routed: typeof definition = {
		...definition,
		async execute(id, params, signal, onUpdate, ctx) {
			const actor = currentActor(rt);
			const policy = readExecutionPolicySettings(ctx.cwd);
			let decision = decideBashPolicy({
				command: params.command,
				mode: rt.state.mode,
				actor,
				policy,
			});
			if (
				rt.isolationNoneSession &&
				(decision.route === "lightweight" || decision.route === "strong")
			) {
				decision = {
					...decision,
					route: "confirm",
					reason: `${decision.reason}. Isolation is disabled for this session; direct host execution requires confirmation`,
				};
			}
			await authorizeBashDecision(decision, ctx, params.command);
			const execute = (selected: BashPolicyDecision) => {
				const operations = resolveBashOperations(
					selected,
					rt.bashBackends,
					ctx.cwd,
				);
				const delegated = createBashToolDefinition(ctx.cwd, { operations });
				return delegated.execute(id, params, signal, onUpdate, ctx);
			};
			try {
				return await execute(decision);
			} catch (error) {
				if (!(error instanceof IsolationUnavailableError)) throw error;
				const action = await isolationFailureActionForActor(
					actor,
					error.tier,
					error.message,
					policy.fallback,
					ctx,
				);
				if (action === "cancel") throw error;
				if (action === "hack") {
					if (!(await rt.requestMode("hack", ctx))) throw error;
					return execute({ ...decision, route: "direct" });
				}
				if (action === "lightweight")
					return execute({ ...decision, route: "lightweight" });
				if (action === "none-session") rt.isolationNoneSession = true;
				return execute({ ...decision, route: "direct" });
			}
		},
	};
	rt.pi.registerTool(routed);
}

export class BashRoutingError extends Error {
	readonly code: "approval-required" | "isolation-unavailable";
	readonly actor: BashActor;
	readonly retryGuidance: string;

	constructor(options: {
		readonly code: "approval-required" | "isolation-unavailable";
		readonly actor: BashActor;
		readonly message: string;
		readonly retryGuidance: string;
	}) {
		super(options.message);
		this.name = "BashRoutingError";
		this.code = options.code;
		this.actor = options.actor;
		this.retryGuidance = options.retryGuidance;
	}
}

const WORKER_RETRY_GUIDANCE =
	"Retry with dedicated safe primitives (read/grep/find/edit), or report the blocked command to Maestro for host-side approval.";

export function nonInteractiveIsolationError(
	actor: Exclude<BashActor, "maestro">,
	tier: IsolationBackendTier,
	detail: string,
): BashRoutingError {
	return new BashRoutingError({
		code: "isolation-unavailable",
		actor,
		message: `${tier} isolation is unavailable for ${actor}; interactive approval is disabled inside agents. ${detail}`,
		retryGuidance: WORKER_RETRY_GUIDANCE,
	});
}

export async function authorizeBashDecision(
	decision: BashPolicyDecision,
	ctx: Pick<ExtensionContext, "ui">,
	command: string,
): Promise<void> {
	if (decision.route === "deny") throw new Error(decision.reason);
	if (decision.route !== "confirm") return;
	if (decision.actor !== "maestro") {
		throw new BashRoutingError({
			code: "approval-required",
			actor: decision.actor,
			message: `Bash approval is required by policy, but interactive approval is disabled for ${decision.actor}.`,
			retryGuidance: WORKER_RETRY_GUIDANCE,
		});
	}
	const title =
		decision.mode === "recon" || decision.mode === "plan"
			? "Run without research isolation?"
			: "Run consequential command?";
	const approved = await ctx.ui.confirm(
		title,
		`Mode: ${decision.mode} · actor: ${decision.actor}\nReason: ${decision.reason}\nCommand:\n  ${command}`,
	);
	if (!approved) throw new Error("Bash command canceled by user");
}

export type IsolationFailureAction =
	| "cancel"
	| "lightweight"
	| "direct-once"
	| "none-session"
	| "hack";

export async function isolationFailureActionForActor(
	actor: BashActor,
	tier: IsolationBackendTier,
	detail: string,
	fallback: "fail-closed" | "confirm",
	ctx: Pick<ExtensionContext, "ui">,
): Promise<IsolationFailureAction> {
	if (actor !== "maestro") {
		throw nonInteractiveIsolationError(actor, tier, detail);
	}
	return isolationFailureAction(tier, detail, fallback, ctx);
}

export async function isolationFailureAction(
	tier: IsolationBackendTier,
	detail: string,
	fallback: "fail-closed" | "confirm",
	ctx: Pick<ExtensionContext, "ui">,
): Promise<IsolationFailureAction> {
	const choices =
		fallback === "fail-closed"
			? ["Cancel (policy is fail-closed)"]
			: [
					"Cancel (recommended)",
					...(tier === "strong" ? ["Try Lightweight once"] : []),
					"Run direct once",
					"Use None for this session",
					"Enter Hack and run direct",
				];
	const choice = await ctx.ui.select(
		`${tier[0]?.toUpperCase()}${tier.slice(1)} isolation failed`,
		choices,
	);
	if (!choice || choice === choices[0]) return "cancel";
	const lightweight = choice === "Try Lightweight once";
	const approved = await ctx.ui.confirm(
		lightweight ? "Use weaker isolation?" : "Weaken isolation?",
		lightweight
			? `${detail}\n\n${choice}\nLightweight is process-policy isolation, not a VM, and keeps host home/network denied.`
			: `${detail}\n\n${choice}\nThis runs on the host and can modify the real checkout.`,
	);
	if (!approved) return "cancel";
	if (lightweight) return "lightweight";
	if (choice === "Run direct once") return "direct-once";
	if (choice === "Use None for this session") return "none-session";
	return "hack";
}

export function resolveBashOperations(
	decision: BashPolicyDecision,
	backends: BashRouterBackends,
	cwd: string,
): BashOperations {
	const direct = backends.direct?.(cwd) ?? createLocalBashOperations();
	switch (decision.route) {
		case "direct":
		case "confirm":
			return direct;
		case "host-read":
			return requiredBackend("host-read", backends.hostRead?.(cwd));
		case "lightweight":
			return requiredBackend("lightweight", backends.lightweight?.(cwd));
		case "strong":
			return requiredBackend("strong", backends.strong?.(cwd));
		case "deny":
			throw new Error(decision.reason);
	}
}

function requiredBackend(
	tier: "host-read" | "lightweight" | "strong",
	operations: BashOperations | undefined,
): BashOperations {
	if (operations) return operations;
	if (tier === "host-read")
		throw new Error(
			"Protected host-read is required by policy but no write-restricted host-read backend is available.",
		);
	throw new IsolationUnavailableError(
		tier,
		`${tier[0]?.toUpperCase()}${tier.slice(1)} Bash isolation is required by policy but no ${tier} backend is available.`,
	);
}

function currentActor(rt: RuntimeContext): BashActor {
	if (rt.state.mode !== "agent") return "maestro";
	return process.env.PI_MAESTRO_AGENT_MODE === "read-only"
		? "reviewer"
		: "worker";
}
