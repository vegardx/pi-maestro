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

/**
 * Mirrors Pi's `getSupportedThinkingLevels`, so a level this router picks is
 * one Pi will not clamp away: a null entry is unsupported, and `xhigh`/`max`
 * exist only where the model maps them, because no provider has a default
 * for levels above `high`.
 */
export function supportedEfforts(
	model: CatalogModel,
): readonly ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return EFFORTS.filter((effort) => {
		const mapped = model.thinkingLevelMap?.[effort];
		if (mapped === null) return false;
		if (effort === "xhigh" || effort === "max") return mapped !== undefined;
		return true;
	});
}
