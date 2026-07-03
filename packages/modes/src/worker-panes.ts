/**
 * Manages a right-side column of stacked tmux panes, each showing raw
 * terminal output from an active worker agent (read-only attach).
 */

import {
	killPane,
	selectLayout,
	splitWindow,
	tmuxExec,
} from "@vegardx/pi-tmux";
import type { TmuxAgentState } from "./execution-tmux.js";

/** Minimum rows per worker pane for useful output. */
const MIN_ROWS_PER_PANE = 6;

export class WorkerPanes {
	/** Map from agent name → tmux pane ID. */
	private panes = new Map<string, string>();
	/** The first pane created on the right side (used as layout target). */
	private columnPaneId: string | undefined;
	private _isOpen = false;

	isOpen(): boolean {
		return this._isOpen;
	}

	/**
	 * Open the worker panes column and populate with current active agents.
	 */
	async open(activeAgents: ReadonlyMap<string, TmuxAgentState>): Promise<void> {
		if (this._isOpen) return;

		// Collect agents that need panes (spawning/working)
		const toShow = this.activeAgentList(activeAgents);
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
			// Terminal too small to split
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
				// No space for more panes — stop stacking
				break;
			}
		}

		// Rebalance the right column evenly
		if (this.panes.size > 1 && this.columnPaneId) {
			await this.rebalance();
		}

		this._isOpen = true;
	}

	/**
	 * Close all worker panes and tear down the column.
	 */
	async close(): Promise<void> {
		for (const paneId of this.panes.values()) {
			try {
				await killPane(paneId);
			} catch {
				// Pane may already be gone
			}
		}
		this.panes.clear();
		this.columnPaneId = undefined;
		this._isOpen = false;
	}

	/**
	 * Reconcile panes with the current set of active agents.
	 * Adds panes for new agents, removes panes for finished ones.
	 */
	async sync(activeAgents: ReadonlyMap<string, TmuxAgentState>): Promise<void> {
		if (!this._isOpen) return;

		const toShow = this.activeAgentList(activeAgents);
		const activeNames = new Set(toShow.map((a) => a.agentName));

		// Remove panes for agents that are no longer active
		for (const [name, paneId] of this.panes) {
			if (!activeNames.has(name)) {
				try {
					await killPane(paneId);
				} catch {
					// Already gone
				}
				this.panes.delete(name);
			}
		}

		// Add panes for new agents (respect height limit)
		const maxPanes = this.columnPaneId
			? await this.maxPanesForColumn(this.columnPaneId)
			: 1;

		for (const agent of toShow) {
			if (this.panes.has(agent.agentName)) continue;
			if (this.panes.size >= maxPanes) break;

			if (this.panes.size === 0) {
				// Column was fully emptied — recreate it
				try {
					const paneId = await splitWindow({
						horizontal: true,
						percent: 30,
						detach: true,
						command: this.attachCommand(agent.agentName),
					});
					this.columnPaneId = paneId;
					this.panes.set(agent.agentName, paneId);
				} catch {
					// Terminal too small
					break;
				}
			} else {
				// Stack below existing panes
				const target = this.columnPaneId ?? [...this.panes.values()][0];
				try {
					const paneId = await splitWindow({
						target,
						horizontal: false,
						detach: true,
						command: this.attachCommand(agent.agentName),
					});
					this.panes.set(agent.agentName, paneId);
				} catch {
					// No space for more panes
					break;
				}
			}
		}

		// If all agents are gone, close entirely
		if (this.panes.size === 0) {
			this._isOpen = false;
			this.columnPaneId = undefined;
			return;
		}

		// Rebalance
		if (this.panes.size > 1) {
			await this.rebalance();
		}
	}

	// ─── Private ──────────────────────────────────────────────────────────────

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
		// The pane exits when the attached session dies (no lingering shell)
		return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${agentName} || exit`;
	}

	private async rebalance(): Promise<void> {
		// Apply even-vertical layout to the right-side column.
		// We target any pane in the column — tmux applies the layout to its window.
		const target = this.columnPaneId ?? [...this.panes.values()][0];
		if (!target) return;
		try {
			await selectLayout(target, "even-vertical");
		} catch {
			// Layout may fail if panes were killed concurrently
		}
	}

	/**
	 * Query the height of a pane and calculate max panes that fit
	 * with at least MIN_ROWS_PER_PANE rows each.
	 */
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
				// Each pane needs MIN_ROWS_PER_PANE + 1 for the separator
				return Math.max(1, Math.floor(height / (MIN_ROWS_PER_PANE + 1)));
			}
		} catch {
			// Fallback if query fails
		}
		return 4;
	}
}
