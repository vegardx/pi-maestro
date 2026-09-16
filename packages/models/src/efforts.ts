import type { CatalogModel } from "./port.js";
import type { ThinkingLevel } from "./thinking.js";

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
export function supportedEfforts(
	model: CatalogModel,
): readonly ThinkingLevel[] {
	if (model.reasoning === false) return ["off"];
	return EFFORTS.filter((effort) => model.thinkingLevelMap?.[effort] !== null);
}
