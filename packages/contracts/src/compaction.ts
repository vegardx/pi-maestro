// Compaction-ownership protocol. The generic `smart-compact` extension and
// `modes` both register a `session_before_compact` handler. To avoid two
// summaries for one compaction, modes claims a compaction by prefixing its
// `ctx.compact({ customInstructions })` with this marker; smart-compact sees
// the marker and declines (returns undefined) so modes' handler wins.
//
// The marker lives here, in shared vocabulary, because the two extensions may
// not import each other — it is the one byte-stable string both sides agree on.

export const MAESTRO_COMPACTION_MARKER = "maestro:modes-deliverable-slice";

/**
 * True when a compaction's customInstructions were authored by modes (carry
 * the ownership marker). Generic compaction extensions must decline these.
 */
export function isMaestroOwnedCompaction(
	customInstructions: string | undefined,
): boolean {
	return (
		typeof customInstructions === "string" &&
		customInstructions.startsWith(MAESTRO_COMPACTION_MARKER)
	);
}
