/**
 * Manages a right-side column of stacked tmux panes, each showing raw
 * terminal output from an active worker agent (read-only attach).
 */

import { killPane, resizePane, splitWindow, tmuxExec } from "@vegardx/pi-tmux";

/** Minimum rows per worker pane for useful output. */
const MIN_ROWS_PER_PANE = 6;

/** Minimum terminal dimensions to show worker panes. */
const MIN_COLS = 160;
const MIN_ROWS = 40;

export class WorkerPanes {
	/** Map from session name → tmux pane ID. */
	private panes = new Map<string, string>();
	/** The first pane created on the right side (used as layout target). */
	private columnPaneId: string | undefined;
	private _isOpen = false;
	private opening = false;
	private _enabled = false;
	/** Cached sessions for resize re-open. */
	private lastSessions: string[] = [];
	/** Resize listener cleanup. */
	private resizeHandler: (() => void) | undefined;

	isOpen(): boolean {
		return this._isOpen;
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	terminalTooSmall(): boolean {
		return !this.terminalLargeEnough();
	}

	shouldSync(_id: string, _status: string): boolean {
		return false;
	}

	/**
	 * Open the worker panes column for the given session names.
	 */
	async open(sessions: string[]): Promise<void> {
		if (this._isOpen || this.opening) return;
		this.opening = true;
		this._enabled = true;
		this.lastSessions = sessions;
		this.listenResize();

		if (!this.terminalLargeEnough()) {
			this.opening = false;
			return;
		}

		await this.createPanes(sessions);
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

	async sync(sessions: string[]): Promise<void> {
		if (!this._isOpen) return;
		this.lastSessions = sessions;

		// Check if set changed
		const currentNames = [...this.panes.keys()].sort().join(",");
		const newNames = [...sessions].sort().join(",");
		if (currentNames === newNames) return;

		// Full redraw
		await this.killAllPanes();
		if (sessions.length > 0) {
			await this.createPanes(sessions);
		} else {
			this._isOpen = false;
		}
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private async createPanes(sessions: string[]): Promise<void> {
		if (sessions.length === 0) return;

		// Create first pane as a horizontal split (30% right column)
		const first = sessions[0];
		let firstPaneId: string;
		try {
			firstPaneId = await splitWindow({
				horizontal: true,
				percent: 30,
				detach: true,
				command: this.attachCommand(first),
			});
		} catch {
			return;
		}
		this.columnPaneId = firstPaneId;
		this.panes.set(first, firstPaneId);

		// Determine how many additional panes fit
		const maxPanes = await this.maxPanesForColumn(firstPaneId);
		const remaining = sessions.slice(1, maxPanes);

		// Stack remaining agents below the first (vertical splits in the column)
		for (const sess of remaining) {
			try {
				const paneId = await splitWindow({
					target: this.columnPaneId,
					horizontal: false,
					detach: true,
					command: this.attachCommand(sess),
				});
				this.panes.set(sess, paneId);
			} catch {
				break;
			}
		}

		// Evenly distribute heights
		await this.evenlyResize();

		// Resize each worker session's window to match pane dimensions
		await this.resizeSessionsToMatchPanes();
	}

	private async killAllPanes(): Promise<void> {
		for (const paneId of this.panes.values()) {
			try {
				await killPane(paneId);
			} catch {}
		}
		this.panes.clear();
		this.columnPaneId = undefined;
		// Re-focus the main pane
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

	private async resizeSessionsToMatchPanes(): Promise<void> {
		for (const [sessionName, paneId] of this.panes.entries()) {
			try {
				const stdout = await tmuxExec([
					"display-message",
					"-t",
					paneId,
					"-p",
					"#{pane_width} #{pane_height}",
				]);
				const [w, h] = stdout.trim().split(" ");
				const width = Number.parseInt(w, 10);
				const height = Number.parseInt(h, 10);
				if (width > 0 && height > 0) {
					await tmuxExec([
						"resize-window",
						"-t",
						`${sessionName}:0`,
						"-x",
						String(width),
						"-y",
						String(height),
					]);
				}
			} catch {
				// Best-effort — session may not exist yet
			}
		}
	}

	private attachCommand(sessionName: string): string {
		return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${sessionName} || exit`;
	}

	private terminalLargeEnough(): boolean {
		const cols = process.stdout.columns || 0;
		const rows = process.stdout.rows || 0;
		return cols >= MIN_COLS && rows >= MIN_ROWS;
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
		if (this.terminalLargeEnough() && !this._isOpen && this.lastSessions.length > 0) {
			this.open(this.lastSessions).catch(() => {});
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
		} catch {}
		return 4;
	}
}
