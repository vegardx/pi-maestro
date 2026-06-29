// Watches an agent's JSONL session file and accumulates token usage in real-time.

import {
	closeSync,
	existsSync,
	type FSWatcher,
	fstatSync,
	openSync,
	readSync,
	watch,
} from "node:fs";
import { basename, dirname } from "node:path";

/** Aggregated token snapshot for one agent session. */
export interface TokenSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
	/** `cacheRead / (input + cacheRead) * 100`, 0 if no reads. */
	readonly cacheHitRate: number;
	/** Number of assistant turns observed. */
	readonly turns: number;
}

export type TokenChangeCallback = (snapshot: TokenSnapshot) => void;

/**
 * Tails a JSONL session file and accumulates token usage from assistant messages.
 * Handles: file not yet created, rapid appends (debounced), graceful stop.
 */
export class SessionTailer {
	private watcher: FSWatcher | undefined;
	private parentWatcher: FSWatcher | undefined;
	private offset = 0;
	private stopped = false;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly debounceMs: number;

	// Accumulated totals.
	private input = 0;
	private output = 0;
	private cacheRead = 0;
	private cacheWrite = 0;
	private cost = 0;
	private turns = 0;

	constructor(
		private readonly sessionFilePath: string,
		private readonly onChange: TokenChangeCallback,
		options?: { debounceMs?: number },
	) {
		this.debounceMs = options?.debounceMs ?? 100;
		this.start();
	}

	/** Stop watching and clean up. */
	stop(): void {
		this.stopped = true;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.watcher?.close();
		this.watcher = undefined;
		this.parentWatcher?.close();
		this.parentWatcher = undefined;
	}

	/** Current snapshot without waiting for a change event. */
	snapshot(): TokenSnapshot {
		return this.buildSnapshot();
	}

	private start(): void {
		if (this.stopped) return;

		if (existsSync(this.sessionFilePath)) {
			this.watchFile();
			// Do an initial read to catch anything already written.
			this.readNewLines();
		} else {
			this.watchParentDir();
		}
	}

	private watchFile(): void {
		if (this.stopped) return;
		// Stop parent watcher if we were waiting for creation.
		this.parentWatcher?.close();
		this.parentWatcher = undefined;

		try {
			this.watcher = watch(this.sessionFilePath, () => {
				this.scheduleRead();
			});
			this.watcher.on("error", () => {
				// File might have been deleted/rotated.
				this.watcher?.close();
				this.watcher = undefined;
				if (!this.stopped) this.watchParentDir();
			});
		} catch {
			// watch can throw if file disappears between check and watch.
			if (!this.stopped) this.watchParentDir();
		}
	}

	private watchParentDir(): void {
		if (this.stopped) return;
		const dir = dirname(this.sessionFilePath);
		const target = basename(this.sessionFilePath);

		try {
			this.parentWatcher = watch(dir, (_, filename) => {
				if (filename === target && existsSync(this.sessionFilePath)) {
					this.parentWatcher?.close();
					this.parentWatcher = undefined;
					this.watchFile();
					this.readNewLines();
				}
			});
			this.parentWatcher.on("error", () => {
				// Parent dir gone — give up silently.
				this.parentWatcher?.close();
				this.parentWatcher = undefined;
			});
		} catch {
			// Dir doesn't exist yet — nothing to watch.
		}
	}

	private scheduleRead(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.readNewLines(), this.debounceMs);
	}

	private readNewLines(): void {
		if (this.stopped) return;
		if (!existsSync(this.sessionFilePath)) return;

		let fd: number | undefined;
		try {
			fd = openSync(this.sessionFilePath, "r");
			const stat = fstatSync(fd);
			const size = stat.size;

			// File was truncated/rotated — reset offset.
			if (size < this.offset) {
				this.offset = 0;
			}

			if (size <= this.offset) {
				closeSync(fd);
				return;
			}

			const bytesToRead = size - this.offset;
			const buffer = Buffer.alloc(bytesToRead);
			readSync(fd, buffer, 0, bytesToRead, this.offset);
			closeSync(fd);
			fd = undefined;
			this.offset = size;

			const chunk = buffer.toString("utf8");
			const lines = chunk.split("\n");
			let changed = false;

			for (const line of lines) {
				if (!line.trim()) continue;
				if (this.processLine(line)) changed = true;
			}

			if (changed) {
				this.onChange(this.buildSnapshot());
			}
		} catch {
			// Read errors are non-fatal (file locked, rotated, etc).
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// ignore
				}
			}
		}
	}

	/**
	 * Process a single JSONL line. Returns true if it contributed tokens.
	 */
	private processLine(line: string): boolean {
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				message?: {
					role?: string;
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						cost?: { total?: number };
					};
				};
			};

			if (entry.type !== "message") return false;
			if (entry.message?.role !== "assistant") return false;

			const usage = entry.message.usage;
			if (!usage) return false;

			this.input += usage.input ?? 0;
			this.output += usage.output ?? 0;
			this.cacheRead += usage.cacheRead ?? 0;
			this.cacheWrite += usage.cacheWrite ?? 0;
			this.cost += usage.cost?.total ?? 0;
			this.turns++;
			return true;
		} catch {
			return false;
		}
	}

	private buildSnapshot(): TokenSnapshot {
		const totalInput = this.input + this.cacheRead;
		return {
			input: this.input,
			output: this.output,
			cacheRead: this.cacheRead,
			cacheWrite: this.cacheWrite,
			totalTokens: this.input + this.output + this.cacheRead + this.cacheWrite,
			cost: this.cost,
			cacheHitRate: totalInput > 0 ? (this.cacheRead / totalInput) * 100 : 0,
			turns: this.turns,
		};
	}
}
