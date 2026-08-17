import { defineExtension } from "@vegardx/pi-core";

export default defineExtension(
	{
		name: "subagent",
		path: "packages/maestro/src/subagent-extension.ts",
		doc: "Public pi-subagent extension bundled by pi-maestro.",
	},
	async (pi) => {
		const packageName = "@agwab/pi-subagent";
		const extension = (await import(packageName)).default;
		extension(pi);
	},
);
