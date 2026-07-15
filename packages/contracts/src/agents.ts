// Unified control identity and selector resolution for persistent workers and
// one-shot subagent runs. Exact opaque ids always win; human display aliases
// are accepted only when they identify exactly one target.

export type AgentTargetKind = "host" | "worker" | "run";
export type AgentTransport = "host" | "tmux" | "headless";

export interface AgentTarget {
	readonly id: string;
	readonly kind: AgentTargetKind;
	readonly displayName: string;
	readonly role: string;
	readonly status: string;
	readonly transport: AgentTransport;
	readonly parentId?: string;
	readonly rootTurnId?: string;
	readonly pid?: number;
	readonly processGroup?: number;
	readonly tmuxSession?: string;
	readonly tmuxPane?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly capabilities: {
		readonly view: boolean;
		readonly capture: boolean;
		readonly steer: boolean;
		readonly interrupt: boolean;
		readonly shutdown: boolean;
	};
}

export type AgentTargetResolution =
	| { readonly ok: true; readonly target: AgentTarget }
	| {
			readonly ok: false;
			readonly reason: "not-found";
			readonly selector: string;
	  }
	| {
			readonly ok: false;
			readonly reason: "ambiguous";
			readonly selector: string;
			readonly matches: readonly AgentTarget[];
	  };

/** Resolve exact opaque ids first, then exact display/role aliases. */
export function resolveAgentTarget(
	targets: readonly AgentTarget[],
	selector: string,
): AgentTargetResolution {
	const value = selector.trim();
	const exact = targets.find((target) => target.id === value);
	if (exact) return { ok: true, target: exact };
	const matches = targets.filter((target) => {
		if (target.displayName === value || target.role === value) return true;
		if (target.kind !== "worker") return false;
		const key = target.id.slice("worker:".length);
		return key === value || key === `${value}/worker`;
	});
	if (matches.length === 1) return { ok: true, target: matches[0] };
	if (matches.length > 1) {
		return { ok: false, reason: "ambiguous", selector: value, matches };
	}
	return { ok: false, reason: "not-found", selector: value };
}

export function descendantsOf(
	targets: readonly AgentTarget[],
	rootId: string,
): AgentTarget[] {
	const result: AgentTarget[] = [];
	const pending = [rootId];
	while (pending.length > 0) {
		const parent = pending.shift();
		for (const target of targets) {
			if (
				target.parentId !== parent ||
				result.some((item) => item.id === target.id)
			)
				continue;
			result.push(target);
			pending.push(target.id);
		}
	}
	return result;
}
