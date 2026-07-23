import { appendFileSync } from "node:fs";
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
	type CommandAuditor,
	createCommandAuditor,
} from "../command-auditor.js";
import {
	type IsolationBackendTier,
	IsolationUnavailableError,
} from "../isolation/backend.js";
import {
	createEnforcingBashOperations,
	createShadowBashOperations,
	defaultSandboxWrap,
} from "../isolation/realtree-sandbox.js";
import { policyRowFor, readPolicyTable } from "../policy-table.js";
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
	// Rung-2 auditor, built lazily from the tool:bash policy row (per session).
	let auditor: CommandAuditor | null | undefined;
	const routed: typeof definition = {
		...definition,
		async execute(id, params, signal, onUpdate, ctx) {
			const actor = currentActor();
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
			// Rung 2 (LLM verdict): child agents' UNKNOWN commands only, and it
			// can only TIGHTEN to deny — allow/escalate defer to the
			// deterministic route, so a hallucinated blessing grants nothing.
			if (
				actor !== "maestro" &&
				decision.route !== "deny" &&
				decision.effects.has("unknown")
			) {
				if (auditor === undefined) {
					const row = policyRowFor(readPolicyTable(ctx.cwd), "tool:bash");
					auditor =
						row && row.run.enabled !== false
							? createCommandAuditor(ctx, row)
							: null;
				}
				const verdict = await auditor?.({
					command: params.command,
					actor,
					mode: rt.state.mode,
					effects: [...decision.effects],
				});
				if (verdict?.verdict === "deny") {
					decision = {
						...decision,
						route: "deny",
						reason: `command-auditor: ${verdict.reason}`,
					};
				}
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

/**
 * Apply the per-actor real-tree write profile to a route's ops. Three states:
 * - MAESTRO_SANDBOX=off → disable (run unchanged — the escape hatch).
 * - MAESTRO_SANDBOX_SHADOW=<file> → report-only: LOG the profile, run unchanged.
 * - default → ENFORCE: confine writes to the profile via the OS on the real
 *   tree (a bash-classifier miss stops being an escape; hack runs unwrapped).
 *   Reads stay open, so `git status`/builds see the real tree.
 */
function realtreeOps(
	ops: BashOperations,
	decision: BashPolicyDecision,
): BashOperations {
	if (process.env.MAESTRO_SANDBOX === "off") return ops;
	const logPath = process.env.MAESTRO_SANDBOX_SHADOW;
	if (logPath)
		return createShadowBashOperations(ops, {
			actor: decision.actor,
			mode: decision.mode,
			log: (line) => {
				try {
					appendFileSync(logPath, `${line}\n`);
				} catch {
					// A shadow-log write must never affect execution.
				}
			},
		});
	return createEnforcingBashOperations(ops, {
		actor: decision.actor,
		mode: decision.mode,
		wrap: defaultSandboxWrap,
	});
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
			return realtreeOps(direct, decision);
		// Reads see the real tree (reads stay open in the profile). The write
		// guard is the kernel now, so even a misclassified "read" that writes is
		// contained to the actor's scope rather than escaping unsandboxed.
		case "host-read":
			return realtreeOps(backends.hostRead?.(cwd) ?? direct, decision);
		// The old lightweight COPY tier is retired: recon/plan writes run
		// in-place on the real tree, confined by the same per-actor profile.
		case "lightweight":
			return realtreeOps(direct, decision);
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

/**
 * The actor is PROCESS IDENTITY, not mutable session mode. Only a spawned agent
 * carries `PI_MAESTRO_AGENT_ID` (the spawner sets it before the child's first
 * token; a nested standalone pi has it deleted). The maestro process never has
 * it. Deriving from the env — not `rt.state.mode` — means privilege can't hang
 * off state an agent's own turn could move.
 */
function currentActor(): BashActor {
	if (!process.env.PI_MAESTRO_AGENT_ID) return "maestro";
	return process.env.PI_MAESTRO_AGENT_MODE === "read-only"
		? "reviewer"
		: "worker";
}
