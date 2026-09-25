import { basename } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandAssessment } from "./bash-contracts.js";
import { type GateDecision, gateBash } from "./bash-gate.js";
import {
	assessBashCommand,
	mergeCommandAssessments,
	shouldAuditCommand,
} from "./bash-policy.js";
import {
	type CommandAuditOutcome,
	createCommandAuditor,
} from "./command-auditor.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import type { Mode } from "./mode.js";
import { analyzeShellProgram } from "./shell-program.js";

const AVAILABLE_ALTERNATIVES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"delete",
]);

export interface BashToolDeps {
	readonly cwd: string;
	readonly mode: () => Mode;
	readonly policy: () => ExecutionPolicySettings;
	readonly confirm?: (command: string, reason: string) => Promise<boolean>;
	readonly direct?: BashOperations;
	readonly assessment?: () => CommandAssessment | undefined;
	readonly confirmBash?: () => boolean;
	readonly onDecision?: (command: string, decision: GateDecision) => void;
}

class Refused extends Error {
	constructor(reason: string) {
		super(`refused: ${reason}`);
		this.name = "Refused";
	}
}

export function createGatedBashOperations(deps: BashToolDeps): BashOperations {
	const host = deps.direct ?? createLocalBashOperations();
	return {
		...host,
		exec: async (command, cwd, options) => {
			const decision = gateBash({
				command,
				mode: deps.mode(),
				policy: deps.policy(),
				...(deps.assessment?.()
					? { assessment: deps.assessment?.() as CommandAssessment }
					: {}),
				availableTools: AVAILABLE_ALTERNATIVES,
				...(deps.confirmBash?.() ? { confirmBash: true } : {}),
			});
			deps.onDecision?.(command, decision);
			if (decision.kind === "deny") throw new Refused(decision.reason);
			if (decision.kind === "confirm") {
				if (!deps.confirm)
					throw new Refused(`${decision.reason} — and there is nobody to ask`);
				if (!(await deps.confirm(command, decision.reason)))
					throw new Refused("you declined this command");
			}
			return host.exec(command, cwd, options);
		},
	};
}

function executableDefinition(
	deps: BashToolDeps,
	assessment: CommandAssessment | undefined,
	confirmBash: boolean,
	confirm: BashToolDeps["confirm"],
): ReturnType<typeof createBashToolDefinition> {
	return createBashToolDefinition(deps.cwd, {
		operations: createGatedBashOperations({
			...deps,
			confirm: confirm ?? deps.confirm,
			assessment: () => assessment,
			confirmBash: () => confirmBash,
		}),
	});
}

interface InvocationAssessment {
	readonly assessment: CommandAssessment;
	readonly audit?: CommandAuditOutcome;
}

async function assessForInvocation(
	ctx: ExtensionContext,
	deps: BashToolDeps,
	command: string,
	intent: string | undefined,
	signal: AbortSignal | undefined,
): Promise<InvocationAssessment> {
	const deterministic = assessBashCommand(command);
	const policy = deps.policy();
	if (!shouldAuditCommand(deps.mode().name, deterministic, policy))
		return { assessment: deterministic.assessment };
	const audit = await createCommandAuditor(ctx, policy.auditor)(
		{
			command,
			...(intent ? { intent } : {}),
			deterministic,
			analysis: analyzeShellProgram(command),
			probeCwd: deps.cwd,
			repository: { name: basename(deps.cwd), cwd: "." },
		},
		signal,
	);
	return {
		assessment: mergeCommandAssessments(
			deterministic,
			audit.assessment ?? {
				assessment: "uncertain",
				confidence: "low",
				rationale: `command auditor${audit.modelId ? ` (${audit.modelId})` : ""} failed: ${audit.failure ?? "no valid assessment"}`,
			},
		),
		audit,
	};
}

export function createBashTool(deps: BashToolDeps): ToolDefinition {
	const base = createBashToolDefinition(deps.cwd);
	const parameters = Type.Object({
		...base.parameters.properties,
		intent: Type.Optional(
			Type.String({
				description:
					"Concise purpose of this command. It is an untrusted auditing hint, not authorization.",
				maxLength: 500,
			}),
		),
		confirmBash: Type.Optional(
			Type.Boolean({
				description:
					"Request the shell form when an exact dedicated tool exists. This requires confirmation and never bypasses mode policy.",
			}),
		),
	});
	return {
		...base,
		parameters,
		execute: async (id, params, signal, onUpdate, ctx) => {
			const input = params as {
				command: string;
				timeout?: number;
				intent?: string;
				confirmBash?: boolean;
			};
			const invocation = await assessForInvocation(
				ctx,
				deps,
				input.command,
				input.intent,
				signal,
			);
			const executable = executableDefinition(
				deps,
				invocation.assessment,
				input.confirmBash === true,
				(command, reason) =>
					ctx.ui.confirm("Run classified command?", `${reason}\n\n${command}`),
			);
			const result = await executable.execute(
				id,
				{
					command: input.command,
					...(input.timeout ? { timeout: input.timeout } : {}),
				},
				signal,
				onUpdate,
				ctx,
			);
			return {
				...result,
				details: {
					...(result.details && typeof result.details === "object"
						? result.details
						: {}),
					assessment: invocation.assessment,
					...(invocation.audit
						? {
								audit: {
									modelId: invocation.audit.modelId,
									probes: invocation.audit.probes ?? 0,
									failure: invocation.audit.failure,
								},
							}
						: {}),
				},
			};
		},
		description:
			"Run a host shell command after deterministic effect assessment and, for unresolved plan/auto commands, a bounded fast-model audit. Plan refuses recognized writes and uncertain effects. Auto and hack do not provide an OS write boundary.",
		promptSnippet:
			"run a host shell command after mode-aware effect assessment.",
		promptGuidelines: [
			"Use intent for a concise purpose when a command's effects are not obvious.",
			"If Bash directs you to an exact dedicated tool, use it; set confirmBash only when the shell form is intentionally required.",
		],
	} as ToolDefinition;
}

/** What a command through the audited Bash tool returned. */
export interface BashOutcome {
	readonly ok: boolean;
	/** Whatever the command (or the refusal) said, for the failure message. */
	readonly output: string;
}

/**
 * The seat's audited Bash tool, narrowed to the one thing a flow needs of it.
 *
 * Declared beside the tool rather than beside its callers so that "run a
 * command the way the model's commands are run" has one type, and publication —
 * the only flow that runs any — takes that type instead of a tool definition.
 */
export type AuditedBash = (
	command: string,
	intent: string,
) => Promise<BashOutcome>;

/**
 * The seat's own Bash tool, as a function the seat's own flows can call.
 *
 * Publication needs to run commands, and it must run them the way the MODEL's
 * commands are run: through this tool, so the deterministic classifier, the
 * ambiguity audit and the mode's confirmation policy all apply. Reaching for
 * `execFileSync` instead would be a second, unaudited way to touch the host —
 * exactly the shape the classifier exists to remove — so the adapter is here,
 * beside the tool, and the flows take the narrow `AuditedBash` function type
 * instead of a tool definition.
 *
 * The tool THROWS on a non-zero exit and on a refusal, with the output or the
 * reason in the message; both are the same fact to a caller — the command did
 * not do what was asked — so both become `{ok: false}` with that text.
 */
export function createAuditedBash(
	tool: ToolDefinition,
	ctx: ExtensionContext,
	label = "maestro",
): AuditedBash {
	let ordinal = 0;
	return async (command, intent) => {
		ordinal += 1;
		try {
			const result = await tool.execute(
				`${label}-${ordinal}`,
				{ command, intent },
				undefined,
				undefined,
				ctx,
			);
			return { ok: true, output: toolText(result) };
		} catch (error) {
			return {
				ok: false,
				output: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

/** Whatever text the tool returned, joined; images are not command output. */
function toolText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.filter(Boolean)
		.join("\n");
}
