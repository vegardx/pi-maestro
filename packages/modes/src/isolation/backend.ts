import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Isolation tiers exposed by execution policy. */
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

/**
 * Compatibility provider for embedders that intentionally do not install a
 * Strong backend. The default modes runtime uses AppleContainerStrongBackend.
 */
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

/**
 * The lightweight tier's copy-workspace backend is retired: recon/plan run
 * in-place on the real tree, confined per-actor by the OS at the bash router
 * (realtree-sandbox). The `lightweight` route no longer calls a backend, so
 * this placeholder keeps the isolation-backend wiring/status intact without any
 * copy. `operations()` is never reached; if it somehow is, it fails visibly.
 */
export class RetiredLightweightIsolationBackend implements IsolationBackend {
	readonly tier = "lightweight" as const;

	status(): IsolationBackendStatus {
		return {
			tier: this.tier,
			state: "idle",
			supported: true,
			detail:
				"Lightweight runs in-place on the real tree, write-confined by the OS at the bash router (no copy).",
		};
	}

	operations(_sourceCwd: string): BashOperations {
		return {
			exec: async () => {
				throw new IsolationUnavailableError(
					this.tier,
					"Lightweight isolation is enforced at the bash router, not this backend.",
				);
			},
		};
	}

	async reset(): Promise<void> {}
	async destroy(): Promise<void> {}
}
