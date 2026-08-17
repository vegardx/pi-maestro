// Feature-gated adapter for the external model-facing questionnaire package.
// Keeping it behind defineExtension preserves the stack's rule that every
// manifest entry can be disabled before it registers any surface.

import { defineExtension } from "@vegardx/pi-core";

export default defineExtension(
	{
		name: "ask-user-question",
		path: "packages/ask/src/rpiv-extension.ts",
		doc: "Model-facing structured planning questions from rpiv-ask-user-question.",
	},
	async (pi) => {
		const extension = (await import("@juicesharp/rpiv-ask-user-question"))
			.default;
		extension(pi);
	},
);
