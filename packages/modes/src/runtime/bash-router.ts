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
			const decision = decideBashPolicy({
				command: params.command,
				mode: rt.state.mode,
				actor,
				policy: readExecutionPolicySettings(ctx.cwd),
			});
			await authorizeBashDecision(decision, ctx, params.command);
			const operations = resolveBashOperations(
				decision,
				rt.bashBackends,
				ctx.cwd,
			);
			const delegated = createBashToolDefinition(ctx.cwd, { operations });
			return delegated.execute(id, params, signal, onUpdate, ctx);
		},
	};
	rt.pi.registerTool(routed);
}

export async function authorizeBashDecision(
	decision: BashPolicyDecision,
	ctx: Pick<ExtensionContext, "ui">,
	command: string,
): Promise<void> {
	if (decision.route === "deny") throw new Error(decision.reason);
	if (decision.route !== "confirm") return;
	const approved = await ctx.ui.confirm(
		"Run consequential command?",
		`Mode: ${decision.mode} · actor: ${decision.actor}\nReason: ${decision.reason}\nCommand:\n  ${command}`,
	);
	if (!approved) throw new Error("Bash command canceled by user");
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
	throw new Error(
		`${tier === "host-read" ? "Protected host-read" : `${tier[0]?.toUpperCase()}${tier.slice(1)} Bash isolation`} is required by policy but no ${tier} backend is available. Configure a backend, change the execution policy explicitly, or use Hack for authorized direct execution.`,
	);
}

function currentActor(rt: RuntimeContext): BashActor {
	if (rt.state.mode !== "agent") return "maestro";
	return process.env.PI_MAESTRO_AGENT_MODE === "read-only"
		? "reviewer"
		: "worker";
}
