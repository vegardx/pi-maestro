// Reviewer verdict protocol — re-homed to @vegardx/pi-contracts (review.js) so
// the v2 contract registry can use the parser as a salvage tier. This module
// stays as the import path for modes-internal callers.

export {
	type ParsedVerdict,
	parseVerdict,
	VERDICT_INSTRUCTION,
	type Verdict,
} from "@vegardx/pi-contracts";
