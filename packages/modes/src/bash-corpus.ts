import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type CorpusMode =
	| "recon"
	| "plan"
	| "auto"
	| "hack"
	| "agent"
	| "unknown";
export type CorpusActor =
	| "maestro"
	| "worker"
	| "reviewer"
	| "agent"
	| "unknown";
export type AgentPosture = "full" | "read-only" | "unknown";

export interface BashCorpusOutcome {
	readonly status: "success" | "error" | "missing";
	readonly timestamp?: string;
	readonly exitCode?: number | null;
}

export interface BashCorpusCall {
	readonly id: string;
	readonly sessionId: string;
	readonly sessionTimestamp?: string;
	readonly timestamp?: string;
	readonly cwd?: string;
	readonly command: string;
	readonly commandBytes: number;
	readonly commandTruncated: boolean;
	readonly mode: CorpusMode;
	readonly actor: CorpusActor;
	readonly posture: AgentPosture;
	readonly nearbyTools: readonly string[];
	readonly outcome: BashCorpusOutcome;
}

export interface CorpusDiagnostic {
	readonly line: number;
	readonly code:
		| "malformed-json"
		| "duplicate-call"
		| "duplicate-result"
		| "invalid-entry";
}

export interface SessionCorpus {
	readonly calls: readonly BashCorpusCall[];
	readonly diagnostics: readonly CorpusDiagnostic[];
}

export interface ExtractCorpusOptions {
	/** Commands beyond this UTF-8 byte count are truncated as inert data. */
	readonly maxCommandBytes?: number;
	readonly sourceName?: string;
}

interface MutableCall {
	call: Omit<BashCorpusCall, "outcome">;
	outcome?: BashCorpusOutcome;
}

const MODES = new Set<CorpusMode>(["recon", "plan", "auto", "hack", "agent"]);
const DEFAULT_MAX_COMMAND_BYTES = 64 * 1024;

/** Read a session as data. This function never imports a shell or process API. */
export async function extractBashCorpusFile(
	path: string,
	options: ExtractCorpusOptions = {},
): Promise<SessionCorpus> {
	return extractBashCorpusJsonl(await readFile(path, "utf8"), {
		...options,
		sourceName: options.sourceName ?? path,
	});
}

/**
 * Parse pi session JSONL in physical line order. Tool calls are paired by ID,
 * never evaluated, expanded, interpolated, or replayed.
 */
export function extractBashCorpusJsonl(
	jsonl: string,
	options: ExtractCorpusOptions = {},
): SessionCorpus {
	const maxCommandBytes = Math.max(
		0,
		options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES,
	);
	const diagnostics: CorpusDiagnostic[] = [];
	const calls = new Map<string, MutableCall>();
	const seenResults = new Set<string>();
	let sessionId = stableId(options.sourceName ?? "session");
	let sessionTimestamp: string | undefined;
	let cwd: string | undefined;
	let mode: CorpusMode = "unknown";
	let actor: CorpusActor = "unknown";
	let posture: AgentPosture = "unknown";
	let availableTools: readonly string[] = [];

	const lines = jsonl.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		let entry: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isObject(parsed)) throw new Error("entry is not an object");
			entry = parsed;
		} catch {
			diagnostics.push({ line: index + 1, code: "malformed-json" });
			continue;
		}

		if (entry.type === "session") {
			sessionId = stringValue(entry.id) ?? sessionId;
			sessionTimestamp = stringValue(entry.timestamp);
			cwd = stringValue(entry.cwd) ?? cwd;
		}

		if (entry.type === "custom") {
			const data = isObject(entry.data) ? entry.data : undefined;
			if (entry.customType === "maestro.modes.state" && data) {
				mode = parseMode(data.mode) ?? mode;
			}
			if (data) {
				const context = parseActorContext(data);
				actor = context.actor ?? actor;
				posture = context.posture ?? posture;
				availableTools =
					parseToolNames(data.activeTools ?? data.tools) ?? availableTools;
			}
		}

		if (entry.type !== "message" || !isObject(entry.message)) continue;
		const message = entry.message;
		const entryTimestamp =
			stringValue(entry.timestamp) ?? stringValue(message.timestamp);

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const messageTools = message.content
				.filter(isObject)
				.map((part) => stringValue(part.name))
				.filter((name): name is string => name !== undefined)
				.sort();
			for (const part of message.content) {
				if (!isObject(part) || part.type !== "toolCall") continue;
				const name = stringValue(part.name)?.toLowerCase();
				if (name !== "bash") continue;
				const callId = stringValue(part.id);
				const args = isObject(part.arguments) ? part.arguments : undefined;
				const rawCommand = args ? stringValue(args.command) : undefined;
				if (!callId || rawCommand === undefined) {
					diagnostics.push({ line: index + 1, code: "invalid-entry" });
					continue;
				}
				if (calls.has(callId)) {
					diagnostics.push({ line: index + 1, code: "duplicate-call" });
					continue;
				}
				const bounded = truncateUtf8(rawCommand, maxCommandBytes);
				const currentMode = mode;
				calls.set(callId, {
					call: {
						id: stableId(`${sessionId}\0${callId}`),
						sessionId,
						sessionTimestamp,
						timestamp: entryTimestamp,
						cwd: args ? (stringValue(args.cwd) ?? cwd) : cwd,
						command: bounded.value,
						commandBytes: Buffer.byteLength(rawCommand),
						commandTruncated: bounded.truncated,
						mode: currentMode,
						actor:
							actor === "unknown" && currentMode !== "agent"
								? "maestro"
								: actor,
						posture,
						nearbyTools: [
							...new Set([...availableTools, ...messageTools]),
						].sort(),
					},
				});
			}
		}

		if (message.role === "toolResult") {
			const callId = stringValue(message.toolCallId);
			if (!callId || !calls.has(callId)) continue;
			if (seenResults.has(callId)) {
				diagnostics.push({ line: index + 1, code: "duplicate-result" });
				continue;
			}
			seenResults.add(callId);
			const details = isObject(message.details) ? message.details : undefined;
			calls.get(callId)!.outcome = {
				status: message.isError === true ? "error" : "success",
				timestamp: entryTimestamp,
				exitCode: parseExitCode(details?.exitCode),
			};
		}
	}

	return {
		calls: [...calls.values()].map(({ call, outcome }) => ({
			...call,
			outcome: outcome ?? { status: "missing" },
		})),
		diagnostics,
	};
}

function parseActorContext(data: Record<string, unknown>): {
	actor?: CorpusActor;
	posture?: AgentPosture;
} {
	const role =
		stringValue(data.actor) ??
		stringValue(data.role) ??
		stringValue(data.agentRole);
	const rawPosture =
		stringValue(data.posture) ?? stringValue(data.agentPosture);
	let actor: CorpusActor | undefined;
	if (
		role === "worker" ||
		role === "reviewer" ||
		role === "maestro" ||
		role === "agent"
	)
		actor = role;
	let posture: AgentPosture | undefined;
	if (rawPosture === "full") posture = "full";
	if (rawPosture === "read-only" || rawPosture === "readonly")
		posture = "read-only";
	return { actor, posture };
}

function parseMode(value: unknown): CorpusMode | undefined {
	return typeof value === "string" && MODES.has(value as CorpusMode)
		? (value as CorpusMode)
		: undefined;
}

function parseToolNames(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [
		...new Set(
			value.filter((item): item is string => typeof item === "string"),
		),
	].sort();
}

function parseExitCode(value: unknown): number | null | undefined {
	return value === null || typeof value === "number" ? value : undefined;
}

function truncateUtf8(
	value: string,
	maxBytes: number,
): { value: string; truncated: boolean } {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return { value, truncated: false };
	return {
		value: bytes
			.subarray(0, maxBytes)
			.toString("utf8")
			.replace(/\uFFFD$/u, ""),
		truncated: true,
	};
}

function stableId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
