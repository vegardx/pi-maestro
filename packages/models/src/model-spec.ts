export interface ParsedModelSpec {
	readonly provider: string;
	readonly modelId: string;
}

/** Parse an exact persisted provider/model id. */
export function parseModelSpec(spec: string): ParsedModelSpec | null {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return null;
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** A well-formed `provider/id` string (a non-empty head and tail). */
export function isModelId(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value
		? parseModelSpec(value) !== null
		: false;
}
