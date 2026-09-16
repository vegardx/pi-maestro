/** Current in-process harness callers that resolve a support model. */
export const MODEL_ROLES = ["classifier", "compact-summarizer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * The persona whose allowance governs a role. Both current in-process harness
 * callers are read-only support work, so both map to `codebase-research`; the
 * indirection exists so a role gains its own allowance by editing one table
 * rather than every call site.
 */
export function personaForRole(_role: ModelRole): string {
	return "codebase-research";
}
