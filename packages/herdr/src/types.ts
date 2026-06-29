// Typed response/error shapes for herdr CLI and socket API.

/** Error returned by herdr when a request fails. */
export class HerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`herdr: ${code}: ${message}`);
		this.name = "HerdrError";
		this.code = code;
	}
}

// --- CLI result ---

export interface HerdrResult<T = unknown> {
	readonly result: T;
}

// --- Worktree ---

export interface WorktreeCreateResult {
	readonly workspace: { workspace_id: string; label?: string };
	readonly tab: { tab_id: string };
	readonly root_pane: { pane_id: string };
	readonly worktree: { path: string; branch?: string; label?: string };
}

export interface WorktreeCreateOptions {
	readonly cwd: string;
	readonly branch?: string;
	readonly base?: string;
	readonly label?: string;
	readonly focus?: boolean;
}

export interface WorktreeRemoveOptions {
	readonly workspaceId: string;
	readonly force?: boolean;
}

// --- Pane ---

export type PaneReadSource =
	| "visible"
	| "recent"
	| "recent-unwrapped"
	| "detection";

export interface PaneReadOptions {
	readonly source?: PaneReadSource;
	readonly lines?: number;
}

// --- Agent ---

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
	readonly pane_id: string;
	readonly terminal_id?: string;
	readonly workspace_id?: string;
	readonly agent_status?: AgentStatus;
	readonly agent?: string;
}

// --- Events ---

export interface Subscription {
	readonly type: string;
	readonly pane_id?: string;
	readonly agent_status?: AgentStatus;
}

export interface AgentStatusChangedEvent {
	readonly type: "pane.agent_status_changed";
	readonly pane_id: string;
	readonly agent_status: AgentStatus;
	readonly previous_agent_status?: AgentStatus;
}

export type HerdrEvent =
	| AgentStatusChangedEvent
	| { type: string; [key: string]: unknown };
