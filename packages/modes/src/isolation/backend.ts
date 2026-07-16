import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Isolation tiers exposed by execution policy. Strong is intentionally reserved. */
export type IsolationBackendTier = "lightweight" | "strong" | "none";

export type IsolationBackendState =
	| "idle"
	| "preparing"
	| "ready"
	| "failed"
	| "destroyed";

export interface IsolationBackendStatus {
	readonly tier: IsolationBackendTier;
	readonly state: IsolationBackendState;
	readonly supported: boolean;
	readonly workspace?: string;
	readonly detail: string;
	readonly error?: string;
}

/**
 * Stateful phase backend. The final command boundary remains Pi's
 * BashOperations contract, preserving command text, cwd, environment,
 * streaming, timeout, cancellation, and nullable exit status.
 */
export interface IsolationBackend {
	readonly tier: IsolationBackendTier;
	status(): IsolationBackendStatus;
	operations(sourceCwd: string): BashOperations;
	/** Start a fresh research epoch. Implementations should remain lazy. */
	reset(sourceRoot?: string): Promise<void>;
	/** Invalidate synchronously, then terminate processes and delete state. */
	destroy(): Promise<void>;
}

/** A setup failure before the requested command has started. */
export class IsolationUnavailableError extends Error {
	readonly tier: IsolationBackendTier;
	readonly cause?: unknown;

	constructor(tier: IsolationBackendTier, message: string, cause?: unknown) {
		super(message);
		this.name = "IsolationUnavailableError";
		this.tier = tier;
		this.cause = cause;
	}
}

/** Reserved contract advertised by Strict policy until a VM backend ships. */
export class ReservedStrongIsolationBackend implements IsolationBackend {
	readonly tier = "strong" as const;

	status(): IsolationBackendStatus {
		return {
			tier: this.tier,
			state: "idle",
			supported: false,
			detail:
				"Strong isolation is reserved; no VM/container provider is installed.",
		};
	}

	operations(_sourceCwd: string): BashOperations {
		return {
			exec: async () => {
				throw new IsolationUnavailableError(
					this.tier,
					"Strong isolation is reserved and unavailable. Select Lightweight, explicitly use None, or enter Hack.",
				);
			},
		};
	}

	async reset(): Promise<void> {}
	async destroy(): Promise<void> {}
}
