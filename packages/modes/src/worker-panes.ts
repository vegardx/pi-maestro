/**
 * Manages a right-side column of stacked tmux panes, each showing raw
 * terminal output from an active worker agent (read-only attach).
 */

import { killPane, resizePane, splitWindow, tmuxExec } from "@vegardx/pi-tmux";
import type { TmuxAgentState } from "./execution-tmux.js";

/** Minimum rows per worker pane for useful output. */
const MIN_ROWS_PER_PANE = 6;

/** Minimum terminal dimensions to show worker panes (approx full-screen). */
const MIN_COLS = 160;
const MIN_ROWS = 40;

export class WorkerPanes {
	/** Map from agent name → tmux pane ID. */
	private panes = new Map<string, string>();
	/** The first pane created on the right side (used as layout target). */
	private columnPaneId: string | undefined;
	private _isOpen = false;
	/** Re-entry guard for open() while awaiting splitWindow. */
	private opening = false;
	/** User has toggled panes on (may not be visible due to size). */
	private _enabled = false;
	/** Re-entry guard — prevents concurrent sync() calls from racing. */
	private syncing = false;
	/** When true, another sync is needed after the current one finishes. */
	private syncPending = false;
	/** Last known agents snapshot for deferred sync. */
	private pendingAgents: ReadonlyMap<string, TmuxAgentState> | undefined;
	/** Track last-seen status per agent to skip token-only updates. */
	private lastStatuses = new Map<string, string>();
	/** Cached agents for resize re-open. */
	private lastAgents: ReadonlyMap<string, TmuxAgentState> | undefined;
	/** Resize listener cleanup. */
	private resizeHandler: (() => void) | undefined;

	isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * Returns true only when an agent's status has changed since last check.
	 * Prevents sync on token-only updates.
	 */
	shouldSync(agentId: string, status: string): boolean {
		const prev = this.lastStatuses.get(agentId);
		if (prev === status) return false;
		this.lastStatuses.set(agentId, status);
		return true;
	}

	/**
	 * Open the worker panes column and populate with current active agents.
	 */
	async open(activeAgents: ReadonlyMap<string, TmuxAgentState>): Promise<void> {
		if (this._isOpen || this.opening) return;
		this.opening = true;
		this._enabled = true;
		this.lastAgents = activeAgents;
		this.listenResize();
		if (!this.terminalLargeEnough()) {
			this.opening = false;
			return;
		}

		await this.createPanes(this.activeAgentList(activeAgents));
		this._isOpen = true;
		this.opening = false;
	}

	/**
	 * Close all worker panes and tear down the column.
	 */
	async close(): Promise<void> {
		this._enabled = false;
		this.stopListenResize();
		await this.killAllPanes();
		this._isOpen = false;
	}

	/**
	 * Reconcile panes with the current set of active agents.
	 * Full redraw on change — ensures even spacing and fresh scroll position.
	 * Re-entry safe: concurrent calls are coalesced.
	 */
	async sync(activeAgents: ReadonlyMap<string, TmuxAgentState>): Promise<void> {
		if (!this._isOpen) return;
		this.lastAgents = activeAgents;

		// Re-entry guard: if already syncing, queue a re-sync
		if (this.syncing) {
			this.syncPending = true;
			this.pendingAgents = activeAgents;
			return;
		}
		this.syncing = true;
		try {
			await this.doSync(activeAgents);
		} finally {
			this.syncing = false;
			if (this.syncPending && this.pendingAgents) {
				this.syncPending = false;
				const agents = this.pendingAgents;
				this.pendingAgents = undefined;
				await this.sync(agents);
			}
		}
	}

	private async doSync(
		activeAgents: ReadonlyMap<string, TmuxAgentState>,
	): Promise<void> {
		const toShow = this.activeAgentList(activeAgents);

		// If nothing to show, tear down
		if (toShow.length === 0) {
			await this.killAllPanes();
			this._isOpen = false;
			this.columnPaneId = undefined;
			return;
		}

		// Check if the set of agents changed — skip redraw if same
		const currentNames = [...this.panes.keys()].sort().join(",");
		const newNames = toShow
			.map((a) => a.agentName)
			.sort()
			.join(",");
		if (currentNames === newNames) return;

		// Full redraw: kill all panes, recreate from scratch
		await this.killAllPanes();
		await this.createPanes(toShow);
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	/**
	 * Create the column split and stack panes for the given agents.
	 */
	private async createPanes(toShow: TmuxAgentState[]): Promise<void> {
		if (toShow.length === 0) return;

		// Create first pane as a vertical split (30% right)
		const first = toShow[0];
		let firstPaneId: string;
		try {
			firstPaneId = await splitWindow({
				horizontal: true,
				percent: 30,
				detach: true,
				command: this.attachCommand(first.agentName),
			});
		} catch {
			return;
		}
		this.columnPaneId = firstPaneId;
		this.panes.set(first.agentName, firstPaneId);

		// Determine how many additional panes fit
		const maxPanes = await this.maxPanesForColumn(firstPaneId);
		const remaining = toShow.slice(1, maxPanes);

		// Stack remaining agents below the first
		for (const agent of remaining) {
			try {
				const paneId = await splitWindow({
					target: this.columnPaneId,
					horizontal: false,
					detach: true,
					command: this.attachCommand(agent.agentName),
				});
				this.panes.set(agent.agentName, paneId);
			} catch {
				break;
			}
		}

		// Evenly distribute heights
		await this.evenlyResize();
	}

	private async killAllPanes(): Promise<void> {
		for (const paneId of this.panes.values()) {
			try {
				await killPane(paneId);
			} catch {}
		}
		this.panes.clear();
		this.columnPaneId = undefined;
		// Re-focus the main pane so input isn't lost
		try {
			await tmuxExec(["select-pane", "-t", ":.0"]);
		} catch {}
	}

	private async evenlyResize(): Promise<void> {
		if (this.panes.size <= 1) return;
		try {
			let totalHeight = 0;
			for (const paneId of this.panes.values()) {
				const stdout = await tmuxExec([
					"display-message",
					"-t",
					paneId,
					"-p",
					"#{pane_height}",
				]);
				totalHeight += Number.parseInt(stdout.trim(), 10) || 0;
			}
			const separators = this.panes.size - 1;
			const usable = totalHeight + separators;
			const perPane = Math.floor((usable - separators) / this.panes.size);
			if (perPane < 2) return;
			for (const paneId of this.panes.values()) {
				await resizePane(paneId, { height: perPane });
			}
		} catch {
			// Best-effort
		}
	}

	private activeAgentList(
		agents: ReadonlyMap<string, TmuxAgentState>,
	): TmuxAgentState[] {
		const active: TmuxAgentState[] = [];
		for (const state of agents.values()) {
			if (
				state.status === "spawning" ||
				state.status === "working" ||
				state.status === "idle" ||
				state.status === "awaiting-decision"
			) {
				active.push(state);
			}
		}
		return active;
	}

	private attachCommand(agentName: string): string {
		// Attach read-only. Pane exits when the session dies.
		return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${agentName} || exit`;
	}

	/** Check if terminal is large enough for side panes. */
	private terminalLargeEnough(): boolean {
		const cols = process.stdout.columns || 0;
		const rows = process.stdout.rows || 0;
		return cols >= MIN_COLS && rows >= MIN_ROWS;
	}

	/** Exposed for the command handler to explain why panes won't open. */
	terminalTooSmall(): boolean {
		return !this.terminalLargeEnough();
	}

	/** Whether the user has enabled panes (even if not visible due to size). */
	isEnabled(): boolean {
		return this._enabled;
	}

	private listenResize(): void {
		if (this.resizeHandler) return;
		const handler = () => this.handleResize();
		process.stdout.on("resize", handler);
		this.resizeHandler = () => process.stdout.off("resize", handler);
	}

	private stopListenResize(): void {
		this.resizeHandler?.();
		this.resizeHandler = undefined;
	}

	private handleResize(): void {
		if (!this._enabled) return;
		const large = this.terminalLargeEnough();
		if (large && !this._isOpen && this.lastAgents) {
			this.open(this.lastAgents).catch(() => {});
		}
	}

	private async maxPanesForColumn(paneId: string): Promise<number> {
		try {
			const stdout = await tmuxExec([
				"display-message",
				"-t",
				paneId,
				"-p",
				"#{pane_height}",
			]);
			const height = Number.parseInt(stdout.trim(), 10);
			if (Number.isFinite(height) && height > 0) {
				return Math.max(1, Math.floor(height / (MIN_ROWS_PER_PANE + 1)));
			}
		} catch {
			// Fallback
		}
		return 4;
	}
}
