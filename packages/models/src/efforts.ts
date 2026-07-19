import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@vegardx/pi-contracts";

const EFFORTS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Pi's null map entries are explicitly unsupported; missing entries default. */
export function supportedEfforts(model: Model<Api>): readonly ThinkingLevel[] {
	const details = model as Model<Api> & {
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	};
	if (details.reasoning === false) return ["off"];
	return EFFORTS.filter(
		(effort) => details.thinkingLevelMap?.[effort] !== null,
	);
}
