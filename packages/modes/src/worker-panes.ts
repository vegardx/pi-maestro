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

/**
 * Pane-level tmux user option marking maestro-owned worker panes. Panes
 * outlive the maestro process (attach commands end in a long sleep so output
 * stays inspectable), so a fresh instance must be able to find and kill the
 * previous run's panes — the in-memory map alone can't.
 */
const PANE_MARKER = "@maestro_worker";

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
	/**
	 * Serializes open/close/sync. sync() is fired un-awaited from agent
	 * state-change callbacks; overlapping kill+create sequences interleave
	 * into duplicate columns without this.
	 */
	private chain: Promise<void> = Promise.resolve();

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

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

		await this.enqueue(async () => {
			// A previous maestro run's panes may still be in the window
			// (attach commands outlive the process) — sweep them first, or
			// the new column gets carved out of a stale one.
			await this.killAllPanes();
			await this.createPanes(sessions);
		});
		this._isOpen = true;
		this.opening = false;
	}

	/**
	 * Close all worker panes and tear down the column.
	 */
	async close(): Promise<void> {
		this._enabled = false;
		this.stopListenResize();
		await this.enqueue(() => this.killAllPanes());
		this._isOpen = false;
	}

	async sync(sessions: string[]): Promise<void> {
		if (!this._isOpen) return;
		this.lastSessions = sessions;

		await this.enqueue(async () => {
			// Compare inside the queued op: an earlier queued redraw may have
			// changed the pane set by the time this one runs.
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
		});
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private async createPanes(rawSessions: string[]): Promise<void> {
		// One pane per session, ever — a duplicate name in the input must not
		// produce a second attach pane.
		const sessions = [...new Set(rawSessions)];
		if (sessions.length === 0) return;

		// Create first pane as a horizontal split (30% right column). The
		// split MUST target the maestro's own pane: without -t, tmux splits
		// the window's *active* pane — which after restarts or focus changes
		// can be a previous (narrow) worker pane, producing sliver columns.
		const first = sessions[0];
		let firstPaneId: string;
		try {
			firstPaneId = await splitWindow({
				...(this.ownPaneId() ? { target: this.ownPaneId() } : {}),
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
		await this.markPane(firstPaneId, first);

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
				await this.markPane(paneId, sess);
			} catch {
				break;
			}
		}

		// Evenly distribute heights
		await this.evenlyResize();

		// Resize each worker session's window to match pane dimensions
		await this.resizeSessionsToMatchPanes();
	}

	/** The tmux pane the maestro itself runs in, if inside tmux. */
	private ownPaneId(): string | undefined {
		return process.env.TMUX_PANE || undefined;
	}

	/** Tag a pane as maestro-owned so later runs can find and kill it. */
	private async markPane(paneId: string, session: string): Promise<void> {
		try {
			await tmuxExec(["set-option", "-p", "-t", paneId, PANE_MARKER, session]);
		} catch {
			// Best-effort — worst case the pane survives a restart sweep.
		}
	}

	private async killAllPanes(): Promise<void> {
		for (const paneId of this.panes.values()) {
			try {
				await killPane(paneId);
			} catch {}
		}
		this.panes.clear();
		this.columnPaneId = undefined;
		// Sweep strays this instance never knew about (panes from a previous
		// maestro run persist — their attach commands outlive pi). Marked
		// panes are ours by definition; the start-command match also catches
		// panes created before the marker existed.
		try {
			const out = await tmuxExec([
				"list-panes",
				"-F",
				`#{pane_id}\t#{${PANE_MARKER}}\t#{pane_start_command}`,
			]);
			for (const line of out.split("\n")) {
				const [id, marker, ...rest] = line.split("\t");
				const startCommand = rest.join("\t");
				const ours =
					Boolean(marker) || startCommand.includes("tmux attach-session -r -t");
				if (id && ours) {
					try {
						await killPane(id);
					} catch {}
				}
			}
		} catch {}
		// Re-focus the maestro's pane (fall back to the window's first pane).
		try {
			await tmuxExec(["select-pane", "-t", this.ownPaneId() ?? ":.0"]);
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
		// Attach read-only. When agent exits, show "[session ended]" and wait.
		return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${sessionName} 2>/dev/null || echo "[session ended: ${sessionName}]" && sleep 86400`;
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
		if (
			this.terminalLargeEnough() &&
			!this._isOpen &&
			this.lastSessions.length > 0
		) {
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
