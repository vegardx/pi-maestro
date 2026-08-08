function values(source) {
	if (Array.isArray(source)) return source;
	if (source && typeof source === "object") return Object.values(source);
	return [];
}

export default function workflowApiHelper({ sources, options }) {
	if (options?.mode === "normalize") {
		const reviews = Object.values(sources).flatMap(values);
		return {
			schema: "workflow-api-normalized-v1",
			digest: "normalized",
			findings: reviews.flatMap((review) =>
				Array.isArray(review?.findings) ? review.findings : [],
			),
		};
	}

	if (options?.mode === "gate") {
		return {
			schema: "workflow-api-gate-v1",
			digest: "gate-passed",
			sourceStages: Object.keys(sources).sort(),
		};
	}

	throw new Error(
		`unsupported workflow API probe mode: ${String(options?.mode)}`,
	);
}
