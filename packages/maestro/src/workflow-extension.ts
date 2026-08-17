import { defineExtension } from "@vegardx/pi-core";

export default defineExtension(
	{
		name: "workflow",
		path: "packages/maestro/src/workflow-extension.ts",
		doc: "Public pi-workflow extension bundled by pi-maestro.",
	},
	async (pi) => {
		const packageName = "@agwab/pi-workflow/extension";
		const extension = (await import(packageName)).default;
		extension(pi);
	},
);
