// Structured-finding parsing and rendering — re-homed to @vegardx/pi-contracts
// (review.js) so the v2 contract registry can use the parsers as salvage
// tiers. This module stays as the import path for modes-internal callers.

export {
	computedVerdict,
	FINDING_SEVERITIES,
	type FindingSeverity,
	isBlockingSeverity,
	parseJsonFindings,
	parseStructuredFindings,
	renderFinding,
	type StructuredFinding,
} from "@vegardx/pi-contracts";
