import { defineExtension } from "@vegardx/pi-core";

export default defineExtension(
	{
		name: "ask-user-question",
		path: "packages/maestro/src/rpiv-ask-extension.ts",
		doc: "Structured model-authored questions from rpiv-ask-user-question.",
	},
	async (pi) => {
		const extension = (await import("@juicesharp/rpiv-ask-user-question"))
			.default;
		extension(pi);
	},
);
