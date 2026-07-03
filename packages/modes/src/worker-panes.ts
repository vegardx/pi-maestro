/**
 * Manages a right-side column of stacked tmux panes, each showing raw
 * terminal output from an active worker agent (read-only attach).
 */

import { killPane, selectLayout, splitWindow } from "@vegardx/pi-tmux";
import type { TmuxAgentState } from "./execution-tmux.js";

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
		const firstPaneId = await splitWindow({
			horizontal: true,
			percent: 30,
			detach: true,
			command: this.attachCommand(first.agentName),
		});
		this.columnPaneId = firstPaneId;
		this.panes.set(first.agentName, firstPaneId);

		// Stack remaining agents below the first
		for (let i = 1; i < toShow.length; i++) {
			const agent = toShow[i];
			const paneId = await splitWindow({
				target: this.columnPaneId,
				horizontal: false,
				detach: true,
				command: this.attachCommand(agent.agentName),
			});
			this.panes.set(agent.agentName, paneId);
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

		// Add panes for new agents
		for (const agent of toShow) {
			if (this.panes.has(agent.agentName)) continue;

			if (this.panes.size === 0) {
				// Column was fully emptied — recreate it
				const paneId = await splitWindow({
					horizontal: true,
					percent: 30,
					detach: true,
					command: this.attachCommand(agent.agentName),
				});
				this.columnPaneId = paneId;
				this.panes.set(agent.agentName, paneId);
			} else {
				// Stack below existing panes
				const target = this.columnPaneId ?? [...this.panes.values()][0];
				const paneId = await splitWindow({
					target,
					horizontal: false,
					detach: true,
					command: this.attachCommand(agent.agentName),
				});
				this.panes.set(agent.agentName, paneId);
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
			if (state.status === "spawning" || state.status === "working") {
				active.push(state);
			}
		}
		return active;
	}

	private attachCommand(agentName: string): string {
		return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${agentName}`;
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
}
