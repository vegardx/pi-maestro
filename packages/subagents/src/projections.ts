import {
	AGENT_KINDS,
	type AgentKind,
	type ChildRunProjection,
	type ChildRunProjectionSourceV1,
	type InterruptResult,
	type ResolvedAgentAssignment,
	type RunBusMessage,
	type RunRecord,
	type TokenSnapshot,
} from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";
import { msgRunId } from "./bus.js";
import type { SubagentService } from "./service.js";
import type { RunStore } from "./store.js";

const ZERO_USAGE: TokenSnapshot = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	turns: 0,
};

function projectionFor(
	record: RunRecord,
	events: readonly RunBusMessage[],
): ChildRunProjection {
	let usage = ZERO_USAGE;
	let activity: string | undefined;
	for (const event of events) {
		if (event.type === "progress") {
			const input = usage.input + (event.delta.tokensIn ?? 0);
			const output = usage.output + (event.delta.tokensOut ?? 0);
			const cacheRead = usage.cacheRead + (event.delta.cacheRead ?? 0);
			const cacheWrite = usage.cacheWrite + (event.delta.cacheWrite ?? 0);
			usage = {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: usage.cost + (event.delta.cost ?? 0),
				turns: usage.turns + 1,
			};
			if (event.delta.text?.trim()) activity = event.delta.text.trim();
		}
	}
	const meta = record.profile.meta;
	const assignment = isAssignment(meta?.assignment)
		? (meta?.assignment as unknown as ResolvedAgentAssignment)
		: undefined;
	const kind = assignment?.kind ?? kindFrom(meta?.kind);
	const effort = assignment?.effort ?? record.profile.thinking ?? "off";
	const model = assignment?.modelId ?? record.profile.model ?? "unknown";
	return {
		runId: record.id,
		revision: events.length,
		...(record.parent ? { parent: record.parent } : {}),
		kind,
		model,
		effort,
		...(assignment ? { assignment } : {}),
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.completedAt !== undefined
			? { completedAt: record.completedAt }
			: {}),
		...(record.lastEventAt !== undefined
			? { lastEventAt: record.lastEventAt }
			: {}),
		...(activity ? { activity } : {}),
		...(record.metadata ? { metadata: record.metadata } : {}),
		profile: {
			profile: record.profile.profile,
			...(record.profile.role ? { role: record.profile.role } : {}),
			...(record.profile.displayName
				? { displayName: record.profile.displayName }
				: {}),
			...(record.profile.cwd ? { cwd: record.profile.cwd } : {}),
			...(record.profile.transport
				? { transport: record.profile.transport }
				: {}),
			...(record.profile.rootTurnId
				? { rootTurnId: record.profile.rootTurnId }
				: {}),
		},
		usage,
		...(record.result ? { result: record.result } : {}),
	};
}

function kindFrom(value: unknown): AgentKind {
	if (value === "security-audit") return "security-review";
	if (value === "test-coverage") return "test-review";
	if (value === "simplification") return "simplification-review";
	if (typeof value === "string" && AGENT_KINDS.includes(value as AgentKind)) {
		return value as AgentKind;
	}
	return "practical-review";
}

function isAssignment(value: unknown): value is ResolvedAgentAssignment {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { modelId?: unknown }).modelId === "string" &&
		typeof (value as { kind?: unknown }).kind === "string"
	);
}

/**
 * Project the worker's durable RunStore. This subscribes after persistRunBus,
 * so every notification is built from status.json/events.jsonl, never from an
 * uncommitted bus message. Revisions are durable event counts and therefore
 * survive worker reconnect/restart without delta replay ambiguity.
 */
export function createChildRunProjectionSource(input: {
	readonly bus: RunBus;
	readonly store: RunStore;
	readonly service: SubagentService;
}): ChildRunProjectionSourceV1 {
	const listeners = new Set<(projection: ChildRunProjection) => void>();
	input.bus.subscribe((message) => {
		const runId = msgRunId(message);
		if (!runId) return;
		const record = input.store.readRecord(runId);
		if (!record) return;
		const projection = projectionFor(record, input.store.readEvents(runId));
		for (const listener of listeners) listener(projection);
	});
	return {
		list: () =>
			input.store
				.list()
				.map((record) =>
					projectionFor(record, input.store.readEvents(record.id)),
				),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		steer: (runId, guidance) => input.service.steer(runId, guidance),
		interrupt: (runId, reason): Promise<InterruptResult> =>
			input.service.interrupt(runId, reason),
		capture: (runId, lines) => input.service.capture(runId, lines),
		stop: (runId, reason) => input.service.stop(runId, reason),
	};
}
